interface MarkdownPoint {
  line: number;
  column: number;
  offset?: number;
}

interface MarkdownPosition {
  start: MarkdownPoint;
  end: MarkdownPoint;
}

interface MarkdownNode {
  type: string;
  children?: MarkdownNode[];
  position?: MarkdownPosition;
  url?: string;
  value?: string;
}

interface SplitAutolink {
  link: MarkdownNode;
  trailing: MarkdownNode;
}

const LITERAL_AUTOLINK_BOUNDARY = /["，。；：！？、…）】》」』〉〕］｝”’]/u;

/**
 * GFM literal autolinks do not stop at every boundary that is invalid inside a
 * raw URL. Repair product-facing CJK sentence boundaries and JSON string
 * boundaries without changing explicit Markdown links, angle autolinks, code,
 * or deliberately authored link destinations.
 */
export function remarkLiteralAutolinkBoundary() {
  return (tree: unknown, file: unknown): void => {
    if (!isMarkdownNode(tree)) {
      return;
    }
    const source = markdownSourceFromFile(file);
    if (source === null) {
      return;
    }
    splitCjkAutolinks(tree, source);
  };
}

function splitCjkAutolinks(parent: MarkdownNode, source: string): void {
  if (!parent.children) {
    return;
  }

  for (let index = 0; index < parent.children.length; index += 1) {
    const child = parent.children[index];
    if (!child) {
      continue;
    }
    const split = splitLiteralAutolink(child, source);
    if (split) {
      parent.children.splice(index, 1, split.link, split.trailing);
      index += 1;
      continue;
    }
    splitCjkAutolinks(child, source);
  }
}

function splitLiteralAutolink(
  node: MarkdownNode,
  source: string
): SplitAutolink | null {
  const textNode = node.children?.[0];
  if (
    node.type !== "link" ||
    typeof node.url !== "string" ||
    node.children?.length !== 1 ||
    textNode?.type !== "text" ||
    typeof textNode.value !== "string" ||
    !node.position
  ) {
    return null;
  }

  const display = textNode.value;
  const sourceStart = node.position.start.offset;
  const sourceEnd = node.position.end.offset;
  if (
    sourceStart === undefined ||
    sourceEnd === undefined ||
    source.slice(sourceStart, sourceEnd) !== display
  ) {
    return null;
  }

  const boundaryIndex = display.search(LITERAL_AUTOLINK_BOUNDARY);
  if (boundaryIndex < 0) {
    return null;
  }

  const displayUrl = display.slice(0, boundaryIndex);
  const trailingText = display.slice(boundaryIndex);
  if (!node.url.endsWith(trailingText)) {
    return null;
  }
  const targetUrl = node.url.slice(0, -trailingText.length);
  if (!isHttpUrl(targetUrl)) {
    return null;
  }

  const boundaryPoint = advancePoint(node.position.start, displayUrl.length);
  return {
    link: {
      ...node,
      url: targetUrl,
      position: {
        start: node.position.start,
        end: boundaryPoint
      },
      children: [
        {
          ...textNode,
          value: displayUrl,
          position: textNode.position
            ? {
                start: textNode.position.start,
                end: boundaryPoint
              }
            : undefined
        }
      ]
    },
    trailing: {
      type: "text",
      value: trailingText,
      position: {
        start: boundaryPoint,
        end: node.position.end
      }
    }
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function advancePoint(point: MarkdownPoint, characters: number): MarkdownPoint {
  return {
    line: point.line,
    column: point.column + characters,
    ...(point.offset === undefined ? {} : { offset: point.offset + characters })
  };
}

function markdownSourceFromFile(file: unknown): string | null {
  if (
    typeof file !== "object" ||
    file === null ||
    !("value" in file) ||
    typeof file.value !== "string"
  ) {
    return null;
  }
  return file.value;
}

function isMarkdownNode(value: unknown): value is MarkdownNode {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string"
  );
}
