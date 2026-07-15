export function normalizeAgentTitleText(
  value: string | null | undefined
): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "";
  }
  let normalized = "";
  for (let index = 0; index < trimmed.length; ) {
    const link = markdownLinkAt(trimmed, index);
    if (!link) {
      normalized += trimmed[index];
      index += 1;
      continue;
    }
    normalized += unescapeMarkdownLabel(
      trimmed.slice(link.labelStart, link.labelEnd)
    );
    index = link.hrefEnd + 1;
  }
  return normalized.replace(/\s+/gu, " ").trim();
}

function unescapeMarkdownLabel(label: string): string {
  let normalized = "";
  let escaped = false;
  for (const character of label) {
    if (escaped) {
      normalized += "\\[]()".includes(character) ? character : `\\${character}`;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    normalized += character;
  }
  return escaped ? `${normalized}\\` : normalized;
}

function markdownLinkAt(
  value: string,
  start: number
): {
  hrefEnd: number;
  labelEnd: number;
  labelStart: number;
} | null {
  if (value[start] !== "[") {
    return null;
  }
  const labelEnd = findUnescaped(value, start + 1, "]");
  if (labelEnd < 0 || value[labelEnd + 1] !== "(") {
    return null;
  }
  const hrefEnd = findBalancedHrefEnd(value, labelEnd + 2);
  return hrefEnd < 0 ? null : { hrefEnd, labelEnd, labelStart: start + 1 };
}

function findUnescaped(value: string, start: number, target: string): number {
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (value[index] === "\\") {
      escaped = true;
      continue;
    }
    if (value[index] === target) {
      return index;
    }
  }
  return -1;
}

function findBalancedHrefEnd(value: string, start: number): number {
  let depth = 0;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    if (escaped) {
      escaped = false;
      continue;
    }
    switch (value[index]) {
      case "\\":
        escaped = true;
        break;
      case "(":
        depth += 1;
        break;
      case ")":
        if (depth === 0) {
          return index;
        }
        depth -= 1;
        break;
    }
  }
  return -1;
}
