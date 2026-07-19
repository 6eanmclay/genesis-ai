import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
  createProduct,
  editProduct,
  editStore,
  toggleProductActive,
  deleteProduct,
  toggleStorePublished,
} from "./actions";
import { DeleteProductButton } from "./DeleteProductButton";
import { SubmitButton } from "./SubmitButton";
import { GenesisAssistant } from "./GenesisAssistant";
import {
  generateStoreDraft,
  updateStoreDraft,
  discardStoreDraft,
  sendDraftMessage,
  applyThemePersonality,
  restoreStoreDraftVersion,
  confirmStoreDraft,
} from "./ai-actions";

const BRAND_PERSONALITIES = [
  "Luxury",
  "Modern",
  "Professional",
  "Friendly",
  "Heritage",
  "Bold",
  "Minimal",
  "Organic",
] as const;

type DraftTheme = {
  colors: {
    primary: string;
    secondary: string;
    accent: string;
    background: string;
    surface: string;
    text: string;
    textSecondary: string;
  };
  typography: {
    headingFont: string;
    bodyFont: string;
  };
  layout: "grid" | "list" | "featured";
};

type DraftProduct = {
  name: string;
  description: string;
  price: number;
};

const DEFAULT_THEME: DraftTheme = {
  colors: {
    primary: "#000000",
    secondary: "#000000",
    accent: "#000000",
    background: "#ffffff",
    surface: "#ffffff",
    text: "#000000",
    textSecondary: "#666666",
  },
  typography: { headingFont: "", bodyFont: "" },
  layout: "grid",
};

export default async function DashboardPage() {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  const store = await prisma.store.findFirst({
    where: { userId: session.user.id },
  });

  if (!store) {
    const draft = await prisma.storeDraft.findUnique({
      where: { userId: session.user.id },
      include: {
        messages: { orderBy: { createdAt: "asc" } },
        generations: { orderBy: { createdAt: "asc" } },
      },
    });

    if (draft) {
      const theme = (draft.theme as DraftTheme | null) ?? DEFAULT_THEME;
      const products = (draft.productsDraft as DraftProduct[] | null) ?? [];

      return (
        <div className="min-h-screen bg-gradient-to-b from-zinc-100 via-zinc-50 to-white p-8 dark:from-zinc-950 dark:via-black dark:to-zinc-950">
          <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
            Draft: {draft.name}
          </h1>
          <p className="mt-1 text-xs text-zinc-500">version {draft.version}</p>

          <h2 className="mt-10 text-lg font-semibold text-black dark:text-zinc-50">
            Your input
          </h2>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            These are the details you provided to Genesis. Edit them anytime
            to guide your next store vision — regenerating creates a new
            version, replacing the store details, theme, and products below.
          </p>
          <form
            action={generateStoreDraft}
            className="mt-4 flex max-w-md flex-col gap-4"
          >
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-black dark:text-zinc-50">
                Store name
              </label>
              <input
                name="inputStoreName"
                type="text"
                defaultValue={draft.inputStoreName ?? ""}
                className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-black dark:text-zinc-50">
                What do you want to sell?
              </label>
              <input
                name="inputProductType"
                type="text"
                defaultValue={draft.inputProductType ?? ""}
                className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-black dark:text-zinc-50">
                Describe your vision*
              </label>
              <textarea
                name="inputVision"
                defaultValue={draft.inputVision ?? ""}
                rows={3}
                required
                className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
              />
            </div>
            <SubmitButton
              pendingText="Regenerating..."
              className="mt-2 self-start rounded-full border border-black/[.08] px-5 py-2 text-sm disabled:opacity-50 dark:border-white/[.145] dark:text-zinc-50"
            >
              Regenerate
            </SubmitButton>
          </form>

          <h2 className="mt-10 text-lg font-semibold text-black dark:text-zinc-50">
            Theme
          </h2>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            How should your brand feel? Genesis will create a custom color
            palette, typography, and visual style that matches it.
          </p>
          <form
            action={applyThemePersonality}
            className="mt-4 flex max-w-md flex-wrap gap-2"
          >
            {BRAND_PERSONALITIES.map((p) => (
              <SubmitButton
                key={p}
                name="personality"
                value={p}
                pendingText="Applying..."
                className="rounded-full border border-black/[.08] px-4 py-2 text-sm disabled:opacity-50 dark:border-white/[.145] dark:text-zinc-50"
              >
                {p}
              </SubmitButton>
            ))}
            <SubmitButton
              name="personality"
              value="auto"
              pendingText="Applying..."
              className="rounded-full bg-foreground px-4 py-2 text-sm text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
            >
              ✨ Let Genesis Decide
            </SubmitButton>
          </form>

          <form action={updateStoreDraft} className="mt-10">
            <h2 className="text-lg font-semibold text-black dark:text-zinc-50">
              Store details
            </h2>
            <div className="mt-4 flex max-w-md flex-col gap-4">
              <input
                name="name"
                type="text"
                defaultValue={draft.name}
                required
                className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
              />
              <textarea
                name="description"
                defaultValue={draft.description ?? ""}
                rows={3}
                className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
              />
            </div>

            <details className="mt-8">
              <summary className="cursor-pointer text-lg font-semibold text-black dark:text-zinc-50">
                Advanced Customization
              </summary>
              <p className="mt-2 text-xs text-zinc-500">
                Fine-tune individual colors, fonts, and layout by hand — most
                people won&apos;t need this, since Genesis handles design
                above.
              </p>
              <div className="mt-4 grid max-w-md grid-cols-2 gap-4 sm:grid-cols-4">
                {(
                  [
                    ["primary", "colorPrimary"],
                    ["secondary", "colorSecondary"],
                    ["accent", "colorAccent"],
                    ["background", "colorBackground"],
                    ["surface", "colorSurface"],
                    ["text", "colorText"],
                    ["textSecondary", "colorTextSecondary"],
                  ] as const
                ).map(([role, fieldName]) => (
                  <div
                    key={role}
                    className="flex flex-col items-center gap-1"
                  >
                    <input
                      name={fieldName}
                      type="color"
                      defaultValue={theme.colors[role]}
                      className="h-10 w-10 cursor-pointer rounded border border-black/[.08] dark:border-white/[.145]"
                    />
                    <span className="text-xs text-zinc-500">{role}</span>
                  </div>
                ))}
              </div>
              <div className="mt-4 flex max-w-md flex-col gap-4">
                <input
                  name="headingFont"
                  type="text"
                  defaultValue={theme.typography.headingFont}
                  placeholder="Heading font"
                  className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
                />
                <input
                  name="bodyFont"
                  type="text"
                  defaultValue={theme.typography.bodyFont}
                  placeholder="Body font"
                  className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
                />
                <select
                  name="layout"
                  defaultValue={theme.layout}
                  className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
                >
                  <option value="grid">Grid</option>
                  <option value="list">List</option>
                  <option value="featured">Featured</option>
                </select>
              </div>
            </details>

            <h2 className="mt-8 text-lg font-semibold text-black dark:text-zinc-50">
              Products
            </h2>
            <input type="hidden" name="productCount" value={products.length} />
            <ul className="mt-4 flex max-w-md flex-col gap-4">
              {products.map((product, index) => (
                <li
                  key={index}
                  className="flex flex-col gap-2 rounded-lg border border-black/[.08] p-4 dark:border-white/[.145]"
                >
                  <input
                    name={`product-${index}-name`}
                    type="text"
                    defaultValue={product.name}
                    required
                    className="rounded-lg border border-black/[.08] px-3 py-1.5 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
                  />
                  <textarea
                    name={`product-${index}-description`}
                    defaultValue={product.description}
                    rows={2}
                    className="rounded-lg border border-black/[.08] px-3 py-1.5 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
                  />
                  <input
                    name={`product-${index}-price`}
                    type="number"
                    step="0.01"
                    min="0"
                    defaultValue={product.price}
                    required
                    className="rounded-lg border border-black/[.08] px-3 py-1.5 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
                  />
                </li>
              ))}
            </ul>

            <SubmitButton
              pendingText="Saving..."
              className="mt-6 self-start rounded-full bg-foreground px-5 py-2 text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
            >
              Save changes
            </SubmitButton>
          </form>

          {draft.generations.length > 0 &&
            (() => {
              const original =
                draft.generations.find((g) => g.milestone === "original") ??
                draft.generations[0];
              const cards = [
                {
                  key: "original",
                  label: "Original Vision",
                  blurb:
                    "The first version Genesis created from your original idea.",
                  date: original.createdAt,
                  restoreId:
                    original.version !== draft.version ? original.id : null,
                },
                {
                  key: "current",
                  label: "Current Vision",
                  blurb: "The version currently shaping your store.",
                  date: draft.updatedAt,
                  restoreId: null as string | null,
                },
              ];

              return (
                <>
                  <h2 className="mt-10 text-lg font-semibold text-black dark:text-zinc-50">
                    Your Store&apos;s Vision
                  </h2>
                  <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
                    See how your store&apos;s direction has evolved, and bring
                    back an earlier vision anytime. This stays with your
                    store for good — even after it goes live.
                  </p>
                  <ul className="mt-4 flex max-w-md flex-col gap-3">
                    {cards.map((card) => (
                      <li
                        key={card.key}
                        className="rounded-lg border border-black/[.08] p-4 dark:border-white/[.145]"
                      >
                        <p className="font-medium text-black dark:text-zinc-50">
                          {card.label}
                        </p>
                        <p className="mt-1 text-xs text-zinc-500">
                          {card.blurb}
                        </p>
                        <p className="mt-1 text-xs text-zinc-400">
                          {card.date.toLocaleDateString()}
                        </p>
                        {card.restoreId && (
                          <form
                            action={restoreStoreDraftVersion.bind(
                              null,
                              card.restoreId
                            )}
                            className="mt-3"
                          >
                            <SubmitButton
                              pendingText="Restoring..."
                              className="rounded-full border border-black/[.08] px-3 py-1 text-xs disabled:opacity-50 dark:border-white/[.145] dark:text-zinc-50"
                            >
                              Restore This Vision
                            </SubmitButton>
                          </form>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              );
            })()}

          <div className="mt-10 rounded-2xl border border-black/[.08] bg-gradient-to-br from-white to-zinc-50 p-6 text-center shadow-sm dark:border-white/[.145] dark:from-zinc-900 dark:to-zinc-950">
            <p className="text-lg font-semibold text-black dark:text-zinc-50">
              Ready to bring {draft.name} to life?
            </p>
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
              Genesis will turn this vision into a real, working store.
            </p>
            <form action={confirmStoreDraft} className="mt-4 flex justify-center">
              <SubmitButton
                pendingText="Bringing your store to life..."
                className="rounded-full bg-foreground px-8 py-3 text-base font-medium text-background transition-transform hover:scale-105 disabled:opacity-50 dark:hover:bg-[#ccc]"
              >
                Confirm &amp; Create Store
              </SubmitButton>
            </form>
          </div>

          <form action={discardStoreDraft} className="mt-10">
            <SubmitButton
              pendingText="Discarding..."
              className="rounded-full border border-black/[.08] px-4 py-1.5 text-sm disabled:opacity-50 dark:border-white/[.145] dark:text-zinc-50"
            >
              Discard draft
            </SubmitButton>
          </form>

          <GenesisAssistant
            storeName={draft.name}
            messages={draft.messages}
            sendMessage={sendDraftMessage}
          />
        </div>
      );
    }

    return (
      <div className="min-h-screen bg-zinc-50 p-8 dark:bg-black">
        <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
          Create your store
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Tell Genesis about your business. Share your vision, and Genesis
          will transform it into a complete online store.
        </p>

        <form
          action={generateStoreDraft}
          className="mt-6 flex max-w-md flex-col gap-4"
        >
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-black dark:text-zinc-50">
              Store name
            </label>
            <p className="text-xs text-zinc-500">
              Optional — If you already have a name, tell us. If not, Genesis
              will create one for you.
            </p>
            <input
              name="inputStoreName"
              type="text"
              placeholder="e.g. Atlas Athletics"
              className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-black dark:text-zinc-50">
              What do you want to sell?
            </label>
            <p className="text-xs text-zinc-500">
              Optional — Tell us what products or services you want to offer.
            </p>
            <input
              name="inputProductType"
              type="text"
              placeholder="e.g. Performance gym clothing"
              className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-black dark:text-zinc-50">
              Describe your vision*
            </label>
            <p className="text-xs text-zinc-500">
              Required — Tell Genesis about your style, audience, colors,
              branding, and the feeling you want your store to create.
            </p>
            <textarea
              name="inputVision"
              placeholder={`"Cozy rustic candle shop."\n"Dark luxury fitness brand."\n"Minimalist clothing company."`}
              rows={4}
              required
              className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
            />
          </div>

          <SubmitButton
            pendingText="Creating..."
            className="mt-2 self-start rounded-full bg-foreground px-5 py-2 text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
          >
            Create My Store
          </SubmitButton>
        </form>
      </div>
    );
  }

  const products = await prisma.product.findMany({
    where: { storeId: store.id },
    orderBy: { position: "asc" },
  });

  const visions = await prisma.storeGeneration.findMany({
    where: { storeId: store.id },
    orderBy: { createdAt: "asc" },
  });
  const originalVision = visions.find((v) => v.milestone === "original");
  const firstRefinedVision = visions.find(
    (v) => v.milestone === "first_refined"
  );

  return (
    <div className="min-h-screen bg-zinc-50 p-8 dark:bg-black">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
          {store.name}
        </h1>
        <form action={toggleStorePublished}>
          <SubmitButton
            pendingText="Updating..."
            className="rounded-full border border-black/[.08] px-4 py-1.5 text-sm disabled:opacity-50 dark:border-white/[.145] dark:text-zinc-50"
          >
            {store.published ? "Published — unpublish" : "Unpublished — publish"}
          </SubmitButton>
        </form>
      </div>

      <h2 className="mt-10 text-lg font-semibold text-black dark:text-zinc-50">
        Store settings
      </h2>
      <form action={editStore} className="mt-4 flex max-w-md flex-col gap-4">
        <input
          name="name"
          type="text"
          defaultValue={store.name}
          required
          className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
        />
        <textarea
          name="description"
          defaultValue={store.description ?? ""}
          placeholder="Description (optional)"
          rows={3}
          className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
        />
        <SubmitButton
          pendingText="Saving..."
          className="mt-2 self-start rounded-full bg-foreground px-5 py-2 text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
        >
          Save store info
        </SubmitButton>
      </form>

      {originalVision && (
        <>
          <h2 className="mt-10 text-lg font-semibold text-black dark:text-zinc-50">
            Your Store&apos;s Vision
          </h2>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            The story of how {store.name} came to be — this stays with your
            store for good.
          </p>
          <ul className="mt-4 flex max-w-md flex-col gap-3">
            <li className="rounded-lg border border-black/[.08] p-4 dark:border-white/[.145]">
              <p className="font-medium text-black dark:text-zinc-50">
                Original Vision
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                The first version Genesis created from your original idea.
              </p>
              <p className="mt-1 text-xs text-zinc-400">
                {originalVision.createdAt.toLocaleDateString()}
              </p>
            </li>
            {firstRefinedVision && (
              <li className="rounded-lg border border-black/[.08] p-4 dark:border-white/[.145]">
                <p className="font-medium text-black dark:text-zinc-50">
                  First Refined Vision
                </p>
                <p className="mt-1 text-xs text-zinc-500">
                  The first version you chose to bring to life.
                </p>
                <p className="mt-1 text-xs text-zinc-400">
                  {firstRefinedVision.createdAt.toLocaleDateString()}
                </p>
              </li>
            )}
            <li className="rounded-lg border border-black/[.08] p-4 dark:border-white/[.145]">
              <p className="font-medium text-black dark:text-zinc-50">
                Current Vision
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                The version currently powering your store.
              </p>
              <p className="mt-1 text-xs text-zinc-400">
                {store.updatedAt.toLocaleDateString()}
              </p>
            </li>
          </ul>
        </>
      )}

      <h2 className="mt-10 text-lg font-semibold text-black dark:text-zinc-50">
        Products
      </h2>

      {products.length === 0 ? (
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          No products yet. Add your first one below.
        </p>
      ) : (
        <ul className="mt-4 flex max-w-md flex-col gap-4">
          {products.map((product) => (
            <li
              key={product.id}
              className="rounded-lg border border-black/[.08] p-4 dark:border-white/[.145]"
            >
              <form
                action={editProduct.bind(null, product.id)}
                className="flex flex-col gap-2"
              >
                <input
                  name="name"
                  type="text"
                  defaultValue={product.name}
                  required
                  className="rounded-lg border border-black/[.08] px-3 py-1.5 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
                />
                <textarea
                  name="description"
                  defaultValue={product.description ?? ""}
                  placeholder="Description (optional)"
                  rows={2}
                  className="rounded-lg border border-black/[.08] px-3 py-1.5 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
                />
                <input
                  name="price"
                  type="number"
                  step="0.01"
                  min="0"
                  defaultValue={(product.priceInCents / 100).toFixed(2)}
                  required
                  className="rounded-lg border border-black/[.08] px-3 py-1.5 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
                />
                <SubmitButton
                  pendingText="Saving..."
                  className="mt-1 self-start rounded-full bg-foreground px-4 py-1 text-sm text-background hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
                >
                  Save
                </SubmitButton>
              </form>

              <div className="mt-3 flex items-center gap-3">
                <form action={toggleProductActive.bind(null, product.id)}>
                  <SubmitButton
                    pendingText="Updating..."
                    className="text-xs text-zinc-500 underline hover:text-black disabled:opacity-50 dark:hover:text-zinc-50"
                  >
                    {product.active ? "Active — hide" : "Hidden — show"}
                  </SubmitButton>
                </form>
                <form action={deleteProduct.bind(null, product.id)}>
                  <DeleteProductButton />
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h2 className="mt-10 text-lg font-semibold text-black dark:text-zinc-50">
        Add a product
      </h2>
      <form action={createProduct} className="mt-4 flex max-w-md flex-col gap-4">
        <input
          name="name"
          type="text"
          placeholder="Product name"
          required
          className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
        />
        <textarea
          name="description"
          placeholder="Description (optional)"
          rows={3}
          className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
        />
        <input
          name="price"
          type="number"
          step="0.01"
          min="0"
          placeholder="Price (e.g. 19.99)"
          required
          className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
        />
        <SubmitButton
          pendingText="Adding..."
          className="mt-2 rounded-full bg-foreground px-5 py-2 text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
        >
          Add product
        </SubmitButton>
      </form>
    </div>
  );
}
