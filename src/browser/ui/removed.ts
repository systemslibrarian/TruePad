/* ============================================================================
 * TruePad Browser Edition — pads removed from the product (presentation only)
 * ----------------------------------------------------------------------------
 * Two different things are called "removing a pad", and confusing them would be
 * a security bug:
 *
 *   1. The INTERNAL tombstone. A permanently disabled pad's destroyed.json is
 *      what makes the destruction durable and the pair permanently unusable.
 *      It is never deleted, never cleared, and nothing in this file can reach
 *      it. Every consuming verb still refuses `pair-destroyed`, and the old pad
 *      file is still refused on import — removed or not.
 *
 *   2. The USER-FACING record. Whether TruePad still shows you a dead pad is a
 *      product question, not a security one. Once you remove it you should
 *      never see it again: no list, no archive, no count, no name, no way in
 *      by URL. That preference lives here, in localStorage, next to the
 *      operator's role choice, and never in the frozen v2 store format.
 *
 * Removal is one-way by design. There is deliberately no unremove, no manage
 * screen and no undo: a user who asked TruePad to forget a pad should not find
 * it again later. The engine's memory is a separate thing, and it is permanent.
 *
 * The storage key keeps its original name so pads a user already put out of
 * sight stay out of sight across this change.
 * ========================================================================= */

const REMOVED_KEY = "truepad2:hidden-pads";

function readAll(): Set<string> {
  try {
    const raw = localStorage.getItem(REMOVED_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    /* storage unavailable or corrupt — nothing is removed */
    return new Set();
  }
}

function writeAll(ids: Set<string>): void {
  try {
    localStorage.setItem(REMOVED_KEY, JSON.stringify([...ids]));
  } catch {
    /* best-effort display preference only */
  }
}

export function isRemoved(pairId: string): boolean {
  return readAll().has(pairId);
}

export function removePair(pairId: string): void {
  const ids = readAll();
  ids.add(pairId);
  writeAll(ids);
}
