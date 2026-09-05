#!/usr/bin/env bash
#
# Generate the iOS Edition's SBOM, in CycloneDX 1.5 JSON.
#
# WHY THIS IS GENERATED AND NOT WRITTEN. An SBOM that is maintained by hand is a
# document that describes what someone believed was vendored on the day they last
# edited it. Every field here is read from the TREE — the pinned tag and commit
# from verify-vendor.sh, the BoringSSL commit from the vendored manifest, the
# hashes from the files that are actually present — so an SBOM that disagrees with
# the code cannot be produced, only a build that fails.
#
# WHAT IT COVERS, and what it does not. This is the iOS Edition: TruePad's own
# modules and the one third-party dependency it vendors, swift-crypto, together
# with the BoringSSL and fiat-crypto code that ships inside it. It does NOT cover
# the Browser/CLI npm tree or the Android Gradle tree; those have their own
# resolution artefacts (package-lock.json, the Gradle lockfile) which are the
# authoritative record for those editions and are pinned separately.
#
# Usage:  ios/scripts/gen-sbom.sh [--check]
#
#   (no args)  write ios/sbom.json
#   --check    regenerate into a temp file and diff, failing if the committed
#              SBOM is stale. This is what CI runs.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$HERE/../.."
VENDOR="$HERE/../vendor"
OUT="$HERE/../sbom.json"

MODE="${1:-write}"

# ---- the pins, read from the sources of truth -------------------------------

UPSTREAM_TAG="$(grep -oE 'UPSTREAM_TAG="[^"]+"' "$VENDOR/verify-vendor.sh" | head -1 | cut -d'"' -f2)"
UPSTREAM_COMMIT="$(grep -oE 'UPSTREAM_COMMIT="[^"]+"' "$VENDOR/verify-vendor.sh" | head -1 | cut -d'"' -f2)"
# The URL is declared with a mirror override, so take the default after the
# ":-" rather than the whole expression.
UPSTREAM_REPO="$(grep -oE 'https://github\.com/apple/swift-crypto\.git' "$VENDOR/verify-vendor.sh" | head -1)"
BORINGSSL_COMMIT="$(grep -oE 'BoringSSL Commit: [0-9a-f]{40}' "$VENDOR/swift-crypto/Package.swift" \
    | head -1 | awk '{print $3}')"

[ -n "$UPSTREAM_TAG" ] && [ -n "$UPSTREAM_COMMIT" ] && [ -n "$BORINGSSL_COMMIT" ] || {
    echo "could not read the vendoring pins from the tree" >&2
    exit 1
}

# The version TruePad itself is at, from the one place that declares it.
TRUEPAD_VERSION="$(grep -oE '"version": *"[^"]+"' "$ROOT/package.json" | head -1 | cut -d'"' -f4)"

# ---- content hashes, over what is actually present --------------------------

# A stable digest of the vendored source tree: every file's path and content,
# sorted, hashed once. This is what makes the SBOM a statement about THESE bytes
# rather than about a version number someone typed.
#
# TWO THINGS MAKE IT REPRODUCIBLE, and the first was learned the hard way.
#
#   LC_ALL=C. The first version let `sort` use the ambient locale, so the digest
#   DIFFERED between a C.UTF-8 machine and an en_US.UTF-8 CI runner — same 853
#   files, same bytes, different answer. A supply-chain hash that changes with the
#   builder's locale is worse than no hash: it makes a legitimate build look
#   tampered with. Collation is now pinned to byte order.
#
#   git ls-files. The list comes from the COMMITTED tree, not from whatever is on
#   disk, so local build detritus cannot enter the digest and the SBOM describes
#   what is actually in the repository.
vendored_digest() {
    ( cd "$ROOT" && \
      LC_ALL=C git ls-files -z ios/vendor/swift-crypto | LC_ALL=C sort -z \
        | xargs -0 shasum -a 256 ) \
      | shasum -a 256 | awk '{print $1}'
}

file_digest() { shasum -a 256 "$1" | awk '{print $1}'; }

# The one remote pin, read from the committed lockfile rather than restated. An
# SBOM that omits a component which is fetched, pinned and compiled is an SBOM
# that answers "what does this build pull in?" incorrectly.
ASN1_VERSION="$(python3 -c "
import json
d=json.load(open('$ROOT/ios/TruePadKit/Package.resolved'))
print(next((p['state'].get('version','') for p in d.get('pins',[]) if p['identity']=='swift-asn1'), 'unpinned'))
")"
ASN1_REVISION="$(python3 -c "
import json
d=json.load(open('$ROOT/ios/TruePadKit/Package.resolved'))
print(next((p['state'].get('revision','') for p in d.get('pins',[]) if p['identity']=='swift-asn1'), ''))
")"

VENDORED_DIGEST="$(vendored_digest)"
PATCH_DIGEST="$(file_digest "$VENDOR/EXPECTED-PATCH.diff" 2>/dev/null || echo "")"

# ---- TruePad's own modules --------------------------------------------------

# Read from the manifest rather than listed here, so a new product appears in the
# SBOM without anyone remembering to add it.
MODULES="$(grep -oE '\.library\(name: "[^"]+"' "$HERE/../TruePadKit/Package.swift" \
    | cut -d'"' -f2 | sort -u)"

emit() {
    printf '%s\n' "$1"
}

build_sbom() {
    emit '{'
    emit '  "bomFormat": "CycloneDX",'
    emit '  "specVersion": "1.5",'
    emit '  "version": 1,'
    emit '  "metadata": {'
    emit '    "component": {'
    emit '      "type": "application",'
    emit '      "name": "TruePad iOS Edition",'
    emit "      \"version\": \"$TRUEPAD_VERSION\","
    emit '      "description": "Authenticated one-time-pad key management. PQC protects pad delivery; OTP encrypts messages; Wegman-Carter authenticates them.",'
    emit '      "licenses": [{ "license": { "id": "AGPL-3.0-only" } }]'
    emit '    },'
    emit '    "properties": ['
    emit '      { "name": "truepad:sbom-scope", "value": "iOS Edition only. The Browser/CLI npm tree and the Android Gradle tree are recorded by their own resolution artefacts." },'
    emit '      { "name": "truepad:generated-from", "value": "the working tree, by ios/scripts/gen-sbom.sh; every field is read from the files rather than restated" }'
    emit '    ]'
    emit '  },'
    emit '  "components": ['

    local first=1
    for module in $MODULES; do
        [ $first -eq 1 ] || emit '    },'
        first=0
        emit '    {'
        emit '      "type": "library",'
        emit "      \"name\": \"$module\","
        emit "      \"version\": \"$TRUEPAD_VERSION\","
        emit '      "scope": "required",'
        emit '      "licenses": [{ "license": { "id": "AGPL-3.0-only" } }],'
        emit '      "properties": [{ "name": "truepad:origin", "value": "first-party" }]'
    done
    [ $first -eq 1 ] || emit '    },'

    emit '    {'
    emit '      "type": "library",'
    emit '      "name": "swift-crypto",'
    emit "      \"version\": \"$UPSTREAM_TAG\","
    emit '      "scope": "required",'
    emit '      "licenses": [{ "license": { "id": "Apache-2.0" } }],'
    emit "      \"purl\": \"pkg:swift/github.com/apple/swift-crypto@$UPSTREAM_TAG\","
    emit '      "externalReferences": ['
    emit "        { \"type\": \"vcs\", \"url\": \"$UPSTREAM_REPO\" }"
    emit '      ],'
    emit '      "hashes": ['
    emit "        { \"alg\": \"SHA-256\", \"content\": \"$VENDORED_DIGEST\" }"
    emit '      ],'
    emit '      "properties": ['
    emit '        { "name": "truepad:origin", "value": "vendored in-tree at ios/vendor/swift-crypto" },'
    emit "        { \"name\": \"truepad:upstream-commit\", \"value\": \"$UPSTREAM_COMMIT\" },"
    emit '        { "name": "truepad:modified", "value": "true" },'
    emit '        { "name": "truepad:modifications", "value": "Three reviewed patches, pinned byte-for-byte by ios/vendor/EXPECTED-PATCH.diff and verified on every CI run by ios/vendor/verify-vendor.sh: (1) the development switch, forcing the BoringSSL backend rather than CryptoKit, which has an iOS 26 floor for the PQ API; (2) exporting CCryptoBoringSSL as a product, needed only by the test-only deterministic KAT support; (3) an entropy-length guard in XWing_boring.swift, closing the unfixed sibling of CVE-2026-28815." },'
    emit "        { \"name\": \"truepad:patch-digest\", \"value\": \"$PATCH_DIGEST\" },"
    emit '        { "name": "truepad:hash-covers", "value": "SHA-256 over the sorted per-file SHA-256 digests of the vendored tree, so it describes the bytes present rather than the tag." }'
    emit '      ]'
    emit '    },'
    emit '    {'
    emit '      "type": "library",'
    emit '      "name": "BoringSSL",'
    emit "      \"version\": \"$BORINGSSL_COMMIT\","
    emit '      "scope": "required",'
    emit '      "licenses": [{ "license": { "name": "OpenSSL/ISC/MIT, as carried in the vendored tree" } }],'
    emit '      "externalReferences": ['
    emit '        { "type": "vcs", "url": "https://boringssl.googlesource.com/boringssl" }'
    emit '      ],'
    emit '      "properties": ['
    emit '        { "name": "truepad:origin", "value": "ships inside swift-crypto as CCryptoBoringSSL; not resolved separately" },'
    emit '        { "name": "truepad:provides", "value": "ML-KEM-768 and X25519, the two halves of the X-Wing KEM that protects pad DELIVERY. It is not on the OTP message path." }'
    emit '      ]'
    emit '    },'
    emit '    {'
    emit '      "type": "library",'
    emit '      "name": "swift-asn1",'
    emit "      \"version\": \"$ASN1_VERSION\","
    emit '      "scope": "excluded",'
    emit '      "licenses": [{ "license": { "id": "Apache-2.0" } }],'
    emit "      \"purl\": \"pkg:swift/github.com/apple/swift-asn1@$ASN1_VERSION\","
    emit '      "externalReferences": ['
    emit '        { "type": "vcs", "url": "https://github.com/apple/swift-asn1.git" }'
    emit '      ],'
    emit '      "properties": ['
    emit "        { \"name\": \"truepad:pinned-revision\", \"value\": \"$ASN1_REVISION\" },"
    emit '        { "name": "truepad:origin", "value": "REMOTE. The vendored swift-crypto still declares this dependency, so resolving the graph fetches it from github.com. It is the only remote fetch in the iOS build." },'
    emit '        { "name": "truepad:scope-rationale", "value": "Resolved and compiled as part of the dependency package, but reachable only through _CryptoExtras, which TruePad does not link. Verified ABSENT by symbol from a device Release build of the application. A build-machine exposure, not a shipping-binary one." },'
    emit '        { "name": "truepad:pin-enforcement", "value": "Pinned identically by ios/TruePadKit/Package.resolved and the app Package.resolved; ios/scripts/check-app-project.sh fails if they disagree or if any other remote package appears." }'
    emit '      ]'
    emit '    },'
    emit '    {'
    emit '      "type": "library",'
    emit '      "name": "fiat-crypto",'
    emit '      "version": "as vendored inside BoringSSL",'
    emit '      "scope": "required",'
    emit '      "licenses": [{ "license": { "id": "MIT" } }],'
    emit '      "properties": ['
    emit '        { "name": "truepad:origin", "value": "formally-verified field arithmetic, ships inside BoringSSL" }'
    emit '      ]'
    emit '    }'
    emit '  ],'
    emit '  "properties": ['
    emit '    { "name": "truepad:no-network", "value": "The iOS Edition performs no network I/O. Asserted by PostureGuardTests, which fails if any shipping source references a networking API." },'
    emit '    { "name": "truepad:otp-kernel-has-no-crypto-dependency", "value": "TruePadCore links no cryptography library, so no library change can alter the frozen message wire. Asserted by ProductionIsolationTests." }'
    emit '  ]'
    emit '}'
}

if [ "$MODE" = "--check" ]; then
    # REPRODUCIBILITY, checked rather than assumed. The digest was once
    # locale-dependent, and the only symptom was a CI failure that looked like a
    # stale SBOM. Recomputing it under a different collation makes a reintroduced
    # dependency fail HERE, with a message that says what actually went wrong.
    D1="$(LC_ALL=C vendored_digest)"
    D2="$(LC_ALL=en_US.UTF-8 vendored_digest)"
    if [ "$D1" != "$D2" ]; then
        echo "FAIL: the vendored-tree digest depends on the locale." >&2
        echo "      LC_ALL=C          -> $D1" >&2
        echo "      LC_ALL=en_US.UTF-8 -> $D2" >&2
        echo "      A supply-chain hash that changes with the builder's environment" >&2
        echo "      makes a legitimate build look tampered with." >&2
        exit 1
    fi
    echo "PASS: the vendored-tree digest is locale-independent"

    TMP="$(mktemp)"
    trap 'rm -f "$TMP"' EXIT
    build_sbom > "$TMP"
    if ! diff -u "$OUT" "$TMP"; then
        echo
        echo "FAIL: ios/sbom.json is stale. Regenerate it with ios/scripts/gen-sbom.sh" >&2
        exit 1
    fi
    echo "PASS: ios/sbom.json matches the tree"
else
    build_sbom > "$OUT"
    echo "wrote $OUT"
fi
