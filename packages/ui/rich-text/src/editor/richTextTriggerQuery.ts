import type {
  RichTextTrigger,
  RichTextTriggerBoundary,
  RichTextTriggerConfig,
  RichTextTriggerQueryInput,
  RichTextTriggerQueryMatch,
  RichTextTriggerRegistry
} from "../types/trigger.ts";

export interface RichTextTriggerQueryState {
  from: number;
  to: number;
  keyword: string;
  trigger: RichTextTrigger;
}

export function isRichTextTriggerPrefixBoundary(
  character: string,
  boundary: RichTextTriggerBoundary
): boolean {
  if (boundary === "whitespace") {
    return /\s/.test(character);
  }
  return /[\s,;:!?<>{}|\\'"`~()[\]]/.test(character);
}

export function findRichTextTriggerQuery(
  value: string,
  caret: number,
  triggerConfigs: readonly RichTextTriggerConfig[]
): RichTextTriggerQueryState | null {
  const cursor = Math.max(0, Math.min(caret, value.length));
  if (triggerConfigs.length === 0) {
    return null;
  }
  let segmentStart = cursor;
  while (segmentStart > 0) {
    const previous = value[segmentStart - 1] ?? "";
    if (/\s/.test(previous)) {
      break;
    }
    segmentStart -= 1;
  }

  const segment = value.slice(segmentStart, cursor);
  for (let index = segment.length - 1; index >= 0; index -= 1) {
    const trigger = segment[index] as RichTextTrigger;
    const matchingConfigs = triggerConfigs.filter(
      (config) => config.trigger === trigger
    );
    if (matchingConfigs.length === 0) {
      continue;
    }
    const previous = segment[index - 1] ?? "";
    if (
      index > 0 &&
      !matchingConfigs.some((config) =>
        isRichTextTriggerPrefixBoundary(previous, config.boundary)
      )
    ) {
      continue;
    }

    const candidate = segment.slice(index);
    if (/[[\]()]/.test(candidate.slice(1))) {
      return null;
    }

    return {
      from: segmentStart + index,
      to: cursor,
      trigger,
      keyword: candidate.slice(1)
    };
  }

  return null;
}

export async function queryRichTextTriggerMatches(
  registry: RichTextTriggerRegistry,
  input: RichTextTriggerQueryInput
): Promise<readonly RichTextTriggerQueryMatch[]> {
  try {
    return await registry.query(input);
  } catch {
    return [];
  }
}
