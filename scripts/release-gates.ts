/* The release gate, as a decision procedure rather than a glance at a checks list.
 * ----------------------------------------------------------------------------
 * WHY THIS EXISTS. Twice during the 3.0.0 release a required workflow was simply
 * ABSENT for a candidate commit — `ios.yml` and `android.yml` are path-filtered,
 * so a docs-only commit triggers neither — and an absent run looks exactly like a
 * passing one in a checks list: no red, nothing to click. The reasoning "the
 * workflow did not run, so nothing it covers can have changed" is fail-OPEN
 * unless something proves it, and nothing did. Both were dispatched by hand for
 * the released SHA, which worked only because somebody remembered.
 *
 * So: ABSENT is not green. Neither is CANCELLED (one required run was cancelled
 * by a concurrent push during this very release), nor PENDING, nor SKIPPED.
 * ONLY PASS IS GREEN.
 *
 * The classification is pure and takes its input as data, so every branch is
 * testable without a network — see tests/release-gates.test.ts, which drives the
 * absent/cancelled/pending/failed/duplicate cases directly. */

/** What GitHub reports for one workflow run against one commit. */
export interface WorkflowRun {
  readonly workflowName: string;
  /** "queued" | "in_progress" | "completed" | ... */
  readonly status: string;
  /** "success" | "failure" | "cancelled" | "skipped" | null while running */
  readonly conclusion: string | null;
  /** ISO 8601. Used only to pick the CURRENT run when a workflow has several. */
  readonly createdAt: string;
}

export type GateState = "PASS" | "FAIL" | "PENDING" | "CANCELLED" | "SKIPPED" | "ABSENT";

export interface GateRow {
  readonly name: string;
  readonly required: boolean;
  readonly state: GateState;
  /** Why this row does or does not block. */
  readonly note: string;
}

export interface GateVerdict {
  readonly ok: boolean;
  readonly rows: readonly GateRow[];
  readonly blocking: readonly GateRow[];
}

/* ---------------------------------------------------------------------------
 * THE MANIFEST. Derived from docs/RELEASE-CHECKLIST-3.0.md Section A, which is
 * the canonical authority on what blocks a release. A workflow is REQUIRED only
 * where the checklist names a gate it runs; everything else is reported and does
 * not block. Being listed here is a deliberate edit, not an inference from
 * whatever happened to run.
 * ------------------------------------------------------------------------- */

/** Workflows that must PASS for the exact SHA before a release may be tagged. */
export const REQUIRED_WORKFLOWS: readonly { name: string; because: string }[] = [
  {
    name: "Deploy demo to GitHub Pages",
    because:
      "its build job runs the Browser/CLI gates the checklist marks blocking: " +
      "npm run typecheck, npm test (unit + claims + falsification guards), " +
      "npm run build, and npm run test:e2e.",
  },
  {
    name: "Android",
    because:
      "the checklist's mobile paragraph makes these blocking: ./gradlew check " +
      "(JVM + lint + verifyReleaseManifest), connectedDebugAndroidTest, and " +
      "assembleRelease, plus the frozen-vector checks.",
  },
  {
    name: "iOS",
    because:
      "the checklist's mobile paragraph makes these blocking: swift test, the " +
      "generic Debug and Release builds, check-app-project.sh, " +
      "inspect-release-binary.sh, check-notices.sh, check-release-isolation.sh, " +
      "gen-sbom.sh --check, vendor/verify-vendor.sh and the ASan/TSan runs.",
  },
];

/** Reported for information. Absence or failure here does NOT block a release. */
export const OPTIONAL_WORKFLOWS: readonly { name: string; because: string }[] = [
  {
    name: "CodeQL",
    because:
      "standing background scanning; Section A does not list it as a release " +
      "gate, and it must not become one by accident.",
  },
  {
    name: "TPM emulator interoperability",
    because:
      "swtpm is EMULATOR interoperability evidence. The checklist records " +
      "physical TPM 2.0 as NOT VALIDATED and NON-BLOCKING, so this cannot be a " +
      "release gate without promoting emulator evidence past what it is.",
  },
  {
    name: "Dependabot Updates",
    because: "dependency-update automation, not a gate on any given commit.",
  },
];

/**
 * The CURRENT run for a workflow: the most recently created one.
 *
 * WHY LATEST AND NOT "any success". A workflow can have several runs against one
 * SHA — a push run, a dispatch, a re-run. Accepting "some run succeeded" lets an
 * older green run mask a newer red one, which is the same fail-open shape as
 * treating absence as success.
 */
function currentRun(runs: readonly WorkflowRun[], name: string): WorkflowRun | undefined {
  const mine = runs.filter((r) => r.workflowName === name);
  if (mine.length === 0) return undefined;
  return mine.reduce((newest, r) => (r.createdAt > newest.createdAt ? r : newest));
}

/** Map one run to a state. No run at all is ABSENT, which is not green. */
export function stateOf(run: WorkflowRun | undefined): GateState {
  if (!run) return "ABSENT";
  if (run.status !== "completed") return "PENDING";
  switch (run.conclusion) {
    case "success":
      return "PASS";
    case "cancelled":
      return "CANCELLED";
    case "skipped":
      return "SKIPPED";
    default:
      return "FAIL";
  }
}

/**
 * The verdict for one commit. `ok` is true only when EVERY required workflow is
 * PASS — not "not failing", not "nothing red".
 */
export function evaluateGates(
  runs: readonly WorkflowRun[],
  required: readonly { name: string; because: string }[] = REQUIRED_WORKFLOWS,
  optional: readonly { name: string; because: string }[] = OPTIONAL_WORKFLOWS,
): GateVerdict {
  const rows: GateRow[] = [];

  for (const w of required) {
    const state = stateOf(currentRun(runs, w.name));
    rows.push({
      name: w.name,
      required: true,
      state,
      note:
        state === "PASS"
          ? "required, passed"
          : state === "ABSENT"
            ? "REQUIRED BUT DID NOT RUN — absence is not evidence of safety"
            : `REQUIRED and ${state}`,
    });
  }

  for (const w of optional) {
    const state = stateOf(currentRun(runs, w.name));
    rows.push({ name: w.name, required: false, state, note: "informational; never blocking" });
  }

  const blocking = rows.filter((r) => r.required && r.state !== "PASS");
  return { ok: blocking.length === 0, rows, blocking };
}

/** Human-readable, and it names every check it used. */
export function formatVerdict(sha: string, v: GateVerdict): string {
  const lines: string[] = [`release gates for ${sha}`, ""];
  for (const r of v.rows) {
    lines.push(`  ${r.state.padEnd(9)} ${r.required ? "[required]" : "[optional]"} ${r.name}`);
  }
  lines.push("");
  if (v.ok) {
    lines.push(`PASS -- all ${v.rows.filter((r) => r.required).length} required checks passed for this exact SHA.`);
  } else {
    for (const r of v.blocking) lines.push(`  BLOCKED: ${r.name} -- ${r.note}`);
    lines.push(`FAIL -- ${v.blocking.length} required check(s) not passing for this exact SHA.`);
  }
  return lines.join("\n");
}
