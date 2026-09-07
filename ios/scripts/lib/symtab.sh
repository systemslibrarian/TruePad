# Symbol-table probing that cannot lie by omission.
#
# WHY THIS IS A FILE AND NOT A PIPELINE. `nm ... | grep -q ...` under
# `set -o pipefail` is a trap on a large stream: `grep -q` exits at its first
# match, closes the pipe, `nm` dies of SIGPIPE, and pipefail reports the whole
# pipeline as FAILED — so "does this object contain X" takes the NOT-FOUND branch
# while X is sitting right there.
#
# This is not hypothetical and it is not new. The header of
# inspect-release-binary.sh has documented it since the first version of that
# script, which was entirely vacuous for this reason. Section 4 then reintroduced
# the same pattern and, on 2026-09-07, failed the release for a
# `CCryptoBoringSSL_XWING_decap` that was present the whole time. Measured against
# the real object, whose `nm -g` output is ~177,000 bytes against a 64 KiB pipe
# buffer: `decap` was reported missing in 25 of 200 trials and `encap` in 9 of
# 200. `decap` sorts one line earlier, so `grep` exits marginally sooner and
# leaves marginally more of `nm`'s output unwritten — which is the whole
# difference between the symbol that failed the release and the one that did not.
#
# So: capture once, to a file, and keep the capturing command's own exit status.
# Reading a FILE has no upstream process to kill.

# symtab_capture <object> <outfile>
# Returns nm's OWN exit status. Not a pipeline, so nothing can mask it.
symtab_capture() {
    nm -g "$1" > "$2" 2>/dev/null
}

# symtab_has <symbol-file> <symbol>
# Fixed-string search over a FILE. Safe: no producer to SIGPIPE.
symtab_has() {
    grep -qF -- "$2" "$1"
}

# symtab_matches <symbol-file> <extended-regex>
# The matching lines, for diagnostics. Never used to DECIDE anything.
symtab_matches() {
    grep -E -- "$2" "$1" || true
}

# symtab_candidates <directory> <basename>
# Every matching object, in LC_ALL=C sorted order, one per line. Deterministic:
# filesystem traversal order must never decide which object a gate inspects.
symtab_candidates() {
    find "$1" -name "$2" -type f 2>/dev/null | LC_ALL=C sort
}
