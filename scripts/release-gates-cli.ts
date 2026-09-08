/* The thin I/O shell around scripts/release-gates.ts. All the deciding lives in
 * that module, which is pure and directly tested; this only reads the JSON the
 * shell script captured and prints the verdict. */
import { readFileSync } from "node:fs";
import { evaluateGates, formatVerdict, type WorkflowRun } from "./release-gates.ts";

const [, , sha, runsPath] = process.argv;
if (!sha || !runsPath) {
  console.error("usage: release-gates-cli.ts <sha> <runs.json>");
  process.exit(2);
}

const runs = JSON.parse(readFileSync(runsPath, "utf8")) as WorkflowRun[];
const verdict = evaluateGates(runs);
console.log(formatVerdict(sha, verdict));
process.exit(verdict.ok ? 0 : 1);
