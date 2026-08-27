#!/usr/bin/env node
// truepad2 launcher. Plain JavaScript on purpose: the CLI is TypeScript run
// under Node's built-in type stripping, and an older Node would reject it
// with a syntax error or "Unknown file extension .ts" before any of our
// code ran. This file parses everywhere an ES module parses (no top-level
// await), checks the runtime, and only then imports the real entry point.
import { lacksTypeStripping, versionError } from "./node-version.mjs";

if (lacksTypeStripping()) {
  process.stderr.write(`${versionError(process.versions.node)}\n`);
  process.exit(1);
}

import("../src/cli/v2/truepad2.ts")
  .then(({ main }) => {
    process.exitCode = main(process.argv.slice(2));
  })
  .catch((error) => {
    process.stderr.write(`truepad2 failed to start: ${error && error.message ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
