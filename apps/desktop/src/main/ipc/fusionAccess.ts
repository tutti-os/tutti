import {
  isDesktopFusionWindowKind,
  type DesktopFusionOpenWindowInput,
  type DesktopFusionUpdateWindowInput,
  type DesktopFusionWindowDescriptor,
  type DesktopFusionWindowTargetInput
} from "../../shared/contracts/fusion.ts";
import type { DesktopFusionRendererAccessContext } from "../windows/fusionWindowCoordinatorTypes.ts";

export function parseFusionOpenWindowInput(
  value: unknown
): DesktopFusionOpenWindowInput {
  const input = requireRecord(value, "Fusion open-window input");
  if (!isDesktopFusionWindowKind(input.kind)) {
    throw new Error("Fusion window kind is invalid");
  }
  const workspaceId = requireText(input.workspaceId, "workspaceId");
  const result: DesktopFusionOpenWindowInput = {
    kind: input.kind,
    workspaceId
  };
  if (input.forceNew !== undefined) {
    if (typeof input.forceNew !== "boolean") {
      throw new Error("Fusion forceNew must be a boolean");
    }
    result.forceNew = input.forceNew;
  }
  if ("launchPayload" in input) {
    result.launchPayload = input.launchPayload;
  }
  if (input.resourceId !== undefined) {
    result.resourceId = readOptionalText(input.resourceId, "resourceId");
  }
  if (input.title !== undefined) {
    result.title = readOptionalText(input.title, "title");
  }
  return result;
}

export function parseFusionWindowTargetInput(
  value: unknown
): DesktopFusionWindowTargetInput {
  const input = requireRecord(value, "Fusion window target");
  return {
    windowInstanceId: requireText(input.windowInstanceId, "windowInstanceId")
  };
}

export function parseFusionUpdateWindowInput(
  value: unknown
): DesktopFusionUpdateWindowInput {
  const input = requireRecord(value, "Fusion update-window input");
  const result: DesktopFusionUpdateWindowInput =
    parseFusionWindowTargetInput(input);
  if (input.resourceId !== undefined) {
    result.resourceId = readOptionalText(input.resourceId, "resourceId");
  }
  if (input.title !== undefined) {
    result.title = readOptionalText(input.title, "title");
  }
  return result;
}

export function assertFusionOpenWindowAccess(
  access: DesktopFusionRendererAccessContext,
  input: DesktopFusionOpenWindowInput
): void {
  if (access.kind === "window" && input.workspaceId !== access.workspaceId) {
    throw new Error("Fusion renderer cannot open a cross-workspace window");
  }
}

export function requireFusionRendererAccess(
  access: DesktopFusionRendererAccessContext | null
): DesktopFusionRendererAccessContext {
  if (!access) {
    throw new Error("Fusion IPC sender is not a registered Fusion renderer");
  }
  return access;
}

export function assertFusionDockAccess(
  access: DesktopFusionRendererAccessContext
): asserts access is Extract<
  DesktopFusionRendererAccessContext,
  { kind: "dock" }
> {
  if (access.kind !== "dock") {
    throw new Error("Fusion action is restricted to the Dock");
  }
}

export function assertFusionTargetWindowAccess(
  access: DesktopFusionRendererAccessContext,
  descriptor: DesktopFusionWindowDescriptor | null
): asserts descriptor is DesktopFusionWindowDescriptor {
  if (!descriptor) {
    throw new Error("Fusion target window is unavailable");
  }
  if (access.kind === "dock") {
    return;
  }
  if (descriptor.workspaceId !== access.workspaceId) {
    throw new Error("Fusion renderer cannot access a cross-workspace window");
  }
  if (descriptor.windowInstanceId !== access.windowInstanceId) {
    throw new Error("Fusion tool windows may only operate on themselves");
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Fusion ${field} is required`);
  }
  return value.trim();
}

function readOptionalText(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Fusion ${field} must be a string or null`);
  }
  return value.trim() || null;
}
