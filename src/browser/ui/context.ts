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
}

export type Route =
  | { name: "home" }
  | { name: "create" }
  | { name: "pair"; pairId: string }
  | { name: "send"; pairId: string }
  | { name: "open"; pairId: string }
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
}
