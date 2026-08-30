#!/usr/bin/env bash
# =============================================================================
# TruePad — TPM SOFTWARE-EMULATOR INTEROPERABILITY (NOT hardware validation)
# -----------------------------------------------------------------------------
# Launches a real swtpm, points real tpm2-tools at it, and drives the real
# `truepad2` CLI against it. What this proves is INTEROPERABILITY: command-line
# syntax, TCTI setup, tpm2_nvreadpublic YAML shape, NV attribute rendering, raw
# 8-octet counter parsing, the freshly-defined/unwritten counter behaviour, the
# authorization model, increment semantics, and Name retrieval.
#
# What it does NOT prove, and must never be described as proving: hardware
# rollback resistance. swtpm's backing state is a file that can itself be
# snapshotted and restored, so it earns no part of the monotonicity claim. The
# restore test below shows TruePad REFUSES a rolled-back state file; it does not
# show that an emulator's counter cannot be rolled back, because it can.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
TPMSTATE="$WORK/swtpm-state"
NV_COUNTER="0x01500016"
NV_ORDERLY="0x01500017"
NV_ORDINARY="0x01500018"
NV_WRONGSIZE="0x01500019"
PASS=0
FAIL=0

cleanup() {
  if [[ -n "${SWTPM_PID:-}" ]]; then kill "$SWTPM_PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

ok()   { PASS=$((PASS+1)); echo "  ok   $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
check(){ if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (expected '$3', got '$2')"; fi; }

echo "=== versions actually under test ==="
swtpm --version | head -1
tpm2_nvreadpublic --version | head -1
echo

# --- launch a real software TPM ---------------------------------------------
mkdir -p "$TPMSTATE"
swtpm socket --tpm2 --tpmstate "dir=$TPMSTATE" \
  --ctrl "type=tcp,port=2322" --server "type=tcp,port=2321" \
  --flags not-need-init,startup-clear --daemon
SWTPM_PID="$(pgrep -f 'swtpm socket --tpm2' | head -1 || true)"
export TPM2TOOLS_TCTI="swtpm:host=127.0.0.1,port=2321"
sleep 1
tpm2_getcap properties-fixed >/dev/null
echo "swtpm is up on the swtpm TCTI"
echo

truepad2() { node "$ROOT/bin/truepad2.mjs" "$@"; }

# --- 1. provision a fresh non-ORDERLY NV COUNTER ----------------------------
echo "=== NV provisioning (operator's job — TruePad never defines an index) ==="
tpm2_nvdefine -C o -s 8 -a "authread|authwrite|nt=1" "$NV_COUNTER" >/dev/null
echo "defined $NV_COUNTER as an 8-octet counter"

# --- 2. TPMA_NV_WRITTEN is initially CLEAR ----------------------------------
PUB="$(tpm2_nvreadpublic "$NV_COUNTER")"
echo "--- real tpm2_nvreadpublic output ---"; echo "$PUB"; echo "-------------------------------------"
if echo "$PUB" | grep -qi "written"; then bad "fresh counter must not be 'written'"; else ok "TPMA_NV_WRITTEN is CLEAR on a fresh counter"; fi

# --- 3. a raw read before the first increment fails as NV_UNINITIALIZED -----
if RAW_ERR="$(tpm2_nvread "$NV_COUNTER" -s 8 2>&1 >/dev/null)"; then
  bad "reading an unwritten counter should have failed"
else
  if echo "$RAW_ERR" | grep -qi "UNINITIALIZED"; then
    ok "raw read before first increment fails NV_UNINITIALIZED"
  else
    ok "raw read before first increment fails ($(echo "$RAW_ERR" | tail -1 | cut -c1-70))"
  fi
fi

# --- 4. platform init SUCCEEDS anyway ---------------------------------------
STATE="$WORK/platform-witness.json"
INIT_JSON="$(truepad2 witness platform init "$STATE" --nv-index "$NV_COUNTER" 2>/dev/null)"
if [[ -n "$INIT_JSON" ]]; then ok "truepad2 witness platform init succeeded on an UNWRITTEN counter"; else bad "platform init failed on a fresh counter"; fi

# --- 5. the state anchor equals the actual TPM counter ----------------------
tpm_counter() { tpm2_nvread "$1" -s 8 2>/dev/null | xxd -p | tr -d '\n' | python3 -c "import sys;print(int(sys.stdin.read().strip() or '0',16))"; }
ANCHOR="$(python3 -c "import json;print(json.load(open('$STATE'))['anchor'])")"
T="$(tpm_counter "$NV_COUNTER")"
check "state anchor equals the real TPM counter" "$ANCHOR" "$T"
echo "  (anchor=$ANCHOR — note a fresh counter need NOT start at zero)"

# --- 6. repeat init is a TRUE no-op -----------------------------------------
BYTES_BEFORE="$(cat "$STATE")"; T_BEFORE="$T"
truepad2 witness platform init "$STATE" --nv-index "$NV_COUNTER" >/dev/null 2>&1
T_AFTER="$(tpm_counter "$NV_COUNTER")"
check "repeat init consumes ZERO counter values" "$T_AFTER" "$T_BEFORE"
if [[ "$(cat "$STATE")" == "$BYTES_BEFORE" ]]; then ok "repeat init leaves the state byte-identical"; else bad "repeat init rewrote the state"; fi

# --- 7-9. a real platform-monotonic pair, and a burn ------------------------
PAIR="$WORK/pair"; SRC="$WORK/src.bin"
head -c 200000 /dev/urandom > "$SRC"
truepad2 gen "$PAIR" --source "$SRC" --encryption-bytes 512 --auth-records 8 \
  --witness-class platform-monotonic --witness-path "$STATE" >/dev/null
ok "gen created a platform-monotonic pair bound to the TPM authority"
T_PRE="$(tpm_counter "$NV_COUNTER")"
ENV_LINE="$(truepad2 burn "$PAIR" --as A "interop" 2>/dev/null)"
T_POST="$(tpm_counter "$NV_COUNTER")"
if [[ -n "$ENV_LINE" ]]; then ok "burn emitted an envelope"; else bad "burn emitted nothing"; fi
check "burn advanced the TPM anchor by exactly one" "$T_POST" "$((T_PRE+1))"
A_NOW="$(python3 -c "import json;print(json.load(open('$STATE'))['anchor'])")"
check "state anchor tracks the TPM after the burn" "$A_NOW" "$T_POST"

# --- 10. raw counter bytes are the big-endian uint64 we parse ---------------
RAWHEX="$(tpm2_nvread "$NV_COUNTER" -s 8 2>/dev/null | xxd -p | tr -d '\n')"
echo "  raw 8 octets: $RAWHEX"
BE="$(python3 -c "print(int('$RAWHEX',16))")"
check "raw octets parse big-endian to the same value" "$BE" "$T_POST"

# --- 11-12. THE RESTORE ATTACK ----------------------------------------------
echo "=== restore attack: old pair + old state file, TPM left forward ==="
cp -r "$PAIR" "$WORK/pair.bak"; cp "$STATE" "$WORK/state.bak"
truepad2 burn "$PAIR" --as A "second" >/dev/null 2>&1
rm -rf "$PAIR"; cp -r "$WORK/pair.bak" "$PAIR"; cp "$WORK/state.bak" "$STATE"
OFF_BEFORE="$(python3 -c "import json;print(json.load(open('$PAIR/a-to-b/head.json'))['encryption']['nextOffset'])")"
T_BEFORE_ATTACK="$(tpm_counter "$NV_COUNTER")"
set +e
ATTACK_OUT="$(truepad2 burn "$PAIR" --as A "should never happen" 2>&1)"
ATTACK_CODE=$?
set -e
OFF_AFTER="$(python3 -c "import json;print(json.load(open('$PAIR/a-to-b/head.json'))['encryption']['nextOffset'])")"
T_AFTER_ATTACK="$(tpm_counter "$NV_COUNTER")"
check "restore attack is REFUSED (exit 2)" "$ATTACK_CODE" "2"
check "  nothing consumed: store offset unchanged" "$OFF_AFTER" "$OFF_BEFORE"
check "  nothing consumed: TPM counter unchanged" "$T_AFTER_ATTACK" "$T_BEFORE_ATTACK"
if echo "$ATTACK_OUT" | grep -qi "BEHIND its TPM anchor"; then ok "  refusal names the anchor regression"; else bad "  refusal did not name the anchor regression: $(echo "$ATTACK_OUT" | tail -1 | cut -c1-90)"; fi

# --- 13. redefinition with a DIFFERENT public area → Name mismatch ----------
echo "=== redefinition with a different public area ==="
cp "$STATE" "$WORK/state.keep"
tpm2_nvundefine -C o "$NV_COUNTER" >/dev/null
tpm2_nvdefine -C o -s 8 -a "ownerread|authread|authwrite|nt=1" "$NV_COUNTER" >/dev/null
NEWNAME="$(tpm2_nvreadpublic "$NV_COUNTER" | sed -n 's/^[[:space:]]*name:[[:space:]]*//p' | head -1)"
OLDNAME="$(python3 -c "import json;print(json.load(open('$WORK/state.keep'))['nvName'])")"
if [[ "$NEWNAME" != "$OLDNAME" ]]; then ok "a different public area yields a different TPM Name"; else bad "Name did not change across redefinition"; fi
cp "$WORK/state.keep" "$STATE"
set +e
NAME_OUT="$(truepad2 burn "$PAIR" --as A "x" 2>&1)"; NAME_CODE=$?
set -e
check "Name mismatch is refused (exit 2)" "$NAME_CODE" "2"
if echo "$NAME_OUT" | grep -qi "no longer has the Name"; then ok "  refusal names the Name mismatch"; else bad "  refusal did not name the Name mismatch"; fi
tpm2_nvundefine -C o "$NV_COUNTER" >/dev/null

# --- 14. same public area → same Name, and TPM counter semantics ------------
echo "=== redefinition with the SAME public area ==="
tpm2_nvdefine -C o -s 8 -a "authread|authwrite|nt=1" "$NV_COUNTER" >/dev/null
SAMENAME="$(tpm2_nvreadpublic "$NV_COUNTER" | sed -n 's/^[[:space:]]*name:[[:space:]]*//p' | head -1)"
if [[ "$SAMENAME" == "$OLDNAME" ]]; then ok "the same public area reproduces the same TPM Name"; else ok "same-area Name differs on this emulator ($SAMENAME)"; fi
tpm2_nvincrement -C "$NV_COUNTER" "$NV_COUNTER" >/dev/null
REBORN="$(tpm_counter "$NV_COUNTER")"
echo "  re-created counter's first value: $REBORN (previous authority reached $T_AFTER_ATTACK)"
if (( REBORN > T_AFTER_ATTACK )); then
  ok "TCG counter semantics hold: a re-created counter starts ABOVE the TPM's largest-ever value"
else
  bad "a re-created counter went backwards ($REBORN <= $T_AFTER_ATTACK)"
fi
tpm2_nvundefine -C o "$NV_COUNTER" >/dev/null

# --- 15-17. indices TruePad must refuse -------------------------------------
echo "=== indices that must be refused ==="
tpm2_nvdefine -C o -s 8 -a "authread|authwrite|nt=1|orderly" "$NV_ORDERLY" >/dev/null
set +e
OUT="$(truepad2 witness platform init "$WORK/s-orderly.json" --nv-index "$NV_ORDERLY" 2>&1)"; C=$?
set -e
if [[ $C -ne 0 ]] && echo "$OUT" | grep -qi "ORDERLY"; then ok "ORDERLY counter is refused"; else bad "ORDERLY counter was not refused"; fi

tpm2_nvdefine -C o -s 8 -a "ownerread|ownerwrite" "$NV_ORDINARY" >/dev/null
set +e
OUT="$(truepad2 witness platform init "$WORK/s-ordinary.json" --nv-index "$NV_ORDINARY" 2>&1)"; C=$?
set -e
if [[ $C -ne 0 ]] && echo "$OUT" | grep -qi "not a TPM NV COUNTER"; then ok "ordinary (non-counter) index is refused"; else bad "ordinary index was not refused"; fi

tpm2_nvdefine -C o -s 32 -a "authread|authwrite|nt=1" "$NV_WRONGSIZE" >/dev/null 2>&1 || true
if tpm2_nvreadpublic "$NV_WRONGSIZE" >/dev/null 2>&1; then
  set +e
  OUT="$(truepad2 witness platform init "$WORK/s-size.json" --nv-index "$NV_WRONGSIZE" 2>&1)"; C=$?
  set -e
  if [[ $C -ne 0 ]] && echo "$OUT" | grep -qi "must be exactly 8"; then ok "wrong-sized index is refused"; else bad "wrong-sized index was not refused"; fi
else
  ok "wrong-sized counter cannot be defined on this TPM (the TPM itself refuses it)"
fi

echo
echo "================================================================"
echo "  $PASS passed, $FAIL failed"
echo "  TPM SOFTWARE-EMULATOR INTEROPERABILITY — NOT hardware validation."
echo "  swtpm's backing state is a file and can itself be restored, so"
echo "  it earns no part of the monotonicity claim."
echo "================================================================"
[[ $FAIL -eq 0 ]]
