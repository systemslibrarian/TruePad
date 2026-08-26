#!/usr/bin/env node
// truepad-pad launcher. Plain JavaScript on purpose: the CLI is TypeScript
// run under Node's built-in type stripping, and an older Node would reject
// it with a syntax error or "Unknown file extension .ts" before any of our
// code ran. This file parses everywhere an ES module parses (no top-level
// await), checks the runtime, and only then imports the real entry point.
import { tooOld, versionError } from "./node-version.mjs";

if (tooOld(process.versions.node)) {
  process.stderr.write(`${versionError(process.versions.node)}\n`);
  process.exit(1);
}

import("../src/cli/truepad-pad.ts")
  .then(({ main }) => {
    process.exitCode = main(process.argv.slice(2));
  })
  .catch((error) => {
    process.stderr.write(`truepad-pad failed to start: ${error && error.message ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
