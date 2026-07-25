import { mergeAttributes, Node } from "@tiptap/core";
import type { AgentGUIProviderSkillOption } from "../model/agentGuiNodeTypes";
import {
  labelForProviderSkill,
  skillTriggerForPrefix
} from "../model/agentSkillOptions";

export interface AgentSkillTokenAttrs {
  label: string;
  name: string;
  trigger: string;
}

export interface AgentSkillTokenMatch {
  attrs: AgentSkillTokenAttrs;
  end: number;
}

export interface AgentSkillTokenExtensionOptions {
  skills?: readonly AgentGUIProviderSkillOption[];
}

export function createAgentSkillTokenExtension(
  options: AgentSkillTokenExtensionOptions = {}
): Node {
  return Node.create({
    name: "agentSkillToken",
    group: "inline",
    inline: true,
    atom: true,
    selectable: true,

    addOptions() {
      return options;
    },

    addAttributes() {
      return {
        label: { default: "" },
        name: { default: "" },
        trigger: { default: "" }
      };
    },

    parseHTML() {
      return [{ tag: "span[data-agent-skill-token]" }];
    },

    renderHTML({ HTMLAttributes }) {
      const attrs = attrsToSkillTokenAttrs(HTMLAttributes);
      const displayLabel = skillTokenDisplayLabel(attrs);
      return [
        "span",
        mergeAttributes(HTMLAttributes, {
          "aria-label": attrs.label,
          contentEditable: "false",
          "data-agent-skill-token": "true",
          "data-agent-skill-trigger": attrs.trigger,
          "data-agent-mention-kind": "skill",
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
        ["span", { class: "tsh-agent-object-token__main" }, displayLabel]
      ];
    },

    renderText({ node }) {
      return attrsToSkillTokenAttrs(node.attrs ?? {}).trigger;
    }
  });
}

export function parseAgentSkillToken(
  text: string,
  start: number,
  skills: readonly AgentGUIProviderSkillOption[] = []
): AgentSkillTokenMatch | null {
  if (!isSkillTokenBoundary(text[start - 1] ?? "")) {
    return null;
  }
  for (const candidate of skillTokenCandidates(skills)) {
    if (!text.startsWith(candidate.trigger, start)) {
      continue;
    }
    const end = start + candidate.trigger.length;
    if (!isSkillTokenBoundary(text[end] ?? "")) {
      continue;
    }
    return {
      attrs: candidate,
      end
    };
  }
  return null;
}

function skillTokenCandidates(
  skills: readonly AgentGUIProviderSkillOption[]
): AgentSkillTokenAttrs[] {
  const candidates = new Map<string, AgentSkillTokenAttrs>();
  for (const skill of skills) {
    for (const prefix of ["$", "/"] as const) {
      const trigger = skillTriggerForPrefix(skill, prefix);
      if (!trigger || candidates.has(trigger)) {
        continue;
      }
      candidates.set(trigger, {
        label: labelForProviderSkill(skill, prefix),
        name: skill.name.trim(),
        trigger
      });
    }
  }
  return [...candidates.values()].sort(
    (left, right) => right.trigger.length - left.trigger.length
  );
}

function isSkillTokenBoundary(value: string): boolean {
  return value === "" || value === " " || value === "\n" || value === "\t";
}

function attrsToSkillTokenAttrs(
  attrs: Record<string, unknown>
): AgentSkillTokenAttrs {
  return {
    label: typeof attrs.label === "string" ? attrs.label : "",
    name: typeof attrs.name === "string" ? attrs.name : "",
    trigger: typeof attrs.trigger === "string" ? attrs.trigger : ""
  };
}

function skillTokenDisplayLabel(attrs: AgentSkillTokenAttrs): string {
  const label = attrs.label.trim() || attrs.trigger.trim();
  if (!label || label.startsWith("/") || label.startsWith("$")) {
    return label;
  }
  return `/${label}`;
}
