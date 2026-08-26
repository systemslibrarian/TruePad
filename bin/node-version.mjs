// Minimum Node for truepad-pad: type stripping on by default. Per the Node.js
// docs' history table that is v22.18.0 on the 22 line and v23.6.0 on the 23
// line; every later major has it (stable from v24.12.0). Tested here on
// v24.14.0. Plain JavaScript, no top-level await, so it parses on any Node
// that can load an ES module.
export const MIN_NODE = [22, 18, 0];
export const MIN_BY_MAJOR = { 22: [22, 18, 0], 23: [23, 6, 0] };

function parse(version) {
  return String(version)
    .replace(/^v/, "")
    .split(".")
    .map((part) => {
      const n = Number.parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    });
}

function below(parts, min) {
  for (let i = 0; i < min.length; i += 1) {
    const have = parts[i] ?? 0;
    if (have > min[i]) return false;
    if (have < min[i]) return true;
  }
  return false;
}

export function tooOld(version) {
  const parts = parse(version);
  const major = parts[0] ?? 0;
  if (major >= 24) return false;
  if (major < 22) return true;
  return below(parts, MIN_BY_MAJOR[major]);
}

// The gate proper: ask the runtime whether it strips types. Node >= 22.10
// exposes process.features.typescript ("strip" | "transform" | false); on
// older runtimes the property is absent and the version tuple decides.
// A `--no-experimental-strip-types` run therefore refuses too. Pass null
// as `features` to model a runtime without the flag.
/**
 * @param {{ typescript?: unknown } | null | undefined} features
 * @param {string} version
 * @returns {boolean}
 */
export function lacksTypeStripping(features = process.features, version = process.versions.node) {
  if (features && typeof features === "object" && "typescript" in features) {
    return !features.typescript;
  }
  return tooOld(version);
}

export function versionError(version) {
  return (
    `truepad-pad needs Node ${MIN_NODE.join(".")} or newer on the 22 line, 23.6.0 or newer on the 23 line, or ` +
    `any 24+ (it runs TypeScript under Node's built-in type stripping); this is Node ${version}. Nothing was run.`
  );
}
