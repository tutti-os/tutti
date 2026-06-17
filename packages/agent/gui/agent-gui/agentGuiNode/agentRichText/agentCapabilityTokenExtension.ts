import { mergeAttributes, Node } from "@tiptap/core";

export interface AgentCapabilityTokenOption {
  capability: string;
  label: string;
  name: string;
  trigger: string;
}

export interface AgentCapabilityTokenAttrs {
  capability: string;
  label: string;
  name: string;
  trigger: string;
}

export interface AgentCapabilityTokenMatch {
  attrs: AgentCapabilityTokenAttrs;
  end: number;
}

export interface AgentCapabilityTokenExtensionOptions {
  capabilities?: readonly AgentCapabilityTokenOption[];
}

export function createAgentCapabilityTokenExtension(
  options: AgentCapabilityTokenExtensionOptions = {}
): Node {
  return Node.create({
    name: "agentCapabilityToken",
    group: "inline",
    inline: true,
    atom: true,
    selectable: false,

    addOptions() {
      return options;
    },

    addAttributes() {
      return {
        capability: { default: "" },
        label: { default: "" },
        name: { default: "" },
        trigger: { default: "" }
      };
    },

    parseHTML() {
      return [{ tag: "span[data-agent-capability-token]" }];
    },

    renderHTML({ HTMLAttributes }) {
      const attrs = attrsToCapabilityTokenAttrs(HTMLAttributes);
      return [
        "span",
        mergeAttributes(HTMLAttributes, {
          "aria-label": attrs.label,
          contenteditable: "false",
          "data-agent-capability-token": "true",
          "data-agent-capability-trigger": attrs.trigger,
          "data-agent-mention-kind": "capability",
          class: "tsh-agent-object-token tsh-agent-object-token--entity"
        }),
        [
          "span",
          {
            class: "tsh-agent-object-token__kind",
            "aria-hidden": "true"
          },
          [
            "span",
            {
              class: "tsh-agent-object-token__kind-icon",
              "aria-hidden": "true"
            },
            ""
          ]
        ],
        ["span", { class: "tsh-agent-object-token__main" }, attrs.label]
      ];
    },

    renderText({ node }) {
      return attrsToCapabilityTokenAttrs(node.attrs ?? {}).trigger;
    }
  });
}

export function parseAgentCapabilityToken(
  text: string,
  start: number,
  capabilities: readonly AgentCapabilityTokenOption[] = []
): AgentCapabilityTokenMatch | null {
  if (!isCapabilityTokenBoundary(text[start - 1] ?? "")) {
    return null;
  }
  for (const candidate of capabilityTokenCandidates(capabilities)) {
    if (!text.startsWith(candidate.trigger, start)) {
      continue;
    }
    const end = start + candidate.trigger.length;
    if (!isCapabilityTokenBoundary(text[end] ?? "")) {
      continue;
    }
    return {
      attrs: candidate,
      end
    };
  }
  return null;
}

function capabilityTokenCandidates(
  capabilities: readonly AgentCapabilityTokenOption[]
): AgentCapabilityTokenAttrs[] {
  const candidates = new Map<string, AgentCapabilityTokenAttrs>();
  for (const capability of capabilities) {
    const trigger = capability.trigger.trim();
    if (!trigger || candidates.has(trigger)) {
      continue;
    }
    candidates.set(trigger, {
      capability: capability.capability.trim(),
      label: capability.label.trim(),
      name: capability.name.trim(),
      trigger
    });
  }
  return [...candidates.values()].sort(
    (left, right) => right.trigger.length - left.trigger.length
  );
}

function isCapabilityTokenBoundary(value: string): boolean {
  return value === "" || value === " " || value === "\n" || value === "\t";
}

function attrsToCapabilityTokenAttrs(
  attrs: Record<string, unknown>
): AgentCapabilityTokenAttrs {
  return {
    capability: typeof attrs.capability === "string" ? attrs.capability : "",
    label: typeof attrs.label === "string" ? attrs.label : "",
    name: typeof attrs.name === "string" ? attrs.name : "",
    trigger: typeof attrs.trigger === "string" ? attrs.trigger : ""
  };
}
