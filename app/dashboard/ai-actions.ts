"use server";

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { slugify } from "@/lib/slugify";
import { Prisma } from "@prisma/client";

const anthropic = new Anthropic();

const PROMPT_VERSION = "v1";

const StoreBlueprintSchema = z.object({
  storeName: z.string(),
  description: z.string(),
  theme: z.object({
    colors: z.object({
      primary: z.string(),
      secondary: z.string(),
      accent: z.string(),
      background: z.string(),
      surface: z.string(),
      text: z.string(),
      textSecondary: z.string(),
    }),
    typography: z.object({
      headingFont: z.string(),
      bodyFont: z.string(),
    }),
    layout: z.enum(["grid", "list", "featured"]),
  }),
  products: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      price: z.number(),
    })
  ),
});

export async function generateStoreDraft(formData: FormData) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const inputStoreName =
    (formData.get("inputStoreName") as string)?.trim() || null;
  const inputProductType =
    (formData.get("inputProductType") as string)?.trim() || null;
  const inputVision = (formData.get("inputVision") as string)?.trim() || null;

  if (!inputVision) {
    throw new Error("Please describe your vision");
  }

  const message = await anthropic.messages.parse({
    model: "claude-opus-4-8",
    max_tokens: 2048,
    system:
      "You are a branding and e-commerce assistant for Genesis AI, a platform that helps users create online storefronts by collaborating with them, not replacing their input. Users may specify some details themselves (a store name, what they sell, and/or a vision for their brand) and leave the rest for you to generate.\n\nRules:\n- Treat any user-provided store name as fixed. Use it exactly as given — never change, rename, or reinterpret it.\n- Treat any user-provided description of what they sell as a fixed constraint. Build the product catalog around it.\n- Treat any user-provided vision (style, audience, colors, branding) as fixed creative direction. Let it guide your choices for whichever parts they didn't specify.\n- Only invent details for fields the user left unspecified. When inventing, make deliberate, on-brand choices — not generic placeholders.\n\nAlways produce: a complete store name (the user's, if given), a short store description, a cohesive color/typography/layout theme, and 3-5 starter products with realistic names, short descriptions, and prices in US dollars.",
    messages: [
      {
        role: "user",
        content: [
          `Store name: ${inputStoreName ?? "(not specified — invent one)"}`,
          `What they sell: ${
            inputProductType ?? "(not specified — invent something fitting)"
          }`,
          `Vision: ${inputVision ?? "(not specified — use your best judgment)"}`,
        ].join("\n"),
      },
    ],
    output_config: {
      format: zodOutputFormat(StoreBlueprintSchema),
    },
  });

  const blueprint = message.parsed_output;
  if (!blueprint) {
    throw new Error("Failed to generate store blueprint");
  }

  const generatedOutput = {
    name: blueprint.storeName,
    description: blueprint.description,
    theme: blueprint.theme,
    productsDraft: blueprint.products,
  };

  const draft = await prisma.storeDraft.upsert({
    where: { userId: session.user.id },
    create: {
      userId: session.user.id,
      inputStoreName,
      inputProductType,
      inputVision,
      name: blueprint.storeName,
      description: blueprint.description,
      theme: blueprint.theme,
      productsDraft: blueprint.products,
      status: "ready",
    },
    update: {
      inputStoreName,
      inputProductType,
      inputVision,
      name: blueprint.storeName,
      description: blueprint.description,
      theme: blueprint.theme,
      productsDraft: blueprint.products,
      status: "ready",
      version: { increment: 1 },
    },
  });

  await prisma.storeGeneration.create({
    data: {
      storeDraftId: draft.id,
      version: draft.version,
      promptVersion: PROMPT_VERSION,
      // version === 1 only happens on the very first generation a draft
      // ever gets (every regenerate/chat update increments it), so this is
      // reliably "the original vision" without a separate lookup.
      milestone: draft.version === 1 ? "original" : null,
      generatedOutput,
    },
  });

  redirect("/dashboard");
}

const LAYOUTS = ["grid", "list", "featured"] as const;

export async function updateStoreDraft(formData: FormData) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const name = (formData.get("name") as string)?.trim();
  const description = (formData.get("description") as string)?.trim();

  if (!name) {
    throw new Error("Store name is required");
  }

  const layout = formData.get("layout") as string;
  if (!LAYOUTS.includes(layout as (typeof LAYOUTS)[number])) {
    throw new Error("Invalid layout");
  }

  const theme = {
    colors: {
      primary: (formData.get("colorPrimary") as string)?.trim(),
      secondary: (formData.get("colorSecondary") as string)?.trim(),
      accent: (formData.get("colorAccent") as string)?.trim(),
      background: (formData.get("colorBackground") as string)?.trim(),
      surface: (formData.get("colorSurface") as string)?.trim(),
      text: (formData.get("colorText") as string)?.trim(),
      textSecondary: (formData.get("colorTextSecondary") as string)?.trim(),
    },
    typography: {
      headingFont: (formData.get("headingFont") as string)?.trim(),
      bodyFont: (formData.get("bodyFont") as string)?.trim(),
    },
    layout,
  };

  const productCount = parseInt(
    (formData.get("productCount") as string) || "0",
    10
  );
  const products = [];
  for (let i = 0; i < productCount; i++) {
    const productName = (formData.get(`product-${i}-name`) as string)?.trim();
    const productDescription = (
      formData.get(`product-${i}-description`) as string
    )?.trim();
    const priceInput = formData.get(`product-${i}-price`) as string;
    const price = parseFloat(priceInput);

    if (!productName) {
      throw new Error("Each product needs a name");
    }
    if (!Number.isFinite(price) || price < 0) {
      throw new Error("Enter a valid price for each product");
    }

    products.push({
      name: productName,
      description: productDescription || "",
      price,
    });
  }

  await prisma.storeDraft.update({
    where: { userId: session.user.id },
    data: {
      name,
      description: description || null,
      theme,
      productsDraft: products,
    },
  });

  redirect("/dashboard");
}

type ThemeColors = {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  surface: string;
  text: string;
  textSecondary: string;
};

type Theme = {
  colors: ThemeColors;
  typography: { headingFont: string; bodyFont: string };
  layout: "grid" | "list" | "featured";
};

type Product = { name: string; description: string; price: number };

type DraftState = {
  name: string;
  description: string | null;
  theme: Theme;
  products: Product[];
};

function diffDraftChanges(before: DraftState, after: DraftState): string[] {
  const changes: string[] = [];

  if (before.name !== after.name) {
    changes.push(`Store name changed from "${before.name}" to "${after.name}"`);
  }
  if ((before.description ?? "") !== (after.description ?? "")) {
    changes.push("Store description changed");
  }

  for (const role of Object.keys(after.theme.colors) as (keyof ThemeColors)[]) {
    if (before.theme.colors[role] !== after.theme.colors[role]) {
      changes.push(`theme.colors.${role} changed`);
    }
  }
  if (before.theme.typography.headingFont !== after.theme.typography.headingFont) {
    changes.push("theme.typography.headingFont changed");
  }
  if (before.theme.typography.bodyFont !== after.theme.typography.bodyFont) {
    changes.push("theme.typography.bodyFont changed");
  }
  if (before.theme.layout !== after.theme.layout) {
    changes.push(`theme.layout changed to ${after.theme.layout}`);
  }

  const beforeNames = new Set(before.products.map((p) => p.name));
  const afterNames = new Set(after.products.map((p) => p.name));
  const added = [...afterNames].filter((n) => !beforeNames.has(n));
  const removed = [...beforeNames].filter((n) => !afterNames.has(n));
  if (added.length > 0) {
    changes.push(`products added: ${added.join(", ")}`);
  }
  if (removed.length > 0) {
    changes.push(`products removed: ${removed.join(", ")}`);
  }
  for (const product of after.products) {
    const match = before.products.find((p) => p.name === product.name);
    if (match && match.price !== product.price) {
      changes.push(`"${product.name}" price changed from $${match.price} to $${product.price}`);
    }
  }

  return changes;
}

const ChatUpdateSchema = z.object({
  reply: z.string(),
  requiresConfirmation: z.boolean(),
  storeName: z.string(),
  description: z.string(),
  theme: z.object({
    colors: z.object({
      primary: z.string(),
      secondary: z.string(),
      accent: z.string(),
      background: z.string(),
      surface: z.string(),
      text: z.string(),
      textSecondary: z.string(),
    }),
    typography: z.object({
      headingFont: z.string(),
      bodyFont: z.string(),
    }),
    layout: z.enum(["grid", "list", "featured"]),
  }),
  products: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      price: z.number(),
    })
  ),
});

const CHAT_SYSTEM_PROMPT = `You are Genesis, a creative partner helping a user turn their idea into a real business — not a general chatbot or customer support agent. You are talking with them specifically about the store draft described below, and your tone should feel like a design collaborator invested in this specific store's success, not a generic assistant.

You will be given the current store draft and the user's latest message. Respond in one of two ways:

1. Apply the change directly. Return the complete updated draft with the requested change applied, and set requiresConfirmation to false. Preserve every field the user did not ask to change EXACTLY as given — do not rephrase, regenerate, or "improve" anything beyond what was requested. Use this for broad requests that clearly invite sweeping changes (e.g. "redesign my store", "make this feel more premium", "refresh the whole look") and for small, unambiguous requests (e.g. "remove the hoodie", "make the accent color more blue").

2. Propose the change and ask for confirmation first. Return the complete proposed draft (so it's ready to apply if confirmed) but set requiresConfirmation to true, and phrase your reply as a specific proposal, e.g. "I'll update your store name from X to Y — this will update your branding across the store. Should I go ahead?" Use this only for changes to foundational identity — most importantly the store name — where an unconfirmed change could feel jarring or accidental.

If you previously proposed a change awaiting confirmation (noted in the message below) and the user's new message confirms it (e.g. "yes", "go ahead", "do it", "sounds good"), apply that previously proposed change now (requiresConfirmation: false). If their new message asks for something different instead, treat it as a new request.

When recommending colors or theme choices, briefly explain why in your reply (e.g. "I recommend this palette because it matches your brand positioning") — you are the primary way this user shapes their store's design, not just a fallback to manual editing.

Keep your reply conversational and brief (1-3 sentences).`;

async function applyGenesisMessage(userId: string, userMessage: string) {
  const draft = await prisma.storeDraft.findUnique({
    where: { userId },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
  if (!draft) {
    redirect("/dashboard");
  }

  await prisma.storeDraftMessage.create({
    data: { storeDraftId: draft.id, role: "user", content: userMessage },
  });

  const currentTheme = draft.theme as Theme;
  const currentProducts = (draft.productsDraft as Product[] | null) ?? [];
  const before: DraftState = {
    name: draft.name,
    description: draft.description,
    theme: currentTheme,
    products: currentProducts,
  };

  const pending = draft.pendingChange as
    | { summary: string; blueprint: z.infer<typeof ChatUpdateSchema> }
    | null;

  const draftSummary = [
    `Store name: ${draft.name}`,
    `Description: ${draft.description ?? ""}`,
    `Theme colors: ${JSON.stringify(currentTheme.colors)}`,
    `Typography: heading=${currentTheme.typography.headingFont}, body=${currentTheme.typography.bodyFont}`,
    `Layout: ${currentTheme.layout}`,
    `Products: ${currentProducts
      .map((p) => `${p.name} ($${p.price}) - ${p.description}`)
      .join("; ")}`,
  ].join("\n");

  const contextParts = [`Current store draft:\n${draftSummary}`];
  if (pending) {
    contextParts.push(
      `\nYou previously proposed this change, awaiting confirmation: "${pending.summary}"`
    );
  }
  contextParts.push(`\nUser's latest message: ${userMessage}`);

  const conversationMessages = draft.messages.map((m) => ({
    role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
    content: m.content,
  }));

  const message = await anthropic.messages.parse({
    model: "claude-opus-4-8",
    max_tokens: 2048,
    system: CHAT_SYSTEM_PROMPT,
    messages: [
      ...conversationMessages,
      { role: "user", content: contextParts.join("\n") },
    ],
    output_config: {
      format: zodOutputFormat(ChatUpdateSchema),
    },
  });

  const result = message.parsed_output;
  if (!result) {
    throw new Error("Genesis couldn't process that request");
  }

  let changes: string[] = [];

  if (result.requiresConfirmation) {
    await prisma.storeDraft.update({
      where: { id: draft.id },
      data: {
        pendingChange: { summary: result.reply, blueprint: result },
      },
    });
  } else {
    const after: DraftState = {
      name: result.storeName,
      description: result.description,
      theme: result.theme,
      products: result.products,
    };
    changes = diffDraftChanges(before, after);

    const updated = await prisma.storeDraft.update({
      where: { id: draft.id },
      data: {
        name: result.storeName,
        description: result.description,
        theme: result.theme,
        productsDraft: result.products,
        pendingChange: Prisma.DbNull,
        version: { increment: 1 },
      },
    });

    await prisma.storeGeneration.create({
      data: {
        storeDraftId: draft.id,
        version: updated.version,
        promptVersion: "chat-v1",
        generatedOutput: {
          name: result.storeName,
          description: result.description,
          theme: result.theme,
          productsDraft: result.products,
        },
      },
    });
  }

  await prisma.storeDraftMessage.create({
    data: {
      storeDraftId: draft.id,
      role: "assistant",
      content: result.reply,
      changes: changes.length > 0 ? changes : undefined,
    },
  });

  redirect("/dashboard");
}

export async function sendDraftMessage(formData: FormData) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const userMessage = (formData.get("message") as string)?.trim();
  if (!userMessage) {
    throw new Error("Please enter a message");
  }

  await applyGenesisMessage(session.user.id, userMessage);
}

const PERSONALITY_PROMPTS: Record<string, string> = {
  Luxury: "Make my brand feel Luxury.",
  Modern: "Make my brand feel Modern.",
  Professional: "Make my brand feel Professional.",
  Friendly: "Make my brand feel Friendly.",
  Heritage: "Make my brand feel Heritage.",
  Bold: "Make my brand feel Bold.",
  Minimal: "Make my brand feel Minimal.",
  Organic: "Make my brand feel Organic.",
  auto: "Let Genesis decide what brand personality and theme would work best for my store.",
};

export async function applyThemePersonality(formData: FormData) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const personality = formData.get("personality") as string;
  const message = PERSONALITY_PROMPTS[personality];
  if (!message) {
    throw new Error("Unknown brand personality");
  }

  await applyGenesisMessage(session.user.id, message);
}

export async function restoreStoreDraftVersion(generationId: string) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const generation = await prisma.storeGeneration.findFirst({
    where: { id: generationId, storeDraft: { userId: session.user.id } },
  });
  if (!generation || !generation.storeDraftId) {
    throw new Error("Version not found");
  }

  const output = generation.generatedOutput as {
    name: string;
    description: string | null;
    theme: Theme;
    productsDraft: Product[];
  };

  const updated = await prisma.storeDraft.update({
    where: { id: generation.storeDraftId },
    data: {
      name: output.name,
      description: output.description,
      theme: output.theme,
      productsDraft: output.productsDraft,
      pendingChange: Prisma.DbNull,
      version: { increment: 1 },
    },
  });

  await prisma.storeGeneration.create({
    data: {
      storeDraftId: updated.id,
      version: updated.version,
      promptVersion: "restore",
      generatedOutput: output,
    },
  });

  await prisma.storeDraftMessage.create({
    data: {
      storeDraftId: updated.id,
      role: "assistant",
      content: `Restored to version ${generation.version}.`,
      changes: [`Restored from version ${generation.version}`],
    },
  });

  redirect("/dashboard");
}

export async function confirmStoreDraft() {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const draft = await prisma.storeDraft.findUnique({
    where: { userId: session.user.id },
  });
  if (!draft) {
    redirect("/dashboard");
  }

  const theme = draft.theme as Theme;
  const products = (draft.productsDraft as Product[] | null) ?? [];

  const baseSlug = slugify(draft.name);
  let slug = baseSlug;
  let suffix = 1;
  while (await prisma.store.findUnique({ where: { slug } })) {
    slug = `${baseSlug}-${suffix}`;
    suffix++;
  }

  const store = await prisma.store.create({
    data: {
      userId: session.user.id,
      name: draft.name,
      slug,
      description: draft.description,
      theme,
      version: draft.version,
      products: {
        create: products.map((p, index) => ({
          name: p.name,
          description: p.description || null,
          priceInCents: Math.round(p.price * 100),
          position: index,
        })),
      },
    },
  });

  // Promote every generation from the draft to the new store so its
  // history survives the draft being deleted below — this is what makes
  // "Your Store's Vision" a permanent part of the store, not just the
  // draft phase.
  await prisma.storeGeneration.updateMany({
    where: { storeDraftId: draft.id },
    data: { storeId: store.id, storeDraftId: null },
  });

  // Stamp whichever generation is live right now as "first refined" — the
  // version the user actually chose to bring to life. Skip it if that same
  // generation is already tagged "original" (a store confirmed with zero
  // edits shouldn't get two competing milestone labels on one row).
  await prisma.storeGeneration.updateMany({
    where: { storeId: store.id, version: draft.version, milestone: null },
    data: { milestone: "first_refined" },
  });

  await prisma.storeDraft.delete({ where: { id: draft.id } });

  redirect("/dashboard");
}

export async function discardStoreDraft() {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  await prisma.storeDraft.deleteMany({
    where: { userId: session.user.id },
  });

  redirect("/dashboard");
}
