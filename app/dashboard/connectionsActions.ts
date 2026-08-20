"use server";

import { redirect } from "next/navigation";
import type { IntegrationProvider } from "@prisma/client";
import { auth } from "@/auth";
import { getConnector } from "@/lib/integrations/registry";
import { execute } from "@/lib/execution/engine";
import type { ExecutionResult } from "@/lib/execution/types";
import {
  connectExecutable,
  verifyExecutable,
  syncExecutable,
} from "@/lib/execution/adapters/integrationExecutable";
import { requireBusinessOrActive, requireStorePermission, PERMISSIONS } from "@/lib/permissions";
import { logProductEvent } from "@/lib/telemetry/events";

// Phase 3 Milestone 2 — the framework's own Server Action layer: 5 generic,
// provider-parameterized actions, not one dedicated set per connector.
// Bound per-card via the same `.bind(null, id)` currying convention
// already used throughout this codebase (e.g. deleteProduct.bind(null,
// product.id)) — <form action={connectIntegration.bind(null, provider)}>.
// Stripe/PayPal's own dedicated actions (app/dashboard/actions.ts) are
// deliberately left untouched; these exist for /dashboard/connections and
// everything added to it going forward.

async function logConnectAttempt(
  provider: IntegrationProvider,
  action: string,
  result: ExecutionResult<unknown>
) {
  const session = await auth();
  if (!session?.user || !result.storeId) return;
  await logProductEvent({
    userId: session.user.id,
    storeId: result.storeId,
    sessionInstanceId: session.user.sessionInstanceId,
    name: action,
    category: "integration",
    attemptKey: `${provider.toLowerCase()}_connect:${result.storeId}`,
    outcome: result.status === "FAILED" ? "failure" : "success",
    metadata: { status: result.status, message: result.message },
  });
}

export async function connectIntegration(provider: IntegrationProvider) {
  const result = await execute(connectExecutable(getConnector(provider)), {});
  await logConnectAttempt(provider, "integration.connect_attempt", result);
  if (result.redirectUrl) {
    redirect(result.redirectUrl);
  }
  redirect(
    result.status === "FAILED"
      ? `/dashboard/connections?integration_error=${provider.toLowerCase()}`
      : `/dashboard/connections?integration_connected=${provider.toLowerCase()}`
  );
}

export async function verifyIntegration(provider: IntegrationProvider) {
  const result = await execute(verifyExecutable(getConnector(provider)), undefined);
  await logConnectAttempt(provider, "integration.recheck_attempt", result);
  redirect("/dashboard/connections");
}

// MIGRATED — see BUSINESS_CONTEXT.md Phase C. Disconnecting a supplier from the
// wrong business is not recoverable by the owner: the credentials are gone.
export async function disconnectIntegration(slug: string | undefined, provider: IntegrationProvider) {
  const { storeId } = await requireBusinessOrActive(PERMISSIONS.CONNECTIONS_MANAGE, slug);
  await getConnector(provider).disconnect(storeId);
  redirect("/dashboard/connections");
}

export async function syncIntegration(provider: IntegrationProvider) {
  const result = await execute(syncExecutable(getConnector(provider)), undefined);
  await logConnectAttempt(provider, "integration.sync_attempt", result);
  redirect("/dashboard/connections");
}

// The generic version of submitPaypalCredentials — collects every FormData
// entry into params rather than hardcoding field names, since a "form"-kind
// ConnectResult's fields vary by connector (Mailchimp has 1, PayPal has 3).
export async function submitIntegrationCredentials(
  provider: IntegrationProvider,
  formData: FormData
) {
  const params: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string") {
      params[key] = value.trim();
    }
  }

  const result = await execute(connectExecutable(getConnector(provider)), { params });
  await logConnectAttempt(provider, "integration.connect_attempt", result);

  redirect(
    result.status === "FAILED"
      ? `/dashboard/connections?integration_error=${provider.toLowerCase()}`
      : `/dashboard/connections?integration_connected=${provider.toLowerCase()}`
  );
}
