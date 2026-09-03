# Physical TPM validation procedure

> **STATUS: TEST PROCEDURE PREPARED — NOT EXECUTED. Physical TPM: OUTSTANDING.**
> This is a checklist to run on a genuine TPM 2.0 host. It has not been run on
> real hardware. swtpm/emulator results (the `test:tpm-interop` CI) are
> interoperability evidence only and do **not** satisfy this gate.

## Prerequisites

- A machine with a **discrete or firmware TPM 2.0** (not swtpm), Linux, and
  `tpm2-tools` (`tpm2_nvreadpublic`, `tpm2_nvread`, `tpm2_nvincrement`,
  `tpm2_nvdefine`, `tpm2_nvundefine`).
- Node ≥ 22.18 and a checkout of the release-candidate SHA.
- An NV index the operator is willing to dedicate (TruePad never defines one).
- Record: host model, TPM vendor/firmware version, tpm2-tools version, SHA.

Run each step; record the actual output. A step that does not match the expected
result is a **release-blocking** failure — report it, do not proceed.

## Steps

1. **Genuine hardware TPM discovery.** Confirm the TPM is real hardware
   (`/dev/tpm0` or a hardware TCTI), not swtpm. Record the device path and vendor.
2. **NV counter creation (operator).** Define an NV **counter** index
   (`nt=1`, 8 octets, non-orderly). Expected: created; TruePad did not define it.
3. **Required attributes.** `tpm2_nvreadpublic` shows `nt=0x1` (counter), size 8,
   `TPMA_NV_ORDERLY` clear. Expected: matches; an orderly or non-counter index is
   later refused.
4. **Name binding.** `truepad2 witness platform init <state> --nv-index <NV>`.
   Expected: succeeds; the state file binds to the index's **TPM Name** (which
   changes when a fresh counter's first increment sets `WRITTEN`).
5. **Authority pin.** `truepad2 authority pin <state> --nv-index <NV> --confirm
   <authorityId>`. Expected: prints the public identity; pins only after the
   `--confirm` matches; the pin lives outside any pair directory.
6. **Burn/open progression.** Generate a `platform-monotonic` pair against the
   pinned state; send and receive. Expected: each burn advances the TPM counter by
   exactly one; open verifies; loss-before-output withholds output but never reuses.
7. **Stale platform-state restore detection.** Copy the state file, advance (burn),
   restore the old copy while the TPM stays forward, and attempt a burn. Expected:
   refused — the state is *behind* its TPM anchor (`witness-regressed` / anchor
   BEHIND). Nothing consumed.
8. **Recreated-index Name mismatch.** `tpm2_nvundefine` then `tpm2_nvdefine` the
   same handle with a different public area; restore the old state; attempt a burn.
   Expected: refused — the live TPM Name no longer matches the bound Name.
9. **Trust-pin removal refusal.** `truepad2 authority unpin`; attempt a
   platform-monotonic burn/status. Expected: burn refused (`no trusted platform
   authority is pinned`); status INSUFFICIENT (never gold).
10. **Ceremony assurance transitions.** Pin, `ceremony create` (records
    `ceremony-created`), `ceremony accept` (advances to `handoff-accepted`).
    Expected: `status` shows CONDITIONALLY ELIGIBLE beside the unproven premises,
    only after accept and only against the pinned authority.
11. **Terminal withdrawal.** `ceremony withdraw`. Expected: NOT ELIGIBLE; deleting
    the sidecar does not resurrect it (platform authority is terminal); re-accept
    refused.
12. **Power-cycle behaviour (where feasible).** Interrupt a burn between the durable
    PREPARE and the TPM increment (or power-cycle mid-operation); re-run.
    Expected: the interrupted operation is recoverable to the *prepared* level and
    never a fabricated stronger level; no pad byte reused; output not falsely
    emitted.

## Reporting

Record for each step: command, actual output (redact nothing security-relevant;
there are no secrets in this flow), pass/fail. Retain the host/TPM identifiers and
the SHA. Only after every step passes on **real hardware** may the release
checklist's "Physical TPM hardware validation" item be marked complete.

**PHYSICAL TPM VALIDATED** is a distinct claim from **TEST PROCEDURE PREPARED**.
Only the former, backed by a real-hardware run log, may be stated at release.
