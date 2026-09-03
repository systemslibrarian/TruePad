package dev.systemslibrarian.truepad.app

import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.systemslibrarian.truepad.core.Direction
import dev.systemslibrarian.truepad.storage.EngineRefused
import dev.systemslibrarian.truepad.storage.PairListEntry
import dev.systemslibrarian.truepad.storage.PairSummary
import dev.systemslibrarian.truepad.storage.Party2
import dev.systemslibrarian.truepad.storage.SourceInput
import dev.systemslibrarian.truepad.storage.WitnessKind
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.security.SecureRandom

/*
 * The application controller.
 *
 * WHAT THIS IS NOT is the important part. It is not a state machine about pad
 * consumption, it does not know what a sequence number is, and it never decides
 * whether something may be sent. It calls the engine, off the main thread, and
 * renders what comes back. Every consumption decision, every refusal, every
 * counter belongs to :truepad-storage.
 *
 * TWO RULES it does enforce, because they are UI concerns:
 *
 *   1. NOTHING CONSUMABLE IS CACHED AS AUTHORITATIVE. `pads` and `current` are
 *      a snapshot for drawing pixels. They are reloaded from the engine after
 *      every operation and on every resume. If this object and the store ever
 *      disagree, the store is right. An Activity that dies mid-operation must
 *      never let the UI conclude the operation "did not happen".
 *
 *   2. ONE UI-INITIATED OPERATION AT A TIME. The mutex below drops a second tap
 *      that arrives while the first is still in flight.
 *
 *      Two DIFFERENT properties meet here and they are worth keeping apart. The
 *      engine's per-pair lock is what makes REUSE impossible: two concurrent
 *      burns are serialised, and each takes its own region, so no byte of pad is
 *      ever spent twice. That holds with or without this mutex. What this mutex
 *      prevents is WASTE: without it, two calls issued in one instant are two
 *      valid sends, and a one-time pad two message slots poorer for one message
 *      has lost something real even though nothing was reused.
 *
 *      Note that the BUTTON also defends this, by disabling itself as soon as
 *      `busy` recomposes — which is why the double-tap UI test passes with this
 *      mutex deleted, and why the falsification round found nothing testing it.
 *      `twoCallsInOneInstantProduceOneOperation` bypasses the button and issues
 *      two calls inside one main-thread message, which is the window this mutex
 *      actually closes; it spends two records without it and one with it.
 */
class PadViewModel(app: Application) : AndroidViewModel(app) {

    private val engine = (app as TruePadApp).engine
    private val hidden = HiddenPads(app)
    private val secureRandom = SecureRandom()

    private val opLock = Mutex()

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    init {
        refresh()
    }

    /* ---- navigation -------------------------------------------------------- */

    fun navigate(screen: Screen) {
        _state.value = _state.value.let { it.copy(backStack = it.backStack + screen, banner = null) }
    }

    /** True when the back press was consumed by the in-app stack. */
    fun back(): Boolean {
        val stack = _state.value.backStack
        if (stack.size <= 1) return false
        _state.value = _state.value.copy(backStack = stack.dropLast(1), banner = null, lastResult = null)
        return true
    }

    fun dismissBanner() {
        _state.value = _state.value.copy(banner = null)
    }

    /** Drop a produced envelope or released plaintext from memory once shown. */
    fun clearResult() {
        _state.value = _state.value.copy(lastResult = null)
    }

    /* ---- reading ----------------------------------------------------------- */

    /**
     * Reload everything from the engine. Called on init, on every resume, and
     * after every operation — the UI never advances its own counters.
     */
    fun refresh() {
        viewModelScope.launch {
            val entries = withContext(Dispatchers.IO) {
                runCatching { engine.listSummaries() }.getOrElse { emptyList() }
            }
            val hiddenIds = withContext(Dispatchers.IO) { hidden.all() }
            val visible = entries.filterNot { it.pairId in hiddenIds }
            val open = _state.value.currentPairId
            val current = if (open == null) {
                null
            } else {
                withContext(Dispatchers.IO) { runCatching { engine.status(open) }.getOrNull() }
            }
            _state.value = _state.value.copy(pads = visible, current = current, loaded = true)
        }
    }

    /* ---- operations -------------------------------------------------------- */

    private fun operate(block: suspend () -> Unit) {
        viewModelScope.launch {
            if (!opLock.tryLock()) return@launch // a second tap while the first is in flight
            _state.value = _state.value.copy(busy = true, banner = null)
            try {
                block()
            } catch (e: EngineRefused) {
                _state.value = _state.value.copy(banner = Banner.Refused(e.toUserFacing()))
            } catch (e: AndroidStorage.PickedFileTooLarge) {
                _state.value = _state.value.copy(banner = Banner.Problem(e.message ?: "That file is too large."))
            } catch (e: Exception) {
                // An unexpected failure is reported by TYPE, never by message.
                // A raw exception string can carry a path, and a path can carry
                // a pairId; the engine's own refusals are audited for this, an
                // arbitrary platform exception is not.
                _state.value = _state.value.copy(
                    banner = Banner.Problem("Something went wrong (${e.javaClass.simpleName}). Nothing was changed."),
                )
            } finally {
                // ALWAYS released, on every path. A tryLock() whose unlock() can
                // be skipped is worse than no mutex at all: the first operation
                // would take it, never give it back, and every later action in
                // this ViewModel would be silently dropped.
                opLock.unlock()
                _state.value = _state.value.copy(busy = false)
                refresh()
            }
        }
    }

    /* ---- create ------------------------------------------------------------ */

    fun createPadFromDevice(label: String, size: PadSize) {
        operate {
            val required = size.requiredSourceLength()
            val summary = withContext(Dispatchers.IO) {
                val material = ByteArray(required.toInt())
                secureRandom.nextBytes(material)
                try {
                    engine.gen(
                        label = label.ifBlank { "Pad" },
                        sources = listOf(
                            SourceInput(Claims.DEVICE_SOURCE_NAME, Claims.DEVICE_DECLARED_ORIGIN, material),
                        ),
                        encryptionBytes = size.encryptionBytes,
                        authRecords = size.authRecords,
                        witnessKind = WitnessKind.LOCAL,
                    ).pair
                } finally {
                    // In-memory hygiene only; no erasure claim. The engine zeroes
                    // its own copies, and this is ours.
                    material.fill(0)
                }
            }
            openPad(summary.pairId)
            _state.value = _state.value.copy(banner = Banner.Created(Claims.DEVICE_SOURCE_LABEL))
        }
    }

    fun createPadFromFiles(label: String, size: PadSize, sources: List<PickedSource>) {
        operate {
            val required = size.requiredSourceLength()
            val summary = withContext(Dispatchers.IO) {
                val resolver = getApplication<Application>().contentResolver
                val inputs = sources.map { picked ->
                    val bytes = AndroidStorage.readPicked(resolver, picked.uri)
                    SourceInput(picked.name, picked.declaredOrigin, bytes)
                }
                try {
                    engine.gen(
                        label = label.ifBlank { "Pad" },
                        sources = inputs,
                        encryptionBytes = size.encryptionBytes,
                        authRecords = size.authRecords,
                        witnessKind = WitnessKind.LOCAL,
                    ).pair
                } finally {
                    inputs.forEach { it.bytes.fill(0) }
                }
            }
            require(required > 0)
            openPad(summary.pairId)
            _state.value = _state.value.copy(banner = Banner.Created(Claims.EXTERNAL_SOURCE_LABEL))
        }
    }

    /* ---- add an existing pad ------------------------------------------------ */

    fun importPad(label: String, uri: Uri) {
        operate {
            val summary = withContext(Dispatchers.IO) {
                val bytes = AndroidStorage.readPicked(getApplication<Application>().contentResolver, uri)
                engine.importPair(label.ifBlank { "Pad" }, bytes, WitnessKind.LOCAL)
            }
            openPad(summary.pairId)
            _state.value = _state.value.copy(banner = Banner.Added)
        }
    }

    /* ---- the daily verbs ---------------------------------------------------- */

    fun send(pairId: String, role: Party2, text: String) {
        operate {
            val envelope = withContext(Dispatchers.IO) {
                val plaintext = text.toByteArray(Charsets.UTF_8)
                try {
                    engine.burn(pairId, role, plaintext).envelope
                } finally {
                    plaintext.fill(0)
                }
            }
            _state.value = _state.value.copy(lastResult = OpResult.Sent(envelope))
        }
    }

    fun open(pairId: String, role: Party2, envelope: String) {
        operate {
            val plaintext = withContext(Dispatchers.IO) {
                val bytes = engine.open(pairId, role, envelope).plaintext
                val text = String(bytes, Charsets.UTF_8)
                bytes.fill(0)
                text
            }
            _state.value = _state.value.copy(lastResult = OpResult.Opened(plaintext))
        }
    }

    fun exportPad(pairId: String, uri: Uri) {
        operate {
            withContext(Dispatchers.IO) {
                val container = engine.exportPair(pairId).container
                try {
                    AndroidStorage.writePicked(getApplication<Application>().contentResolver, uri, container)
                } finally {
                    container.fill(0)
                }
            }
            _state.value = _state.value.copy(banner = Banner.Exported)
        }
    }

    fun clearFreeze(pairId: String) {
        operate {
            val cleared = withContext(Dispatchers.IO) { engine.clearFreeze(pairId) }
            _state.value = _state.value.copy(
                banner = Banner.Info(
                    if (cleared > 0) "This pad can be used again." else "This pad was not paused.",
                ),
            )
        }
    }

    /**
     * REMOVE. Two separate acts, in this order, and the order matters.
     *
     * First the engine destroys the pad: the durable tombstone lands, the secret
     * body is best-effort zeroed and unlinked, and the pair becomes permanently
     * unusable — that boundary is what stops the old pad file being re-imported
     * later, and nothing in the UI can undo it. ONLY THEN is the pairId added to
     * the local hidden list, which is a display preference and nothing more.
     *
     * If the second step fails, the pad is still destroyed and merely still
     * visible. If the order were reversed, a failure between them would hide a
     * pad that was still live — a pad the operator believes is gone but which
     * still holds usable material.
     */
    fun removePad(pairId: String, confirmation: String) {
        operate {
            withContext(Dispatchers.IO) {
                engine.destroy(pairId, confirmation, "removed on Android")
                hidden.hide(pairId)
            }
            _state.value = _state.value.copy(
                backStack = listOf(Screen.Home),
                currentPairId = null,
                current = null,
                banner = Banner.Removed,
            )
        }
    }

    /* ---- selection --------------------------------------------------------- */

    fun openPad(pairId: String) {
        _state.value = _state.value.copy(
            currentPairId = pairId,
            backStack = listOf(Screen.Home, Screen.Pad),
            banner = null,
            lastResult = null,
        )
        refresh()
    }

    /** Which half of the pair this device sends on. Persisted per pad by the operator's choice. */
    fun setRole(role: Party2) {
        _state.value = _state.value.copy(role = role)
    }
}

/* ---- the UI's view of the world ------------------------------------------- */

enum class Screen { Home, CreatePad, AddPad, Pad, Send, Open, Details, Remove }

data class PickedSource(val uri: Uri, val name: String, val declaredOrigin: String)

/**
 * Pad sizes in the units a person thinks in. The engine's real budgets are
 * E (encryption bytes) and N (authentication records); N is the number of
 * MESSAGES, because every message costs exactly one record whatever its length.
 */
enum class PadSize(val label: String, val encryptionBytes: Long, val authRecords: Long) {
    Small("Small", 16L * 1024, 128),
    Medium("Medium", 64L * 1024, 512),
    Large("Large", 256L * 1024, 2048);

    fun requiredSourceLength(): Long = 2 * (encryptionBytes + 32 * authRecords)

    /** Plain language: what you actually get. */
    fun describe(): String =
        "about $authRecords messages, ${encryptionBytes / 1024} KB of text in total"
}

sealed interface OpResult {
    /**
     * The envelope the engine emitted. It exists ONLY here, in memory. The pad
     * material is already spent — that happened durably before this string was
     * produced — so losing it loses the message, not the pad's integrity. The
     * screen says so.
     */
    data class Sent(val envelope: String) : OpResult

    data class Opened(val plaintext: String) : OpResult
}

sealed interface Banner {
    data class Refused(val refusal: UserFacingRefusal) : Banner
    data class Problem(val text: String) : Banner
    data class Info(val text: String) : Banner
    data class Created(val sourceLabel: String) : Banner
    data object Added : Banner
    data object Exported : Banner
    data object Removed : Banner
}

data class UiState(
    val loaded: Boolean = false,
    val busy: Boolean = false,
    val backStack: List<Screen> = listOf(Screen.Home),
    val pads: List<PairListEntry> = emptyList(),
    val currentPairId: String? = null,
    val current: PairSummary? = null,
    val role: Party2 = Party2.A,
    val banner: Banner? = null,
    val lastResult: OpResult? = null,
) {
    val screen: Screen get() = backStack.last()

    /** The direction this device SENDS on, given the operator's chosen role. */
    val sendDirection: Direction
        get() = if (role == Party2.A) Direction.A_TO_B else Direction.B_TO_A

    /** The direction this device RECEIVES on. */
    val receiveDirection: Direction
        get() = if (role == Party2.A) Direction.B_TO_A else Direction.A_TO_B
}
