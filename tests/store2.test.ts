import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  commitAdvance,
  HEAD_FILE,
  initStore2,
  JOURNAL_FILE,
  loadStore2,
  persistAuthFail,
  readAuthRecord,
  readEncryption,
  reserveAttempt,
  SECRET_FILE,
  zeroizeRetired,
  type HeadV2,
  type JournalRecord
} from "../src/cli/v2/store2";

/* ============================================================================
 * store2 — the v2 direction store on disk (FORMAT-V2.md §1, §12.1, §12.4).
 *
 * Covered here: gen's file artifacts and ordering constraints; v1-store
 * detection; strict head validation (corrupt-head); the secret-body length
 * gate (corrupt-secret-body / corrupt-store); §12.1 reconciliation — the
 * regressed-below-mark refusal vs the allowed header-ahead crash signature,
 * the never-refusing maximum rule for attempts and failure counters, retire
 * lines feeding both maxima; the two corrupt-journal registers (torn last
 * line vs malformed mid-file); positioned secret reads; and zeroizeRetired
 * touching exactly the named ranges.
 * ========================================================================= */

const E = 64; // encryption capacity, bytes
const N = 4; // auth capacity, records
const SECRET_TOTAL = E + 32 * N;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "truepad2-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const storeDir = (): string => join(dir, "a-to-b");
const headPath = (): string => join(storeDir(), HEAD_FILE);
const secretPath = (): string => join(storeDir(), SECRET_FILE);
const journalPath = (): string => join(storeDir(), JOURNAL_FILE);

function makeHead(): HeadV2 {
  return {
    formatVersion: 2,
    pairId: "a0a1a2a3a4a5a6a7a8a9aaabacadaeaf",
    direction: "A->B",
    mode: "bytes",
    sourceDeclarations: [
      { name: "fixture.bin", declaredOrigin: "test fixture, operator-asserted", lengthBytes: 2 * SECRET_TOTAL }
    ],
    encryption: { capacity: E, nextOffset: 0 },
    authentication: {
      profile: "wc-one-time-v1",
      tagBits: 128,
      capacityRecords: N,
      nextSequence: 0,
      verifyAttemptLimit: 8,
      maxCiphertextBytes: 1048576,
      maxAuthLookahead: 64
    },
    recordPolicy: { authenticated: "required", downgradeAllowed: false },
    rollback: { witnessClass: "none", config: {} },
    verification: {
      failurePolicy: { kind: "freeze", threshold: 32 },
      failureCount: 0,
      clearedAtFailureCount: 0,
      perSequenceAttempts: {}
    }
  };
}

// secret.bin fixture: byte i is i mod 256, so every positioned read and
// every zeroized range is checkable byte-for-byte.
function countingSecret(): Uint8Array {
  const bytes = new Uint8Array(SECRET_TOTAL);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = i % 256;
  }
  return bytes;
}

function freshStore(): HeadV2 {
  const head = makeHead();
  initStore2(storeDir(), head, countingSecret());
  return head;
}

// Rewrite head.json directly, bypassing the durable primitives — the test
// stand-in for a restored backup or a stale copy.
const rewriteHead = (head: HeadV2): void => writeFileSync(headPath(), JSON.stringify(head));

const editRawHead = (edit: (raw: Record<string, unknown>) => void): void => {
  const raw = JSON.parse(readFileSync(headPath(), "utf8")) as Record<string, unknown>;
  edit(raw);
  writeFileSync(headPath(), JSON.stringify(raw));
};

const at = (): string => new Date().toISOString();

const expectRefusal = (reason: string): { message: string } => {
  const result = loadStore2(storeDir());
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.reason).toBe(reason);
  return result;
};

/* ---- init (§12.4) --------------------------------------------------------- */

describe("initStore2 — gen's on-disk artifacts", () => {
  it("writes all three files, owner-only", () => {
    freshStore();
    expect(existsSync(headPath())).toBe(true);
    expect(existsSync(secretPath())).toBe(true);
    expect(existsSync(journalPath())).toBe(true);
    expect(statSync(storeDir()).mode & 0o777).toBe(0o700);
    for (const path of [headPath(), secretPath(), journalPath()]) {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it("secret.bin holds exactly the material given, and the init journal line records the budgets", () => {
    freshStore();
    expect(new Uint8Array(readFileSync(secretPath()))).toEqual(countingSecret());
    const lines = readFileSync(journalPath(), "utf8").split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]) as { op: string; capacity: number; capacityRecords: number; pairId: string };
    expect(record.op).toBe("init");
    expect(record.capacity).toBe(E);
    expect(record.capacityRecords).toBe(N);
    expect(record.pairId).toBe(makeHead().pairId);
  });

  it("throws on secret material of the wrong length, before writing any store file", () => {
    expect(() => initStore2(storeDir(), makeHead(), new Uint8Array(SECRET_TOTAL - 1))).toThrow(/E \+ 32\*N/);
    expect(existsSync(headPath())).toBe(false);
    expect(existsSync(secretPath())).toBe(false);
    expect(existsSync(journalPath())).toBe(false);
  });

  it("refuses to overwrite an existing store", () => {
    freshStore();
    expect(() => initStore2(storeDir(), makeHead(), countingSecret())).toThrow(/never overwritten/);
  });

  it("a fresh store loads clean with zeroed effective state", () => {
    freshStore();
    const loaded = loadStore2(storeDir());
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.head.pairId).toBe(makeHead().pairId);
    expect(loaded.effective.nextOffset).toBe(0);
    expect(loaded.effective.nextSequence).toBe(0);
    expect(loaded.effective.attempts.size).toBe(0);
    expect(loaded.effective.failureCount).toBe(0);
    expect(loaded.effective.clearedAtFailureCount).toBe(0);
  });
});

/* ---- no-store / v1-store (§12.1, §9.1) ------------------------------------ */

describe("loadStore2 — store detection", () => {
  it("no head.json and no pad.json is no-store", () => {
    mkdirSync(storeDir(), { recursive: true });
    const refusal = expectRefusal("no-store");
    expect(refusal.message).toContain(HEAD_FILE);
  });

  it("a v1 pad.json is v1-store: no conversion path, letters or bytes alike", () => {
    mkdirSync(storeDir(), { recursive: true });
    writeFileSync(join(storeDir(), "pad.json"), JSON.stringify({ label: "PAD-TEST-AB", mode: "letters" }));
    const refusal = expectRefusal("v1-store");
    expect(refusal.message).toContain("v1");
    expect(refusal.message).toContain("no conversion path exists");
    expect(refusal.message).toContain("Nothing was burned");
  });
});

/* ---- corrupt-head (§1.1) --------------------------------------------------- */

describe("loadStore2 — strict head validation", () => {
  it("wrong maxCiphertextBytes is corrupt-head: not a per-store knob", () => {
    freshStore();
    editRawHead((raw) => {
      (raw.authentication as Record<string, unknown>).maxCiphertextBytes = 65536;
    });
    const refusal = expectRefusal("corrupt-head");
    expect(refusal.message).toContain("maxCiphertextBytes");
  });

  it("a missing field is corrupt-head", () => {
    freshStore();
    editRawHead((raw) => {
      delete raw.verification;
    });
    const refusal = expectRefusal("corrupt-head");
    expect(refusal.message).toContain("verification");
  });

  it("formatVersion 1 is corrupt-head, not v1-store — v1 heads do not exist", () => {
    freshStore();
    editRawHead((raw) => {
      raw.formatVersion = 1;
    });
    const refusal = expectRefusal("corrupt-head");
    expect(refusal.message).toContain("formatVersion");
  });

  it("a relaxed recordPolicy is corrupt-head", () => {
    freshStore();
    editRawHead((raw) => {
      (raw.recordPolicy as Record<string, unknown>).downgradeAllowed = true;
    });
    expectRefusal("corrupt-head");
  });

  it("nextOffset beyond capacity is corrupt-head", () => {
    freshStore();
    editRawHead((raw) => {
      (raw.encryption as Record<string, unknown>).nextOffset = E + 1;
    });
    expectRefusal("corrupt-head");
  });

  it("unparseable JSON is corrupt-head", () => {
    freshStore();
    writeFileSync(headPath(), "{ not json");
    expectRefusal("corrupt-head");
  });
});

/* ---- corrupt-secret-body / corrupt-store (§1.2, §12.4) --------------------- */

describe("loadStore2 — secret body and missing files", () => {
  it("a truncated secret.bin is corrupt-secret-body", () => {
    freshStore();
    writeFileSync(secretPath(), countingSecret().slice(0, SECRET_TOTAL - 7));
    const refusal = expectRefusal("corrupt-secret-body");
    expect(refusal.message).toContain(`${SECRET_TOTAL}`);
    expect(refusal.message).toContain("Nothing was burned");
  });

  it("head.json present but secret.bin missing is corrupt-store", () => {
    freshStore();
    unlinkSync(secretPath());
    const refusal = expectRefusal("corrupt-store");
    expect(refusal.message).toContain(SECRET_FILE);
  });

  it("head.json present but journal.log missing is corrupt-store", () => {
    freshStore();
    unlinkSync(journalPath());
    const refusal = expectRefusal("corrupt-store");
    expect(refusal.message).toContain(JOURNAL_FILE);
  });
});

/* ---- §12.1 high-waters: regression refused, header-ahead allowed ----------- */

describe("loadStore2 — high-water reconciliation", () => {
  it("a head behind a journaled open is regressed-below-mark", () => {
    const head = freshStore();
    const advanced = structuredClone(head);
    advanced.encryption.nextOffset = 10;
    advanced.authentication.nextSequence = 2;
    const line: JournalRecord = {
      op: "open",
      sequence: 1,
      startOffset: 6,
      consumed: 4,
      skipped: 6,
      nextOffset: 10,
      nextSequence: 2,
      at: at()
    };
    commitAdvance(storeDir(), advanced, line);
    rewriteHead(head); // the pre-open copy comes back
    const refusal = expectRefusal("regressed-below-mark");
    expect(refusal.message).toContain("older than its own history");
    expect(refusal.message).toContain("Nothing was burned");
  });

  it("a head that regressed on offset alone is still refused", () => {
    const head = freshStore();
    const advanced = structuredClone(head);
    advanced.encryption.nextOffset = 10;
    advanced.authentication.nextSequence = 2;
    commitAdvance(storeDir(), advanced, {
      op: "open",
      sequence: 1,
      startOffset: 6,
      consumed: 4,
      skipped: 6,
      nextOffset: 10,
      nextSequence: 2,
      at: at()
    });
    const stale = structuredClone(advanced);
    stale.encryption.nextOffset = 5; // sequence is intact, offset is behind
    rewriteHead(stale);
    const refusal = expectRefusal("regressed-below-mark");
    expect(refusal.message).toContain("through offset 9");
  });

  it("header ahead of the journal is the allowed crash signature, and the header is the truth", () => {
    const head = freshStore(); // journal holds only the init line
    const ahead = structuredClone(head);
    ahead.encryption.nextOffset = 10;
    ahead.authentication.nextSequence = 2;
    rewriteHead(ahead);
    const loaded = loadStore2(storeDir());
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.effective.nextOffset).toBe(10);
    expect(loaded.effective.nextSequence).toBe(2);
  });

  it("retire lines feed both maxima", () => {
    const head = freshStore();
    const retired = structuredClone(head);
    retired.encryption.nextOffset = 20;
    retired.authentication.nextSequence = 3;
    commitAdvance(storeDir(), retired, { op: "retire", toSequence: 3, toOffset: 20, reason: "operator", at: at() });

    const loaded = loadStore2(storeDir());
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.effective.nextOffset).toBe(20);
    expect(loaded.effective.nextSequence).toBe(3);

    rewriteHead(head); // regress below the retire marks
    expectRefusal("regressed-below-mark");
  });
});

/* ---- §12.1 maximum rule: attempts and failure counters --------------------- */

describe("loadStore2 — attempt/failure caches resolve as the maximum, never a refusal", () => {
  it("head says 0, journal holds 2 attempt lines: effective 2", () => {
    freshStore();
    reserveAttempt(storeDir(), 1);
    reserveAttempt(storeDir(), 1);
    const loaded = loadStore2(storeDir());
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.head.verification.perSequenceAttempts).toEqual({});
    expect(loaded.effective.attempts.get(1)).toBe(2);
  });

  it("head says 3, journal holds 1 attempt line: effective 3", () => {
    const head = freshStore();
    reserveAttempt(storeDir(), 1);
    const cachedAhead = structuredClone(head);
    cachedAhead.verification.perSequenceAttempts = { "1": 3 };
    rewriteHead(cachedAhead);
    const loaded = loadStore2(storeDir());
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.effective.attempts.get(1)).toBe(3);
  });

  it("persistAuthFail appends the journal line, rewrites the head, and returns it", () => {
    const head = freshStore();
    reserveAttempt(storeDir(), 1);
    const written = persistAuthFail(storeDir(), head, 1);
    expect(written.verification.failureCount).toBe(1);
    expect(written.verification.perSequenceAttempts).toEqual({ "1": 1 });
    expect(JSON.parse(readFileSync(headPath(), "utf8"))).toEqual(written);
    const lines = readFileSync(journalPath(), "utf8").split("\n").filter((line) => line.length > 0);
    const last = JSON.parse(lines[lines.length - 1]) as { op: string; sequence: number; failureCount: number };
    expect(last).toMatchObject({ op: "auth-fail", sequence: 1, failureCount: 1 });
  });

  it("a head whose failureCount lags the journal loads fine and effective takes the journal", () => {
    const head = freshStore();
    reserveAttempt(storeDir(), 1); // O3 precedes O4: the attempt line is what feeds the attempt count
    persistAuthFail(storeDir(), head, 1);
    rewriteHead(head); // failureCount back to 0 — cache lag, not a regression
    const loaded = loadStore2(storeDir());
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.effective.failureCount).toBe(1);
    expect(loaded.effective.attempts.get(1)).toBe(1);
  });

  it("clearedAtFailureCount takes the larger of head and the last clear-freeze line", () => {
    const head = freshStore();
    commitAdvance(storeDir(), head, { op: "clear-freeze", atFailureCount: 2, at: at() });
    const loaded = loadStore2(storeDir());
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.effective.clearedAtFailureCount).toBe(2);
  });
});

/* ---- corrupt-journal: torn last line vs malformed mid-file ------------------ */

describe("loadStore2 — the two corrupt-journal registers", () => {
  it("a torn last line is the crash signature, with remove-and-retry instructions", () => {
    freshStore();
    appendFileSync(journalPath(), '{"op":"open","sequ'); // no newline: torn append
    const refusal = expectRefusal("corrupt-journal");
    expect(refusal.message).toContain("crash between an append and its fsync");
    expect(refusal.message).toContain("Remove only that last line");
  });

  it("a malformed mid-file line is not a crash signature: inspect by hand", () => {
    freshStore();
    appendFileSync(journalPath(), "not json\n");
    appendFileSync(journalPath(), `${JSON.stringify({ op: "attempt", sequence: 0, at: at() })}\n`);
    const refusal = expectRefusal("corrupt-journal");
    expect(refusal.message).toContain("inspect the file by hand");
    expect(refusal.message).toContain("line 2");
  });

  it("a well-formed JSON line with an unknown op is malformed too", () => {
    freshStore();
    appendFileSync(journalPath(), `${JSON.stringify({ op: "rewind", to: 0, at: at() })}\n`);
    expectRefusal("corrupt-journal");
  });
});

/* ---- positioned secret reads (§1.2 layout) ---------------------------------- */

describe("readEncryption / readAuthRecord — §1.2 offsets", () => {
  it("readEncryption reads the encryption slice at the pad offset", () => {
    const head = freshStore();
    expect(readEncryption(storeDir(), head, 3, 5)).toEqual(new Uint8Array([3, 4, 5, 6, 7]));
    expect(readEncryption(storeDir(), head, 0, 0)).toEqual(new Uint8Array(0));
  });

  it("readAuthRecord finds K then R at E + 32*sequence", () => {
    const head = freshStore();
    const { key, mask } = readAuthRecord(storeDir(), head, 1);
    const base = E + 32 * 1;
    expect(key).toEqual(countingSecret().slice(base, base + 16));
    expect(mask).toEqual(countingSecret().slice(base + 16, base + 32));
  });

  it("out-of-range reads throw: callers pre-validate against the budgets", () => {
    const head = freshStore();
    expect(() => readEncryption(storeDir(), head, E - 2, 4)).toThrow(/out of range/);
    expect(() => readAuthRecord(storeDir(), head, N)).toThrow(/out of range/);
  });
});

/* ---- zeroizeRetired --------------------------------------------------------- */

describe("zeroizeRetired — exactly the named ranges, nothing else", () => {
  it("zeroes the given ranges and leaves every other byte intact", () => {
    const head = freshStore();
    zeroizeRetired(storeDir(), head, [
      { offset: 10, length: 5 },
      { offset: E + 32, length: 32 } // auth record 1, K and R both
    ]);
    const body = new Uint8Array(readFileSync(secretPath()));
    const expected = countingSecret();
    expected.fill(0, 10, 15);
    expected.fill(0, E + 32, E + 64);
    expect(body).toEqual(expected);
  });

  it("a range past the body is a programmer error and throws before any write", () => {
    const head = freshStore();
    expect(() => zeroizeRetired(storeDir(), head, [{ offset: SECRET_TOTAL - 4, length: 8 }])).toThrow(/out of range/);
    expect(new Uint8Array(readFileSync(secretPath()))).toEqual(countingSecret());
  });
});

/* ============================================================================
 * §12's commit orders, observed under fault injection (ledger N13). The
 * matrices depend on which write lands first when the second one cannot: the
 * advance order must leave the header AHEAD of the journal (the crash state
 * §12.1 accepts), and the failure order must leave the journal ahead (the
 * state the maximum rule absorbs). An inverted implementation passes every
 * happy-path test and turns those crash states into wedged stores.
 * ========================================================================= */

describe("commit orders under fault injection (§12.2 S2, §12.3 O4, N13)", () => {
  it("commitAdvance writes the header before the journal: a failing append leaves the header already ahead", () => {
    const head = freshStore();
    chmodSync(journalPath(), 0o444);
    const advanced: HeadV2 = {
      ...head,
      encryption: { ...head.encryption, nextOffset: 5 },
      authentication: { ...head.authentication, nextSequence: 1 }
    };
    const line: JournalRecord = {
      op: "send",
      sequence: 0,
      startOffset: 0,
      consumed: 5,
      nextOffset: 5,
      nextSequence: 1,
      at: at()
    };
    expect(() => commitAdvance(storeDir(), advanced, line)).toThrow();
    chmodSync(journalPath(), 0o600);
    // The header is durably advanced; the journal never got the line. That
    // is exactly the header-ahead crash signature §12.1 loads as the truth.
    const onDisk = JSON.parse(readFileSync(headPath(), "utf8")) as HeadV2;
    expect(onDisk.authentication.nextSequence).toBe(1);
    expect(onDisk.encryption.nextOffset).toBe(5);
    const loaded = loadStore2(storeDir());
    expect(loaded.ok).toBe(true);
  });

  it("persistAuthFail appends the journal line before the header rewrite: a failing rewrite leaves the journal ahead", () => {
    const head = freshStore();
    // With the directory read/execute-only, appending to the EXISTING
    // journal file still works, but creating the header's temp file cannot.
    chmodSync(storeDir(), 0o500);
    try {
      expect(() => persistAuthFail(storeDir(), head, 0)).toThrow();
    } finally {
      chmodSync(storeDir(), 0o700);
    }
    const lines = readFileSync(journalPath(), "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines[lines.length - 1]).toMatchObject({ op: "auth-fail", sequence: 0 });
    // The header never advanced its failure count — the journal is ahead,
    // which the §12.1 maximum rule resolves without ever under-counting.
    const onDisk = JSON.parse(readFileSync(headPath(), "utf8")) as HeadV2;
    expect(onDisk.verification.failureCount).toBe(0);
    const loaded = loadStore2(storeDir());
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.effective.failureCount).toBe(1);
    }
  });
});
