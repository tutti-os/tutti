import { isTuttiExternalManagedAiModelProviderId } from "@tutti-os/workspace-external-core/core";
import type {
  TuttiExternalManagedAiModel,
  TuttiExternalManagedAiModelProviderId,
  TuttiExternalPermissionRequestInput,
  TuttiExternalPermissionRequestResult
} from "@tutti-os/workspace-external-core/contracts";
import {
  resolveDesktopDaemonBaseUrl,
  type DesktopDaemonEndpoint
} from "../transport/paths.ts";
import { createWorkspaceAppContextToken } from "./workspaceAppContextToken.ts";
import type { WorkspaceAppGuestContext } from "./workspaceAppContextTypes.ts";
import { isRecord } from "./workspaceAppPayloadValidation.ts";

export async function requestManagedAiModelPermission(
  endpoint: DesktopDaemonEndpoint,
  context: WorkspaceAppGuestContext,
  input: TuttiExternalPermissionRequestInput
): Promise<TuttiExternalPermissionRequestResult> {
  const baseUrl = resolveDesktopDaemonBaseUrl(endpoint);
  const issuer = new URL(baseUrl).origin;
  const installationId = `${context.workspaceID}:${context.appID}`;
  const contextToken = createWorkspaceAppContextToken(endpoint, context, {
    installationId,
    issuer
  });
  // oxlint-disable-next-line no-restricted-globals -- talks to the local daemon, not outbound
  const response = await fetch(
    new URL(
      `/v1/workspaces/${encodeURIComponent(context.workspaceID)}/apps/${encodeURIComponent(context.appID)}/managed-model-grants`,
      baseUrl
    ),
    {
      body: JSON.stringify({
        contextToken,
        nonce: input.nonce,
        providers: input.providers ?? [],
        scopes: input.scopes,
        state: input.state
      }),
      headers: {
        Authorization: `Bearer ${endpoint.accessToken}`,
        "Content-Type": "application/json"
      },
      method: "POST"
    }
  );
  if (!response.ok) {
    const message = await readManagedAiModelGrantError(response);
    throw new Error(message);
  }
  const payload: unknown = await response.json();
  return {
    ...normalizeManagedAiModelPermissionResponse(payload),
    contextToken
  };
}

async function readManagedAiModelGrantError(
  response: Response
): Promise<string> {
  try {
    const payload: unknown = await response.json();
    if (isRecord(payload) && typeof payload.error === "string") {
      return payload.error;
    }
    if (isRecord(payload) && typeof payload.message === "string") {
      return payload.message;
    }
  } catch {
    // Keep the status fallback when the daemon does not return JSON.
  }
  return `Managed AI model permission request failed with status ${response.status}.`;
}

function normalizeManagedAiModelPermissionResponse(
  value: unknown
): TuttiExternalPermissionRequestResult {
  if (!isRecord(value) || typeof value.grantCode !== "string") {
    throw new Error("Managed AI model permission response is invalid.");
  }
  return {
    code: value.grantCode,
    ...(typeof value.contextToken === "string"
      ? { contextToken: value.contextToken }
      : {}),
    ...(typeof value.expiresAt === "string"
      ? { expiresAt: value.expiresAt }
      : {}),
    ...(Array.isArray(value.models)
      ? { models: normalizeManagedAiModels(value.models) }
      : {}),
    ...(Array.isArray(value.providers)
      ? { providers: normalizeManagedAiModelProviderIds(value.providers) }
      : {})
  };
}

function normalizeManagedAiModels(
  values: unknown[]
): TuttiExternalManagedAiModel[] {
  return values.map((value) => {
    if (
      !isRecord(value) ||
      typeof value.id !== "string" ||
      !isTuttiExternalManagedAiModelProviderId(value.provider)
    ) {
      throw new Error("Managed AI model permission response model is invalid.");
    }
    return {
      id: value.id,
      ...(typeof value.name === "string" ? { name: value.name } : {}),
      provider: value.provider
    };
  });
}

function normalizeManagedAiModelProviderIds(
  values: unknown[]
): TuttiExternalManagedAiModelProviderId[] {
  return values.map((value) => {
    if (!isTuttiExternalManagedAiModelProviderId(value)) {
      throw new Error(
        "Managed AI model permission response provider is invalid."
      );
    }
    return value;
  });
}
