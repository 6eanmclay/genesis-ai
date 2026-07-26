import type { IntegrationConnector } from "@/lib/integrations/types";
import type { Executable } from "../executable";
import { EXECUTION_ACTIONS } from "../actions";

// PH-02's IntegrationConnector and PH-03's Executable stay separate
// contracts, composed via this thin adapter rather than folded into one —
// ConnectResult's `redirect`/`form`/`connected` cases don't map cleanly
// onto a single run() call, and forcing them to would bloat Executable with
// integration-only concepts. IntegrationConnector stays the source of truth
// for how an integration works; Executable stays the source of truth for
// how any action reports its outcome. See ARCHITECTURE.md.

interface ConnectInput {
  params?: Record<string, string>;
}

interface ConnectMetadata {
  fields?: { name: string; label: string; type: "text" | "password" }[];
}

export function connectExecutable(
  connector: IntegrationConnector
): Executable<ConnectInput, ConnectMetadata> {
  return {
    action:
      connector.provider === "STRIPE"
        ? EXECUTION_ACTIONS.INTEGRATION_STRIPE_CONNECT
        : `integration.${connector.provider.toLowerCase()}.connect`,
    requiredPermission: connector.requiredPermission,
    async run(input, ctx) {
      const result = await connector.connect(ctx.storeId, ctx.userId!, input.params);
      if (result.kind === "redirect") {
        return { message: `Redirecting to ${connector.displayName}`, redirectUrl: result.url };
      }
      if (result.kind === "form") {
        // Nothing was connected yet — a form was returned, awaiting more
        // input. Equally non-terminal as a redirect handoff, so PENDING.
        return {
          message: `Additional information required for ${connector.displayName}`,
          metadata: { fields: result.fields },
          pending: true,
        };
      }
      return { message: `${connector.displayName} connected` };
    },
  };
}

export function verifyExecutable(
  connector: IntegrationConnector
): Executable<void, Record<string, never>> {
  return {
    action:
      connector.provider === "STRIPE"
        ? EXECUTION_ACTIONS.INTEGRATION_STRIPE_VERIFY
        : `integration.${connector.provider.toLowerCase()}.verify`,
    requiredPermission: connector.requiredPermission,
    async run(_input, ctx) {
      const result = await connector.verify(ctx.storeId);
      return result.ok
        ? { message: `${connector.displayName} verified` }
        : { message: result.error ?? "Verification failed", retryable: true };
    },
  };
}
