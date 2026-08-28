# Creation Station → Social Media Post Creation

**Status: REQUIREMENTS ONLY. Nothing here is authorized to build.**

Recorded from Sean across 2026-08-27 and 2026-08-28. This exists so the architecture is settled before the first line of it is written — the mistakes it is guarding against are all retrofits.

Creation Station's first surface is product design. Its second is social posts. **The same principle governs both:** the owner chooses how much of the work they want to do, and J4 does the rest without pretending to be them.

---

## 1. The phase

The owner brings a piece of content — **especially video, but photos too** — and a description of what it is about, in their own words.

> **User:** *"Here's the video. This is what I'm talking about."*
>
> **J4:** *"Got it. I'll use your description as the basis, but I'm going to phrase each post differently for the platforms. Here's what I'd use..."*

J4 uses the owner's description as the **basis**, not as the caption.

## 2. Platform-specific captions, not one caption copied four times

**J4 writes a different caption per connected platform.** Not one caption syndicated.

Sean's examples — **examples, not hardcoded rules**:

- **X** — the owner's natural voice, conversational and direct. **No automatic hashtags.**
- **Facebook** — phrased to invite conversation, comments and questions, because engagement is what carries the post further.
- **Instagram** — more visual and brand-oriented, hashtags where they are useful.
- **TikTok** — fitted to the platform's style and to the content itself, hashtags where appropriate.

**J4 must understand the actual platform and adapt.** A table of per-platform rules in code would be the wrong shape: it freezes four platforms as they were on the day it was written, and every one of them changes.

## 3. The differentiator: J4 learns the owner's voice

The accounts are connected, so J4 can read what the owner has already published, and learn from it:

- vocabulary
- sentence structure
- tone
- humour
- punctuation habits
- whether they use emojis
- how often they use hashtags
- how they open a post
- how they address their audience
- the calls-to-action they reach for naturally

**The captions should sound like the business owner wrote them, not like generated content.**

**Never call this a clone in the product.** It is J4 *learning the owner's voice*. The word matters: one describes replacing a person, the other describes knowing them, and only one of those is what an owner would want done with their name.

### The same person is different on each platform

Because J4 is connected to all of them, he must understand that **one owner communicates differently in different places**. He is not copying an Instagram caption onto Facebook and X. Voice is per-owner **and** per-platform.

### Keep this separate from the business brain

**The owner's writing voice is not a business fact.** It belongs beside the owner, not in the understanding graph that holds what the business is, sells and promises. Mixing them would let a stylistic observation ("they rarely use exclamation marks") sit in the same store as an owner-authoritative claim about the business — see [J4_BUSINESS_UNDERSTANDING_MODEL.md](J4_BUSINESS_UNDERSTANDING_MODEL.md), where provenance is the whole point.

## 4. One upload, one carousel, one creation

**The same carousel interaction Creation Station already uses.** A single piece of uploaded content becomes **one Social Creation workflow**, not four. The owner swipes through the connected platforms one at a time — Facebook, Instagram, TikTok, X, and whatever is connected next.

Each platform card carries:

- a **Post / Don't Post** toggle
- the **platform-specific caption** J4 wrote for it
- the **content preview**
- the ability to **review and edit** that caption

The captions are generated independently per platform, from the owner's learned voice and that platform's way of communicating. **Never one caption duplicated across four cards.**

At the end of the carousel there are two actions:

```
Post Now          Post Later
```

**Post Later** asks for the day and time, and the owner confirms the schedule.

### The carousel must extend without redesign

Adding a fifth platform is a card, not a new workflow. That is the test of whether this is built right: if supporting a new network means reopening the interaction design, the workflow was modelled around the four that existed on the day it was written.

## 5. What it costs, and when

**One Growth Point, charged exactly once, at the commitment point** — when the owner presses Post Now, or confirms a scheduled post.

**Not charged again when a scheduled post actually publishes.** The lifecycle:

```
DRAFT  ->  READY  ->  SCHEDULED  ->  PUBLISHED
```

Once the owner has committed and the Growth Point is allocated, **the creation is paid for**. A later publishing failure must never charge a second one — Genesis retries and recovers instead. The owner bought the creation, not the attempt.

**Four platforms is one charge.** Selecting more platforms must never turn one piece of content into four Growth Point charges. Writing four captions instead of one is J4 doing the job properly, not four purchases — and the carousel, where each platform gets its own card, is exactly where per-card metering would look natural and be wrong.

## 6. Progressive trust

**At first J4 shows his work. As the owner gains confidence, he asks less.** That is the whole shape of this, and it is a shape the owner controls at every point.

Initially the full carousel: the owner chooses platforms, reads the captions, changes what they want. **J4 explains his reasoning where it helps** rather than dumping four captions and waiting for a verdict.

Once they are comfortable, they can save their normal setup:

```
My usual platforms
  [x] TikTok
  [x] Instagram
  [x] Facebook
  [x] X

[ ] Don't ask me to review every post
```

With that enabled, J4 remembers two separate things:

1. **which platforms** the owner normally posts to
2. **that he may proceed** without caption-by-caption approval

The workflow then collapses to: upload the video, give J4 the concept, J4 writes the platform-specific captions, uses the saved platforms, Post Now or Post Later.

**The carousel still exists and stays reachable.** It stops interrupting; it does not disappear. And the preference is always reversible — the owner can turn review back on whenever they like.

### A saved default is not an instruction

**J4 must recognise the unusual case.** If the saved setup is TikTok, Instagram, Facebook and X, and the owner says *"don't post this one on X"*, the current instruction wins. A default that overrides what someone just said is not a preference, it is a bug.

> **This should feel like J4 learning how the owner normally works, not like the owner permanently giving up control.**

## 7. Keep it open to engagement signals

**Architect so that J4 can eventually learn from performance, not only from captions.** Over time he should be able to tell what kinds of content and messaging actually work for *this* business, from the engagement and history the connected platforms already expose.

Nothing needs to read those signals today. But a voice model that can only ever ingest caption text would have to be replaced to ingest anything else, and that is the retrofit this section exists to prevent.

---

## Why this is not a cross-platform scheduler

The value is not publishing to several platforms at once. Anything can do that.

**The value is that J4 understands the business, understands the owner's voice, understands the audience, and knows that each platform requires different communication.** Every requirement above exists to protect one of those four.

## Explicitly out of scope today

Do not build the social system. Do not extend the current Creation Station work into it. This document is to be read *before* that work is designed, and for no other purpose yet.
