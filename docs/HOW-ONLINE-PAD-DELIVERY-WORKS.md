# How TruePad Sends a Pad Securely Online

TruePad's online delivery feature **does not use the one-time pad to send the pad
itself**. It cannot: the whole point of a one-time pad is that the two people
already share one, and at this moment they do not.

Instead the recipient first creates a **one-time receive code**. That code lets
the sender encrypt the pad specifically for that one request, and for nothing
else. Once the recipient has successfully added the pad, the online-delivery
cryptography has finished its job and is never used again. Normal TruePad
messages then use the shared one-time pad and Wegman–Carter authentication
exactly as they always have.

> **Online cryptography delivers the pad.**
> **The one-time pad protects the messages.**

You will sometimes see this written as "PQC delivers the pad, OTP encrypts the
messages." That shorthand is accurate about *which layer does what*, but it hides
the thing that matters most: the delivery layer is **computational**, not
information-theoretic. A pad you carried by hand is not protected by any
assumption about how hard a mathematical problem is. A pad you sent online is.
The rest of this document explains what that difference buys and costs.

---

## The locked-mailbox picture

Creating a receive code is like putting out a **one-time locked mailbox**.

The receive code is the part anyone can see: it carries the public information a
sender needs in order to lock something for that particular mailbox. The private
information needed to *open* the mailbox never leaves the recipient's TruePad —
it stays in their browser's local storage.

Two things this picture does **not** mean:

* **There is no mailbox on a server.** TruePad has no backend. Nothing is
  deposited anywhere, and no TruePad service ever sees the code, the sealed file,
  or the pad.
* **There is no account.** Nobody registers anything. The receive code is
  cryptographic public information and nothing more.

---

## 1. The recipient creates a receive code

When Bob chooses **Add a shared pad → Receive securely online → Create receive
code**, TruePad generates a fresh one-time recipient keypair and a fresh request
identifier.

* The **public** half goes into the receive code.
* The **private** half stays inside Bob's TruePad.
* The private half is never copied into the receive code, and never leaves his
  browser.

The receive code is a single line of text beginning with `TPR2:`. **It is not
secret.** Bob can send it through chat, email, a text message, or any other
ordinary channel. Someone who copies it cannot open anything with it — it is the
lock, not the key.

## 2. They compare 12 words

Here is the real problem the twelve words solve.

Suppose Mallory intercepts Bob's message and replaces Bob's receive code with a
receive code Mallory generated. Alice, seeing nothing unusual, seals the pad for
what she believes is Bob's request. She has in fact sealed it for Mallory.

So TruePad turns the *exact* receive request into **twelve words**. Bob sees
twelve words on his screen. Alice pastes the code she received and independently
sees twelve words on hers. They read them to each other and compare **all
twelve**, in order.

If all twelve match, they have evidence of one specific thing:

> Alice is sealing for the same receive code Bob is looking at.

Be precise about what that is not. Matching words are **not proof of anyone's
identity**. TruePad has not checked that Bob is Bob, and it never says it has:
it does not claim to have verified an identity, authenticated a person, or
established that a recipient is trusted, because it is not in a position to know
any of those things.

The words prove the two screens agree. The *humans* establish who they are, by
comparing the words over a channel where they already recognise each other — a
phone call, a voice they know, a conversation in person.

If even one word differs, or appears in a different position, stop.

## 3. The sender seals the pad

Once Alice confirms the twelve words matched, TruePad remembers that exact
receive request.

When she chooses **Seal pad**, TruePad uses the public cryptographic material
inside Bob's receive code to produce a fresh encryption key — one that only Bob's
saved private key can recover. That key encrypts Alice's existing TruePad pad
into a sealed file:

```
truepad-sealed-<id>.tps2
```

The `.tps2` file is the **sealed copy** of the pad. It is not the raw `.pad`
file, and the two must never be confused.

### What is doing the work

TruePad's suite `0x0001` uses **X-Wing**, in the draft-10 construction
(`draft-connolly-cfrg-xwing-kem-10`). X-Wing combines two independent key
exchanges:

| Component | What it is |
| --- | --- |
| **ML-KEM-768** | a lattice-based key-encapsulation mechanism, standardised by NIST as FIPS 203 |
| **X25519** | the widely deployed elliptic-curve exchange |

Their two results are combined into shared secret key material. **HKDF-SHA-256**
derives the delivery keys from it, and **AES-256-GCM** encrypts and authenticates
the pad container.

Combining the two is the point: an attacker has to break *both* to recover the
pad, so the delivery survives a future break of either one alone.

State the standards status accurately, because it is easy to overstate:

* **ML-KEM is standardised.** X-Wing is **not**. It is an IETF *draft*; TruePad
  has frozen the draft-10 construction and will not silently follow the draft.
* X-Wing is not a NIST standard, not an RFC, and not IETF-approved.
* The delivery claim is **computational** — it rests on those problems being
  hard, not on information theory.

## 4. Alice sends the sealed file

The `.tps2` can travel through an ordinary channel precisely because it is the
encrypted transport package rather than the pad itself: Signal, email, another
messaging app, cloud storage, a USB stick, ordinary file sharing.

**TruePad does not send it.** TruePad creates the file; the person chooses the
channel. Nothing is uploaded, no recipient is stored, and no service is
contacted.

| | What it contains | Can it travel through an ordinary channel? |
| --- | --- | --- |
| Raw `.pad` | **the secret pad itself** | **No.** Anyone who holds it can read and forge this pad's messages. Hand it over in person, or use a channel only the two of you control. |
| Sealed `.tps2` | an encrypted delivery of the pad, locked to one receive request | Yes — that is what it is for. |

## 5. The recipient opens the sealed pad

When Bob chooses the `.tps2` file, TruePad:

1. reads which receive request the package belongs to;
2. finds the private key it saved when he created that receive code;
3. **verifies the package is bound to that same request** — matching the request
   identifier alone is not enough to authorise use of the private key, and
   TruePad checks the request's stored fingerprint too;
4. performs the X-Wing decapsulation with Bob's private key;
5. derives the same delivery key Alice used;
6. lets AES-GCM authenticate and decrypt the pad — if a single byte was altered
   anywhere, this fails and nothing proceeds;
7. keeps the decrypted pad **inside TruePad's worker** while the human
   confirmation ceremony is still going on. It is not written to storage, and it
   is not handed to the page.

## 6. They compare 8 confirmation words

The two ceremonies check different things, at different times:

* the **twelve** words checked the receive request **before** Alice sent anything;
* the **eight** words check the sealed package **after** she created it.

The order matters. **Bob sees his eight words first and reads them to Alice.**
Only after Alice says she has heard them does TruePad show Alice her own eight —
before that they are not merely hidden on her screen, they are not in the page at
all.

The reason is that hearing Bob's words first hands an attacker a value he must
already have matched, rather than a target to aim at. If Alice's words appeared
first, someone impersonating Bob could simply repeat them back.

If the eight match, Bob chooses **The words matched** and the pad is added. If
they do not, he chooses **They did not match** and the transfer is over — the
receive code cannot be used again.

One honest limitation: TruePad controls the order of its own screens, but it
cannot know whether a human actually spoke first, or compared carefully, or
compared at all. That part is an **operator assumption**, and no amount of
software changes it.

## Why the receive code is one-time

A receive code is deliberately tied to one transfer.

* When Bob successfully adds a pad, the request is **used up**.
* If he rejects the comparison, the request ends permanently.
* If it expires — after about seven days — it can no longer be used.

None of these can be undone, and a used or rejected request never becomes
available again. This is what stops a recipient's one-time private key from
quietly turning into a reusable, general-purpose delivery endpoint that anyone
who once saw the code could send to.

## Why a pad is handed off only once

A newly created pad can be delivered **one** way:

* **A** — as a raw pad file, through a private handoff; or
* **B** — as a sealed online transfer.

Once either commits, TruePad will not create a second independent handoff for
that pad. Trying the other method afterwards is refused, in plain language.

The same rule runs the other way: once a receive request has been claimed for one
pad, it cannot be redirected to a different pad. Retrying the *same* pad after an
interrupted attempt is fine; switching pads is not.

A pad that arrived from someone else can never be passed onward at all, by either
method.

## 7. After the pad is added, normal TruePad messaging begins

This is the most important boundary in the whole feature.

Once Bob has added the pad:

* **X-Wing is not used for messages.**
* **ML-KEM is not used for messages.**
* **The AES-GCM from the sealed transfer is not used for messages.**

Alice and Bob now hold corresponding copies of the same TruePad pad, and messages
go back to TruePad's ordinary mechanism: plaintext combined with fresh, never
reused pad bytes, plus one-time Wegman–Carter authentication.

```
  DELIVERY:   X-Wing (ML-KEM-768 + X25519)  →  HKDF-SHA-256  →  AES-256-GCM
  MESSAGES:   one-time pad  +  Wegman–Carter authentication
```

The delivery cryptography ran once, to move the pad. The messages are protected
by the pad.

---

## The whole flow

```
  BOB                                          ALICE
  ───                                          ─────
  Create receive code
        │
        ▼
  TPR2 public receive code
  + 12 comparison words
        │
        │   send the code (chat, email, …)
        └──────────────────────────────────▶   Paste code
                                               Compare all 12 words
                                                     │
                                                     ▼
                                               Seal the existing pad
                                                     │
                                                     ▼
                                               X-Wing
                                               ML-KEM-768 + X25519
                                                     │
                                                     ▼
                                               HKDF-SHA-256
                                                     │
                                                     ▼
                                               AES-256-GCM
                                                     │
                                                     ▼
                                               .tps2 sealed pad
                                                     │
        ◀──────────────────────────────────────────  │
        │        chat / email / cloud / USB
        ▼
  Open with the private key
  saved with the receive request
        │
        ▼
  Decrypt the pad (in the worker)
        │
        ▼
  Bob reads his 8 words FIRST  ─────────────▶  Alice then reveals hers
        │                                            │
        ▼                                            ▼
  Words match ──▶ Bob adds the pad             Words match
        │
        ▼
  ═══════════════════════════════════════════════════════
   NORMAL TRUEPAD MESSAGES — one-time pad + Wegman–Carter
  ═══════════════════════════════════════════════════════
```

---

## Why online delivery is a different security claim

If Alice hands Bob the raw pad privately, and the one-time pad's assumptions hold
— good pad material, kept secret, never reused — the delivery fits the
conditional information-theoretic model the OTP is famous for. Nothing about that
delivery depends on a computation being hard.

Online delivery is different. The pad is first wrapped in ordinary modern
cryptography, and an attacker who watches the channel can keep a copy of the
`.tps2` file indefinitely.

Today, without Bob's one-time private state and without a break of the delivery
cryptography, that archived file should be useless to them. But there are two
ways it could stop being useless:

1. the delivery cryptography is broken at some point in the future; or
2. Bob's saved one-time key state is **restored or cloned from a backup**.

Either would let the archived package be opened, which would reveal the pad — and
because the pad decrypts the messages made with it, archived messages could be at
risk too.

So the online **delivery** layer is computational. This says nothing about the
messages themselves: they were never encrypted with AES or X-Wing.

## Keeping a sealed file around

An attacker can hold a copy of a sealed `.tps2` even though they cannot open it
today. If the delivery protection or the recipient's saved key state becomes
available to them later, that archived file could reveal the pad.

That is a reason to delete sealed files you no longer need — and a reason to be
clear about what deleting can do. **Deleting your local copy does not erase
copies already sent through chat, email, cloud storage, or backups.** TruePad
cannot reach those, and it cannot prove that any copy has been physically erased,
including its own.

---

## Common questions

### Is the receive code secret?

No. It carries the public information needed to seal a pad for that one request.
The recipient's private key does not appear in it.

### Can I email the receive code?

Yes. Comparing the twelve words is what detects a substituted code, not keeping
the code hidden.

### Can I email the sealed `.tps2` file?

Yes, if that is the channel you choose. It is computationally encrypted transport
material, locked to one receive request.

### Can I email the raw `.pad` file?

**No — don't.** The raw pad *is* the secret. Anyone who obtains it can read and
forge that pad's messages immediately. Hand it over in person, or use a channel
only the two of you control.

### Does TruePad upload the pad?

No. TruePad creates the receive code and the sealed file locally, on your device.
You choose how to send them. There is no backend, no account, and nothing is
transmitted automatically.

### Does X-Wing encrypt every message?

No. It delivers the pad, once. After the pad is added, normal messages use the
one-time pad and Wegman–Carter authentication.

### Are the 12 or 8 words passwords?

No. They are a readable form of a cryptographic value, meant to be spoken aloud
and compared. Typing them somewhere gains you nothing; there is nowhere to type
them.

### Does matching the words prove who someone is?

No. It proves the two of you are looking at the same cryptographic values. Who
you are talking to is established by the channel you compare them over — a voice
you recognise, or a person in front of you.

### What if I lose the sealed file before the recipient opens it?

Ask for it again — the same receive code returns the identical sealed file, byte
for byte. TruePad does not create a second package, and there is nothing to
re-seal.

---

## Technical details

| | |
| --- | --- |
| Receive request | `TPR2:` + canonical unpadded base64url, 1652 characters |
| KEM | **X-Wing**, `draft-connolly-cfrg-xwing-kem-10`, suite `0x0001` — ML-KEM-768 with X25519 |
| Key derivation | HKDF-SHA-256 |
| Pad transport encryption | AES-256-GCM |
| Sealed package | **TPS2**, saved as `.tps2` |
| Request comparison | 12 words / **132 bits** |
| Package confirmation | 8 words / **88 bits** |
| After import | the existing TruePad one-time pad + one-time Wegman–Carter authentication |

The receiver's request state is durable and terminal-by-existence: a cancelled or
consumed marker (`cancelled.json`, `consumed.json`) can never revert to pending,
which is what makes "one-time" survive a crash or a torn write. On the sender's
side a durable request claim binds one receive request to one pad, and a handoff
marker records that the pad has been given out — so neither a retry nor a restart
can produce a second independent copy.

**About the wordlist.** TruePad renders the protocol's fixed 11-bit indices as
English words using the BIP-39 English list, purely as a readable mapping. Index
position *is* the mapping, which is why the list is vendored verbatim and pinned
by hash. These are **not** BIP-39 wallet mnemonics and **not** a recovery phrase.
Nothing is derived from them, nothing is typed back in, and they unlock nothing.

**Scope.** A page that already holds worker-RPC authority is endpoint compromise,
and no ordering in these ceremonies changes that. All Browser state is one
rollback domain: restoring a whole browser profile can rewind pad counters,
markers and request state together.

For the normative specification see
[`SEALED-PAD-TRANSFER.md`](SEALED-PAD-TRANSFER.md); for how the shipped product
was verified against it, see
[`SEALED-PAD-TRANSFER-RELEASE-AUDIT.md`](SEALED-PAD-TRANSFER-RELEASE-AUDIT.md).
