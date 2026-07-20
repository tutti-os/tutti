import type { BrowserNodeAutomationTargetMetadata } from "../core/types.ts";
import { resolveBrowserNavigationUrl } from "../core/url.ts";
import { BrowserNodeAutomationDriver } from "./automationDebugger.ts";
import type {
  BrowserNodeAutomationCallInput,
  BrowserNodeAutomationRegistry,
  BrowserNodeAutomationRegistryOptions,
  BrowserNodeAutomationTargetSummary,
  BrowserNodeAutomationTool,
  BrowserNodeAutomationToolResult
} from "./automationTypes.ts";
import type { BrowserGuestWebContents } from "./types.ts";

interface RegisteredTarget {
  contents: BrowserGuestWebContents;
  driver: BrowserNodeAutomationDriver;
  focusedSequence: number;
  metadata: BrowserNodeAutomationTargetMetadata;
  nodeId: string;
}

interface AutomationLease {
  expiresAt: number;
  owner: string;
}

const defaultLeaseTtlMs = 60_000;
const createdPageResultPrefix = "Created browser page";
const closedPageResultPrefix = "Closed browser page";
const selectedPageResultPrefix = "Selected browser page";

export function createBrowserNodeAutomationRegistry(
  options: BrowserNodeAutomationRegistryOptions = {}
): BrowserNodeAutomationRegistry {
  const targets = new Map<string, RegisteredTarget>();
  const leases = new Map<string, AutomationLease>();
  const selectedTargetByOwner = new Map<string, string>();
  const now = options.now ?? Date.now;
  const leaseTtlMs = Math.max(1, options.leaseTtlMs ?? defaultLeaseTtlMs);
  let focusSequence = 0;

  const list = (input: {
    agentSessionId?: string | null;
    workspaceId: string;
  }): BrowserNodeAutomationTargetSummary[] => {
    const workspaceId = normalizeRequired(input.workspaceId, "workspaceId");
    const agentSessionId = normalizeOptional(input.agentSessionId);
    return Array.from(targets.values())
      .filter((target) => isTargetVisible(target, workspaceId, agentSessionId))
      .sort(compareTargets)
      .map(toSummary);
  };

  const resolveTarget = async (
    input: BrowserNodeAutomationCallInput,
    args: Record<string, unknown>
  ): Promise<RegisteredTarget> => {
    const pageId = readString(args.pageId) || readString(args.page_id);
    const visible = list({
      agentSessionId: input.agentSessionId,
      workspaceId: input.workspaceId
    });
    const ownerKey = resolveOwnerKey(input);
    const stablePageId = selectedTargetByOwner.get(ownerKey);
    const selected = pageId
      ? visible.find((target) => target.nodeId === pageId)
      : (visible.find((target) => target.nodeId === stablePageId) ??
        visible.find((target) => target.focused && target.selected) ??
        visible.find((target) => target.selected) ??
        visible[0]);
    if (selected) {
      const registered = targets.get(selected.nodeId);
      if (registered) {
        selectedTargetByOwner.set(ownerKey, registered.nodeId);
        return registered;
      }
    }

    if (pageId) {
      throw new Error(`Browser page is unavailable: ${pageId}`);
    }
    const requestedNodeId = await options.requestTarget?.({
      agentSessionId: normalizeOptional(input.agentSessionId),
      requestedPageId: null,
      workspaceId: input.workspaceId
    });
    const requested = requestedNodeId ? targets.get(requestedNodeId) : null;
    if (
      !requested ||
      !isTargetVisible(
        requested,
        input.workspaceId,
        normalizeOptional(input.agentSessionId)
      )
    ) {
      throw new Error("No in-app Browser page is available");
    }
    return requested;
  };

  const authorize = async (
    input: BrowserNodeAutomationCallInput,
    args: Record<string, unknown>,
    target: RegisteredTarget
  ): Promise<void> => {
    const result = await options.authorize?.({
      agentSessionId: normalizeOptional(input.agentSessionId),
      args,
      target: toSummary(target),
      tool: input.tool,
      workspaceId: input.workspaceId
    });
    if (result && !result.allowed) {
      throw new Error(`${result.code}: ${result.message}`);
    }
  };

  const acquireLease = (
    input: BrowserNodeAutomationCallInput,
    target: RegisteredTarget
  ): void => {
    const timestamp = now();
    const owner =
      normalizeOptional(input.agentSessionId) ??
      `manual:${normalizeRequired(input.workspaceId, "workspaceId")}`;
    const current = leases.get(target.nodeId);
    if (current && current.owner !== owner && current.expiresAt > timestamp) {
      throw new Error(
        `tab_in_use: browser page is controlled by ${current.owner}`
      );
    }
    leases.set(target.nodeId, { expiresAt: timestamp + leaseTtlMs, owner });
  };

  return {
    async call(input) {
      const workspaceId = normalizeRequired(input.workspaceId, "workspaceId");
      const args = input.args ?? {};
      if (input.tool === "list_pages") {
        return {
          text: formatPageList(
            list({ agentSessionId: input.agentSessionId, workspaceId })
          )
        };
      }

      if (input.tool === "new_page") {
        const requestedPageId =
          readString(args.pageId) || readString(args.page_id) || null;
        const rawUrl = readString(args.url) || "about:blank";
        const nodeId = await options.requestTarget?.({
          agentSessionId: normalizeOptional(input.agentSessionId),
          requestedPageId,
          url: rawUrl,
          workspaceId
        });
        if (!nodeId) {
          throw new Error("In-app Browser did not create a page");
        }
        selectedTargetByOwner.set(resolveOwnerKey(input), nodeId);
        const text = `${createdPageResultPrefix} ${nodeId}`;
        return { text };
      }

      const normalizedInput = { ...input, workspaceId };
      const target = await resolveTarget(normalizedInput, args);
      await authorize(normalizedInput, args, target);
      acquireLease(normalizedInput, target);

      switch (input.tool) {
        case "click":
          return target.driver.click(requireString(args, "uid"));
        case "close_page":
          if (!options.closeTarget) {
            throw new Error("Closing in-app Browser pages is unavailable");
          }
          await options.closeTarget(toSummary(target));
          clearSelectedTarget(selectedTargetByOwner, target.nodeId);
          return {
            text: formatPageResult(closedPageResultPrefix, target.nodeId)
          };
        case "evaluate_script":
          return target.driver.evaluate(requireString(args, "function"));
        case "fill":
          return target.driver.fill(
            requireString(args, "uid"),
            requireString(args, "value")
          );
        case "navigate_page":
          return navigateTarget(target, requireString(args, "url"));
        case "select_page":
          selectedTargetByOwner.set(
            resolveOwnerKey(normalizedInput),
            target.nodeId
          );
          await options.selectTarget?.(toSummary(target));
          return {
            text: formatPageResult(selectedPageResultPrefix, target.nodeId)
          };
        case "take_screenshot":
          return target.driver.screenshot(args.fullPage === true);
        case "take_snapshot":
          return target.driver.snapshot();
      }
    },
    list,
    register(nodeId, contents, metadata) {
      const normalizedNodeId = normalizeRequired(nodeId, "nodeId");
      const existing = targets.get(normalizedNodeId);
      if (existing?.contents === contents) {
        existing.metadata = normalizeMetadata(metadata);
        if (metadata.focused) {
          existing.focusedSequence = ++focusSequence;
        }
        return;
      }
      existing?.driver.dispose();
      targets.set(normalizedNodeId, {
        contents,
        driver: new BrowserNodeAutomationDriver(contents),
        focusedSequence: metadata.focused ? ++focusSequence : 0,
        metadata: normalizeMetadata(metadata),
        nodeId: normalizedNodeId
      });
    },
    releaseAgent(agentSessionId) {
      const owner = normalizeRequired(agentSessionId, "agentSessionId");
      for (const [nodeId, lease] of leases) {
        if (lease.owner === owner) {
          leases.delete(nodeId);
        }
      }
    },
    unregister(nodeId, contents) {
      const existing = targets.get(nodeId);
      if (!existing || (contents && existing.contents !== contents)) {
        return;
      }
      existing.driver.dispose();
      targets.delete(nodeId);
      leases.delete(nodeId);
      clearSelectedTarget(selectedTargetByOwner, nodeId);
    },
    update(nodeId, metadata) {
      const target = targets.get(nodeId);
      if (!target) {
        return;
      }
      target.metadata = normalizeMetadata(metadata);
      if (metadata.focused) {
        target.focusedSequence = ++focusSequence;
      }
    }
  };
}

function resolveOwnerKey(input: BrowserNodeAutomationCallInput): string {
  return `${normalizeRequired(input.workspaceId, "workspaceId")}:${normalizeOptional(input.agentSessionId) ?? "manual"}`;
}

function formatPageResult(prefix: string, nodeId: string): string {
  return `${prefix} ${nodeId}`;
}

function clearSelectedTarget(
  selections: Map<string, string>,
  nodeId: string
): void {
  for (const [owner, selectedNodeId] of selections) {
    if (selectedNodeId === nodeId) {
      selections.delete(owner);
    }
  }
}

async function navigateTarget(
  target: RegisteredTarget,
  rawUrl: string
): Promise<BrowserNodeAutomationToolResult> {
  const resolved = resolveBrowserNavigationUrl(rawUrl);
  if (!resolved.url) {
    throw new Error("Invalid browser URL");
  }
  await target.contents.loadURL(resolved.url);
  return target.driver.snapshot();
}

function isTargetVisible(
  target: RegisteredTarget,
  workspaceId: string,
  agentSessionId: string | null
): boolean {
  if (
    target.contents.isDestroyed() ||
    target.metadata.workspaceId !== workspaceId
  ) {
    return false;
  }
  return (
    target.metadata.surfaceRole === "user" ||
    (target.metadata.surfaceRole === "agent" &&
      normalizeOptional(target.metadata.agentSessionId) === agentSessionId)
  );
}

function compareTargets(
  left: RegisteredTarget,
  right: RegisteredTarget
): number {
  if (left.focusedSequence !== right.focusedSequence) {
    return right.focusedSequence - left.focusedSequence;
  }
  if (left.metadata.selected !== right.metadata.selected) {
    return left.metadata.selected ? -1 : 1;
  }
  return left.nodeId.localeCompare(right.nodeId);
}

function toSummary(
  target: RegisteredTarget
): BrowserNodeAutomationTargetSummary {
  return {
    ...target.metadata,
    focused: target.focusedSequence > 0,
    nodeId: target.nodeId,
    title: target.contents.getTitle(),
    url: target.contents.getURL()
  };
}

function formatPageList(
  targets: readonly BrowserNodeAutomationTargetSummary[]
): string {
  if (targets.length === 0) {
    return "No in-app Browser pages are available";
  }
  return targets
    .map(
      (target) =>
        `${target.nodeId}${target.selected ? " [selected]" : ""} ${target.title || "(untitled)"} ${target.url || "about:blank"} surface=${target.surfaceRole}:${target.surfaceId}`
    )
    .join("\n");
}

function normalizeMetadata(
  metadata: BrowserNodeAutomationTargetMetadata
): BrowserNodeAutomationTargetMetadata {
  return {
    agentSessionId: normalizeOptional(metadata.agentSessionId),
    focused: metadata.focused === true,
    selected: metadata.selected === true,
    surfaceId: normalizeRequired(metadata.surfaceId, "surfaceId"),
    surfaceRole: metadata.surfaceRole,
    tabId: normalizeOptional(metadata.tabId),
    workspaceId: normalizeRequired(metadata.workspaceId, "workspaceId")
  };
}

function normalizeRequired(value: unknown, label: string): string {
  const normalized = readString(value);
  if (!normalized) {
    throw new Error(`Browser automation ${label} is required`);
  }
  return normalized;
}

function normalizeOptional(value: unknown): string | null {
  return readString(value) || null;
}

function requireString(args: Record<string, unknown>, key: string): string {
  return normalizeRequired(args[key], key);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function isBrowserNodeAutomationTool(
  value: string
): value is BrowserNodeAutomationTool {
  return new Set<string>([
    "click",
    "close_page",
    "evaluate_script",
    "fill",
    "list_pages",
    "navigate_page",
    "new_page",
    "select_page",
    "take_screenshot",
    "take_snapshot"
  ]).has(value);
}
