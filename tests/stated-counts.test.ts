import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/* ============================================================================
 * Numbers the project states about itself
 * ----------------------------------------------------------------------------
 * Test counts are the most drift-prone claim in the repository. They are written
 * into prose by hand, they are correct on the day, and nothing notices when the
 * suite moves underneath them. Two failures of exactly that kind are what this
 * file exists to prevent, and both had actually happened:
 *
 *   1. `verify-instrumentation.sh` expected six classes and a floor of 44 while
 *      the suite was eight classes and 51. The floor was the sum of the six —
 *      correct when written — so the two classes added afterwards could have
 *      stopped running ENTIRELY and the check would still have reported success.
 *
 *   2. Four documents described the same Samsung physical run with three
 *      different pairs of numbers, one of which quoted TODAY'S suite size as the
 *      size of a run made before two of its classes existed.
 *
 * WHY THIS GUARDS THE TABLE RATHER THAN REPLACING IT. The verifier's expected
 * counts stay hand-maintained, because a table derived from the suite could never
 * notice the suite shrinking — it would rewrite its own expectation to match the
 * loss, which is the vacuity the verifier exists to avoid. So the division is:
 * the VERIFIER checks the table against what RAN, and this file checks the table
 * against what EXISTS. Deleting a class then still requires deleting its row by
 * hand, in a diff a reviewer can see; it can no longer happen by accident.
 * ========================================================================= */

const ROOT = resolve(__dirname, "..");
const ANDROID_TEST_DIR = join(ROOT, "android/app/src/androidTest/kotlin/dev/systemslibrarian/truepad/app");
const VERIFIER = readFileSync(join(ROOT, "android/tools/verify-instrumentation.sh"), "utf8");
const IOS_TEST_DIR = join(ROOT, "ios/TruePadKit/Tests");

/** Swift line and block comments removed, so a `func test` being DISCUSSED is not counted. */
function swiftCode(swift: string): string {
  return swift.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** Every XCTest case that exists in the iOS package's test tree. */
function iosTestsInTree(): number {
  let total = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".swift")) {
        total += (swiftCode(readFileSync(full, "utf8")).match(/^\s*func test[A-Za-z0-9_]*\(/gm) ?? []).length;
      }
    }
  };
  walk(IOS_TEST_DIR);
  return total;
}

/** Kotlin line and block comments removed, so an `@Test` being DISCUSSED is not counted. */
function code(kotlin: string): string {
  return kotlin.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/**
 * The name of the annotation the runner is told to EXCLUDE, read from the build
 * rather than repeated here. A class every one of whose tests carries it does not
 * run in the ordinary suite, so demanding an entry for it in the verifier would
 * demand that CI expect a run that cannot happen.
 */
function excludedAnnotation(): string {
  const gradle = readFileSync(join(ROOT, "android/app/build.gradle.kts"), "utf8");
  const m = gradle.match(/notAnnotation"\]\s*=\s*\n?\s*"([\w.]+)"/);
  if (!m) throw new Error("the runner's notAnnotation argument is no longer where this guard looks");
  return m[1].split(".").pop()!;
}

/**
 * The instrumentation suite as it exists in the tree, per class — meaning the
 * classes the DEFAULT run will actually execute.
 *
 * TWO KINDS OF FILE ARE NOT PART OF THAT and are skipped, because counting them
 * would make this guard demand entries in `verify-instrumentation.sh` for classes
 * the verifier can never see:
 *
 *   · a file that declares no `@Test` at all — `CrossEditionStep.kt` is an
 *     annotation declaration, not a test class;
 *   · a class every one of whose tests carries the excluded annotation —
 *     `CrossEditionTest` is the two-device exchange, which takes runner arguments
 *     and is invoked by name from the physical harness, never by the suite.
 *
 * A class that merely SOME of whose tests are excluded is still counted in full,
 * deliberately: that is a class the suite does run, and losing it should be loud.
 */
/** Every .kt under a directory, RECURSIVELY. */
function kotlinFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".kt")) out.push(full);
    }
  };
  walk(dir);
  return out;
}

function suiteInTree(): Map<string, number> {
  const excluded = excludedAnnotation();
  const counts = new Map<string, number>();
  // RECURSIVE, like the iOS walk below it. `verify-instrumentation.sh` delegates
  // its "was the table gutted?" check here, and a flat readdir meant an
  // instrumentation class in a subpackage was invisible to BOTH halves: never
  // demanded in EXPECTED, and so never required to run.
  for (const file of kotlinFilesUnder(ANDROID_TEST_DIR)) {
    const body = code(readFileSync(file, "utf8"));
    const tests = (body.match(/^\s*@Test\b/gm) ?? []).length;
    if (tests === 0) continue;
    const skipped = (body.match(new RegExp(`^\\s*@${excluded}\\b`, "gm")) ?? []).length;
    if (skipped >= tests) continue;
    counts.set(file.split("/").pop()!.replace(/\.kt$/, ""), tests);
  }
  return counts;
}

/** The hand-maintained expectation inside the verifier. */
function expectedTable(): Map<string, number> {
  const block = VERIFIER.match(/EXPECTED="\\\n([\s\S]*?)"/);
  if (!block) throw new Error("the EXPECTED table is no longer where this guard looks for it");
  const table = new Map<string, number>();
  for (const line of block[1].split("\n").filter((l) => l.trim())) {
    const [name, n] = line.trim().split("=");
    table.set(name, Number(n));
  }
  return table;
}

describe("the instrumentation verifier's expectation matches the suite that exists", () => {
  it("finds a real suite to compare against", () => {
    // POSITIVE CONTROL. Every assertion below is vacuous if the tree walk or the
    // comment stripper silently returned nothing, and a guard that passes by
    // finding nothing is worse than no guard.
    const tree = suiteInTree();
    expect(tree.size).toBeGreaterThanOrEqual(8);
    expect(tree.get("UiJourneyTest")).toBeGreaterThan(0);
    expect([...tree.values()].reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(51);
    expect(expectedTable().size).toBeGreaterThanOrEqual(8);
  });

  it("lists every instrumentation class, so none can be lost unnoticed", () => {
    const missing = [...suiteInTree().keys()].filter((c) => !expectedTable().has(c));
    expect(missing, `these instrumentation classes have no entry in verify-instrumentation.sh, `
      + `so the CI check would not notice them failing to run: ${missing.join(", ")}`).toEqual([]);
  });

  it("relies on one test annotation meaning one test case, and checks that it does", () => {
    // THE COUNTING ASSUMPTION, made explicit. `verify-instrumentation.sh` counts
    // <testcase> elements from a real run; this file counts `@Test` annotations
    // in the tree. Those agree only while every instrumentation test is an
    // ordinary single case. A parameterized runner would emit several testcases
    // per annotation, the two counts would diverge, and this guard would start
    // demanding a table that made the verifier fail.
    //
    // NOT hypothetical, but not for the reason first written here. This comment
    // claimed the Android JVM suite already diverges this way, "227 annotations,
    // 254 cases executed". Both numbers are real and the explanation was wrong:
    // `./gradlew test` builds the app module's unit tests for BOTH the debug and
    // release variants and runs them twice (testDebugUnitTest 27 +
    // testReleaseUnitTest 27), so 254 is 227 distinct tests with 27 of them
    // counted a second time — duplicate execution, not parameterization.
    // The assertion below is still worth making; the claim that it was already
    // load-bearing was not true, and is corrected rather than deleted because the
    // wrong reason is the interesting part.
    for (const file of kotlinFilesUnder(ANDROID_TEST_DIR)) {
      const body = code(readFileSync(file, "utf8"));
      expect(body, `${file} uses a parameterized or repeated runner, so an @Test `
        + `annotation no longer means one test case — the counts in this file and in `
        + `verify-instrumentation.sh can no longer be compared directly`)
        .not.toMatch(/@RunWith\(Parameterized|@RepeatedTest|@ParameterizedTest|@TestFactory/);
    }
  });

  it("lists no class that no longer exists", () => {
    const tree = suiteInTree();
    const stale = [...expectedTable().keys()].filter((c) => !tree.has(c));
    expect(stale, `verify-instrumentation.sh expects classes that are not in the tree: `
      + `${stale.join(", ")}`).toEqual([]);
  });

  it("expects each class's actual size, so a test deleted from a class is caught", () => {
    const tree = suiteInTree();
    const wrong = [...expectedTable()].filter(([c, n]) => tree.get(c) !== n)
      .map(([c, n]) => `${c}: table says ${n}, tree has ${tree.get(c)}`);
    expect(wrong, `verify-instrumentation.sh is stale — update the EXPECTED table `
      + `deliberately: ${wrong.join("; ")}`).toEqual([]);
  });
});

describe("documents do not quote a suite size that has moved", () => {
  const DOCS = ["docs/ANDROID-SECURITY.md", "docs/REMAINING-PHYSICAL-GATES.md",
                "docs/MOBILE-3.0-HANDOFF.md", "docs/REVIEWER-START-HERE.md",
                "docs/RELEASE-CHECKLIST-3.0.md"];

  it("states the current suite size correctly wherever it states one at all", () => {
    const total = [...suiteInTree().values()].reduce((a, b) => a + b, 0);
    for (const rel of DOCS) {
      const text = readFileSync(join(ROOT, rel), "utf8");
      // Only sentences about the suite AS IT IS. A sentence explicitly about a
      // past run ("of that commit", "as it stood") is a historical observation
      // and must NOT be rewritten to today's number.
      // The number must be ADJACENT to the word, not merely near it. A 120-char
      // window matched "iOS 386 tests" in a sentence that also mentioned the
      // Android instrumentation suite, which is a guard inventing a defect.
      // TWO SHAPES, because one missed the claims this guard was written for.
      // The first pattern requires the number next to "instrumentation". Every
      // sentence that carries a CURRENT count in these documents is phrased
      // "the suite is 51 today" or "the suite is 51 tests today" — the word
      // "instrumentation" is in the previous clause — so the guard matched only
      // the four historical mentions it then exempted, and policed nothing at
      // all. It passed because it found nothing to check.
      const pattern = /(\d+)(?:-test\s+instrumentation\s+suite|[- ](?:on-device\s+)?instrumentation\s+tests?)|(?:suite\s+is\s+)(\d+)(?:\s+tests?)?\s+today/g;
      for (const m of text.matchAll(pattern)) {
        const claimed = Number(m[1] ?? m[2]);
        // A sentence explicitly about a PAST run states what that run observed.
        // A "...is N today" claim is current BY CONSTRUCTION and is never exempt,
        // even though it sits in the same sentence as a historical figure — which
        // is exactly where all three of them sit.
        const isTodayForm = m[2] !== undefined;
        const sentence = text.slice(Math.max(0, m.index! - 200), m.index! + 200);
        if (!isTodayForm && /of that commit|as it stood|once said|used to say/.test(sentence)) continue;
        if (!isTodayForm) {
          const around = text.slice(Math.max(0, m.index! - 120), m.index! + 60);
          if (!/instrumentation/i.test(around)) continue;
        }
        expect(claimed, `${rel} says "${m[0]}" but the instrumentation suite is ${total} tests`)
          .toBe(total);
      }
    }
  });

  it("quotes no fixed on-device security-check count, because there is not one", () => {
    // `device-security-check.sh` skips checks that do not apply to a given
    // handset and prints what it ran, so any hardcoded total is a claim about a
    // device rather than about TruePad. Three documents carried three different
    // numbers for one run before this was noticed.
    for (const rel of DOCS) {
      const text = readFileSync(join(ROOT, rel), "utf8");
      const quoted = [...text.matchAll(/(\d+)\s+(?:on-device\s+)?security checks/g)]
        .filter((m) => !/once said|used to|§1's table/.test(
          text.slice(Math.max(0, m.index! - 200), m.index!)));
      expect(quoted.map((m) => m[0]), `${rel} quotes a fixed on-device security-check count`)
        .toEqual([]);
    }
  });

  it("has documents that actually mention the physical run", () => {
    // POSITIVE CONTROL for the two guards above: they read the right files, and
    // the passages they police are still present.
    const gates = readFileSync(join(ROOT, "docs/REMAINING-PHYSICAL-GATES.md"), "utf8");
    expect(gates).toMatch(/SM-A176U/);
    expect(readFileSync(join(ROOT, "docs/ANDROID-SECURITY.md"), "utf8")).toMatch(/SM-A176U/);
  });
});

describe("documents do not quote an iOS suite size that has moved", () => {
  /* The iOS count drifted the first time the interface was restyled: adding the
   * theme guards took the suite from 398 to 405, and two documents kept saying
   * 398. Nothing noticed, because the guard above only covers Android.
   *
   * WHY A DERIVED NUMBER IS SAFE HERE, when the Android table is deliberately
   * hand-maintained. The Android table is an EXPECTATION checked against what
   * ran, so deriving it would let it absorb a loss. This is the opposite job:
   * the documents make a claim about the tree, and the tree is the authority for
   * it. A suite that shrinks makes the documents wrong, and this says so. */
  const iosDocs = ["docs/REVIEWER-START-HERE.md", "docs/TRUEPAD-3-WHITEPAPER.md"];

  it("finds a real iOS suite to compare against", () => {
    // POSITIVE CONTROL. Without this a broken walk would report zero and every
    // assertion below would pass by finding no claims to contradict.
    expect(iosTestsInTree()).toBeGreaterThan(300);
  });

  it("states the current iOS suite size correctly, in every document that states one", () => {
    const actual = iosTestsInTree();
    for (const rel of iosDocs) {
      const text = readFileSync(join(ROOT, rel), "utf8");
      const claims = [...text.matchAll(/([0-9]{2,5})\s*(?:\*\*)?\s*iOS tests|iOS\s+(?:\*\*)?([0-9]{2,5})\s*tests/g)];
      // PER DOCUMENT, NOT ACROSS THE SET.
      //
      // This counted matches globally at first, and a mutation caught it: one
      // document could drop its claim entirely and the other would satisfy the
      // vacuity check on its behalf. Each document listed here is one that states
      // the size, so each must still state it — a document that stops is a change
      // a reviewer should see in a diff, not one that silently stops being
      // checked.
      expect(claims.length, `${rel} no longer states an iOS suite size`).toBeGreaterThan(0);
      for (const m of claims) {
        const stated = Number(m[1] ?? m[2]);
        expect(stated, `${rel} states ${stated} iOS tests; the tree holds ${actual}`).toBe(actual);
      }
    }
  });
});

describe("documents do not quote an Android JVM suite size that has moved", () => {
  /* Twice in one session a change to the Android unit tests left these two
   * numbers stale, and each time it was noticed by hand rather than by a test —
   * once at 227/254 and again at 243/286. The distinct count and the execution
   * count are DIFFERENT numbers for a real reason (the app module's tests are
   * built and run for both the debug and release variants), and a document that
   * quotes one where it means the other overstates coverage.
   *
   * DERIVED FROM THE TREE, deliberately, and unlike the instrumentation table
   * above. That table is an EXPECTATION checked against what ran, so deriving it
   * would let it absorb a loss. This is the opposite job: the documents make a
   * claim ABOUT the tree, so the tree is the authority for it. */
  const ANDROID_UNIT_DIRS = [
    "android/app/src/test",
    "android/truepad-core/src/test",
    "android/truepad-spt/src/test",
    "android/truepad-storage/src/test",
  ];

  function countTests(dir: string): number {
    const root = join(ROOT, dir);
    let total = 0;
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".kt")) {
          total += (code(readFileSync(full, "utf8")).match(/^\s*@Test\b/gm) ?? []).length;
        }
      }
    };
    walk(root);
    return total;
  }

  const distinct = (): number => ANDROID_UNIT_DIRS.reduce((n, d) => n + countTests(d), 0);
  /* The app module's tests are executed twice, once per variant. */
  const executions = (): number => distinct() + countTests("android/app/src/test");

  const docs = ["docs/REVIEWER-START-HERE.md", "docs/TRUEPAD-3-WHITEPAPER.md"];

  it("finds a real Android unit suite to compare against", () => {
    // POSITIVE CONTROL, and it must find tests in EVERY module — a walk that
    // silently missed one is how the last stale pair happened.
    for (const dir of ANDROID_UNIT_DIRS) {
      expect(countTests(dir), `${dir} contributed no tests`).toBeGreaterThan(0);
    }
    expect(executions()).toBeGreaterThan(distinct());
  });

  it("states the current distinct and executed counts correctly", () => {
    const d = distinct();
    const x = executions();
    for (const rel of docs) {
      const text = readFileSync(join(ROOT, rel), "utf8");
      const distinctClaims = [...text.matchAll(/([0-9]{2,5})\s*(?:\*\*)?\s*(?:distinct\s+)?Android\s+JVM|Android\s+(?:\*\*)?([0-9]{2,5})\s*JVM/g)];
      expect(distinctClaims.length, `${rel} no longer states an Android JVM suite size`)
        .toBeGreaterThan(0);
      for (const m of distinctClaims) {
        expect(Number(m[1] ?? m[2]), `${rel} states the wrong distinct Android count`).toBe(d);
      }
      const execClaims = [...text.matchAll(/reports ([0-9]{2,5}) executions/g)];
      expect(execClaims.length, `${rel} no longer states the execution count`).toBeGreaterThan(0);
      for (const m of execClaims) {
        expect(Number(m[1]), `${rel} states the wrong execution count`).toBe(x);
      }
      // And the trailing "so N is the distinct count" sentence, which is the one
      // a substitution missed last time.
      for (const m of text.matchAll(/so ([0-9]{2,5}) is the distinct count/g)) {
        expect(Number(m[1]), `${rel} restates the wrong distinct count`).toBe(d);
      }
    }
  });
});
