/* ============================================================================
 * TruePad 2 Browser Edition — UI context & typed engine surface
 * ----------------------------------------------------------------------------
 * The `Engine` interface is the UI's typed view of the worker RPC: one method
 * per protocol op, each returning the matching ok-response OR a structured
 * refusal / error (never a thrown string). Method argument types are DERIVED
 * from `EngineRequest` so they cannot drift from the frozen protocol. main.ts
 * implements this over the id-keyed Worker client; screens depend only on the
 * interface, so they never touch the worker, transferables, or ids directly.
 * ========================================================================= */

import type { EngineRequest, EngineOk, EngineRefusal, EngineError } from "../engine/protocol.ts";

// The reply to op `Op`: its ok-response, or a typed refusal / error.
export type Reply<Op extends EngineRequest["op"]> = Extract<EngineOk, { op: Op }> | EngineRefusal | EngineError;

// The request payload for op `Op`, minus the transport-managed `id`/`op`.
type Args<Op extends EngineRequest["op"]> = Omit<Extract<EngineRequest, { op: Op }>, "id" | "op">;

export interface Engine {
  listPairs(): Promise<Reply<"list-pairs">>;
  status(args: Args<"status">): Promise<Reply<"status">>;
  gen(args: Args<"gen">): Promise<Reply<"gen">>;
  burn(args: Args<"burn">): Promise<Reply<"burn">>;
  open(args: Args<"open">): Promise<Reply<"open">>;
  retire(args: Args<"retire">): Promise<Reply<"retire">>;
  clearFreeze(args: Args<"clear-freeze">): Promise<Reply<"clear-freeze">>;
  destroy(args: Args<"destroy">): Promise<Reply<"destroy">>;
  exportPair(args: Args<"export-pair">): Promise<Reply<"export-pair">>;
  importPair(args: Args<"import-pair">): Promise<Reply<"import-pair">>;
  /* ---- Sealed Pad Transfer ------------------------------------------------
   * Argument types derive from `EngineRequest` like every other method, so the
   * two RPCs that deliberately carry ONLY an opaque handle cannot grow one:
   * `sptConfirmRequest` takes a reviewId and `sptCommitReceive` a sessionId,
   * because that is what the protocol type says, and there is no hand-written
   * interface here that could quietly say otherwise.
   * --------------------------------------------------------------------- */
  sptCreateRequest(): Promise<Reply<"spt-create-request">>;
  sptCancelRequest(args: Args<"spt-cancel-request">): Promise<Reply<"spt-cancel-request">>;
  sptInspectRequest(args: Args<"spt-inspect-request">): Promise<Reply<"spt-inspect-request">>;
  sptConfirmRequest(args: Args<"spt-confirm-request">): Promise<Reply<"spt-confirm-request">>;
  sptSeal(args: Args<"spt-seal">): Promise<Reply<"spt-seal">>;
  sptOpenSealed(args: Args<"spt-open-sealed">): Promise<Reply<"spt-open-sealed">>;
  sptCommitReceive(args: Args<"spt-commit-receive">): Promise<Reply<"spt-commit-receive">>;
  sptReject(args: Args<"spt-reject">): Promise<Reply<"spt-reject">>;
  sptAbandon(args: Args<"spt-abandon">): Promise<Reply<"spt-abandon">>;
}

/** The live receive session, carried in route state rather than the URL.
 *  A sessionId in a hash would land in history, in a shared link, and in the
 *  referrer of anything the page loads. The URL names the SCREEN; the ceremony
 *  handles stay in memory. */
export type ReceiveSessionState = { sessionId: string; requestId: string; confirmationIndices: number[] };

export type Route =
  | { name: "home" }
  | { name: "create" }
  | { name: "import" }
  | { name: "import-file" }
  | { name: "receive-online" }
  | { name: "receive-confirm"; session: ReceiveSessionState }
  | { name: "send-online"; pairId: string }
  | { name: "pair"; pairId: string }
  | { name: "send"; pairId: string; mode: "message" | "file" }
  | { name: "open"; pairId: string; mode: "message" | "file" }
  | { name: "destroy"; pairId: string }
  | { name: "security" };

export type ToastTone = "ok" | "danger" | "info";

export interface Ctx {
  engine: Engine;
  navigate(route: Route): void;
  toast(message: string, tone?: ToastTone): void;
  // navigator.storage.persisted() at boot: true (durable), false (best-effort
  // / possibly ephemeral), or null (the query is unavailable here).
  storagePersistent: boolean | null;
  requestPersistent(): Promise<boolean>;
  /** Run `cleanup` when the CURRENT screen is left, by any route change —
   *  in-app navigation, a hash change, or the browser's own back button.
   *
   *  A receive session holds a cross-tab Web Lock in the worker ACROSS RPCs.
   *  Worker death releases it, but ordinary single-page navigation does not
   *  kill the worker, so leaving the confirmation screen without this would
   *  strand the lock and block every other tab from opening that transfer. */
  onLeave(cleanup: () => void): void;
}
