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
import dev.systemslibrarian.truepad.storage.HandoffState
import dev.systemslibrarian.truepad.storage.UNREADABLE_ADVICE
import dev.systemslibrarian.truepad.storage.PairOrigin
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
import dev.systemslibrarian.truepad.storage.sptSealedToRequest
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

    /**
     * Switch persistent destination.
     *
     * DELIBERATELY NOT `navigate()` AND NOT `back()`. Both of those clear state
     * that a tab switch has no business clearing — `back()` resets `spt`, which is
     * the live sealed-transfer session, and both drop the banner. A tab switch
     * moves the viewport; it is not a step in any flow, and it must not be able to
     * cancel one. Nothing here touches `spt`, `lastResult`, `currentPairId`,
     * `banner`, or anything the engine owns.
     */
    fun selectTab(tab: Tab) {
        val s = _state.value
        if (s.tab == tab) return
        val parked = s.parked + (s.tab to s.backStack)
        _state.value = s.copy(
            tab = tab,
            backStack = parked[tab] ?: listOf(tab.root),
            parked = parked - tab,
        )
        // ARRIVING AT THE INBOX MUST SURFACE A PENDING REQUEST. See
        // restorePendingReceiveRequest — this is the one thing a tab switch has to
        // DO, as against all the things it must not.
        if (tab == Tab.Inbox) restorePendingReceiveRequest()
    }

    /**
     * A WHOLESALE STACK REPLACEMENT, WITH THE TAB IT BELONGS TO.
     *
     * `tab` used to be written in exactly one place — `selectTab` — while five
     * verbs replaced `backStack` outright. That left the two able to disagree: a
     * Pads-rooted stack could be showing while `tab` still said Inbox, and because
     * `selectTab` early-returns when the tab already matches, tapping Inbox then
     * did nothing at all and the receive destination became unreachable without a
     * relaunch. Every wholesale replacement goes through here now, so the pair
     * cannot drift.
     */
    private fun UiState.movedTo(tab: Tab, stack: List<Screen>): UiState {
        val kept = if (this.tab == tab) parked else parked + (this.tab to backStack)
        return copy(tab = tab, backStack = stack, parked = kept - tab)
    }

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
            // BACK TO THE INBOX'S OWN ROOT, not to the Pads home. Ending a receive
            // request is an Inbox action; sending it to `Screen.Home` put the Pads
            // home screen inside the Inbox tab and stranded the destination.
            _state.value = _state.value.movedTo(Tab.Inbox, listOf(Tab.Inbox.root)).copy(
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
        val s = _state.value
        // FLOORED. `dropLastWhile` removes EVERY element when the target is not on
        // the stack, and `UiState.screen` is `backStack.last()` — so an empty stack
        // is a crash on the next recomposition, not a blank screen. That became
        // reachable once each tab had its own stack: cancelling a sealed transfer
        // with `Screen.Pad` from a stack that has no Pad screen is exactly that
        // case. Falling back to the current tab's root is the safe answer.
        // AND IT CARRIES ITS TAB. This was the one wholesale replacement that did
        // not go through `movedTo`: the `Screen.Home` branch wrote a PADS-rooted
        // stack while leaving `tab` alone, which is exactly the divergence
        // `movedTo` exists to prevent — a Pads stack under the Inbox tab, after
        // which `selectTab(Inbox)` early-returns and the destination is gone. Its
        // only caller with `Screen.Home` is `endReceiveRequest`'s null-request
        // path, unreachable today because `requestIdHex` is non-null; a latent
        // bypass of a repair is still a bypass of it.
        _state.value = if (to == Screen.Home) {
            s.movedTo(Tab.Pads, listOf(Screen.Home))
        } else {
            s.copy(backStack = s.backStack.dropLastWhile { it != to }.ifEmpty { listOf(s.tab.root) })
        }.copy(banner = null, spt = SptUi())
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
            // WHETHER THIS PAD MAY STILL LEAVE — the ENGINE's answer, asked
            // without mutating anything.
            //
            // The pad screen used to render "Share this pad" and both of its
            // routes UNCONDITIONALLY. The sealed route is refused by the engine
            // under the pair lock, so nothing was ever duplicated by it — but the
            // refusal arrived only after the other person had generated a receive
            // code, sent it, and both had compared twelve words. The physical
            // route is not backstopped at all: `exportPair` refuses Sealed and
            // UnreadableSpent and lets a Physical marker through, so a second raw
            // pad file really is produced. The sentence under the button says "A
            // pad can be given only once, whichever way you choose", and for that
            // one case it was a promise the engine does not keep. Gating here is
            // what makes it true again.
            val handoff = current?.let {
                withContext(Dispatchers.IO) { runCatching { engine.handoffState(open!!) }.getOrNull() }
            }
            // NOT `== IMPORTED`. An origin that cannot be read is not a pad that
            // was made here: it is a pad TruePad cannot vouch for, and it already
            // refuses to SEND or OPEN on one. Reading UNKNOWN as "not imported"
            // made the same fact fail closed for the role and open for the
            // handoff, ten lines apart — and exporting the raw pad is the one
            // substantive thing an otherwise-unusable pad can still do.
            val vouched = current?.origin == PairOrigin.GENERATED_HERE
            val imported = !vouched
            // FAIL CLOSED. A pad whose handoff state could not be read is not a
            // pad that may be handed over; `handoff == null` falls to the else.
            val mayHandOff = handoff is HandoffState.Absent &&
                HandoffPolicy.mayExportRawPad(handedOver = false, imported = imported)
            val mayReshareSealed = handoff is HandoffState.Sealed &&
                HandoffPolicy.mayReshareSealedPackage(sealed = true, imported = imported)
            // THE PHYSICAL EQUIVALENT, and it exists for the same reason the
            // sealed one does. `exportPair` deliberately lets a re-export through
            // under an existing Physical marker — the first save can be cancelled
            // at the file picker, land on a full disk, or go to a drive that was
            // pulled — and the marker keeps the time of the FIRST handoff either
            // way. Gating the whole screen without this made a failed delivery
            // permanent, which is loss the engine had deliberately not imposed.
            // It is NOT a second handoff and the screen must not offer it as one.
            val mayResavePhysical = handoff is HandoffState.Physical && !imported
            val handOffRefusal: String? = when {
                current == null -> null
                handoff == null ->
                    "TruePad could not read this pad's handoff state, so it will not offer to hand " +
                        "it over. Nothing about the pad has been changed."
                handoff is HandoffState.Physical ->
                    "This pad was already handed over on ${handoff.at}."
                handoff is HandoffState.Sealed ->
                    "This pad was already sent by sealed transfer."
                // THE ADVICE, NOT THE EXCEPTION. `UnreadableSpent.message` is
                // UNREADABLE_ADVICE with a platform exception string appended, and
                // a platform string can carry a path, and a path can carry a
                // pairId. `operate`'s own catch refuses to show one for exactly
                // that reason; this must not be the way around it.
                handoff is HandoffState.UnreadableSpent -> UNREADABLE_ADVICE
                imported ->
                    "This pad arrived from someone else, so TruePad will not pass it on. Two " +
                        "people holding the same pad would each use the same material."
                else -> null
            }
            // LAST WRITER WINS, SO CHECK WHO WON. `refresh()` suspends across
            // several IO hops; two overlapping reloads could land the older pad's
            // `current`, `role` and handoff eligibility under the newer pad's id.
            // The pad-scoped half is dropped if the selection moved while this one
            // was reading.
            if (_state.value.currentPairId != open) return@launch
            _state.value = _state.value.copy(
                pads = visible, current = current, loaded = true,
                // DERIVED, OR NOTHING. There is no second source.
                //
                // This used to fall back to an answer the operator had given by
                // hand, kept for as long as the same pad stayed selected. That
                // fallback is gone, along with the control that fed it: a pad
                // whose origin cannot say is exactly the case where a guess spends
                // the other person's material, and an operator's pick is a guess
                // wearing a different name — which is what this screen's own
                // prompt already told them. Offering it created a SECOND role
                // authority beside the origin, which is the architecture the
                // cross-copy reuse fix exists to prevent; the Browser edition
                // refused to add one for that reason and says so in role.ts.
                //
                // Unknown therefore REFUSES. `send` and `open` already fail closed
                // on a null role with reason `role-unknown`; nothing here has to
                // invent a half for them.
                role = derivedRole,
                roleWasDerived = derivedRole != null,
                mayHandOff = mayHandOff,
                mayReshareSealed = mayReshareSealed,
                mayResavePhysical = mayResavePhysical,
                handOffRefusal = handOffRefusal,
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
            // THE FORM IS SPENT. It survives a tab switch on purpose; it must not
            // survive the pad it made, or the next create starts pre-filled with
            // the last one's name and the last one's source files.
            resetCreateForm()
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
            // Spent, for the same reason as the device path — and here it also
            // drops the picked source URIs, which must not be carried into a pad
            // the operator has not chosen them for.
            resetCreateForm()
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
            // BACK TO THE PAD, because the handoff is over.
            //
            // This left the operator on the Give screen with its "Save as a file"
            // control still live and its "a pad is given only once" callout still
            // on screen. A second tap produced a second raw copy: the engine lets
            // a re-export through under an existing Physical marker, by the same
            // deliberate rule the Browser has. Leaving the screen is what makes
            // the callout's promise true. `refresh()` in operate's finally
            // recomputes `mayHandOff`, so the pad screen comes back gated.
            _state.value = _state.value
                .copy(backStack = _state.value.backStack.dropLastWhile { it != Screen.Pad }
                    .ifEmpty { listOf(_state.value.tab.root) })
                .copy(banner = Banner.Exported)
        }
    }

    /* ---- sealed transfer: RECEIVE a pad ------------------------------------- */

    // `startReceive()` USED TO LIVE HERE, and is deliberately gone.
    //
    // It had no caller left — the home screen's "Receive a pad" selects the Inbox
    // tab instead — and it was not inert dead code: it appended `Screen.ReceivePad`,
    // which is the Inbox tab's ROOT, onto whatever stack was showing. Rewiring it
    // would have put a second copy of the receive destination on the Pads stack,
    // which is how a live one-time request gets stranded behind the wrong back
    // stack in the first place. What it did that was worth keeping —
    // `restorePendingReceiveRequest()` — is called by `selectTab` below.

    /**
     * PICK UP A REQUEST THAT SURVIVED, from whichever way the operator arrived.
     *
     * Extracted because the Inbox tab reintroduced the exact defect the comment in
     * [startReceive] describes. A tab switch must NOT reset the transient session —
     * doing so would cancel a ceremony in progress — so it does not go through
     * `startReceive`, and for one build that meant selecting Inbox showed the
     * "create a receive code" screen while a live one-time key sat pending on
     * disk: uncancellable, unrejectable, and unable to open the sealed file that
     * came back for it. Found by the two-device run, which is where the same
     * defect was found the first time.
     *
     * Safe to call on every arrival: it only ever fills an EMPTY slot, so it
     * cannot displace a request the operator is looking at.
     */
    private fun restorePendingReceiveRequest() {
        viewModelScope.launch {
            // A FAILED RESTORE IS NOT "NOTHING PENDING". `.getOrNull()` made the
            // two indistinguishable, which is the precise stranding this function
            // exists to close: a live one-time key still on disk, an interface
            // offering to create another, and no way to cancel or reject the
            // request that is actually there. It is told now.
            val outcome = withContext(Dispatchers.IO) {
                runCatching { engine.sptRestorePendingReceiveRequest() }
            }
            val restored = outcome.getOrElse { failure ->
                // THE ENGINE'S OWN WORDS WHEN IT HAS THEM. `sptRestorePendingReceiveRequest`
                // now REFUSES rather than returning null when it cannot determine
                // whether a request is pending — a directory it could not list, or
                // a request whose state on disk could not be read. Those used to
                // come back as a successful null, which the interface rendered as
                // "Create a receive code" over a possibly-live one-time key.
                val text = (failure as? SptRefused)?.toUserFacing()?.detail
                    ?: "TruePad could not check whether a receive code is already waiting on " +
                        "this device (${failure.javaClass.simpleName})."
                _state.value = _state.value.copy(banner = Banner.Problem(text))
                return@launch
            } ?: return@launch
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
    /**
     * Whether the reviewed request is the one this pad was ALREADY sealed to.
     *
     * Advisory, and asked of the same comparison `sptSeal` is about to make. The
     * sealed-send screen used one set of words for both cases, so an operator
     * coming back for the file they had already committed was told "Sealing gives
     * this pad away" and "this pad can be given only once" about an act that
     * encapsulates nothing and creates no second copy.
     */
    fun sealIsReshare(pairId: String): Boolean {
        val hash = _state.value.spt.sendReview?.requestHashHex ?: return false
        return runCatching { engine.sptSealedToRequest(pairId, hash) }.getOrDefault(false)
    }

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
            _state.value = _state.value.movedTo(Tab.Pads, listOf(Screen.Home)).copy(
                currentPairId = null,
                current = null,
                banner = Banner.Removed,
            )
        }
    }

    /* ---- selection --------------------------------------------------------- */

    fun openPad(pairId: String) {
        // A PAD LIVES IN THE PADS TAB. `commitReceive` calls this from the Inbox,
        // and without moving the tab the Pad screen was drawn under Inbox — after
        // which the receive destination could not be reached again.
        // THE ANSWER IS ABOUT A PAD, SO IT DOES NOT SURVIVE A CHANGE OF PAD.
        //
        // `current`, `mayHandOff`, `mayReshareSealed` and `handOffRefusal` are
        // single global slots, and `refresh()` is asynchronous — it calls
        // `status()` for every pad on disk before it writes the corrected values.
        // Leaving them alone here meant Compose drew the NEW pad's screen with the
        // OLD pad's label, meters and eligibility, so a pad that had already been
        // handed over could show a live "Give this pad to someone" for as long as
        // the reload took. Cleared to their fail-closed defaults first; `refresh`
        // fills them in.
        _state.value = _state.value.movedTo(Tab.Pads, listOf(Screen.Home, Screen.Pad)).copy(
            currentPairId = pairId,
            current = null,
            role = null,
            roleWasDerived = false,
            mayHandOff = false,
            mayReshareSealed = false,
            mayResavePhysical = false,
            handOffRefusal = null,
            banner = null,
            lastResult = null,
            spt = SptUi(),
        )
        refresh()
    }

    // `setRole` USED TO LIVE HERE and is deliberately gone. See `refresh`: an
    // unknown origin refuses rather than delegating, on every edition.

    /** Edit the create form. See [UiState.create] for why it does not live in the
     *  composition. */
    fun updateCreate(edit: (CreateForm) -> CreateForm) {
        _state.value = _state.value.copy(create = edit(_state.value.create))
    }

    /** Start a new create form. Called when the operator LEAVES the finished
     *  ceremony, never on the way in — returning to a half-filled form is the
     *  behaviour this exists to preserve. */
    fun resetCreateForm() {
        _state.value = _state.value.copy(create = CreateForm())
    }
}

/**
 * The create screen's whole form.
 *
 * A plain data class of the operator's answers, and nothing else: no engine
 * state, nothing durable, nothing that outlives the process. It is here rather
 * than in the composition only so that switching tabs cannot silently undo the
 * operator's choice of randomness source. See [UiState.create].
 */
data class CreateForm(
    val label: String = "",
    val size: PadSize = PadSize.Medium,
    val external: Boolean = false,
    val declared: Boolean = false,
    val origin: String = "",
    val picked: List<PickedSource> = emptyList(),
    val fixedLength: Boolean = false,
    val fixedSize: String = "256",
)

/* ---- the UI's view of the world ------------------------------------------- */

enum class Screen {
    Home, CreatePad, AddPad, Pad, Send, Open, Details, Remove, About,
    // Sealed Pad Transfer — the same SPT protocol the Browser Edition speaks.
    ReceivePad, GivePad, SendSealed, ScanQr,
}

/**
 * THE THREE PERSISTENT DESTINATIONS, matching the iPhone edition.
 *
 * The labels are the iOS ones VERBATIM — "Pads", "Inbox", "About" — because the
 * two editions are meant to read as one product and iOS is the authority for what
 * these destinations mean.
 *
 * EACH TAB KEEPS ITS OWN BACK STACK. That is not a nicety: `back()` deliberately
 * drops the transient sealed-transfer session, because it may hold a decrypted
 * pad, and `navigate()` clears the banner. If switching tabs reused either, then
 * glancing at About in the middle of receiving a pad would silently destroy the
 * ceremony the operator was halfway through. Switching parks the current stack and
 * restores the other one, and touches nothing else.
 */
enum class Tab(val label: String, val root: Screen) {
    Pads("Pads", Screen.Home),
    Inbox("Inbox", Screen.ReceivePad),
    About("About", Screen.About),
}

data class PickedSource(val uri: Uri, val name: String, val declaredOrigin: String)

/**
 * Pad sizes in the units a person thinks in. The engine's real budgets are
 * E (encryption bytes) and N (authentication records); N is the number of
 * MESSAGES, because every message costs exactly one record whatever its length.
 *
 * THESE ARE CROSS-EDITION PRODUCT PRESETS. Small, Medium and Large must mean the
 * SAME capacities on Browser, Android and iOS. They did not: this edition shipped
 * Small 16 KB/128, Medium 64 KB/512 and Large 256 KB/2048 while the Browser and
 * iOS editions used the values below, so two people choosing "Medium" got
 * different pads depending on which app they happened to be holding. The values
 * here are now the canonical ones (`src/browser/ui/create-pair.ts`), and
 * `PadSizeParityTest` fails if this edition drifts from them again.
 *
 * They are CONVENIENCE DEFAULTS and nothing more. A preset writes E and N; the
 * four-slice partition, the required-source rule, serialization, fixed-record
 * behaviour and custom sizes are untouched, and pads that already exist keep the
 * capacities they were created with.
 */
enum class PadSize(
    val label: String,
    val blurb: String,
    val encryptionBytes: Long,
    val authRecords: Long,
) {
    Small("Small", "Occasional messages.", 16_384, 64),
    Medium("Medium", "Regular conversation.", 262_144, 512),
    Large("Large", "Messages and files.", 4_194_304, 4_096);

    /** DERIVED, never tabulated: L = 2 * (E + 32 * N). */
    fun requiredSourceLength(): Long = 2 * (encryptionBytes + 32 * authRecords)

    /**
     * Plain language, matching the other editions.
     *
     * "Up to N messages each way" rather than the previous "about N messages":
     * N is the number of one-time authentication records, which is a HARD
     * ceiling, not an estimate. The old text also printed the encryption budget
     * in KB, which at the canonical Large would have read "4096 KB".
     */
    fun describe(): String = "$blurb Up to $authRecords messages each way."
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
    /** Which persistent destination is showing. */
    val tab: Tab = Tab.Pads,
    /**
     * The back stacks of the tabs that are NOT showing. Parked, not discarded:
     * coming back to a tab must find it where it was left.
     */
    val parked: Map<Tab, List<Screen>> = emptyMap(),
    val pads: List<PairListEntry> = emptyList(),
    val currentPairId: String? = null,
    val current: PairSummary? = null,
    /**
     * Which half of the pair this device owns, DERIVED per pad from how it was
     * acquired — never a default. Null means the pad's origin is unknown and
     * TruePad REFUSES; there is no control that sets one, and a role the operator
     * picked would be a guess wearing a different name. See
     * [dev.systemslibrarian.truepad.storage.PartyRole].
     */
    val role: Party2? = null,
    /** True when the pad supplied the role. False means TruePad refuses, not that
     *  the operator is asked — there is no control that sets one. */
    val roleWasDerived: Boolean = false,
    /**
     * Whether the RAW pad may still leave this device. FAIL-CLOSED: false until
     * the engine has actually said otherwise, so a pad whose handoff state has
     * not been read yet — or could not be read — is never offered a fresh handoff.
     */
    val mayHandOff: Boolean = false,
    /** Whether the ALREADY-COMMITTED sealed package may be offered again. Distinct
     *  from [mayHandOff]; see [HandoffPolicy] for why collapsing the two stranded
     *  pads on the iOS edition. */
    val mayReshareSealed: Boolean = false,
    /** Whether the pad file of an ALREADY-COMPLETED physical handoff may be
     *  written again. Not a second handoff: the same pad, already given away, for
     *  a delivery that did not land. See the computation in `refresh`. */
    val mayResavePhysical: Boolean = false,
    /** Why a fresh handoff is refused, in the operator's terms. Null only when
     *  one is genuinely still available. */
    val handOffRefusal: String? = null,
    /**
     * THE CREATE FORM, held here rather than in the composition.
     *
     * Every field was a `remember { }` inside `CreatePadScreen`. The tab shell
     * parks BACK STACKS, not compositions, so leaving the Pads tab removed the
     * screen from the tree and discarded all of them — and coming back restored a
     * stack whose top still said `Screen.CreatePad`, so the operator returned to
     * what looked like the screen they left with every value silently at its
     * default. Including `external = false`.
     *
     * That is the one reset that is not merely annoying: an operator who had
     * chosen external material, picked their files and ticked the declaration
     * comes back to a form that will make a DEVICE-CSPRNG pad, with the Create
     * button live. Material must never be quietly substituted for what the
     * operator selected. The ViewModel outlives both the tab park and an activity
     * recreation, so it outlives the defect and the rotation route as well.
     */
    val create: CreateForm = CreateForm(),
    val banner: Banner? = null,
    val lastResult: OpResult? = null,
    val spt: SptUi = SptUi(),
) {
    val screen: Screen get() = backStack.last()

    /**
     * The direction this device SENDS on — NULL when the pad cannot say which half
     * is ours.
     *
     * These returned `B_TO_A` for a null role, because `if (role == Party2.A)`
     * treats "not A" and "we do not know" as the same answer. The pad screen then
     * printed that half's budget as a confident figure: an unknown-origin pad
     * whose B->A half was spent said "Messages you can still send: 0" about a pad
     * with four hundred sends left on the other half, and with the halves the
     * other way round it promised capacity that was not the operator's. The
     * Browser fixed exactly this by replacing `resolveRole(...) ?? "A"` with a
     * null-aware role; there is no honest number to show, so there is none.
     */
    val sendDirection: Direction?
        get() = when (role) {
            Party2.A -> Direction.A_TO_B
            Party2.B -> Direction.B_TO_A
            null -> null
        }

    /** The direction this device RECEIVES on. Null for the same reason. */
    val receiveDirection: Direction?
        get() = when (role) {
            Party2.A -> Direction.B_TO_A
            Party2.B -> Direction.A_TO_B
            null -> null
        }
}
