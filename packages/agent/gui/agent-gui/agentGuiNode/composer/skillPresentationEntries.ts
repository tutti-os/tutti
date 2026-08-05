import type { AgentGUIProviderSkillOption } from "../model/agentGuiNodeTypes";

export interface AgentSkillPresentationEntry {
  entryId: string;
  name: string;
  path: string | null;
  skill: AgentGUIProviderSkillOption;
}

/**
 * Plugin-owned Skills are suppressed only from the slash presentation. The
 * authoritative Skill list remains available to `$` invocation and submit
 * serialization, so this helper deliberately has no execution side effects.
 */
export function shouldHideSkillPresentationEntry(input: {
  entryId: string;
  hiddenSlashSkillEntryIds: ReadonlySet<string>;
  prefix: "/" | "$" | null;
}): boolean {
  return (
    input.prefix === "/" && input.hiddenSlashSkillEntryIds.has(input.entryId)
  );
}

// This is a presentation identity, not a Skill execution identity. It keeps
// duplicate names distinct and lets the Desktop host suppress only an exact
// Plugin -> Skill proof for `/`, while `$` still receives the original list.
export function skillPresentationEntries(
  skills: readonly AgentGUIProviderSkillOption[]
): readonly AgentSkillPresentationEntry[] {
  const occurrences = new Map<string, number>();
  return skills.map((skill) => {
    const name = skill.name.trim();
    const path = normalizeSkillPresentationPath(skill.path);
    const base = `${name}\u0000${path ?? ""}`;
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    return {
      entryId: `skill:${encodeURIComponent(base)}:${occurrence}`,
      name,
      path,
      skill
    };
  });
}

export function normalizeSkillPresentationPath(
  path: string | null | undefined
): string | null {
  const trimmed = path?.trim();
  if (!trimmed) {
    return null;
  }
  const isAbsolute = trimmed.startsWith("/");
  const parts: string[] = [];
  for (const part of trimmed.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      if (parts.length > 0 && parts.at(-1) !== "..") {
        parts.pop();
      } else if (!isAbsolute) {
        parts.push(part);
      }
      continue;
    }
    parts.push(part);
  }
  const normalized = parts.join("/");
  return isAbsolute ? `/${normalized}` : normalized || ".";
}
