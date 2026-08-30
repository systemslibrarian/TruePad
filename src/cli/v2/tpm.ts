/* ============================================================================
 * truepad2 platform-monotonic provider — Linux TPM 2.0 NV counter (§15.2)
 * ----------------------------------------------------------------------------
 * Node only. The ONE provider implemented for the `platform-monotonic` witness
 * class: `tpm2-nv-counter-v1`, a TPM 2.0 NV index of type COUNTER driven
 * through the tpm2-tools command suite on Linux.
 *
 * WHAT THE TPM IS FOR. The separate-state-file witness is about as strong as a
 * plain file can honestly be, and its remaining limitation is fundamental: a
 * VALID historical witness file restored between operations cannot detect its
 * own rollback, because it has no external truth. The TPM supplies exactly that
 * external truth and nothing else. It anchors NON-SECRET monotone state: no pad
 * byte, key, mask, plaintext, or pad-derived value is ever sent to, stored in,
 * or read from the TPM. The witness record shape is unchanged — the same three
 * counters — and the NV index holds one uint64 that only ever counts up.
 *
 * WHAT IT DOES NOT CLAIM. TruePad trusts the host to be talking to the real
 * TPM. A compromised host that can subvert the runtime — intercept tpm2-tools,
 * emulate the device, or rewrite this process's memory — is outside the model,
 * and no counter can fix that from inside the machine it is defending. This is
 * rollback resistance against RESTORE (of the pair, of the state file, of both
 * together), which is the attack separate-state-file cannot see. It is not a
 * claim against a malicious TPM, malicious firmware, or a malicious host.
 *
 * SCOPE. Linux, TPM 2.0, tpm2-tools. Not macOS, not Windows, not Secure
 * Enclave, not "all TPMs". A software TPM (swtpm) speaks the same commands and
 * is useful for interoperability testing, but its backing state can itself be
 * snapshotted and restored, so it earns NO part of the hardware claim and is
 * never described as a monotonic authority.
 *
 * SAFETY. Every invocation is spawnSync with an explicit argv array and
 * shell:false — nothing is ever concatenated into a shell string. The NV index
 * is parsed by a strict grammar before it reaches an argv slot, so a config
 * value cannot smuggle an option or a command. Output is size-bounded and the
 * call is time-bounded. No authorization secret is accepted, stored, or logged
 * by this module: the index must work under the operator's externally managed
 * authorization model (see initPlatformWitness), because inventing credential
 * storage would put a secret somewhere TruePad promises never to keep one.
 *
 * TruePad NEVER defines, undefines, or clears anything. tpm2_nvdefine,
 * tpm2_nvundefine and TPM clear involve platform ownership and authorization
 * policy, and are far too dangerous to hide inside ordinary pad commands. The
 * operator provisions a dedicated NV counter; TruePad validates and adopts it.
 * ========================================================================= */

import { spawnSync } from "node:child_process";

export const PROVIDER_ID = "tpm2-nv-counter-v1";

// A TPM NV counter is 8 octets, and TPM structures are marshalled big-endian
// (TCG canonical form), so the value read back is a big-endian uint64. That
// assumption is not merely documented: initialization increments the counter
// once and requires the parsed value to move by exactly one, and every advance
// requires the post-increment read to equal the anchor it just committed. A
// wrong byte order therefore fails closed on the first use rather than silently
// corrupting the anchor.
export const NV_COUNTER_BYTES = 8;
export const UINT64_MAX = (1n << 64n) - 1n;

const EXEC_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 1 << 20;

// The tools this provider uses. Nothing else is ever invoked — in particular
// nothing that defines, undefines, or clears.
export const REQUIRED_TOOLS = ["tpm2_nvreadpublic", "tpm2_nvread", "tpm2_nvincrement"] as const;

/* ---- the NV index grammar ------------------------------------------------- */

// Strict: 0x followed by 1..8 hex digits, and inside the TPM NV handle range
// (0x01000000..0x01FFFFFF, TPM_HT_NV_INDEX). Parsed before the value can reach
// an argv slot, so a config string can never introduce an option or an
// argument of its own.
const NV_INDEX_RE = /^0x[0-9a-fA-F]{1,8}$/;
const NV_RANGE_LO = 0x01000000;
const NV_RANGE_HI = 0x01ffffff;

export function parseNvIndex(raw: unknown): { ok: true; index: string } | { ok: false; why: string } {
  if (typeof raw !== "string" || !NV_INDEX_RE.test(raw)) {
    return { ok: false, why: `nvIndex must be a hex handle like "0x01500016"; found ${JSON.stringify(raw)}` };
  }
  const value = Number.parseInt(raw, 16);
  if (!Number.isSafeInteger(value) || value < NV_RANGE_LO || value > NV_RANGE_HI) {
    return {
      ok: false,
      why: `nvIndex ${raw} is outside the TPM NV handle range 0x01000000..0x01FFFFFF (TPM_HT_NV_INDEX)`
    };
  }
  // Re-emit canonically so the exact bytes handed to tpm2-tools are ours, not
  // the config file's spelling.
  return { ok: true, index: `0x${value.toString(16).padStart(8, "0")}` };
}

/* ---- the provider interface ----------------------------------------------- */

// The public area of an NV index, reduced to what TruePad must decide on.
export type NvPublic = {
  name: string; // the TPM Name, lowercase hex — the index's cryptographic identity
  isCounter: boolean;
  isOrderly: boolean;
  sizeBytes: number;
  attributesFriendly: string;
};

export type TpmResult<T> = { ok: true; value: T } | { ok: false; message: string };

// Injectable so the state machine can be tested exhaustively without a device.
// The FAKE implementation lives in the test suite and is NEVER selectable from
// a pair header: the header names a PROVIDER ID, and only PROVIDER_ID resolves.
export type TpmProvider = {
  readonly id: string;
  available(): TpmResult<null>;
  readPublic(nvIndex: string): TpmResult<NvPublic>;
  readCounter(nvIndex: string): TpmResult<bigint>;
  increment(nvIndex: string): TpmResult<null>;
};

/* ---- tpm2-tools plumbing --------------------------------------------------- */

type Run = { ok: true; stdout: Buffer; stderr: string } | { ok: false; message: string };

function run(tool: string, argv: string[]): Run {
  const child = spawnSync(tool, argv, {
    shell: false, // never a shell: argv is passed through verbatim
    timeout: EXEC_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true
  });
  if (child.error !== undefined) {
    const code = (child.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: false, message: `${tool} is not installed or not on PATH` };
    }
    return { ok: false, message: `${tool} could not be run (${child.error.message})` };
  }
  if (child.signal !== null) {
    return { ok: false, message: `${tool} was killed by ${child.signal} (timeout is ${EXEC_TIMEOUT_MS}ms)` };
  }
  const stderr = (child.stderr ?? Buffer.alloc(0)).toString("utf8").trim().slice(0, 2000);
  if (child.status !== 0) {
    return { ok: false, message: `${tool} exited ${child.status}${stderr ? `: ${stderr}` : ""}` };
  }
  return { ok: true, stdout: child.stdout ?? Buffer.alloc(0), stderr };
}

/* ---- parsing the NV public area ------------------------------------------- */

// tpm2_nvreadpublic prints YAML, one block per defined index:
//
//   0x1500016:
//     name: 000b<hex>
//     hash algorithm:
//       friendly: sha256
//       value: 0xB
//     attributes:
//       friendly: ownerread|authread|authwrite|written|nt=0x1
//       value: 0x42060008
//     size: 8
//
// Only this index's block is read, and every field TruePad decides on must be
// present: a missing `name`, `size`, or `attributes` fails closed rather than
// defaulting. The attribute test uses the FRIENDLY list, which names `nt=`
// (the NV index type: 0x1 is TPM_NT_COUNTER) and `orderly` explicitly.
export function parseNvPublic(yaml: string, nvIndex: string): TpmResult<NvPublic> {
  const lines = yaml.split("\n");
  // Blocks are keyed by the handle WITHOUT leading zeros in tpm2-tools output,
  // so match on the numeric value rather than on our canonical spelling.
  const wanted = Number.parseInt(nvIndex, 16);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^\s*(0x[0-9a-fA-F]+)\s*:\s*$/.exec(lines[i]);
    if (m !== null && Number.parseInt(m[1], 16) === wanted) {
      start = i;
      break;
    }
  }
  if (start === -1) {
    return { ok: false, message: `tpm2_nvreadpublic reported no NV index at ${nvIndex}` };
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*0x[0-9a-fA-F]+\s*:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const block = lines.slice(start + 1, end);

  const field = (name: string): string | null => {
    for (const line of block) {
      const m = new RegExp(`^\\s*${name}\\s*:\\s*(.*?)\\s*$`).exec(line);
      if (m !== null && m[1] !== "") {
        return m[1];
      }
    }
    return null;
  };

  const name = field("name");
  if (name === null || !/^[0-9a-fA-F]+$/.test(name)) {
    return { ok: false, message: `tpm2_nvreadpublic gave no usable "name" for ${nvIndex} — refusing to bind to an index with no identity` };
  }
  const sizeRaw = field("size");
  if (sizeRaw === null || !/^\d+$/.test(sizeRaw)) {
    return { ok: false, message: `tpm2_nvreadpublic gave no usable "size" for ${nvIndex}` };
  }
  // `attributes:` is a nested block whose `friendly:` line carries the list.
  let friendly: string | null = null;
  for (let i = 0; i < block.length; i += 1) {
    if (/^\s*attributes\s*:\s*$/.test(block[i])) {
      for (let j = i + 1; j < block.length && /^\s{2,}/.test(block[j]); j += 1) {
        const m = /^\s*friendly\s*:\s*(.*?)\s*$/.exec(block[j]);
        if (m !== null) {
          friendly = m[1];
          break;
        }
      }
      break;
    }
  }
  if (friendly === null) {
    return { ok: false, message: `tpm2_nvreadpublic gave no attributes for ${nvIndex} — refusing to adopt an index whose attributes cannot be read` };
  }
  const flags = friendly.split("|").map((f) => f.trim().toLowerCase());
  // TPM_NT_COUNTER is nt=0x1. Anything else — ordinary (nt=0x0), bits, extend,
  // pin pass/fail — is NOT a counter and must never be treated as one just
  // because it happens to hold an integer.
  const nt = flags.find((f) => f.startsWith("nt="));
  const isCounter = nt !== undefined && /^nt=(0x)?0*1$/.test(nt);
  return {
    ok: true,
    value: {
      name: name.toLowerCase(),
      isCounter,
      isOrderly: flags.includes("orderly"),
      sizeBytes: Number.parseInt(sizeRaw, 10),
      attributesFriendly: friendly
    }
  };
}

// The 8-octet NV counter, big-endian per TCG canonical marshalling. Anything
// that is not exactly 8 octets fails closed rather than being padded or
// truncated into a plausible-looking number.
export function parseCounterBytes(bytes: Buffer): TpmResult<bigint> {
  if (bytes.length !== NV_COUNTER_BYTES) {
    return {
      ok: false,
      message: `expected exactly ${NV_COUNTER_BYTES} octets from the NV counter, got ${bytes.length}`
    };
  }
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return { ok: true, value };
}

/* ---- the real provider ----------------------------------------------------- */

export function tpm2ToolsProvider(): TpmProvider {
  return {
    id: PROVIDER_ID,

    available(): TpmResult<null> {
      for (const tool of REQUIRED_TOOLS) {
        const probe = run(tool, ["--version"]);
        if (!probe.ok) {
          return {
            ok: false,
            message:
              `${probe.message}. The platform-monotonic witness needs the tpm2-tools suite (${REQUIRED_TOOLS.join(", ")}) ` +
              "on a Linux host with a TPM 2.0 device. It fails closed rather than degrading to a weaker witness class."
          };
        }
      }
      return { ok: true, value: null };
    },

    readPublic(nvIndex: string): TpmResult<NvPublic> {
      const parsed = parseNvIndex(nvIndex);
      if (!parsed.ok) {
        return { ok: false, message: parsed.why };
      }
      const result = run("tpm2_nvreadpublic", [parsed.index]);
      if (!result.ok) {
        return { ok: false, message: result.message };
      }
      return parseNvPublic(result.stdout.toString("utf8"), parsed.index);
    },

    readCounter(nvIndex: string): TpmResult<bigint> {
      const parsed = parseNvIndex(nvIndex);
      if (!parsed.ok) {
        return { ok: false, message: parsed.why };
      }
      // Raw octets on stdout — never a pretty-printed integer.
      const result = run("tpm2_nvread", [parsed.index, "-s", String(NV_COUNTER_BYTES)]);
      if (!result.ok) {
        return { ok: false, message: result.message };
      }
      return parseCounterBytes(result.stdout);
    },

    increment(nvIndex: string): TpmResult<null> {
      const parsed = parseNvIndex(nvIndex);
      if (!parsed.ok) {
        return { ok: false, message: parsed.why };
      }
      // Index authorization: the index authorizes itself (-C <index>), which is
      // the model an operator can run non-interactively without TruePad holding
      // any credential. No -P is ever passed: this module accepts no auth value,
      // so none can be persisted or logged.
      const result = run("tpm2_nvincrement", ["-C", parsed.index, parsed.index]);
      if (!result.ok) {
        return { ok: false, message: result.message };
      }
      return { ok: true, value: null };
    }
  };
}
