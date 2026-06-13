export interface StreamingMarkdownTailStabilizerOptions {
  streaming: boolean;
  maxTailChars?: number;
}

export interface StreamingMarkdownTailStabilizerResult {
  content: string;
  changed: boolean;
  reason?: string;
}

const DEFAULT_MAX_TAIL_CHARS = 4096;

export function stabilizeStreamingMarkdownTail(
  content: string,
  options: StreamingMarkdownTailStabilizerOptions
): StreamingMarkdownTailStabilizerResult {
  if (!options.streaming || content.length === 0) {
    return { content, changed: false };
  }

  const maxTailChars = Math.max(
    256,
    options.maxTailChars ?? DEFAULT_MAX_TAIL_CHARS
  );
  const tailStart = Math.max(0, content.length - maxTailChars);
  const tail = content.slice(tailStart);

  const fence = findOpenFence(tail);
  if (fence) {
    return {
      content: `${content}\n${fence.marker.repeat(fence.length)}`,
      changed: true,
      reason: "open-fence"
    };
  }

  const incompleteLink = stabilizeIncompleteTailLink(content);
  if (incompleteLink) {
    return incompleteLink;
  }

  const listMarker = stabilizeDanglingListMarker(content);
  if (listMarker) {
    return listMarker;
  }

  const tableRow = stabilizePartialTableRow(content);
  if (tableRow) {
    return tableRow;
  }

  const inlineCode = findOpenInlineCodeSpan(tail);
  if (inlineCode) {
    return {
      content: `${content}${"`".repeat(inlineCode.length)}`,
      changed: true,
      reason: "open-inline-code"
    };
  }

  const emphasis = stabilizeTrailingEmphasisMarker(content);
  if (emphasis) {
    return emphasis;
  }

  return { content, changed: false };
}

function findOpenFence(
  tail: string
): { marker: "`" | "~"; length: number } | null {
  let openFence: { marker: "`" | "~"; length: number } | null = null;
  for (const line of tail.replace(/\r\n?/g, "\n").split("\n")) {
    const fence = parseFenceLine(line);
    if (!fence) {
      continue;
    }
    if (!openFence) {
      openFence = fence;
      continue;
    }
    if (fence.marker === openFence.marker && fence.length >= openFence.length) {
      openFence = null;
    }
  }
  return openFence;
}

function parseFenceLine(
  line: string
): { marker: "`" | "~"; length: number } | null {
  let index = 0;
  while (index < line.length && line[index] === " " && index < 4) {
    index += 1;
  }
  const marker = line[index];
  if (marker !== "`" && marker !== "~") {
    return null;
  }

  let length = 0;
  while (line[index + length] === marker) {
    length += 1;
  }
  return length >= 3 ? { marker, length } : null;
}

function stabilizeIncompleteTailLink(
  content: string
): StreamingMarkdownTailStabilizerResult | null {
  const lineStart = content.lastIndexOf("\n") + 1;
  const line = content.slice(lineStart);
  const linkStart = line.lastIndexOf("[");
  const imageStart = line.lastIndexOf("![");
  const openBracketIndex =
    imageStart >= 0 && imageStart + 1 === linkStart ? imageStart : linkStart;
  if (openBracketIndex < 0) {
    return null;
  }

  const absoluteOpenIndex = lineStart + openBracketIndex;
  const suffix = content.slice(absoluteOpenIndex);
  const closeLabelIndex = suffix.indexOf("]");
  if (closeLabelIndex < 0) {
    const label = suffix.startsWith("![") ? suffix.slice(2) : suffix.slice(1);
    return {
      content: `${content.slice(0, absoluteOpenIndex)}${label}`,
      changed: true,
      reason: "incomplete-link-label"
    };
  }

  if (suffix[closeLabelIndex + 1] !== "(" || suffix.includes(")")) {
    return null;
  }

  const label = suffix.startsWith("![")
    ? suffix.slice(2, closeLabelIndex)
    : suffix.slice(1, closeLabelIndex);
  return {
    content: `${content.slice(0, absoluteOpenIndex)}${label}`,
    changed: true,
    reason: "incomplete-link-target"
  };
}

function stabilizeDanglingListMarker(
  content: string
): StreamingMarkdownTailStabilizerResult | null {
  const lineStart = content.lastIndexOf("\n") + 1;
  const line = content.slice(lineStart);
  const trimmed = line.trim();
  const isBullet = trimmed === "-" || trimmed === "*" || trimmed === "+";
  const isOrdered =
    trimmed.length >= 2 &&
    trimmed.endsWith(".") &&
    [...trimmed.slice(0, -1)].every((char) => char >= "0" && char <= "9");
  if (!isBullet && !isOrdered) {
    return null;
  }
  return {
    content: content.slice(0, lineStart),
    changed: true,
    reason: "dangling-list-marker"
  };
}

function stabilizePartialTableRow(
  content: string
): StreamingMarkdownTailStabilizerResult | null {
  if (content.endsWith("\n")) {
    return null;
  }
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const currentLine = lines.at(-1) ?? "";
  const previousLine = lines.at(-2) ?? "";
  if (!currentLine.includes("|") || !previousLine.includes("|")) {
    return null;
  }
  if (currentLine.trimEnd().endsWith("|")) {
    return null;
  }
  if (countChar(previousLine, "|") < 2) {
    return null;
  }
  return {
    content: `${content} |`,
    changed: true,
    reason: "partial-table-row"
  };
}

function findOpenInlineCodeSpan(tail: string): { length: number } | null {
  const lastParagraph = tail.slice(tail.lastIndexOf("\n\n") + 2);
  let openLength = 0;
  for (let index = 0; index < lastParagraph.length; index += 1) {
    if (lastParagraph[index] !== "`") {
      continue;
    }
    let length = 1;
    while (lastParagraph[index + length] === "`") {
      length += 1;
    }
    if (length >= 3) {
      index += length - 1;
      continue;
    }
    openLength = openLength === length ? 0 : length;
    index += length - 1;
  }
  return openLength > 0 ? { length: openLength } : null;
}

function stabilizeTrailingEmphasisMarker(
  content: string
): StreamingMarkdownTailStabilizerResult | null {
  const marker = content.at(-1);
  if (marker !== "*" && marker !== "_") {
    return null;
  }
  const previous = content.at(-2);
  const nextContent =
    previous === marker ? content.slice(0, -2) : content.slice(0, -1);
  return {
    content: nextContent,
    changed: true,
    reason: "trailing-emphasis-marker"
  };
}

function countChar(value: string, char: string): number {
  let count = 0;
  for (const current of value) {
    if (current === char) {
      count += 1;
    }
  }
  return count;
}
