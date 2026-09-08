import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateGates,
  formatVerdict,
  stateOf,
  OPTIONAL_WORKFLOWS,
  REQUIRED_WORKFLOWS,
  type WorkflowRun,
} from "../scripts/release-gates.ts";

/* ============================================================================
 * ABSENT IS NOT GREEN
 * ----------------------------------------------------------------------------
 * Twice during the 3.0.0 release a required workflow did not run at all for a
 * candidate commit — `ios.yml` and `android.yml` are path-filtered, so a
 * docs-only commit triggers neither — and a checks list shows that exactly the
 * way it shows success: nothing red. Both were dispatched by hand, which worked
 * because somebody remembered. A separate required run was CANCELLED mid-flight
 * by a concurrent push to the same ref.
 *
 * So this file drives every not-green state through the decision procedure. The
 * classification is pure and takes runs as data, so none of this needs a network
 * or a repository — which is the point: the gate can be tested, and it is.
 * ========================================================================= */

const REQUIRED = REQUIRED_WORKFLOWS.map((w) => w.name);
const IOS = "iOS";
const ANDROID = "Android";
const BROWSER = "Deploy demo to GitHub Pages";

function run(
  workflowName: string,
  conclusion: string | null,
  status = "completed",
  createdAt = "2026-09-07T10:00:00Z",
): WorkflowRun {
  return { workflowName, status, conclusion, createdAt };
}

/** Every required workflow passing, which every case below then perturbs. */
function allGreen(): WorkflowRun[] {
  return REQUIRED.map((n) => run(n, "success"));
}

describe("the manifest is real and matches the canonical checklist's shape", () => {
  it("names the three required workflows, each with a justification", () => {
    // POSITIVE CONTROL. An empty required set would make every assertion below
    // pass by having nothing to block on.
    expect(REQUIRED_WORKFLOWS.length).toBe(3);
    expect(REQUIRED).toEqual(expect.arrayContaining([IOS, ANDROID, BROWSER]));
    for (const w of REQUIRED_WORKFLOWS) {
      expect(w.because.length, `${w.name} must say WHY it blocks`).toBeGreaterThan(40);
    }
    for (const w of OPTIONAL_WORKFLOWS) {
      expect(w.because.length, `${w.name} must say why it does NOT block`).toBeGreaterThan(20);
    }
  });

  it("does not make emulator TPM evidence a release gate", () => {
    // The checklist records physical TPM 2.0 as NOT VALIDATED and NON-BLOCKING.
    // Promoting the swtpm workflow to required would quietly contradict that.
    expect(REQUIRED).not.toContain("TPM emulator interoperability");
    expect(OPTIONAL_WORKFLOWS.map((w) => w.name)).toContain("TPM emulator interoperability");
  });
});

describe("only PASS is green", () => {
  it("passes when every required workflow passed", () => {
    const v = evaluateGates(allGreen());
    expect(v.ok).toBe(true);
    expect(v.blocking).toEqual([]);
  });

  for (const missing of [IOS, ANDROID, BROWSER]) {
    it(`BLOCKS when the required "${missing}" check is ABSENT`, () => {
      const v = evaluateGates(allGreen().filter((r) => r.workflowName !== missing));
      expect(v.ok, `${missing} absent must block`).toBe(false);
      expect(v.blocking.map((b) => b.name)).toEqual([missing]);
      expect(v.blocking[0].state).toBe("ABSENT");
      // And it must SAY that absence is not evidence, not just fail quietly.
      expect(v.blocking[0].note).toMatch(/did not run|absence/i);
    });
  }

  for (const [conclusion, state] of [
    ["failure", "FAIL"],
    ["cancelled", "CANCELLED"],
    ["skipped", "SKIPPED"],
    ["timed_out", "FAIL"],
    ["action_required", "FAIL"],
    [null, "PENDING"],
  ] as const) {
    it(`BLOCKS when a required check is ${state}`, () => {
      const runs = allGreen().filter((r) => r.workflowName !== IOS);
      runs.push(
        conclusion === null
          ? run(IOS, null, "in_progress")
          : run(IOS, conclusion),
      );
      const v = evaluateGates(runs);
      expect(v.ok).toBe(false);
      expect(v.blocking.map((b) => b.name)).toEqual([IOS]);
      expect(v.blocking[0].state).toBe(state);
    });
  }

  it("BLOCKS on a queued run, which has no conclusion at all", () => {
    const runs = allGreen().filter((r) => r.workflowName !== ANDROID);
    runs.push(run(ANDROID, null, "queued"));
    const v = evaluateGates(runs);
    expect(v.ok).toBe(false);
    expect(v.blocking[0].state).toBe("PENDING");
  });
});

describe("optional workflows never decide a release", () => {
  it("does not block when an optional workflow is absent", () => {
    // Exactly the shape of the real released SHA: Dependabot never ran.
    const v = evaluateGates(allGreen());
    expect(v.ok).toBe(true);
    const dependabot = v.rows.find((r) => r.name === "Dependabot Updates");
    expect(dependabot?.state).toBe("ABSENT");
    expect(dependabot?.required).toBe(false);
  });

  it("does not block when an optional workflow is cancelled or failed", () => {
    for (const conclusion of ["cancelled", "failure", "skipped"]) {
      const runs = [...allGreen(), run("CodeQL", conclusion)];
      const v = evaluateGates(runs);
      expect(v.ok, `optional CodeQL ${conclusion} must not block`).toBe(true);
      expect(v.blocking).toEqual([]);
    }
  });

  it("reports optional state rather than hiding it", () => {
    const v = evaluateGates([...allGreen(), run("CodeQL", "failure")]);
    expect(v.rows.find((r) => r.name === "CodeQL")?.state).toBe("FAIL");
  });
});

describe("an older green run cannot mask the current one", () => {
  it("BLOCKS when the newest run for a required workflow failed", () => {
    const runs = allGreen().filter((r) => r.workflowName !== IOS);
    runs.push(run(IOS, "success", "completed", "2026-09-07T10:00:00Z"));
    runs.push(run(IOS, "failure", "completed", "2026-09-07T12:00:00Z")); // newer
    const v = evaluateGates(runs);
    expect(v.ok, "a later failure must win over an earlier success").toBe(false);
    expect(v.blocking[0].state).toBe("FAIL");
  });

  it("PASSES when the newest run succeeded after an earlier failure", () => {
    // The legitimate re-run case: a red run, then a green one on the same SHA.
    const runs = allGreen().filter((r) => r.workflowName !== IOS);
    runs.push(run(IOS, "failure", "completed", "2026-09-07T10:00:00Z"));
    runs.push(run(IOS, "success", "completed", "2026-09-07T12:00:00Z")); // newer
    const v = evaluateGates(runs);
    expect(v.ok).toBe(true);
  });

  it("BLOCKS when the newest run is still pending behind an older success", () => {
    const runs = allGreen().filter((r) => r.workflowName !== ANDROID);
    runs.push(run(ANDROID, "success", "completed", "2026-09-07T10:00:00Z"));
    runs.push(run(ANDROID, null, "in_progress", "2026-09-07T12:00:00Z"));
    const v = evaluateGates(runs);
    expect(v.ok).toBe(false);
    expect(v.blocking[0].state).toBe("PENDING");
  });
});

describe("the verdict names every check it used", () => {
  it("prints each required and optional workflow with its state", () => {
    const text = formatVerdict("deadbeef", evaluateGates(allGreen()));
    for (const name of [...REQUIRED, ...OPTIONAL_WORKFLOWS.map((w) => w.name)]) {
      expect(text, `${name} must appear in the report`).toContain(name);
    }
    expect(text).toContain("[required]");
    expect(text).toContain("[optional]");
  });

  it("names the blocking check when it fails", () => {
    const v = evaluateGates(allGreen().filter((r) => r.workflowName !== IOS));
    const text = formatVerdict("deadbeef", v);
    expect(text).toMatch(/BLOCKED: iOS/);
    expect(text).toMatch(/^FAIL --/m);
  });
});

describe("stateOf is total", () => {
  it("maps every shape a run can take", () => {
    expect(stateOf(undefined)).toBe("ABSENT");
    expect(stateOf(run("x", null, "queued"))).toBe("PENDING");
    expect(stateOf(run("x", null, "in_progress"))).toBe("PENDING");
    expect(stateOf(run("x", "success"))).toBe("PASS");
    expect(stateOf(run("x", "cancelled"))).toBe("CANCELLED");
    expect(stateOf(run("x", "skipped"))).toBe("SKIPPED");
    expect(stateOf(run("x", "failure"))).toBe("FAIL");
    expect(stateOf(run("x", "neutral"))).toBe("FAIL");
  });
});

/* ============================================================================
 * THE WORKFLOWS THEMSELVES MUST NOT BE ABLE TO GO ABSENT
 * ----------------------------------------------------------------------------
 * The verifier above fails closed when a required check is missing. That is the
 * detector. This is the cause: a required workflow that path-filters itself out
 * of a candidate commit, or that declares no `tags:` and so never runs on the
 * release ref at all. Both were true during 3.0.0 — pushing the v3.0.0 tag ran
 * exactly one of the five workflows.
 * ========================================================================= */

const WF_DIR = resolve(__dirname, "../.github/workflows");

/** The `push:` section of a workflow's `on:` block, as text. */
function pushTrigger(file: string): string {
  const text = readFileSync(join(WF_DIR, file), "utf8");
  const on = text.slice(text.indexOf("\non:"), text.indexOf("\npermissions:"));
  const start = on.indexOf("\n  push:");
  expect(start, `${file} has no push trigger`).toBeGreaterThanOrEqual(0);
  const rest = on.slice(start + 1);
  // Up to the next key at two-space indent (pull_request:, workflow_dispatch:, ...).
  const end = rest.search(/\n  [a-z_]+:/);
  return end === -1 ? rest : rest.slice(0, end);
}

/** workflow file -> its declared `name:`. */
function workflowNames(): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of readdirSync(WF_DIR)) {
    if (!f.endsWith(".yml") && !f.endsWith(".yaml")) continue;
    const m = readFileSync(join(WF_DIR, f), "utf8").match(/^name:\s*(.+)$/m);
    if (m) out.set(f, m[1].trim());
  }
  return out;
}

describe("every required workflow actually exists and cannot be absent", () => {
  it("finds the workflow directory it polices", () => {
    // POSITIVE CONTROL: an empty read would make the rest vacuous.
    const names = workflowNames();
    expect(names.size, "workflow files").toBeGreaterThanOrEqual(5);
  });

  it("maps every manifest entry to a real workflow file", () => {
    const declared = [...workflowNames().values()];
    for (const w of [...REQUIRED_WORKFLOWS, ...OPTIONAL_WORKFLOWS]) {
      // Dependabot is a policy file, not a workflow, and produces a check run
      // GitHub names itself. It is optional, so it can never block.
      if (w.name === "Dependabot Updates") continue;
      expect(declared, `the manifest names "${w.name}", which no workflow declares`)
        .toContain(w.name);
    }
  });

  it("gives every REQUIRED workflow a push trigger with no path filter", () => {
    const byName = new Map([...workflowNames()].map(([f, n]) => [n, f]));
    for (const w of REQUIRED_WORKFLOWS) {
      if (w.name === "Dependabot Updates") continue;
      const file = byName.get(w.name);
      expect(file, `no workflow file declares "${w.name}"`).toBeDefined();
      const push = pushTrigger(file!);
      // THE DEFECT THIS EXISTS FOR. A `paths:` filter here means a candidate
      // commit outside those paths produces no run, and no run reads as green.
      expect(push, `${file} path-filters its push trigger — a required workflow `
        + `must not be able to skip a candidate commit`).not.toMatch(/^\s+paths:/m);
      expect(push, `${file} must run on master`).toMatch(/branches:\s*\[master\]/);
      // ...and on the release ref itself, which is what a tag push is.
      expect(push, `${file} does not run on a v* tag, so the release ref would be `
        + `the least-covered ref in the repository`).toMatch(/tags:\s*\['v\*'\]/);
    }
  });

  it("still allows pull requests to be path-filtered, where absence costs nothing", () => {
    // Not a laxity: a missing PR run cannot be mistaken for a release gate,
    // and running the emulator suite on every unrelated PR is pure waste.
    const ios = readFileSync(join(WF_DIR, "ios.yml"), "utf8");
    const android = readFileSync(join(WF_DIR, "android.yml"), "utf8");
    expect(ios).toMatch(/pull_request:\s*\n\s+paths:/);
    expect(android).toMatch(/pull_request:\s*\n\s+paths:/);
  });
});
