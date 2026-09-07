#!/usr/bin/env bash
#
# Prove the symbol-table gate is not vacuous — WITHOUT rebuilding iOS.
#
# The gate this tests exists because the previous one lied. Against a real object
# in which both X-Wing symbols were independently verified present, the old
# `nm -g "$OBJ" | grep -qF "$sym"` pipeline reported `encap` missing 9 times in
# 200 and `decap` missing 25 times in 200. The nm stream was 177,247 bytes against
# a 64 KiB pipe buffer; under `pipefail`, `grep -q` exits at its first match, the
# pipe closes, and nm dies of SIGPIPE — so the pipeline reports failure for a
# symbol that is present. `decap` sorts one line before `encap`, which is the
# entire reason one of them failed a release and the other did not.
#
# So this file asserts the replacement finds what is there, fails on what is not,
# fails LOUDLY when the probe itself breaks, is order-independent, and that the
# unsafe construct cannot come back.
#
# Usage:  ios/scripts/selftest-symtab.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/symtab.sh
. "$HERE/lib/symtab.sh"

FAIL=0
pass() { printf '  PASS  %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAIL=1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ENCAP=CCryptoBoringSSL_XWING_encap
DECAP=CCryptoBoringSSL_XWING_decap

# A symbol table the size of the real one, so the large-stream behaviour this
# exists to police is actually exercised rather than assumed.
BIG="$TMP/big-symbols.txt"
: > "$BIG"
for i in $(seq 1 3000); do
    printf '00000000000%05x T _CCryptoBoringSSL_filler_symbol_%05d_padding_padding_padding\n' "$i" "$i" >> "$BIG"
done
printf '000000000009bde8 T _%s\n' "$DECAP" >> "$BIG"
printf '000000000009bbbc T _%s\n' "$ENCAP" >> "$BIG"
SIZE="$(wc -c < "$BIG" | tr -d ' ')"
if [ "$SIZE" -lt 65536 ]; then
    fail "the fixture is only $SIZE bytes — smaller than a pipe buffer, so it does not exercise the case this gate exists for"
else
    pass "fixture symbol table is $SIZE bytes, larger than a 64 KiB pipe buffer"
fi

echo
echo "== 1. both symbols present => found =="
if symtab_has "$BIG" "$ENCAP" && symtab_has "$BIG" "$DECAP"; then
    pass "both symbols found in a large captured table"
else
    fail "a symbol that is present was not found — the probe is broken"
fi

# THE REGRESSION THIS FILE IS NAMED FOR. 200 trials, because the defect it
# replaces was intermittent at 4.5% and 12.5% and a single trial would have
# passed straight through it.
echo
echo "== 2. the probe does not intermittently lie =="
for sym in "$ENCAP" "$DECAP"; do
    misses=0
    for _ in $(seq 1 200); do
        symtab_has "$BIG" "$sym" || misses=$((misses + 1))
    done
    if [ "$misses" -eq 0 ]; then
        pass "$sym found in 200/200 trials"
    else
        fail "$sym reported missing in $misses/200 trials — the probe is still nondeterministic"
    fi
done

echo
echo "== 3. a symbol that is absent => not found =="
grep -v -F "$ENCAP" "$BIG" > "$TMP/no-encap.txt"
grep -v -F "$DECAP" "$BIG" > "$TMP/no-decap.txt"
if symtab_has "$TMP/no-encap.txt" "$ENCAP"; then
    fail "encap removed from the table but still reported present — the gate cannot fail"
else
    pass "encap removed => reported absent"
fi
if symtab_has "$TMP/no-decap.txt" "$DECAP"; then
    fail "decap removed from the table but still reported present — the gate cannot fail"
else
    pass "decap removed => reported absent"
fi
# ...and removing one must not disturb the other.
if symtab_has "$TMP/no-encap.txt" "$DECAP"; then
    pass "removing encap leaves decap findable"
else
    fail "removing one symbol hid the other — the probe is not independent"
fi

echo
echo "== 4. a broken probe fails loudly rather than reporting 'absent' =="
if symtab_capture "$TMP/definitely-not-an-object" "$TMP/out.txt"; then
    fail "nm 'succeeded' on a file that does not exist — a broken probe would read as a clean binary"
else
    pass "nm failing is reported as failure, not as a missing symbol"
fi

echo
echo "== 5. no candidates is a failure, not a pass =="
mkdir -p "$TMP/empty-products"
if [ -z "$(symtab_candidates "$TMP/empty-products" 'CCryptoBoringSSL.o')" ]; then
    pass "an empty products directory yields no candidates (the caller must fail)"
else
    fail "candidates were reported where there are none"
fi

echo
echo "== 6. candidate order cannot depend on the filesystem =="
mkdir -p "$TMP/prod/zzz" "$TMP/prod/aaa" "$TMP/prod/mmm"
# Created deliberately out of order.
: > "$TMP/prod/zzz/CCryptoBoringSSL.o"
: > "$TMP/prod/mmm/CCryptoBoringSSL.o"
: > "$TMP/prod/aaa/CCryptoBoringSSL.o"
GOT="$(symtab_candidates "$TMP/prod" 'CCryptoBoringSSL.o' | sed "s|^$TMP/prod/||" | tr '\n' ' ')"
WANT="aaa/CCryptoBoringSSL.o mmm/CCryptoBoringSSL.o zzz/CCryptoBoringSSL.o "
if [ "$GOT" = "$WANT" ]; then
    pass "candidates are LC_ALL=C sorted regardless of creation order"
else
    fail "candidate order is not deterministic: got '$GOT'"
fi

echo
echo "== 7. the unsafe construct cannot come back =="
# The gate is only as good as the pattern staying out of it. This is the guard
# that would have caught section 4 reintroducing what the header already warned
# about.
OFFENDERS=""
for f in "$HERE/inspect-release-binary.sh" "$HERE/lib/symtab.sh"; do
    # CODE ONLY. The first version of this check scanned the whole file and
    # fired on symtab.sh's own comment DESCRIBING the banned construct — a guard
    # failing on its own documentation, which is the vacuity mirror image of the
    # bug it polices. Comment lines are stripped first.
    #
    # A live `nm ... | grep -q` DECIDES a question from a pipeline that pipefail
    # can turn into a lie. Diagnostics that pipe into `sed`/`head` are fine:
    # they decide nothing.
    if grep -vE '^[[:space:]]*#' "$f" \
        | grep -nE 'nm[^|]*\|[[:space:]]*grep[[:space:]]+-[A-Za-z]*q' > "$TMP/hits.txt" 2>/dev/null; then
        OFFENDERS="$OFFENDERS $f"
        sed 's/^/    /' "$TMP/hits.txt"
    fi
done
if [ -n "$OFFENDERS" ]; then
    fail "a live 'nm | grep -q' decision is back in:$OFFENDERS"
else
    pass "no live 'nm | grep -q' decision in the inspection gate"
fi
# POSITIVE CONTROL for the guard itself: it must fire on the exact old line.
printf '%s\n' 'if nm -g "$BORING" 2>/dev/null | grep -qF "$symbol"; then' > "$TMP/old-pattern.sh"
if grep -vE '^[[:space:]]*#' "$TMP/old-pattern.sh" \
    | grep -qE 'nm[^|]*\|[[:space:]]*grep[[:space:]]+-[A-Za-z]*q'; then
    pass "the guard fires on the exact construct that failed the release"
else
    fail "the guard does not recognise the construct it exists to ban — it is vacuous"
fi
# ...and must NOT fire on a comment that merely mentions it, which is how the
# first version of this guard failed.
printf '%s\n' '# never write: nm -g "$OBJ" | grep -q "$sym"' > "$TMP/only-a-comment.sh"
if grep -vE '^[[:space:]]*#' "$TMP/only-a-comment.sh" \
    | grep -qE 'nm[^|]*\|[[:space:]]*grep[[:space:]]+-[A-Za-z]*q'; then
    fail "the guard fires on a comment describing the construct — it cannot tell code from prose"
else
    pass "the guard ignores a comment that only describes the construct"
fi

echo
if [ "$FAIL" -eq 0 ]; then
    echo "RESULT: PASS -- the symbol-table gate finds what is there and fails on what is not."
else
    echo "RESULT: FAIL"
fi
exit "$FAIL"
