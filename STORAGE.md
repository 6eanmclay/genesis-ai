# Storage Architecture and Lifecycle

**Status: REQUIREMENTS, direction locked 2026-08-28. Implementation is NOT authorized — see [What is left to build](#what-is-left-to-build).**

Sean, after the cleanup that produced this document:

> *"This is no longer just about my account — Genesis is going to be used by customers, so anything we discovered here that prevents unnecessary storage consumption needs to become part of the product architecture for every new business/user... Don't just document this as a one-off cleanup of my account. Turn the lessons from this cleanup into requirements."*

That is what this file is. The cleanup is evidence; the requirements are the point.

---

## 1. What happened, and why it is evidence

Cubit & Coil's storage reached **954 MB of a 1 GB ceiling — 93.2% — and Create Product began failing** with `Vercel Blob: Storage quota exceeded`. The account was not doing anything unusual. It had been used for about a month.

| | Files | Reclaimed |
|---|---|---|
| `designs/` unreferenced | 110 | 116 MB |
| `products/` + `voice-turns/` unreferenced | 153 | 190 MB |
| **Deleted** | **263** | **~306 MB** |
| **Refused — still referenced** | **122** | — |

**One ordinary month of one account produced 306 MB of storage that nothing pointed at.** Nothing in the product told the owner, and nothing in the product could have cleaned it up: before this work, `del` from `@vercel/blob` was imported **nowhere in the codebase**. Genesis had never deleted a file.

That is the finding, and raising the allocation does not answer it. At that rate the leak alone consumes a **5 GB** plan in about sixteen months — a customer filling their whole allocation without keeping a single thing they chose. A bigger number buys time; only the lifecycle in section 6 fixes it.

### What the refusals proved

Of the 122 files held back, **23 would have been deleted by the first version of the reference scan** — including **three store logos** (`Store.logoUrl`), six `ApprovalRequest` payloads, seven `StoreDraft.creativeDirection` images and five `Store.creativeDirection` images. Three of them appeared in the first report's "largest unreferenced" list, meaning they were queued to go.

The scan missed them because it read five tables against a schema with more than forty JSON columns. It announced itself honestly first: `voice-memos/` came back **100% unreferenced**, fifteen files and not one reference, because `uploadVoiceMemo` records audio on `StoreMessage.changes` — a column the scan never read. **A whole category reading as orphaned is the shape of a scan that cannot see, not a fact about a working system.**

---

## 2. Reference safety — non-negotiable rules

**These are the rules any deletion in Genesis must follow, now and later.**

### The scan must be schema-driven, not a list of tables

A reference check that enumerates columns falls behind the first time somebody stores a URL somewhere new, and it does so **silently**. `lib/storage/scan.ts` asks `information_schema` for every text and JSON column in the public schema and sweeps all of them. That is the one source that cannot be out of date with the schema, because it *is* the schema.

### Deletion re-checks; a report is never authority

A report is a photograph of a moment. Between reading one and acting on it, somebody can finish a design, create a product or set a logo — and the file that was safe when the report was drawn is load-bearing by the time the delete arrives. **`cleanupUnreferenced` re-runs the full scan inside the deletion and refuses anything referenced, however explicitly it was named.**

The check that authorises a deletion must never be weaker than the check that proposed it.

### The scan must cross tenants

Blob storage is **one namespace for the whole deployment**. A file referenced by *any* store is unsafe to delete. A scan scoped to one business would report another business's product image as unreferenced, and the first deletion built on it would take a stranger's storefront picture. This is why the current endpoints are platform-admin only: the answer requires seeing across businesses, so the question may only be asked by somebody entitled to.

**When storage becomes customer-facing, the customer sees only their own usage — but the safety scan behind any deletion still runs system-wide.**

### Errors are asymmetric, and the design must lean

A file wrongly kept costs bytes. A file wrongly deleted costs a product photograph, a storefront tile, a brand logo, or a design that cannot be reopened. **Every ambiguity resolves toward keeping.**

---

## 3. Removing from the library is not deleting

**They are different operations and must stay different.**

| Operation | What it does | Storage |
|---|---|---|
| **Remove from Creation Station** | Sets `creationLibraryRemovedAt`. The record stays, J4 still remembers the asset, designs using it keep working. | **Frees nothing** |
| **Delete permanently** | Removes the record *and* the underlying file, after a reference check. | Frees the bytes |

The first is right and should stay — it exists so tidying a toolbox does not make J4 forget. **The problem is that it is currently the only thing on offer**, so an owner who "removes" fifty images believes they have cleaned up and has freed nothing. That is a promise the interface makes and does not keep.

**Requirement:** the interface must offer both, name them differently, and say what each does. A permanent delete warns when an asset is still referenced and refuses rather than cascading.

---

## 4. The four leaks

Found while investigating. All four are ongoing, all four affect every customer, and none is specific to one account.

### Voice-turn audio, abandoned after transcription

`uploadVoiceMemo` writes `audioUrl` onto a `StoreMessage` **only on the failure branch** — "the recording itself is still real and kept". On success the transcript becomes the message and the audio URL is discarded. **Every successful voice interaction leaves an audio file nothing will ever reference.** Eighteen were deleted in this cleanup; they accumulate again from the next conversation.

### Empty and failed generations, uploaded anyway

Eight `products/` blobs were **68 to 179 bytes** — failed or empty image generations that were written to storage regardless. Small individually, permanent collectively, and a signal that generation paths do not check what they got before storing it.

### Deleting a record does not reclaim its file

`deleteProductImageExecutable` removes the `ProductImage` row and leaves the
blob. So does every other delete path in Genesis, because until this work there
was no delete path for blobs at all. **An owner who tidies their product
gallery frees nothing**, and the storage they think they recovered is still
being counted against them.

This is the same shape as the Creation Station's removal in section 3, and it
matters more than either one alone: it means Genesis currently has *two*
operations that read as deletion to a customer and are not, and no operation
that actually is.

**Requirement:** deleting a record must either reclaim its derived files or
leave them for a sweep that will — never silently orphan them. Which of the two
depends on the file's class in section 6; doing neither is not an option.

### Failed Create attempts, stranding print files and mockups

`lib/execution/executables/productFromDesign.ts` uploads print files (line ~117) and mockups (line ~157) **before** the supplier call (~176) and its verification (~193). A Create that fails at the supplier leaves both behind for ever.

**This one is the most serious, and it is self-worsening: every failed creation consumes the very quota the next creation needs.** It has not fired yet only because Create never reached that far. It will now that it can.

---

## 5. Temporary assets need a lifecycle, not cleanup afterwards

Sean:

> *"If Genesis uploads temporary print files/mockups and the supplier creation fails, those temporary assets should be cleaned up safely rather than permanently consuming customer storage."*

The required shape:

```
create  ->  temporary assets  ->  supplier creation succeeds  ->  PROMOTE (they are now the product's)
                              \
                               ->  creation fails  ->  DISCARD the temporaries
                                                       keep the design
                                                       record the failure honestly
```

**The design always survives.** Only artefacts created solely for the failed attempt are discarded.

It must hold wherever the failure lands — a supplier refusal, a placement the supplier will not confirm, a timeout, a crash between two uploads. **A temporary asset must be recoverable by a sweep even when the code that created it never got to run its own cleanup**, because the case that leaks is the one that did not reach the `finally`.

---

## 6. Every blob Genesis writes needs a declared lifecycle

Today Genesis writes to five prefixes and has never classified any of them. The classification below is the requirement.

| Prefix | What it is | Lifecycle | Reclaimable when |
|---|---|---|---|
| `assets/` | The owner's own uploads — artwork, documents, photos | **Permanent customer asset** | Only on explicit permanent delete |
| `products/` | Product photographs, uploaded or generated | **Permanent while referenced** | The product and every reference to it are gone |
| `designs/` | Composed print files and mockups from J4's design layer | **Derived** | The design record is gone, or it never became one |
| `printfiles/` | Composed print-ready artwork for a supplier | **Derived, then supplier-bound** | Creation failed → immediately. Product deleted → with it |
| `mockups/` | Composed product photographs | **Derived** | Same as printfiles |
| `voice-memos/` | Audio the owner deliberately sent | **Permanent while attached to a message** | The message is gone |
| `voice-turns/` | Audio captured to transcribe a spoken turn | **Temporary by design** | The transcript exists |

**The organising principle: derived assets are reproducible.** A print file can be recomposed from the design and its source artwork at any time — the design is the durable thing, the render is not. That is what makes a retention policy on derived assets safe, and it is why `assets/` sits at the other end: an owner's upload is the one thing Genesis cannot recreate.

**Every new blob path must declare its class before it ships.** A path with no declared lifecycle is a leak that has not been noticed yet.

---

## 7. New accounts inherit the architecture, not the problem

> *"New customer accounts must start with this architecture already in place. We should not rely on manual cleanup, Vercel dashboard deletion, or customers understanding storage management."*

Concretely:

- **No customer should ever be asked to manage storage manually.** The cleanup that produced this document took two operator-run endpoints, several rounds of evidence, and a scan bug caught by luck. That is not a customer experience.
- **Cleanup is automatic and continuous**, not a thing somebody remembers to run.
- **The owner sees usage before it becomes a problem** — `742 MB / 1 GB used`, with a warning well before the ceiling, not a failed Create as the first signal. That is exactly how this surfaced, and it is the wrong way round.
- **Hitting a limit must degrade honestly**: say what is full, what can be freed, and offer more space. Never a raw provider error in the middle of creating a product.

---

## 8. Production readiness

Add to the production-readiness checklist, with **tests that prove it rather than intentions that describe it**:

- [ ] A failed Create leaves **no** orphaned print files or mockups
- [ ] An abandoned draft does not accumulate derived assets over repeated saves
- [ ] A successful voice interaction leaves no unreferenced audio
- [ ] A failed or empty generation is never stored
- [ ] Deleting a product reclaims its derived assets, and only its own
- [ ] Permanent asset deletion refuses anything still referenced — across all stores
- [ ] Storage usage is reported accurately, and the number an owner sees matches what is stored
- [ ] A repeated create/fail cycle does not grow storage without bound

**The last one is the real test.** Every leak found here was invisible until something stopped working, and each was found by measuring rather than by reading code. The test that matters is the one that runs the loop a hundred times and asserts the bytes did not climb.

---

## 9. Economics — storage is capacity, not a trap

> **Storage should feel like capacity, not a trap.**
>
> *"Genesis should give customers enough storage that they normally never have to think about it. If someone genuinely grows beyond their allocation, they can purchase additional capacity."*

### Locked direction, 2026-08-28

| Plan | Included storage |
|---|---|
| $20 | **5 GB** |
| $50 | **15 GB** |
| $100 (Pro) | **50 GB** |

*Supersedes the 1 / 3 / 10 GB figures recorded earlier the same day.*

Sean's reasoning, which is the part worth keeping: **5 GB is already an enormous
amount of room for a normal small business once Genesis manages its own
generated and temporary storage properly.** 15 GB gives a growing business
substantially more, and 50 GB makes Pro feel genuinely generous rather than
artificially restricted. The shape matters as much as the numbers — the top tier
should feel different without the lower ones feeling crippled.

### Additional storage as an add-on

Available to customers who legitimately need it, and **priced as close to our
actual incremental cost as is economically practical**, with enough margin to
cover infrastructure and management.

**Storage must never become a predatory upsell.** A customer with real
photographs, videos and product assets should be able to buy more without
feeling punished for having content. The business Genesis is in is helping
somebody build a business; charging them a premium for owning pictures of their
own products is the opposite of that.

### Storage is not Growth Points

**Keep the two architectures separate and do not conflate them.**

| | |
|---|---|
| **Storage** | Infrastructure capacity. Passive. You have it or you need more. |
| **Growth Points** | The business-growth and action economy. Spent deliberately on things that move the business. |

A Growth Point buys an action. A gigabyte holds a file. Metering storage the way
actions are metered would turn keeping your own photographs into a transaction,
which is exactly the feeling section 9 exists to prevent — and pricing an action
by the bytes it happens to produce would make the cost of creating something
depend on how large its output was. See [GROWTH_POINTS.md](GROWTH_POINTS.md),
which stays the single source for the action economy.

### Why the cleanup comes first

The measured leak was **306 MB in roughly one month of one ordinary account**.
Unchecked, that alone consumes a 5 GB allocation in about sixteen months —
**a customer could fill their entire plan without storing a single thing they
chose to keep.**

That is the argument for the whole of this document, and for the order Sean put
it in: *"The immediate goal isn't 'give me more than 1 GB.' The immediate goal
is: make sure Genesis isn't wasting the storage customers are already paying
for."* Raising the allocation before fixing the waste sells customers the cost
of our own inefficiency, and buys perhaps a year before the same wall arrives.
Fixing it first is what makes 5 GB the generous number it should be.

## What is left to build

**None of this is authorized yet.** Recorded so the work is known, not started.

### Already built (this cleanup)

- `lib/storage/provider.ts` — provider-agnostic interface. **Deliberately has no `delete`** on the interface yet
- `lib/storage/vercelBlob.ts` — the only file that knows which storage product is in use
- `lib/storage/scan.ts` — schema-driven reference sweep via `information_schema`
- `lib/storage/references.ts` — pure URL extraction, canonicalisation and usage summary (24 assertions)
- `lib/storage/cleanup.ts` — the only file importing `del`; re-checks references; dry run by default
- `/api/storage/report` and `/api/storage/cleanup` — platform-admin, read-only by default

### Still required

1. **Failed-Create cleanup** *(highest priority — it is a resource leak, not a feature)*. Temporary-asset lifecycle with promote-or-discard, plus a sweep that catches what a crash skipped.
2. **Voice-turn cleanup** — delete after transcription, or record the audio so it is genuinely referenced. Decide which; both are defensible, silently doing neither is not.
3. **Reject empty generations** before upload.
4. **Permanent asset deletion** — record plus blob, reference-checked, exposed to the owner.
5. **Split the UI** into *Remove from Creation Station* and *Delete permanently*, with a warning when something is still referenced.
6. **`delete` on the storage interface**, once the policy above exists to guard it.
7. **Lifecycle declaration required for every blob path** — a new path without one should not pass review.
8. **Customer-facing usage view**, warnings before the ceiling, and honest degradation at it.
9. **Per-plan quota enforcement** for the tiers in section 9.
10. **A scheduled orphan sweep**, using the same reference scan.
11. **The tests in section 8**, especially the create/fail loop that asserts bytes do not climb.

**Suggested order:** 1 → 2 → 3 (stop the bleeding), then 4 → 5 → 6 (give owners real control), then 8 → 9 → 10 (make it a product), with 11 written alongside each.

Item 1 is not a storage feature. It is a correctness bug: **every failed creation makes the next creation more likely to fail.**
