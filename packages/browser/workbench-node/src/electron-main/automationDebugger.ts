import type { BrowserGuestDebugger, BrowserGuestWebContents } from "./types.ts";
import type {
  BrowserNodeAutomationAuthorizationResult,
  BrowserNodeAutomationToolResult
} from "./automationTypes.ts";

const clickedResultPrefix = "Clicked";
const filledResultPrefix = "Filled";

interface AccessibilityNode {
  backendDOMNodeId?: number;
  childIds?: string[];
  ignored?: boolean;
  name?: { value?: unknown };
  nodeId?: string;
  role?: { value?: unknown };
}

interface SnapshotElement {
  backendDOMNodeId: number;
  uid: string;
}

export class BrowserNodeAutomationDriver {
  private attachedByDriver = false;
  private readonly contents: BrowserGuestWebContents;
  private readonly elements = new Map<string, SnapshotElement>();
  private nextSnapshotSequence = 1;
  private requestAuthorizer:
    | ((url: string) => Promise<BrowserNodeAutomationAuthorizationResult>)
    | null = null;
  private requestGuardEnabled = false;
  private readonly onNavigation = (): void => {
    this.elements.clear();
  };
  private readonly onDebuggerMessage = (
    _event: unknown,
    method: string,
    rawParams: unknown
  ): void => {
    if (method !== "Fetch.requestPaused") return;
    void this.handlePausedRequest(asRecord(rawParams));
  };

  constructor(contents: BrowserGuestWebContents) {
    this.contents = contents;
    this.contents.on("did-start-navigation", this.onNavigation);
  }

  async click(uid: string): Promise<BrowserNodeAutomationToolResult> {
    const element = this.requireElement(uid);
    const debuggerClient = this.requireDebugger();
    const model = asRecord(
      await debuggerClient.sendCommand("DOM.getBoxModel", {
        backendNodeId: element.backendDOMNodeId
      })
    );
    const quad = readNumberArray(asRecord(model.model)?.content);
    if (quad.length < 8) {
      throw new Error(`Browser element ${uid} is not visible`);
    }
    const x = (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4;
    const y = (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4;
    await debuggerClient.sendCommand("Input.dispatchMouseEvent", {
      button: "left",
      clickCount: 1,
      type: "mousePressed",
      x,
      y
    });
    await debuggerClient.sendCommand("Input.dispatchMouseEvent", {
      button: "left",
      clickCount: 1,
      type: "mouseReleased",
      x,
      y
    });
    const text = `${clickedResultPrefix} ${uid}`;
    return { text };
  }

  dispose(): void {
    const debuggerClient = this.contents.debugger;
    if (this.attachedByDriver && debuggerClient?.isAttached()) {
      debuggerClient.detach();
    }
    this.attachedByDriver = false;
    this.requestAuthorizer = null;
    this.requestGuardEnabled = false;
    this.elements.clear();
    this.contents.off("did-start-navigation", this.onNavigation);
    debuggerClient?.off?.("message", this.onDebuggerMessage);
  }

  async enableRequestGuard(
    authorizer: (
      url: string
    ) => Promise<BrowserNodeAutomationAuthorizationResult>
  ): Promise<void> {
    this.requestAuthorizer = authorizer;
    if (this.requestGuardEnabled) return;
    const debuggerClient = this.requireDebugger();
    if (!debuggerClient.on) {
      throw new Error("Browser request interception is unavailable");
    }
    debuggerClient.on("message", this.onDebuggerMessage);
    try {
      await debuggerClient.sendCommand("Fetch.enable", {
        patterns: [
          { requestStage: "Request", urlPattern: "http://*" },
          { requestStage: "Request", urlPattern: "https://*" }
        ]
      });
      this.requestGuardEnabled = true;
    } catch (error) {
      debuggerClient.off?.("message", this.onDebuggerMessage);
      this.requestAuthorizer = null;
      throw error;
    }
  }

  async disableRequestGuard(): Promise<void> {
    this.requestAuthorizer = null;
    if (!this.requestGuardEnabled) return;
    this.requestGuardEnabled = false;
    const debuggerClient = this.contents.debugger;
    debuggerClient?.off?.("message", this.onDebuggerMessage);
    if (debuggerClient?.isAttached()) {
      await debuggerClient.sendCommand("Fetch.disable").catch(() => undefined);
    }
  }

  invalidate(): void {
    this.elements.clear();
  }

  async evaluate(script: string): Promise<BrowserNodeAutomationToolResult> {
    const expression = normalizeEvaluationExpression(script);
    const response = asRecord(
      await this.requireDebugger().sendCommand("Runtime.evaluate", {
        awaitPromise: true,
        expression,
        returnByValue: true,
        userGesture: true
      })
    );
    const exception = recordOrNull(response.exceptionDetails);
    if (exception) {
      throw new Error(
        readString(exception.text) || "Browser script evaluation failed"
      );
    }
    const result = asRecord(response.result);
    const value = result.value;
    return { text: formatEvaluationResult(value) };
  }

  async fill(
    uid: string,
    value: string
  ): Promise<BrowserNodeAutomationToolResult> {
    const element = this.requireElement(uid);
    const debuggerClient = this.requireDebugger();
    const resolved = asRecord(
      await debuggerClient.sendCommand("DOM.resolveNode", {
        backendNodeId: element.backendDOMNodeId
      })
    );
    const objectId = readString(asRecord(resolved.object)?.objectId);
    if (!objectId) {
      throw new Error(`Browser element ${uid} is unavailable`);
    }
    await debuggerClient.sendCommand("Runtime.callFunctionOn", {
      functionDeclaration:
        "function(){ if(typeof this.focus==='function'){this.focus();} if('value' in this){this.value=''; this.dispatchEvent(new Event('input',{bubbles:true}));} else if(this.isContentEditable){this.textContent='';} }",
      objectId,
      returnByValue: true,
      userGesture: true
    });
    await debuggerClient.sendCommand("Input.insertText", { text: value });
    await debuggerClient.sendCommand("Runtime.callFunctionOn", {
      functionDeclaration:
        "function(){ if('value' in this){this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true}));} }",
      objectId,
      returnByValue: true,
      userGesture: true
    });
    const text = `${filledResultPrefix} ${uid}`;
    return { text };
  }

  async screenshot(
    fullPage: boolean
  ): Promise<BrowserNodeAutomationToolResult> {
    const response = asRecord(
      await this.requireDebugger().sendCommand("Page.captureScreenshot", {
        captureBeyondViewport: fullPage,
        format: "png",
        fromSurface: true
      })
    );
    const data = readString(response.data);
    if (!data) {
      throw new Error("Browser screenshot capture returned no data");
    }
    return {
      screenshotData: data,
      text: fullPage
        ? "Captured full-page browser screenshot"
        : "Captured browser screenshot"
    };
  }

  async snapshot(): Promise<BrowserNodeAutomationToolResult> {
    const debuggerClient = this.requireDebugger();
    await debuggerClient.sendCommand("Accessibility.enable");
    const response = asRecord(
      await debuggerClient.sendCommand("Accessibility.getFullAXTree")
    );
    const nodes = Array.isArray(response.nodes)
      ? response.nodes.map(readAccessibilityNode).filter(isAccessibilityNode)
      : [];
    this.elements.clear();
    const snapshotSequence = this.nextSnapshotSequence++;
    let elementSequence = 1;
    const lines: string[] = [];
    for (const node of nodes) {
      if (node.ignored) {
        continue;
      }
      const role = readString(node.role?.value) || "generic";
      const name = readString(node.name?.value);
      const actionable =
        typeof node.backendDOMNodeId === "number" &&
        isActionableAccessibilityRole(role);
      let uid = "";
      if (actionable) {
        uid = `${snapshotSequence}_${elementSequence++}`;
        this.elements.set(uid, {
          backendDOMNodeId: node.backendDOMNodeId!,
          uid
        });
      }
      if (!name && !actionable && role === "generic") {
        continue;
      }
      lines.push(
        `${role}${name ? ` "${sanitizeSnapshotText(name)}"` : ""}${uid ? ` uid=${uid}` : ""}`
      );
    }
    if (lines.length === 0) {
      lines.push("(no accessible page content)");
    }
    return { text: lines.join("\n") };
  }

  private requireDebugger(): BrowserGuestDebugger {
    if (this.contents.isDestroyed()) {
      throw new Error("Browser page is closed");
    }
    const debuggerClient = this.contents.debugger;
    if (!debuggerClient) {
      throw new Error("Browser page debugging is unavailable");
    }
    if (!debuggerClient.isAttached()) {
      debuggerClient.attach("1.3");
      this.attachedByDriver = true;
    }
    return debuggerClient;
  }

  private async handlePausedRequest(
    params: Record<string, unknown>
  ): Promise<void> {
    const debuggerClient = this.contents.debugger;
    const requestId = readString(params.requestId);
    const url = readString(asRecord(params.request)?.url);
    if (!debuggerClient?.isAttached() || !requestId) return;
    let allowed = false;
    try {
      allowed = Boolean(url && (await this.requestAuthorizer?.(url))?.allowed);
    } catch {
      allowed = false;
    }
    await debuggerClient
      .sendCommand(
        allowed ? "Fetch.continueRequest" : "Fetch.failRequest",
        allowed ? { requestId } : { errorReason: "BlockedByClient", requestId }
      )
      .catch(() => undefined);
  }

  private requireElement(uid: string): SnapshotElement {
    const normalized = uid.trim();
    const element = this.elements.get(normalized);
    if (!element) {
      throw new Error(
        `Unknown browser element uid ${normalized || "(empty)"}; run browser snapshot again`
      );
    }
    return element;
  }
}

function normalizeEvaluationExpression(script: string): string {
  const trimmed = script.trim();
  if (!trimmed) {
    throw new Error("Browser evaluation script is required");
  }
  return `(${trimmed})()`;
}

function formatEvaluationResult(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "undefined";
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function readAccessibilityNode(value: unknown): AccessibilityNode | null {
  const record = recordOrNull(value);
  if (!record) {
    return null;
  }
  return {
    backendDOMNodeId:
      typeof record.backendDOMNodeId === "number"
        ? record.backendDOMNodeId
        : undefined,
    childIds: Array.isArray(record.childIds)
      ? record.childIds.filter(
          (item): item is string => typeof item === "string"
        )
      : undefined,
    ignored: record.ignored === true,
    name: asRecord(record.name) ?? undefined,
    nodeId: readString(record.nodeId) || undefined,
    role: asRecord(record.role) ?? undefined
  };
}

function isAccessibilityNode(
  value: AccessibilityNode | null
): value is AccessibilityNode {
  return value !== null;
}

function isActionableAccessibilityRole(role: string): boolean {
  return new Set([
    "button",
    "checkbox",
    "combobox",
    "link",
    "menuitem",
    "option",
    "radio",
    "searchbox",
    "slider",
    "spinbutton",
    "switch",
    "tab",
    "textbox"
  ]).has(role.toLowerCase());
}

function sanitizeSnapshotText(value: string): string {
  return value.replace(/\s+/gu, " ").replaceAll('"', '\\"').trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNumberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === "number")
    : [];
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
