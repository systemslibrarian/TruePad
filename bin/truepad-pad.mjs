#!/usr/bin/env node
// truepad-pad launcher. Plain JavaScript on purpose: the CLI is TypeScript
// run under Node's built-in type stripping, and an older Node would reject
// it with a syntax error or "Unknown file extension .ts" before any of our
// code ran. This file parses everywhere, checks the runtime, and only then
// imports the real entry point.
import { tooOld, versionError } from "./node-version.mjs";

if (tooOld(process.versions.node)) {
  process.stderr.write(`${versionError(process.versions.node)}\n`);
  process.exit(1);
}

const { main } = await import("../src/cli/truepad-pad.ts");
process.exitCode = main(process.argv.slice(2));
