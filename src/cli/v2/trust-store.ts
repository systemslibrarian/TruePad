/* ============================================================================
 * truepad2 host trust store — the installation's pinned platform authority
 * ----------------------------------------------------------------------------
 * A pair MUST NOT be allowed to choose its own root of trust. Everything inside
 * a pair directory — head.json, provenance.json, withdrawal.json — is
 * attacker-controlled under the stated threat model, and so may only REFER to a
 * platform authority, never DEFINE which authority is trusted.
 *
 * This file is that independent root: a host-level trust store, OUTSIDE every
 * pair directory, that records the canonical public identity of the ONE platform
 * authority the operator has explicitly pinned for this installation. The
 * deployment evaluator and every platform-authority operation resolve the pair's
 * *claimed* authority AGAINST this pin; a pair that names any other authority —
 * however internally valid — never satisfies the maximum-assurance verdict.
 *
 * THREAT BOUNDARY. The pin is durable and outside the pair-directory writable
 * domain, so an attacker bounded to pair-directory writes cannot forge or
 * redirect it. It is NOT a claim against a hostile OS, a malicious administrator,
 * root compromise, a replaced TruePad binary, or host-level configuration
 * tampering — those can change the host trust config and are outside the claim.
 *
 * NO SECRET / PAD-DERIVED MATERIAL. The pin holds only PUBLIC platform identity
 * values (provider, authorityId, TPM NV index and Name, and the trusted state
 * file location). Never a hash, MAC, fingerprint, or anything derived from pad
 * bytes.
 *
 * FAIL CLOSED. Any malformation, wrong version, wrong shape, or unknown provider
 * reads as NO PIN (unpinned), which the evaluator maps to INSUFFICIENT — never a
 * stronger result. There is NO trust-on-first-use: a pin is only ever written by
 * the explicit `truepad2 authority pin` operator command, never inferred from a
 * pair. Written with the same temp→fsync→rename→fsync-dir durability as head.json.
 * ========================================================================= */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { PROVIDER_ID, parseNvIndex } from "./tpm.ts";

export const TRUST_VERSION = 1;

/** The canonical public identity of a pinned platform authority, plus the
 *  trusted location of its state file. `statePath` is a LOCATION, not part of the
 *  cryptographic identity: the identity is provider + authorityId + nvIndex +
 *  nvName, verified against the live TPM at resolution time. */
export interface TrustPin {
  trustVersion: 1;
  provider: string;
  authorityId: string;
  nvIndex: string;
  nvName: string;
  statePath: string;
}

const EXPECTED_KEYS = ["authorityId", "nvIndex", "nvName", "provider", "statePath", "trustVersion"] as const;

/** The host trust-store path: `$TRUEPAD_TRUST_STORE` when set (must be absolute),
 *  else `~/.config/truepad/platform-trust.json`. The env override is part of the
 *  host trust configuration, outside the pair-directory boundary. */
export function trustStorePath(): string {
  const override = process.env.TRUEPAD_TRUST_STORE;
  if (override !== undefined && override !== "") {
    if (!isAbsolute(override)) {
      throw new Error(`TRUEPAD_TRUST_STORE must be an absolute path; found ${JSON.stringify(override)}`);
    }
    return override;
  }
  return join(homedir(), ".config", "truepad", "platform-trust.json");
}

function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* best-effort: not every platform opens a directory handle */
  }
}

/** Write the pin durably (temp→fsync→rename→fsync dir), creating the parent
 *  directory. Overwrite is a deliberate, explicit operator action (pin/repin). */
export function writeTrustPin(record: TrustPin, path: string = trustStorePath()): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp.${process.pid}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    const data = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    let off = 0;
    while (off < data.length) off += writeSync(fd, data, off, data.length - off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  fsyncDir(dir);
}

/** Remove the pin (explicit `authority unpin`). Missing pin is a no-op. */
export function removeTrustPin(path: string = trustStorePath()): void {
  rmSync(path, { force: true });
}

/**
 * Read and strictly validate the pin. Returns null on ANY problem — absent,
 * unparsable, wrong key set, wrong version, unknown provider, malformed
 * identity, or a non-absolute state path. Null means UNPINNED (fail closed).
 */
export function readTrustPin(path: string = trustStorePath()): TrustPin | null {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  if (keys.length !== EXPECTED_KEYS.length || !EXPECTED_KEYS.every((k, i) => keys[i] === k)) return null;
  if (o.trustVersion !== TRUST_VERSION) return null;
  if (o.provider !== PROVIDER_ID) return null;
  if (typeof o.authorityId !== "string" || !/^[0-9a-f]{32}$/.test(o.authorityId)) return null;
  const index = parseNvIndex(o.nvIndex);
  if (!index.ok) return null;
  if (typeof o.nvName !== "string" || !/^[0-9a-f]{4,128}$/.test(o.nvName)) return null;
  if (typeof o.statePath !== "string" || !isAbsolute(o.statePath)) return null;
  return { trustVersion: TRUST_VERSION, provider: PROVIDER_ID, authorityId: o.authorityId, nvIndex: index.index, nvName: o.nvName, statePath: o.statePath };
}
