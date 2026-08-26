import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encryptLetters } from "../src/core/cipher-otp";
import { Pad } from "../src/core/pad";
import { acquireLock, LOCK_FILE } from "../src/cli/lock";
import { initStore, loadPad, MARKS_FILE, PAD_FILE, persistBurn, readMarks } from "../src/cli/store";
import { directionFor, parseArgs } from "../src/cli/truepad-pad";
import { lacksTypeStripping, MIN_BY_MAJOR, MIN_NODE, tooOld, versionError } from "../bin/node-version.mjs";

/* ============================================================================
 * Lane 2 — durable burn.
 *
 * T1. Crash-reuse: serialize a pad, encrypt from it, then attempt to load the
 *     pre-encrypt serialization through the CLI loader. Must be refused by
 *     the high-water mark.
 * ========================================================================= */

const ROOT = resolve(__dirname, "..");
const LAUNCHER = join(ROOT, "bin", "truepad-pad.mjs");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "truepad-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const padDir = (): string => join(dir, "pad");

describe("T1 — crash-reuse is refused by the high-water mark", () => {
  it("a pre-encrypt pad.json cannot be loaded after a burn was recorded", () => {
    initStore(padDir(), Pad.generate(50, "letters", { label: "PAD-TEST" }));
    // The last durable copy before the crash: the pre-encrypt serialization.
    const preEncrypt = readFileSync(join(padDir(), PAD_FILE), "utf8");

    const loaded = loadPad(padDir());
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const result = encryptLetters("ATTACKATDAWN", loaded.pad, "A");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    persistBurn(padDir(), loaded.pad, { op: "burn", startOffset: 0, consumed: 12, skipped: 0 });

    // Crash model: pad.json regresses to its pre-encrypt content (a restored
    // backup of pad.json alone, or a copy taken before the burn).
    writeFileSync(join(padDir(), PAD_FILE), preEncrypt);

    const again = loadPad(padDir());
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.reason).toBe("regressed-below-mark");
    expect(again.message).toContain("through offset 11");
    expect(again.message).toContain("Nothing was burned");
  });

  it("the mark is per label: another label's history does not block this pad", () => {
    initStore(padDir(), Pad.generate(20, "letters", { label: "PAD-AAAA" }));
    const other = Pad.generate(20, "letters", { label: "PAD-BBBB" });
    other.consume(15);
    persistBurn(padDir(), other, { op: "burn", startOffset: 0, consumed: 15, skipped: 0 });
    writeFileSync(join(padDir(), PAD_FILE), Pad.generate(20, "letters", { label: "PAD-AAAA" }).serialize());
    expect(loadPad(padDir()).ok).toBe(true);
    const marks = readMarks(padDir());
    expect(marks instanceof Map && marks.get("PAD-BBBB")).toBe(15);
  });

  it("the mark is monotonic: a later, lower record never lowers it", () => {
    initStore(padDir(), Pad.generate(20, "bytes", { label: "PAD-MONO" }));
    const loaded = loadPad(padDir());
    if (!loaded.ok) throw new Error("load");
    loaded.pad.consume(10);
    persistBurn(padDir(), loaded.pad, { op: "burn", startOffset: 0, consumed: 10, skipped: 0 });
    const stale = { label: "PAD-MONO", nextOffset: 3, startOffset: 0, consumed: 3, skipped: 0, op: "burn", at: "x" };
    writeFileSync(join(padDir(), MARKS_FILE), readFileSync(join(padDir(), MARKS_FILE), "utf8") + JSON.stringify(stale) + "\n");
    const marks = readMarks(padDir());
    expect(marks instanceof Map && marks.get("PAD-MONO")).toBe(10);
  });

  it("a corrupt marks.log refuses the load rather than being ignored; a torn LAST line gets recovery guidance", () => {
    initStore(padDir(), Pad.generate(20, "bytes", { label: "PAD-CRPT" }));
    const good = readFileSync(join(padDir(), MARKS_FILE), "utf8");
    // Torn tail: the crash signature. Refused, and the message says what to do.
    writeFileSync(join(padDir(), MARKS_FILE), good + '{"label":"PAD-CRPT","nextOff');
    const torn = loadPad(padDir());
    expect(!torn.ok && torn.reason).toBe("corrupt-marks");
    if (!torn.ok) {
      expect(torn.message).toContain("ends in a malformed line");
      expect(torn.message).toContain("Remove only that last line");
    }
    // Garbage in the middle is not a crash signature and says so.
    writeFileSync(join(padDir(), MARKS_FILE), "not json\n" + good);
    const middle = loadPad(padDir());
    expect(!middle.ok && middle.reason).toBe("corrupt-marks");
    if (!middle.ok) expect(middle.message).toContain("in the middle of the file");
  });

  it("pad.json, marks.log and the lock are created owner-only (0600) in a 0700 directory", () => {
    initStore(padDir(), Pad.generate(5, "letters"));
    expect(statSync(join(padDir(), PAD_FILE)).mode & 0o777).toBe(0o600);
    expect(statSync(join(padDir(), MARKS_FILE)).mode & 0o777).toBe(0o600);
    expect(statSync(padDir()).mode & 0o777).toBe(0o700);
    const lock = acquireLock(padDir());
    if (lock.ok) {
      expect(statSync(join(padDir(), LOCK_FILE)).mode & 0o777).toBe(0o600);
      lock.release();
    }
    // A rewrite keeps the mode.
    const loaded = loadPad(padDir());
    if (!loaded.ok) throw new Error("load");
    loaded.pad.consume(1);
    persistBurn(padDir(), loaded.pad, { op: "burn", startOffset: 0, consumed: 1, skipped: 0 });
    expect(statSync(join(padDir(), PAD_FILE)).mode & 0o777).toBe(0o600);
  });

  it("DOCUMENTED LIMITATION: restoring pad.json AND marks.log together is not detected", () => {
    initStore(padDir(), Pad.generate(20, "letters", { label: "PAD-BKUP" }));
    const backupPad = readFileSync(join(padDir(), PAD_FILE), "utf8");
    const backupMarks = readFileSync(join(padDir(), MARKS_FILE), "utf8");
    const loaded = loadPad(padDir());
    if (!loaded.ok) throw new Error("load");
    loaded.pad.consume(5);
    persistBurn(padDir(), loaded.pad, { op: "burn", startOffset: 0, consumed: 5, skipped: 0 });
    // Whole-directory restore regresses pad and mark together.
    writeFileSync(join(padDir(), PAD_FILE), backupPad);
    writeFileSync(join(padDir(), MARKS_FILE), backupMarks);
    const regressed = loadPad(padDir());
    // This passes — that is the limitation the README states in one sentence.
    expect(regressed.ok).toBe(true);
    if (regressed.ok) expect(regressed.pad.nextOffset).toBe(0);
  });
});

describe("order of operations: persist, fsync, then emit", () => {
  it("disk is already burned before anything is emitted; a dropped envelope loses pad, never reuses it", () => {
    initStore(padDir(), Pad.generate(30, "letters", { label: "PAD-EMIT" }));
    const loaded = loadPad(padDir());
    if (!loaded.ok) throw new Error("load");
    const result = encryptLetters("HELLOWORLD", loaded.pad, "A");
    if (!result.ok) throw new Error("encrypt");
    persistBurn(padDir(), loaded.pad, { op: "burn", startOffset: 0, consumed: 10, skipped: 0 });
    // Simulated crash before emit: the envelope is dropped on the floor.
    const onDisk = Pad.deserialize(readFileSync(join(padDir(), PAD_FILE), "utf8"));
    expect(onDisk.nextOffset).toBe(10);
    expect(onDisk.highWaterMark).toBe(9);
    expect(onDisk.valueAt(0)).toBeUndefined();
    const marks = readMarks(padDir());
    expect(marks instanceof Map && marks.get("PAD-EMIT")).toBe(10);
    expect(existsSync(join(padDir(), `${PAD_FILE}.tmp`))).toBe(false);
  });

  it("the REAL burn prints nothing when persistence fails — emit-before-persist would print the envelope", () => {
    // The Lane 2 review showed a reorder-only mutation (emit, then persist)
    // passed every other test: nothing observed stdout relative to the disk.
    // Force the mark append to fail through the real binary (marks.log
    // read-only; the lock and the pad rewrite still work) and assert stdout
    // is empty. Under the correct order the pad rewrite has already landed
    // when the append fails: those symbols are lost, never reused.
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      return; // root ignores file modes; the check below cannot bite
    }
    const a = join(dir, "a");
    const gen = spawnSync(process.execPath, [LAUNCHER, "gen", a, "--size", "20", "--label", "PAD-NOWR"], { encoding: "utf8" });
    expect(gen.status).toBe(0);
    const half = join(a, "a-to-b"); // A burns the A->B half
    const marksBefore = readFileSync(join(half, MARKS_FILE), "utf8");
    chmodSync(join(half, MARKS_FILE), 0o400);
    try {
      const burn = spawnSync(process.execPath, [LAUNCHER, "burn", a, "--as", "A", "HELLO"], { encoding: "utf8" });
      expect(burn.status).toBe(1);
      expect(burn.stdout).toBe("");
      expect(burn.stderr).toMatch(/EACCES|permission denied/i);
    } finally {
      chmodSync(join(half, MARKS_FILE), 0o600);
    }
    expect(readFileSync(join(half, MARKS_FILE), "utf8")).toBe(marksBefore);
    // pad.json was rewritten first (step 1 of the order): the five symbols are gone, not reused.
    expect(JSON.parse(readFileSync(join(half, PAD_FILE), "utf8")).nextOffset).toBe(5);
    expect(existsSync(join(a, LOCK_FILE))).toBe(false);
  });

  it("initStore never overwrites an existing pad directory", () => {
    initStore(padDir(), Pad.generate(5, "letters"));
    expect(() => initStore(padDir(), Pad.generate(5, "letters"))).toThrow(/never overwritten/);
  });
});

describe("exclusive lockfile", () => {
  it("a second holder is refused until the first releases", () => {
    initStore(padDir(), Pad.generate(10, "letters"));
    const first = acquireLock(padDir());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = acquireLock(padDir());
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe("locked");
      expect(second.holder).toContain(`pid ${process.pid}`);
    }
    first.release();
    expect(existsSync(join(padDir(), LOCK_FILE))).toBe(false);
    const third = acquireLock(padDir());
    expect(third.ok).toBe(true);
    if (third.ok) third.release();
  });

  it("a leftover lock (crash) is refused, not silently broken", () => {
    initStore(padDir(), Pad.generate(10, "letters"));
    writeFileSync(join(padDir(), LOCK_FILE), "pid 999999 since 2000-01-01T00:00:00.000Z");
    const result = acquireLock(padDir());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(LOCK_FILE);
  });
});

describe("launcher version gate", () => {
  it("compares against the documented minimum, per major line", () => {
    expect(MIN_NODE).toEqual([22, 18, 0]);
    expect(MIN_BY_MAJOR).toEqual({ 22: [22, 18, 0], 23: [23, 6, 0] });
    expect(tooOld("20.19.0")).toBe(true);
    expect(tooOld("22.17.9")).toBe(true);
    expect(tooOld("22.18.0")).toBe(false);
    expect(tooOld("22.99.0")).toBe(false);
    // 23.0–23.5 run TypeScript only behind a flag: too old, even though > 22.18.
    expect(tooOld("23.0.0")).toBe(true);
    expect(tooOld("23.5.9")).toBe(true);
    expect(tooOld("23.6.0")).toBe(false);
    expect(tooOld("24.0.0")).toBe(false);
    expect(tooOld("24.14.0")).toBe(false);
    expect(tooOld("v22.18.0")).toBe(false);
    expect(tooOld("22.18.0-nightly20250101")).toBe(false);
    expect(versionError("18.0.0")).toContain("22.18.0");
    expect(versionError("18.0.0")).toContain("23.6.0");
    expect(versionError("18.0.0")).toContain("Nothing was run");
  });

  it("gates on the runtime's own capability flag, falling back to the version only where the flag is absent", () => {
    expect(lacksTypeStripping({ typescript: "strip" }, "0.0.0")).toBe(false);
    expect(lacksTypeStripping({ typescript: "transform" }, "0.0.0")).toBe(false);
    expect(lacksTypeStripping({ typescript: false }, "99.0.0")).toBe(true); // --no-experimental-strip-types
    expect(lacksTypeStripping({}, "22.9.0")).toBe(true); // pre-22.10: no flag, old version
    expect(lacksTypeStripping({}, "24.14.0")).toBe(false);
    expect(lacksTypeStripping(null, "20.0.0")).toBe(true); // no features object at all
    // This process really strips types (the suite imports .ts through Node in child processes).
    expect(lacksTypeStripping()).toBe(false);
    // The real launcher refuses when stripping is turned off, before importing anything.
    const off = spawnSync(process.execPath, ["--no-experimental-strip-types", LAUNCHER, "status", "/nonexistent"], { encoding: "utf8" });
    expect(off.status).toBe(1);
    expect(off.stderr).toContain("Nothing was run");
    expect(off.stdout).toBe("");
  });

  it("the launcher has no top-level await, so the version message can print on any ESM-capable Node", () => {
    const launcher = readFileSync(LAUNCHER, "utf8");
    expect(launcher).not.toMatch(/^\s*const .*= await /m);
    expect(launcher).not.toMatch(/^await /m);
  });

  it("parseArgs separates positionals from --flag value pairs", () => {
    const args = parseArgs(["burn", "dir", "--in", "f.txt", "text"]);
    expect(args.positional).toEqual(["burn", "dir", "text"]);
    expect(args.flags.get("in")).toBe("f.txt");
    expect(() => parseArgs(["gen", "--size"])).toThrow(/needs a value/);
  });
});

describe("truepad-pad end to end (real binary via the launcher)", () => {
  function run(...argv: string[]): { code: number; stdout: string; stderr: string } {
    const child = spawnSync(process.execPath, [LAUNCHER, ...argv], { encoding: "utf8" });
    return { code: child.status ?? -1, stdout: child.stdout, stderr: child.stderr };
  }

  it("gen -> courier copy -> burn/open both ways; replay exits 2; the banner names the limitation", () => {
    const a = join(dir, "a");
    const b = join(dir, "b");
    const gen = run("gen", a, "--size", "40", "--label", "PAD-CLIT");
    expect(gen.code).toBe(0);
    expect(gen.stderr).toContain("NOT secure messaging");
    expect(gen.stderr).toContain("flip chosen bits");
    const genOut = JSON.parse(gen.stdout);
    expect(genOut["A->B"]).toMatchObject({ label: "PAD-CLIT-AB", direction: "A->B", source: "csprng", nextOffset: 0, remaining: 40 });
    expect(genOut["B->A"]).toMatchObject({ label: "PAD-CLIT-BA", direction: "B->A" });
    expect(existsSync(join(a, "a-to-b", PAD_FILE)) && existsSync(join(a, "b-to-a", PAD_FILE))).toBe(true);

    // Out-of-band delivery, modelled as a whole-directory copy before any burn.
    cpSync(a, b, { recursive: true });

    // T2 in CLI form: both peers burn before either opens — different halves, no overlap.
    const fromA = run("burn", a, "--as", "A", "ATTACK AT DAWN");
    const fromB = run("burn", b, "--as", "B", "MEET ME AT NOON");
    expect(fromA.code).toBe(0);
    expect(fromB.code).toBe(0);
    expect(JSON.parse(fromA.stdout)).toMatchObject({ label: "PAD-CLIT-AB", startOffset: 0, consumed: 12 });
    expect(JSON.parse(fromB.stdout)).toMatchObject({ label: "PAD-CLIT-BA", startOffset: 0, consumed: 12 });
    expect(JSON.parse(run("status", a).stdout)["A->B"]).toMatchObject({ nextOffset: 12, highWaterMark: 11, recordedNextOffset: 12 });

    const bOpens = run("open", b, "--as", "B", fromA.stdout.trim());
    const aOpens = run("open", a, "--as", "A", fromB.stdout.trim());
    expect(bOpens.code).toBe(0);
    expect(aOpens.code).toBe(0);
    expect(bOpens.stdout.trim()).toBe("ATTACKATDAWN");
    expect(aOpens.stdout.trim()).toBe("MEETMEATNOON");

    // The wrong role: A trying to open A's own envelope picks b-to-a, whose label does not match.
    const wrongRole = run("open", a, "--as", "A", fromA.stdout.trim());
    expect(wrongRole.code).toBe(2);
    expect(wrongRole.stderr).toContain("addressed to pad page PAD-CLIT-AB");

    const replay = run("open", b, "--as", "B", fromA.stdout.trim());
    expect(replay.code).toBe(2);
    expect(replay.stderr).toContain("Reuse refused");
    expect(JSON.parse(run("status", b).stdout)["A->B"]).toMatchObject({ nextOffset: 12 });
    // No lock left behind by any of the above.
    expect(existsSync(join(a, LOCK_FILE))).toBe(false);
    expect(existsSync(join(b, LOCK_FILE))).toBe(false);
  });

  it("a swapped subdirectory is refused by the core direction check, not burned", () => {
    const a = join(dir, "a");
    expect(run("gen", a, "--size", "10").code).toBe(0);
    // Operator error: b-to-a's pad copied over a-to-b's.
    cpSync(join(a, "b-to-a", PAD_FILE), join(a, "a-to-b", PAD_FILE));
    const r = run("burn", a, "--as", "A", "HELLO");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Direction refused");
    expect(JSON.parse(readFileSync(join(a, "a-to-b", PAD_FILE), "utf8")).nextOffset).toBe(0);
  });

  it("a half-pair (gen interrupted between halves) is refused by burn, open and status", () => {
    const a = join(dir, "a");
    expect(run("gen", a, "--size", "10").code).toBe(0);
    rmSync(join(a, "b-to-a"), { recursive: true, force: true });
    for (const argv of [["burn", a, "--as", "A", "HELLO"], ["open", a, "--as", "B", "{}"], ["status", a]]) {
      const r = run(...argv);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("half-pair");
      expect(r.stderr).toContain("do not use the surviving half");
    }
    expect(JSON.parse(readFileSync(join(a, "a-to-b", PAD_FILE), "utf8")).nextOffset).toBe(0);
    expect(existsSync(join(a, LOCK_FILE))).toBe(false);
  });

  it("--as is required and directionFor maps roles to halves", () => {
    expect(directionFor("A", "burn")).toBe("A->B");
    expect(directionFor("A", "open")).toBe("B->A");
    expect(directionFor("B", "burn")).toBe("B->A");
    expect(directionFor("B", "open")).toBe("A->B");
    const a = join(dir, "a");
    expect(run("gen", a, "--size", "10").code).toBe(0);
    const r = run("burn", a, "HELLO");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--as A or --as B is required");
  });

  it("refuses to burn while another process holds the pad", () => {
    const a = join(dir, "a");
    expect(run("gen", a, "--size", "10").code).toBe(0);
    writeFileSync(join(a, LOCK_FILE), "pid 1 since test");
    const burn = run("burn", a, "--as", "A", "HELLO");
    expect(burn.code).toBe(2);
    expect(burn.stderr).toContain("locked");
    expect(JSON.parse(readFileSync(join(a, "a-to-b", PAD_FILE), "utf8")).nextOffset).toBe(0);
  });

  it("gen --external tags the pad external and reduces letters by rejection", () => {
    const material = join(dir, "material.bin");
    // 14 bytes split 7/7: A->B gets [233,234,255,0,1,2,3] -> 5 letters (234, 255 rejected);
    // B->A gets [4..10] -> 7 letters.
    writeFileSync(material, Uint8Array.from([233, 234, 255, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    const a = join(dir, "ext");
    const gen = run("gen", a, "--external", material, "--mode", "letters");
    expect(gen.code).toBe(0);
    expect(gen.stderr).toContain("did not verify");
    expect(gen.stderr).toContain("split at the midpoint");
    const out = JSON.parse(gen.stdout);
    expect(out["A->B"]).toMatchObject({ source: "external", size: 5, direction: "A->B" });
    expect(out["B->A"]).toMatchObject({ source: "external", size: 7, direction: "B->A" });
  });

  it("usage and I/O errors exit 1; a missing pad directory is named", () => {
    expect(run().code).toBe(1);
    expect(run("burn").code).toBe(1);
    const missing = run("open", join(dir, "nope"), "--as", "A", "{}");
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("no such pad directory");
  });
});
