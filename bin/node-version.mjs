// Minimum Node for truepad-pad: type stripping on by default (v22.18.0 and
// v23.6.0 per the Node.js docs; stable from v24.12.0). Tested here on
// v24.14.0. Plain JavaScript so it parses on any Node that can run ESM.
export const MIN_NODE = [22, 18, 0];

export function tooOld(version, min = MIN_NODE) {
  const parts = String(version).replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < min.length; i += 1) {
    const have = Number.isFinite(parts[i]) ? parts[i] : 0;
    if (have > min[i]) return false;
    if (have < min[i]) return true;
  }
  return false;
}

export function versionError(version, min = MIN_NODE) {
  return (
    `truepad-pad needs Node ${min.join(".")} or newer (it runs TypeScript under Node's built-in type ` +
    `stripping); this is Node ${version}. Nothing was run.`
  );
}
