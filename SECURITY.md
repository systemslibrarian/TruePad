# Security Policy

## What TruePad is

TruePad 2 is an **educational cryptographic systems project** with working
implementations: a Browser Edition, an authenticated Format v2 store and CLI,
and sealed online pad delivery. The code is real, the tests are real, and the
claims are audited against the implementation.

It is **not a recommendation to deploy one-time pads for routine
communication.** A one-time pad moves the entire problem into key management —
generating good material, keeping it secret, never reusing a symbol, and getting
it to the other person. TruePad exists to show what that costs when you actually
build it.

## Reporting a vulnerability

**Private vulnerability reporting is enabled on this repository.** Use GitHub's
own **Report a vulnerability** button — on the repository's **Security** tab,
under **Advisories** — to open a private advisory only the maintainers can see.
That is the correct route for anything with working exploit detail, and it keeps
the report out of public view until there is a fix to disclose alongside it.

- **Do not put working exploit detail in a public issue.** The private advisory
  is the place for a proof of concept, a reproduction, or a concrete path to pad
  reuse or a secret crossing the worker boundary. A public issue may describe the
  *class* of problem, but the recipe belongs in the private channel.
- If you would rather sketch the *class* of problem publicly first — "pad reuse
  reachable through X", "a secret crosses the worker boundary in Y" — and share
  the specifics through the private advisory, that is welcome too.

## In scope

Reports are in scope if they involve:

- **pad reuse** — any path where a pad symbol can serve twice
- **burn / commit ordering** — emitting before durably recording consumption
- **Store Format v2** — framing, partitioning, canonical authenticated bytes
- **Wegman–Carter authentication** — tag forgery, key or mask reuse, POLYVAL use
- **witness and rollback behaviour** — including the documented browser boundary
- **destruction and tombstones** — a destroyed pad becoming usable again
- **provenance** — an imported pad passing itself off as generated here
- **the Browser worker secret boundary** — pad material, decapsulation keys,
  shared secrets or derived keys reaching the page
- **Sealed Pad Transfer request binding** — a package opening against a request
  it is not bound to
- **one pad / one handoff** and **one request / one pad** — any second
  independent handoff, or a request redirected to another pad
- **consume-before-import** — importing without a durable consumption record
- **secret leakage** of any kind, including through error text or logs
- **cryptographic implementation** defects in the core or the transfer suite
- **claims text that materially misrepresents shipped behaviour**

That last item is deliberate. This project's central commitment is not claiming
more than the implementation earns, so a document or screen that overstates what
the code does is a defect in the same sense as a broken check — and it has been
treated that way in past audits.

## Known model boundaries

These are documented limits, not undisclosed weaknesses:

- TruePad **cannot prove physical randomness**. It records what you declared
  about a source; it does not certify it.
- Software **cannot prove physical erasure**. Best-effort wipes are hygiene.
- **A restored or cloned browser profile can rewind the local state domain** —
  counters, markers and request state together. There is no external independent
  witness in the Browser Edition.
- The **OPFS write fallback is not truly atomic.** Safety rests on marker
  existence, terminal precedence, readback and fail-closed classification, never
  on an assumption that replacement is atomic.
- **Comparing the words is human behaviour.** The software can order its own
  screens; it cannot know whether two people actually compared anything.
- **Receiver-first display cannot prove who spoke first.** It supports an honest
  operator's ceremony; it is not enforcement.
- The **raw `.pad` file is secret material** and stays that way wherever it goes.
- An **archived `.tps2` inherits computational assumptions**, including
  harvest-now-decrypt-later: it could become readable if the recipient's device
  storage is restored from a backup, or if the delivery cryptography is broken
  later.

**A defect that violates one of these documented boundaries is still a
vulnerability.** The boundary describes what TruePad does not promise — not a
licence for the code to fail inside what it does.

## Supported versions

The supported release line is **2.0.x**: security fixes land there. Fixes also
target current `master`, which carries **TruePad 3.0 development** — where the
next release line is prepared. 3.0 is not released, not tagged, and not published;
its maximum-assurance architecture is development code until a formal 3.0 release.

There is no supported v1.x release, because there was never a formal TruePad 1.0.

## Related documents

- [Product claims](docs/PRODUCT-CLAIMS.md) — every claim, and what proves it
- [Browser security](docs/BROWSER-SECURITY.md) — the Browser Edition's model
- [Sealed Pad Transfer release audit](docs/SEALED-PAD-TRANSFER-RELEASE-AUDIT.md)
