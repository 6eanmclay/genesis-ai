import Link from "next/link";

// Genesis's own platform Privacy Policy — same real gap and same
// discipline as app/terms/page.tsx (see that file's own header comment):
// a genuine, honest starting point reflecting how Genesis actually
// handles data today, not a substitute for real legal review.
export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-zinc-50 px-8 py-16 dark:bg-black">
      <div className="mx-auto max-w-2xl">
        <Link href="/" className="text-sm text-zinc-500 hover:underline">
          &larr; Back to Genesis
        </Link>
        <h1 className="mt-4 text-3xl font-semibold text-black dark:text-zinc-50">
          Privacy Policy
        </h1>
        <p className="mt-2 text-sm text-zinc-500">Last updated: [PLACEHOLDER — date this actually goes live]</p>

        <div className="mt-8 flex flex-col gap-6 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
          <p>
            This Privacy Policy explains what information Genesis collects, how we use it, and who we share it
            with when you use Genesis to build and run your business.
          </p>

          <section>
            <h2 className="text-base font-semibold text-black dark:text-zinc-50">1. What We Collect</h2>
            <p className="mt-2">
              <strong className="text-black dark:text-zinc-50">Account information</strong> — your name, email,
              and password (stored as a securely hashed value, never in plain text) when you sign up.
            </p>
            <p className="mt-2">
              <strong className="text-black dark:text-zinc-50">Business information</strong> — whatever you tell
              Genesis about the business you&rsquo;re building (your idea, brand direction, product details), used
              to generate your store.
            </p>
            <p className="mt-2">
              <strong className="text-black dark:text-zinc-50">Connected-service credentials</strong> — when you
              connect Stripe, PayPal, or a fulfillment provider, we store the access credentials needed to act on
              your behalf, encrypted at rest. We never see or store your customers&rsquo; raw card numbers —
              payment processing happens directly with Stripe or PayPal.
            </p>
            <p className="mt-2">
              <strong className="text-black dark:text-zinc-50">Order and customer data</strong> — when your store
              makes a real sale, we store the order details (product, amount, buyer email, shipping address) so
              you can view, fulfill, and analyze your own orders.
            </p>
            <p className="mt-2">
              <strong className="text-black dark:text-zinc-50">Usage data</strong> — basic activity on the
              platform (what actions you take, when), used to operate and improve Genesis and to enforce
              reasonable usage limits.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black dark:text-zinc-50">2. How We Use It</h2>
            <p className="mt-2">
              We use your information to operate Genesis: generating and running your store, processing the
              connections you set up, showing you your own real business data (orders, customers, revenue), and
              maintaining the security and reliability of the platform.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black dark:text-zinc-50">3. Who We Share It With</h2>
            <p className="mt-2">
              <strong className="text-black dark:text-zinc-50">Anthropic</strong> (Claude) — the business
              description and content you provide is sent to Anthropic&rsquo;s API to generate your store&rsquo;s
              branding and content.
            </p>
            <p className="mt-2">
              <strong className="text-black dark:text-zinc-50">Stripe / PayPal</strong> — when you connect a
              payment provider, relevant account and transaction data is shared with that provider to process
              real payments.
            </p>
            <p className="mt-2">
              <strong className="text-black dark:text-zinc-50">Printful</strong> (or another connected fulfillment
              provider) — product and order details are shared so physical goods can be produced and shipped.
            </p>
            <p className="mt-2">We don&rsquo;t sell your data, or your customers&rsquo; data, to anyone.</p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black dark:text-zinc-50">4. Data Retention</h2>
            <p className="mt-2">
              We keep your account and business data for as long as your account is active. If you delete your
              account, we&rsquo;ll remove your personal account information, though some records (like completed
              order history) may be retained where needed for legal, accounting, or fraud-prevention purposes.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black dark:text-zinc-50">5. Your Rights</h2>
            <p className="mt-2">
              You can access, correct, or request deletion of your account information at any time by contacting
              us. If your business operates in a region with additional data rights (like the EU&rsquo;s GDPR or
              California&rsquo;s CCPA), those rights apply to you as described by that law.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black dark:text-zinc-50">6. Security</h2>
            <p className="mt-2">
              Passwords are hashed, not stored in plain text. Connected-service credentials (Stripe, PayPal,
              fulfillment providers) are encrypted at rest. We use industry-standard practices to protect your
              data, but no system is perfectly secure, and we can&rsquo;t guarantee absolute security.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black dark:text-zinc-50">7. Children&rsquo;s Privacy</h2>
            <p className="mt-2">
              Genesis is not directed at children under 16, and we don&rsquo;t knowingly collect information from
              them.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black dark:text-zinc-50">8. Changes to This Policy</h2>
            <p className="mt-2">
              We may update this policy as Genesis evolves. We&rsquo;ll post the updated version here with a new
              &ldquo;last updated&rdquo; date.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black dark:text-zinc-50">9. Contact</h2>
            <p className="mt-2">
              Questions about this policy, or a data request? Reach us at [PLACEHOLDER — real support/legal
              contact email].
            </p>
          </section>

          <p className="mt-4 text-xs text-zinc-500">
            This document is a genuine starting point written to reflect how Genesis actually handles data today
            — it is not a substitute for review by a real attorney familiar with your business and jurisdiction
            before real users rely on it.
          </p>
        </div>
      </div>
    </div>
  );
}
