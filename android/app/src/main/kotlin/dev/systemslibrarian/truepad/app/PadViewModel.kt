package dev.systemslibrarian.truepad.app

import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.systemslibrarian.truepad.core.Direction
import dev.systemslibrarian.truepad.spt.CancelReason
import dev.systemslibrarian.truepad.spt.SptRefused
import dev.systemslibrarian.truepad.storage.PartyRole
import dev.systemslibrarian.truepad.storage.EngineRefused
import dev.systemslibrarian.truepad.storage.PairListEntry
import dev.systemslibrarian.truepad.storage.PairSummary
import dev.systemslibrarian.truepad.storage.Party2
import dev.systemslibrarian.truepad.storage.SourceInput
import dev.systemslibrarian.truepad.storage.SptCreateResult
import dev.systemslibrarian.truepad.storage.SptOpenResult
import dev.systemslibrarian.truepad.storage.SptReviewResult
import dev.systemslibrarian.truepad.storage.SptSealResult
import dev.systemslibrarian.truepad.storage.WitnessKind
import dev.systemslibrarian.truepad.storage.sptCommitReceive
import dev.systemslibrarian.truepad.storage.sptConfirmRequest
import dev.systemslibrarian.truepad.storage.sptCreateReceiveRequest
import dev.systemslibrarian.truepad.storage.sptEndReceiveRequest
import dev.systemslibrarian.truepad.storage.sptRestorePendingReceiveRequest
import dev.systemslibrarian.truepad.storage.sptOpen
import dev.systemslibrarian.truepad.storage.sptReviewRequest
import dev.systemslibrarian.truepad.storage.sptSeal
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

    /** True when the back press was consumed by the in-app stack. Leaving any
     *  screen drops the transient sealed-transfer session — it may hold a
     *  decrypted pad, and it must never outlive the flow that produced it. */
    fun back(): Boolean {
        val stack = _state.value.backStack
        if (stack.size <= 1) return false
        _state.value = _state.value.copy(
            backStack = stack.dropLast(1), banner = null, lastResult = null, spt = SptUi(),
        )
        return true
    }

    /** Discard any in-flight sealed-transfer session and return to the given
     *  screen. Used by the flows' own Cancel controls. */
    /**
     * RECEIVER — the eight confirmation words DID NOT MATCH.
     *
     * This is the outcome the comparison exists to produce, so it has to be
     * durable. It previously only cleared the screen, which was survivable while
     * nothing read pending requests back and stopped being survivable the moment
     * `startReceive()` began restoring them: the rejected request — and the sealed
     * package the mismatch was warning about — would be offered again on the next
     * visit to this screen.
     *
     * The in-memory session is dropped either way. If the durable write fails the
     * operator is TOLD, rather than being returned to a home screen that implies
     * the rejection stuck.
     */
    fun rejectOpenedPackage() {
        val requestId = _state.value.spt.openSession?.requestIdHex
            ?: _state.value.spt.receiveRequest?.requestIdHex
        endReceiveRequest(requestId, CancelReason.REJECTED,
                          "Rejected. That receive code is finished and cannot receive a pad.")
    }

    /** RECEIVER — the operator abandons their own receive code before any package
     *  arrives. A different fact from a rejection, recorded as a different reason;
     *  the primitive keeps the FIRST reason, so this can never mask one. */
    fun cancelReceiveCode() {
        endReceiveRequest(_state.value.spt.receiveRequest?.requestIdHex, CancelReason.OPERATOR,
                          "That receive code is cancelled.")
    }

    private fun endReceiveRequest(requestId: String?, reason: CancelReason, done: String) {
        if (requestId == null) { cancelSpt(Screen.Home); return }
        viewModelScope.launch {
            val outcome = withContext(Dispatchers.IO) {
                runCatching { engine.sptEndReceiveRequest(requestId, reason) }
            }
            _state.value = _state.value.copy(
                backStack = listOf(Screen.Home),
                spt = SptUi(),
                banner = outcome.fold(
                    onSuccess = { Banner.Info(done) },
                    // NOT swallowed. A rejection that did not reach the disk is a
                    // request that can come back, and the operator is the only one
                    // who can decide what to do about that.
                    onFailure = {
                        Banner.Problem(
                            "This receive code could NOT be closed on disk, so it may still be " +
                                "usable. Open Receive again and cancel it before accepting any pad.",
                        )
                    },
                ),
            )
        }
    }

    fun cancelSpt(to: Screen) {
        _state.value = _state.value.copy(
            backStack = if (to == Screen.Home) listOf(Screen.Home) else _state.value.backStack.dropLastWhile { it != to },
            banner = null,
            spt = SptUi(),
        )
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
            // ONE ROLE PER PAIR, derived from the pad itself. This used to be a
            // single global default of Party2.A shared by every pad, which is how
            // two devices holding one pair both burned A_TO_B.
            val derivedRole = current?.let { PartyRole.derive(it.origin) }
            _state.value = _state.value.copy(
                pads = visible, current = current, loaded = true,
                role = derivedRole ?: _state.value.role.takeIf { current == null },
                roleWasDerived = derivedRole != null,
            )
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
            } catch (e: SptRefused) {
                // The sealed-transfer verbs raise their OWN typed refusal, with the
                // same discipline as the engine's: the reason is the contract, the
                // message carries no secret. It is mapped to a plain sentence the
                // same way, and an unmapped reason falls through to its own words.
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

    fun createPadFromDevice(label: String, size: PadSize, recordBytes: Int? = null) {
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
                        recordBytes = recordBytes,
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

    fun createPadFromFiles(label: String, size: PadSize, sources: List<PickedSource>, recordBytes: Int? = null) {
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
                        recordBytes = recordBytes,
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

    fun send(pairId: String, role: Party2?, text: String) {
        // FAIL CLOSED ON AN UNKNOWN ROLE. Burning on a guess is how two devices
        // spend the same one-time material; refusing is only loss.
        if (role == null) {
            _state.value = _state.value.copy(banner = Banner.Refused(
                    UserFacingRefusal(
                        reason = "role-unknown",
                        headline = "TruePad does not know which half of this pair is yours",
                        detail = PartyRole.UNKNOWN_ORIGIN_PROMPT,
                    )
                ))
            return
        }
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

    fun open(pairId: String, role: Party2?, envelope: String) {
        if (role == null) {
            _state.value = _state.value.copy(banner = Banner.Refused(
                    UserFacingRefusal(
                        reason = "role-unknown",
                        headline = "TruePad does not know which half of this pair is yours",
                        detail = PartyRole.UNKNOWN_ORIGIN_PROMPT,
                    )
                ))
            return
        }
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

    /* ---- sealed transfer: RECEIVE a pad ------------------------------------- */

    /** Begin the receive flow with a clean slate. The engine holds no state yet;
     *  a receive request is only created when the operator asks for one. */
    fun startReceive() {
        _state.value = _state.value.copy(
            backStack = _state.value.backStack + Screen.ReceivePad, banner = null, spt = SptUi(),
        )
        // PICK UP A REQUEST THAT SURVIVED. `SptUi()` above deliberately clears the
        // transient session, and `request.json`/`dk.bin` are durable — so without
        // this, leaving the screen or restarting the app stranded a LIVE one-time
        // key: still pending on disk, unreachable from the interface. The operator
        // could not cancel it, could not REJECT it after a failed word comparison,
        // and could not open the sealed file that came back.
        //
        // Found by the two-device physical ceremony: the iPhone sealed a pad to
        // this device's request and this device then had no way to open it. The
        // iOS edition carried the identical defect.
        viewModelScope.launch {
            val restored = withContext(Dispatchers.IO) {
                runCatching { engine.sptRestorePendingReceiveRequest() }.getOrNull()
            } ?: return@launch
            // Only fill an EMPTY slot, so a reload can never displace a request the
            // operator is looking at.
            if (_state.value.spt.receiveRequest == null) {
                _state.value = _state.value.copy(
                    spt = _state.value.spt.copy(receiveRequest = restored),
                )
            }
        }
    }

    /** RECEIVER — publish a one-time receive request. The TPR2 code and the
     *  twelve request words come back for the operator to share and compare. */
    fun createReceiveRequest() {
        operate {
            val created = withContext(Dispatchers.IO) { engine.sptCreateReceiveRequest() }
            _state.value = _state.value.copy(spt = _state.value.spt.copy(receiveRequest = created))
        }
    }

    /** RECEIVER — open a sealed pad file the sender delivered, into a transient
     *  session. No pad byte is saved yet; the confirmation ceremony comes first. */
    fun openReceivedPackage(uri: Uri) {
        operate {
            val session = withContext(Dispatchers.IO) {
                val bytes = AndroidStorage.readPicked(getApplication<Application>().contentResolver, uri)
                engine.sptOpen(bytes)
            }
            _state.value = _state.value.copy(spt = _state.value.spt.copy(openSession = session))
        }
    }

    /** RECEIVER — after the words match, CONSUME the request and import the pad.
     *  On success the new pad is opened; the transient session is dropped. */
    fun commitReceive(label: String) {
        operate {
            val session = _state.value.spt.openSession ?: return@operate
            val summary = withContext(Dispatchers.IO) { engine.sptCommitReceive(session, label.ifBlank { "Pad" }) }
            openPad(summary.pairId)
            _state.value = _state.value.copy(banner = Banner.Added)
        }
    }

    /* ---- sealed transfer: GIVE a pad ---------------------------------------- */

    /** From a pad, choose how to hand it over (a file, or a sealed transfer). */
    fun startGive() {
        _state.value = _state.value.copy(
            backStack = _state.value.backStack + Screen.GivePad, banner = null, spt = SptUi(),
        )
    }

    /** Enter the sealed-transfer sender flow. */
    fun startSendSealed() {
        _state.value = _state.value.copy(
            backStack = _state.value.backStack + Screen.SendSealed, banner = null, spt = SptUi(),
        )
    }

    /** Open the camera scanner from the send flow. */
    fun scanReceiveCode() {
        _state.value = _state.value.copy(backStack = _state.value.backStack + Screen.ScanQr, banner = null)
    }

    /** SENDER — a receive code arrived from the QR scanner: leave the scanner and
     *  review it through the SAME strict path a pasted code takes. A QR that is
     *  not a canonical receive code is refused by the review, exactly like a bad
     *  paste. */
    fun reviewFromScan(tpr2Text: String) {
        val stack = _state.value.backStack
        val popped = if (stack.lastOrNull() == Screen.ScanQr) stack.dropLast(1) else stack
        _state.value = _state.value.copy(backStack = popped, banner = null)
        reviewSealRequest(tpr2Text)
    }

    /** SENDER — decode the receiver's TPR2 code and return the twelve words to
     *  compare. The canonical body is held for the seal step, never re-derived. */
    fun reviewSealRequest(tpr2Text: String) {
        operate {
            val review = withContext(Dispatchers.IO) { engine.sptReviewRequest(tpr2Text.trim()) }
            _state.value = _state.value.copy(spt = _state.value.spt.copy(sendReview = review))
        }
    }

    /** SENDER — record the twelve-word match, then seal this pad to the request.
     *  Returns the sealed package and the eight confirmation words to read aloud. */
    fun sealPad(pairId: String) {
        operate {
            val review = _state.value.spt.sendReview ?: return@operate
            val sealed = withContext(Dispatchers.IO) {
                engine.sptConfirmRequest(review.canonicalBody)
                engine.sptSeal(review.requestHashHex, pairId)
            }
            _state.value = _state.value.copy(spt = _state.value.spt.copy(sealed = sealed))
        }
    }

    /** SENDER — write the sealed .tps2 to a location the operator chose. It is a
     *  package sealed to the receiver's one-time key, safe to move over any
     *  channel; only the intended receiver can open it. */
    fun saveSealedPackage(uri: Uri) {
        operate {
            val sealed = _state.value.spt.sealed ?: return@operate
            withContext(Dispatchers.IO) {
                AndroidStorage.writePicked(getApplication<Application>().contentResolver, uri, sealed.packageBytes)
            }
            _state.value = _state.value.copy(
                spt = _state.value.spt.copy(savedPackage = true), banner = Banner.SealedSaved,
            )
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
            spt = SptUi(),
        )
        refresh()
    }

    /**
     * Override the role for the CURRENT pad. Only reachable when the pad's origin
     * is unknown, so the operator is answering a question TruePad could not.
     *
     * The previous comment here said "Persisted per pad by the operator's choice";
     * it was neither persisted nor per pad — one global field served every pad.
     */
    fun setRole(role: Party2) {
        _state.value = _state.value.copy(role = role)
    }
}

/* ---- the UI's view of the world ------------------------------------------- */

enum class Screen {
    Home, CreatePad, AddPad, Pad, Send, Open, Details, Remove,
    // Sealed Pad Transfer — the same SPT protocol the Browser Edition speaks.
    ReceivePad, GivePad, SendSealed, ScanQr,
}

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
    data object SealedSaved : Banner
}

/**
 * The transient state of ONE sealed-transfer flow, held in memory only.
 *
 * These carry secrets and one-shot cryptographic material — [SptOpenResult]
 * holds the decrypted pad bytes before import — so they live here and nowhere
 * durable, are never written to the saved-instance bundle, and are dropped the
 * moment the flow ends or the operator navigates away. Every AUTHORITY (the
 * durable receiver/claim/handoff/confirmed records) lives in the engine; this is
 * only what the current screen needs to draw and to complete the next step.
 */
data class SptUi(
    /** RECEIVER: the published receive request — its TPR2 code and the twelve
     *  request words to compare aloud. */
    val receiveRequest: SptCreateResult? = null,
    /** RECEIVER: a sealed package opened into a transient session — carries the
     *  eight confirmation words and, in memory only, the decrypted pad. */
    val openSession: SptOpenResult? = null,
    /** SENDER: a reviewed receive request — its twelve request words and the
     *  canonical body to seal against. */
    val sendReview: SptReviewResult? = null,
    /** SENDER: the sealed package to hand over, plus its eight confirmation words. */
    val sealed: SptSealResult? = null,
    /** SENDER: true once the sealed .tps2 has been saved to a chosen location. */
    val savedPackage: Boolean = false,
)

data class UiState(
    val loaded: Boolean = false,
    val busy: Boolean = false,
    val backStack: List<Screen> = listOf(Screen.Home),
    val pads: List<PairListEntry> = emptyList(),
    val currentPairId: String? = null,
    val current: PairSummary? = null,
    /**
     * Which half of the pair this device owns, DERIVED per pad from how it was
     * acquired — never a default. Null means the pad's origin is unknown and the
     * operator must choose; see [dev.systemslibrarian.truepad.storage.PartyRole].
     */
    val role: Party2? = null,
    /** True when the pad supplied the role, so the picker is shown only when there is a question. */
    val roleWasDerived: Boolean = false,
    val banner: Banner? = null,
    val lastResult: OpResult? = null,
    val spt: SptUi = SptUi(),
) {
    val screen: Screen get() = backStack.last()

    /** The direction this device SENDS on, given the operator's chosen role. */
    val sendDirection: Direction
        get() = if (role == Party2.A) Direction.A_TO_B else Direction.B_TO_A

    /** The direction this device RECEIVES on. */
    val receiveDirection: Direction
        get() = if (role == Party2.A) Direction.B_TO_A else Direction.A_TO_B
}
