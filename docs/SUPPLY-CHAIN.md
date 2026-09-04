# TruePad supply chain — what is pinned, what is verified, what is not

The question this document answers is narrow: **when a build runs, what code
executes that nobody in this repository reviewed?**

Every entry below is classified as one of:

- **immutable** — pinned to a commit SHA or an exact version, and cannot change
  under us;
- **integrity-checked** — fetched by a mutable name, but verified against a
  recorded digest or commit before it is used;
- **intentionally mutable** — deliberately not pinned, with the reason stated and
  the blast radius bounded;
- **needs fix** — a real gap, recorded rather than hidden.

## GitHub Actions — immutable

All 28 `uses:` entries across the five workflows are pinned to full 40-character
commit SHAs, with a comment naming the release each SHA was resolved from:

| Action | SHA | Release |
| --- | --- | --- |
| actions/checkout | `11d5960a326750d5838078e36cf38b85af677262` | v4.4.0 |
| actions/setup-node | `49933ea5288caeca8642d1e84afbd3f7d6820020` | v4.4.0 |
| actions/setup-java | `cf277c60eb25467037889841efdb72551f06f6c3` | v4.9.1 |
| actions/upload-artifact | `ea165f8d65b6e75b540449e92b4886f43607fa02` | v4.6.2 |
| actions/configure-pages | `983d7736d9b0ae728b81ab479565c72886d7745b` | v5.0.0 |
| actions/upload-pages-artifact | `56afc609e74202658d3ffba0e8f6dda462b719fa` | v3.0.1 |
| actions/deploy-pages | `d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e` | v4.0.5 |
| android-actions/setup-android | `9fc6c4e9069bf8d3d10b2204b1fb8f6ef7065407` | v3.2.2 |
| gradle/actions/setup-gradle | `ed408507eac070d1f99cc633dbcf757c94c7933a` | v4.4.3 |
| reactivecircus/android-emulator-runner | `a421e43855164a8197daf9d8d40fe71c6996bb0d` | v2.38.0 |
| github/codeql-action/init, /analyze | `cdf488f595d80d6e07e03d4674febd5ab45fa938` | v4.37.9 |

Every SHA was resolved from its tag through the GitHub API and then **verified to
exist as a commit in that repository** before being written down. Two required
recursive dereferencing through nested annotated tag objects — `gradle/actions@v4`
in particular resolves tag → tag → commit, and stopping one level early yields a
SHA that looks plausible and is not a commit. That is exactly the failure a
"verify before writing" step is for.

**CodeQL is pinned too, and that is a deliberate trade.** GitHub recommends
tracking the major tag so the bundled CLI stays fresh. This repository chooses
immutability instead: the analysis that runs is the analysis that was reviewed.
The freshness cost is paid by Dependabot rather than by trusting a moving tag.

Highest-value pins are the three Pages actions, because that job runs with
`pages: write` and `id-token: write` and publishes the live demo.

## Dependabot — the counterweight to pinning

`.github/dependabot.yml` enables the `github-actions` ecosystem weekly. Pinning
without an update mechanism is how a fixed vulnerability stays unfixed, so the two
belong together. Nothing auto-merges; every bump is a pull request a human reads.

npm, Gradle and SwiftPM are **deliberately not** enabled there: each is already
exactly pinned by its lockfile, version catalogue or `Package.resolved`, and each
is audited against advisories as part of the release flow. Adding them would
produce routine version churn without a security signal the existing gates do not
already give. A considered omission, not an oversight.

## Gradle distribution — integrity-checked

`android/gradle/wrapper/gradle-wrapper.properties` now carries

    distributionSha256Sum=efe9a3d147d948d7528a9887fa35abcf24ca1a43ad06439996490f77569b02d1

for `gradle-8.14-all.zip`. Without it the wrapper downloads and executes whatever
arrives, on every clean machine and every CI run.

Verified **two independent ways** rather than copied from one: against Gradle's
published `gradle-8.14-all.zip.sha256`, and against the SHA-256 of the
already-cached distribution on this machine. Both agree. The guard is
mutation-tested — corrupting one character makes the wrapper refuse with
`Verification of Gradle distribution failed!` rather than proceeding.

## npm — immutable

Both workflows use `npm ci`, which installs exactly `package-lock.json` and fails
on any drift, rather than `npm install`, which may resolve differently.

## SwiftPM — immutable

`swift-crypto` is **vendored**, not fetched: pinned to upstream 4.5.2 at commit
`da9d28d6`, with the complete delta recorded in `ios/vendor/EXPECTED-PATCH.diff`
and enforced by `ios/vendor/verify-vendor.sh`. `swift-asn1` is pinned by exact
revision in `Package.resolved`.

## Vendor verification clone — integrity-checked

`verify-vendor.sh` clones upstream by **tag**, which is mutable, and then requires
`HEAD` to equal the pinned **commit**, failing with *"a moved tag is a
supply-chain event, not a merge conflict"*. So the mutable reference is used only
to fetch; the commit is what is trusted.

## Playwright browsers — intentionally mutable

`npx playwright install --with-deps chromium` (deploy workflow) downloads browser
binaries and apt packages at run time. The Playwright *version* comes from
`package-lock.json`; the browser build it then fetches is not separately pinned
here. Bounded: this is the end-to-end test job only. No browser binary reaches a
shipped artifact, and the job gates the deploy rather than producing it.

## swtpm / tpm2-tools — intentionally mutable

`apt-get install swtpm swtpm-tools tpm2-tools xxd` installs unpinned Ubuntu
packages. Bounded, and worth being precise about what that job is: it is the TPM
**emulator** interoperability check, which the workflow itself names *"NOT
hardware validation"*. It proves wire interoperability against a software TPM. The
physical TPM gate is separate and remains outstanding, so a version drift here
cannot inflate a hardware claim.

## Gradle dependency verification — NEEDS FIX (recorded, not closed)

Gradle resolves from `google()` and `mavenCentral()` with exact versions pinned in
`android/gradle/libs.versions.toml`, but **`verification-metadata.xml` is not
enabled**, so individual artifacts are not checksum- or signature-verified at
resolution time.

Exact versions mean a passive attacker cannot substitute a *different version*;
they do not stop a compromised repository serving different bytes for the same
coordinates. Enabling verification requires generating and reviewing metadata for
every artifact on the resolution graph, which is a substantial change and is not
bundled into a security-fix commit.

Recorded as an open item rather than quietly accepted. The mitigations that do
exist today: exact version pins, an advisory sweep over all 106 GAVs on the real
`releaseRuntimeClasspath`, and the rule that a Bouncy Castle bump must re-run the
SPT known-answer corpora.
