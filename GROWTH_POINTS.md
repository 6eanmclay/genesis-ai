# The Growth Point Economy

**Status: CONTRACT. Locked 2026-08-28. This is not authorization to build.**

Recorded from Sean after going through the Growth Point system end to end. The economy is implemented **after** Product Creation and Social Media Creation are finished — see [Implementation order](#implementation-order). Nothing here may be started as a side effect of that work.

> **Growth Points should feel like a business levelling system, not a nickel-and-dime billing system.**

The goal is for Genesis to feel extremely inexpensive and frictionless, while leaving a clear path to monetise the higher-value actions that actually help a business grow.

---

## 1. What is charged, and what is not

**Growth Points are for valuable creation and execution actions** — especially ones that consume meaningful generation or external-service resources. An owner must be able to run the basic operation of Genesis without being stopped by confirmations.

### Free, and stays free

- Using Genesis and J4
- Business intelligence
- Connections and integrations
- **Saving designs**
- **Browsing and reopening saved work**
- Normal business guidance
- Basic website functionality
- Anything that does not consume a meaningful creation or execution resource

The rule behind the list: **thinking is free, execution is invested.** If an action produces nothing outside Genesis and calls nothing that charges us, it is free.

### Locked prices

| Action | Cost |
|---|---|
| **Create a product** — take a completed design and actually create it | **2** |
| **Create another variant or product from an existing design** | **2** |
| **Create a social post for one platform** | **1** |
| **Create the same content for multiple platforms** | **2** |
| Image differentiation — a better presentation of a product that exists | **1** |

**A second product from an existing design is 2, not 1.** It is based on work already done, and it still creates another real product — so it costs what creating a product costs. Written down because 1 is the number somebody will reach for.

**Multi-platform is 2, not 4.** J4 is doing platform-specific adaptation rather than copying one caption everywhere, which is worth more than a single post and is not worth four. Instagram, Facebook, TikTok and X can each receive appropriate copy from one piece of content the owner supplied.

**Not now:** weekly or monthly bulk social-content packages. Social creation stays post-oriented.

---

## 2. When the cost is disclosed

**Never lead with the cost. Let the owner finish the creative work first.**

The confirmation happens at the very end, immediately before execution:

> *"You're ready to post. This will use 1 Growth Point. You have 8 Growth Points remaining. Continue?"*

A price on a button all day is a toll. A price at the moment of committing is information somebody is about to act on. The distinction is the whole reason this section exists.

## 3. "Don't show me this again" is PER INVESTMENT TIER

**Resolved 2026-08-29.** This section previously described a per-action
preference. What is shipped, and what is intended going forward, is a preference
scoped to the **size of the investment** rather than to the action that happens
to carry it.

The owner is choosing: **"I understand an investment of this size. Don't ask me
to confirm one this size again."** They are not choosing to be told less
afterwards — see the accounting rule below.

### How it is scoped

`User.growthPointConfirmSkippedAt` records that the preference was set;
`User.growthPointConfirmSkippedCost` records **the largest investment they have
waved through**. A later action asks again if — and only if — it is *dearer*
than that:

| Already waved through | 1-point action | 2-point action | 5-point action |
|---|---|---|---|
| nothing yet | asks | asks | asks |
| 2 points | silent | silent | **asks** |
| 5 points | silent | silent | silent |

The rule in one line, from `confirmation.ts` itself: *waving through an action at
one price authorises that price and anything cheaper, never more.* The stored
figure is the **highest** ever approved, so confirming something small later does
not narrow a preference the owner already widened.

**Why size rather than action.** An owner who is comfortable with a 2-point
investment is comfortable with a 1-point one; that is a fact about the money, not
about which button produced it. Keying on the action instead would ask again the
first time somebody met a *new* 1-point action they had every reason to be
relaxed about, and — worse — would stay silent when a familiar action was
repriced upward. The tier answers both.

### It never suppresses the accounting

The preference silences the confirmation **before** the investment, never the
report **after** it. A completed action still says what it used and what is left —
*"Posted ✓ · 1 Growth Point invested · 23 remaining"* — whatever the preference
says. Somebody who asked not to be interrupted has not asked to stop being told
what their business invested.

### It is always overridden when

- **the investment is larger than the one they approved** — the comparison above
- **the owner cannot cover it** — that is news rather than a confirmation, and it
  has to arrive before anything runs rather than as a failure afterwards
- **the action insists** — a caller may require an explicit confirmation for its
  own reasons, whatever the preference says

And it is reversible: `resumeGrowthPointConfirmation` puts the asking back.
Nothing here is one-way.

## 4. When there are not enough points

J4 explains the situation in plain terms rather than refusing:

> *"This will take 2 Growth Points, but you only have 1."*

Then offers to buy more, **and what more would let them do**:

> *"You need 1 more point for this product. Growth Points are sold in packs of 5. With 10 Growth Points you could create this design as a T-shirt, a hoodie and a hat, and build a complete collection."*

**This is J4 helping them grow, not a paywall.** The difference is whether the sentence is about what they cannot do or about what they could.

---

## 5. Where this diverges from what is shipped today

One thing is already built and does not match this contract. Recorded here rather than left for whoever implements the economy to discover.

*The confirmation preference used to be listed here too. It was resolved on
2026-08-29 in favour of what is shipped — see section 3, which now describes the
per-tier behaviour rather than proposing a per-action one.*

**SOCIAL_CREATION.md §5 said one Growth Point regardless of platform count.** It was locked in `68971c4` and is superseded by the table above: one platform is 1, several are 2. The rule it was really protecting survives — four platforms is still not four charges, and per-card metering in the carousel is still wrong. Only the number changed, and that file now says so.

---

## 6. Future concepts — DOCUMENT ONLY

Ideas that may be built later. **No prices are assigned**, deliberately: a price on an action nobody has defined is a number that will be wrong.

### Product

- Create a product collection
- Create a complete product line
- Generate product descriptions
- Generate descriptions for an entire collection
- Product launch assistance
- Product promotional campaigns
- Product presentation and image differentiation

### Marketing

These need defining before they can be priced:

- Create an advertisement
- Create an email campaign
- Create an SMS campaign
- Create a landing page
- Create promotional campaigns
- Seasonal campaigns

### A post is not a campaign

**A post** is a single piece of social content published to one or more connected platforms.

**A campaign** is a coordinated series of marketing actions and content around a specific objective — a product, a promotion, a launch, a season.

**A campaign must not become another name for a social post.** Before any campaign action is priced, define exactly what J4 creates and executes. The risk is precise: campaign is the word that makes a 1-point action sound like a 10-point one, and pricing it before defining it is how that happens by accident.

### The presentation economy

A product is created for 2 points and **becomes available immediately**. Improving how it is presented is optional and separate:

> *"You already have several products photographed from this angle. I think this one would look better with a different model position."*

Different pose, angle, hands in pockets, product-only, a different lifestyle shot — **1 Growth Point**, and only when accepted. The product does not wait for it. See [WORK_STUDIO.md](WORK_STUDIO.md), where the separation of product from presentation is already recorded.

---

## 7. Pro is not "more points"

**For selected high-frequency actions, Pro removes the friction of the economy entirely.**

Multi-platform social posting is the first: included with Pro. That produces a real distinction rather than a bigger number.

```
Free / lower tier   "I can post everywhere, but I use Growth Points."
Pro                 "I can run my social presence without thinking about points."
```

Other actions can be designated Pro-included later, based on how valuable and how frequent they are.

## 8. The ledger

An owner-accessible record of:

- current balance
- points earned or allocated
- points spent, and **which action consumed them**
- date and time
- ideally the balance after each transaction

**This is not a public pricing sheet.** The detailed economy lives somewhere appropriate — Settings, account management — while J4 explains a cost contextually at the moment it applies. A pricing page is the shape this must not take.

---

## Implementation order

1. Finish **Product Creation**
2. Build **Social Media Creation** — see [SOCIAL_CREATION.md](SOCIAL_CREATION.md)
3. Implement **this economy**
4. Expand website creation and design capabilities
5. Reassess the whole product before choosing the next major phase

**Do not stop current Creation Station work to implement this.**

## Scope discipline

**Do not expand this scope or invent additional Growth Point charges without discussing them first.** A new charge is a change to what Genesis costs, which is a product decision rather than an implementation detail — and the failure mode is not one wrong price, it is the system stopping feeling like a levelling mechanic and starting to feel like a meter.
