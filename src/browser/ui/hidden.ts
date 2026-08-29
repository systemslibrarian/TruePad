/* ============================================================================
 * TruePad Browser Edition — hidden disabled pads (presentation only)
 * ----------------------------------------------------------------------------
 * A permanently disabled pad is dead, but its entry still sits in the browser
 * store forever: the destroyed.json tombstone is what makes the destruction
 * durable, and it is never removed. That is a security property. Whether the
 * dead entry is worth showing on the home screen is NOT — it is a display
 * preference, so it lives here, in localStorage, next to the operator's role
 * choice, and never in the frozen v2 store format.
 *
 * Hiding removes a disabled pad from the home screen. It does not delete the
 * tombstone, does not touch the store, and cannot make the pair usable or
 * importable again: every consuming verb still refuses `pair-destroyed`, and
 * an import of the old pad file is still refused, hidden or not.
 * ========================================================================= */

const HIDDEN_KEY = "truepad2:hidden-pads";

function readAll(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    /* storage unavailable or corrupt — nothing is hidden */
    return new Set();
  }
}

function writeAll(ids: Set<string>): void {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...ids]));
  } catch {
    /* best-effort display preference only */
  }
}

export function isHidden(pairId: string): boolean {
  return readAll().has(pairId);
}

export function hidePair(pairId: string): void {
  const ids = readAll();
  ids.add(pairId);
  writeAll(ids);
}

export function unhidePair(pairId: string): void {
  const ids = readAll();
  if (ids.delete(pairId)) writeAll(ids);
}
