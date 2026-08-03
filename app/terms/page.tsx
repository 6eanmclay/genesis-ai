import Link from "next/link";

// Genesis's own platform Terms of Service — for people who sign up to
// build and run a business with Genesis. Distinct from a merchant's own
// store policies (Settings > shippingPolicy/returnPolicy/termsAndConditions
// etc.), which are AI-generated per-store content for THAT store's
// customers — this page is the one legal document Genesis itself has
// never had, found as a real gap during the launch-readiness audit.
//
// Written as real, reasonable standard-SaaS terms — same calibration this
// codebase already applies to AI-generated merchant policies (see
// GENERATION_SECONDARY_SYSTEM_PROMPT in ai-actions.ts): a genuine starting
// point, not a substitute for professional legal review. [PLACEHOLDER]
// markers below need Sean's real business/contact details before this is
// genuinely ready for real users.
export default function TermsPage() {
  return (
    <div className="min-h-screen bg-zinc-50 px-8 py-16 dark:bg-black">
      <div className="mx-auto max-w-2xl">
        <Link href="/" className="text-sm text-zinc-500 hover:underline">
          &larr; Back to Genesis
        </Link>
        <h1 className="mt-4 text-3xl font-semibold text-black dark:text-zinc-50">
          Terms of Service
        </h1>
        <p className="mt-2 text-sm text-zinc-500">Last updated: [PLACEHOLDER — date this actually goes live]</p>

        <div className="mt-8 flex flex-col gap-6 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
          <p>
            These Terms of Service (&ldquo;Terms&rdquo;) govern your access to and use of Genesis
            (&ldquo;Genesis,&rdquo; &ldquo;we,&rdquo; &ldquo;us&rdquo;), an AI-assisted platform for building and
            operating an online store. By creating an account or using Genesis, you agree to these Terms.
          </p>

          <section>
            <h2 className="text-base font-semibold text-black dark:text-zinc-50">1. What Genesis Is</h2>
            <p className="mt-2">
              Genesis helps you describe a business in plain language and turns that description into a real
              storefront — branding, product listings, and store content — which you can review, edit, and publish.
              Genesis also connects to third-party services on your behalf when you choose to, including payment
              processors (Stripe, PayPal) and fulfillment providers (currently Printful), so your store can accept
              real orders and have them produced and shipped.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black dark:text-zinc-50">2. Your Account</h2>
            <p className="mt-2">
              You&rsquo;re responsible for the accuracy of the information you provide, for keeping your login
              credentials secure, and for all activity that happens under your account. You must be legally able to
              enter into these Terms and to run the kind of business you describe to Genesis.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black dark:text-zinc-50">3. AI-Generated Content</h2>
            <p className="mt-2">
              Genesis uses AI to generate store content on your behalf — including product descriptions, brand
              copy, and store policies (shipping, returns, privacy, and terms language shown to your own
              customers). This content is a real starting point, not professional advice. You&rsquo;re responsible
              for reviewing anything Genesis generates before it goes live, especially content with legal or
              regulatory implications (like your own store&rsquo;s policies), and for correcting anything that
              doesn&rsquo;t accurately describe your business.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black dark:text-zinc-50">4. Payments and Fulfillment</h2>
            <p className="mt-2">
              Genesis does not hold or process your customers&rsquo; funds directly. Payments go straight to your
              own connected Stripe or PayPal account, subject to that provider&rsquo;s own terms. You must connect
              Stripe or PayPal before your store can publish or accept payments — Genesis never routes real funds
              through any account other than the one you connect. Fulfillment (production and shipping of physical
              goods) is handled by third-party providers you connect; Genesis facilitates the connection but is not
              the merchant of record for those goods.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black dark:text-zinc-50">5. Acceptable Use</h2>
            <p className="mt-2">
              You agree not to use Genesis to build or operate a business that is illegal, fraudulent, or violates
              the terms of any third-party service Genesis connects to (Stripe, PayPal, Printful, or others). We
              may suspend or terminate accounts that violate this.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black dark:text-zinc-50">6. Third-Party Services</h2>
            <p className="mt-2">
              Genesis integrates with third-party services (including Stripe, PayPal, Printful, and Anthropic) to
              provide its features. Your use of those integrations is also governed by each provider&rsquo;s own
              terms. Genesis isn&rsquo;t responsible for the availability or conduct of these third parties.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black dark:text-zinc-50">7. Termination</h2>
            <p className="mt-2">
              You can stop using Genesis at any time. We may suspend or terminate your access if you violate these
              Terms or if we reasonably believe your use of Genesis creates risk or legal exposure for Genesis or
              others.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black dark:text-zinc-50">8. Disclaimers &amp; Limitation of Liability</h2>
            <p className="mt-2">
              Genesis is provided &ldquo;as is.&rdquo; We don&rsquo;t guarantee that AI-generated content will be
              accurate, that the service will be uninterrupted, or that connected third-party services will
              function without error. To the fullest extent permitted by law, Genesis isn&rsquo;t liable for
              indirect, incidental, or consequential damages arising from your use of the platform.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black dark:text-zinc-50">9. Changes to These Terms</h2>
            <p className="mt-2">
              We may update these Terms as Genesis evolves. We&rsquo;ll post the updated version here with a new
              &ldquo;last updated&rdquo; date; continuing to use Genesis after a change means you accept the
              update.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black dark:text-zinc-50">10. Contact</h2>
            <p className="mt-2">
              Questions about these Terms? Reach us at [PLACEHOLDER — real support/legal contact email].
            </p>
          </section>

          <p className="mt-4 text-xs text-zinc-500">
            This document is a genuine starting point written to reflect how Genesis actually works today — it is
            not a substitute for review by a real attorney familiar with your business and jurisdiction before
            real users rely on it.
          </p>
        </div>
      </div>
    </div>
  );
}
