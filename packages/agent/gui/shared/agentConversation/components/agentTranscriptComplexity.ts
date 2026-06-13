import type { AgentTranscriptRowVM } from "../contracts/agentTranscriptRowVM";

export interface AgentTranscriptComplexity {
  totalScore: number;
  maxTurnScore: number;
  turnScores: readonly number[];
}

export interface AgentTranscriptComplexityAssessment extends AgentTranscriptComplexity {
  shouldVirtualize: boolean;
  turnCount: number;
}

const AGENT_TRANSCRIPT_COMPLEXITY_VIRTUALIZATION_SCORE = 40;
const AGENT_TRANSCRIPT_COMPLEXITY_SINGLE_TURN_SCORE = 24;
const AGENT_TRANSCRIPT_COMPLEXITY_TURN_COUNT = 30;

export function assessAgentTranscriptComplexity(
  turnGroups: ReadonlyArray<{
    rows: ReadonlyArray<{ row: AgentTranscriptRowVM }>;
  }>
): AgentTranscriptComplexityAssessment {
  const complexity = calculateAgentTranscriptComplexity(turnGroups);
  return {
    ...complexity,
    shouldVirtualize: shouldVirtualizeAgentTranscript({
      turnCount: turnGroups.length,
      complexity
    }),
    turnCount: turnGroups.length
  };
}

export function calculateAgentTranscriptComplexity(
  turnGroups: ReadonlyArray<{
    rows: ReadonlyArray<{ row: AgentTranscriptRowVM }>;
  }>
): AgentTranscriptComplexity {
  const turnScores = turnGroups.map((group) => calculateTurnScore(group.rows));
  const totalScore = turnScores.reduce((total, score) => total + score, 0);
  return {
    totalScore,
    maxTurnScore: Math.max(0, ...turnScores),
    turnScores
  };
}

export function shouldVirtualizeAgentTranscript(input: {
  turnCount: number;
  complexity: AgentTranscriptComplexity;
}): boolean {
  return (
    input.turnCount >= AGENT_TRANSCRIPT_COMPLEXITY_TURN_COUNT ||
    input.complexity.totalScore >=
      AGENT_TRANSCRIPT_COMPLEXITY_VIRTUALIZATION_SCORE ||
    input.complexity.maxTurnScore >=
      AGENT_TRANSCRIPT_COMPLEXITY_SINGLE_TURN_SCORE
  );
}

function calculateTurnScore(
  rows: ReadonlyArray<{ row: AgentTranscriptRowVM }>
): number {
  let rowCount = 0;
  let charCount = 0;
  let codeFenceCount = 0;
  let tableCount = 0;
  let toolCallCount = 0;
  let thinkingBlockCount = 0;
  let imageCount = 0;

  for (const { row } of rows) {
    rowCount += 1;
    if (row.kind === "message") {
      for (const message of row.messages) {
        charCount += message.body.length;
        codeFenceCount += countCodeFences(message.body);
        tableCount += countMarkdownTables(message.body);
        imageCount +=
          (message.images?.length ?? 0) + countMarkdownImages(message.body);
      }
      for (const thinking of row.thinking) {
        thinkingBlockCount += 1;
        charCount += thinking.body.length;
        codeFenceCount += countCodeFences(thinking.body);
      }
      continue;
    }
    if (row.kind === "tool-group") {
      toolCallCount += row.calls.length;
      thinkingBlockCount += row.entries.filter(
        (entry) => entry.kind === "thinking"
      ).length;
      charCount += (row.summary ?? "").length;
      continue;
    }
    if (row.kind === "turn-summary") {
      charCount += row.files.reduce(
        (total, file) =>
          total +
          file.label.length +
          file.path.length +
          (file.unifiedDiff?.length ?? 0) +
          (file.content?.length ?? 0),
        0
      );
    }
  }

  return (
    rowCount +
    charCount / 1200 +
    codeFenceCount * 4 +
    tableCount * 5 +
    toolCallCount * 2 +
    thinkingBlockCount * 2 +
    imageCount * 4
  );
}

function countCodeFences(value: string): number {
  let count = 0;
  for (const line of value.split("\n")) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      count += 1;
    }
  }
  return Math.ceil(count / 2);
}

function countMarkdownTables(value: string): number {
  const lines = value.split("\n");
  let count = 0;
  for (let index = 1; index < lines.length; index += 1) {
    if (
      looksLikeTableSeparator(lines[index] ?? "") &&
      lines[index - 1]?.includes("|")
    ) {
      count += 1;
    }
  }
  return count;
}

function countMarkdownImages(value: string): number {
  let count = 0;
  let index = 0;
  while (index < value.length) {
    const imageStart = value.indexOf("![", index);
    if (imageStart < 0) {
      break;
    }
    const labelEnd = value.indexOf("]", imageStart + 2);
    const targetStart = labelEnd >= 0 ? value.indexOf("(", labelEnd) : -1;
    const targetEnd = targetStart >= 0 ? value.indexOf(")", targetStart) : -1;
    if (
      labelEnd >= 0 &&
      targetStart === labelEnd + 1 &&
      targetEnd > targetStart
    ) {
      count += 1;
      index = targetEnd + 1;
      continue;
    }
    index = imageStart + 2;
  }
  return count;
}

function looksLikeTableSeparator(line: string): boolean {
  const cells = line
    .split("|")
    .map((cell) => cell.trim())
    .filter(Boolean);
  return (
    cells.length > 0 &&
    cells.every((cell) => {
      const normalized = cell.replace(/:/gu, "");
      return (
        normalized.length >= 3 && [...normalized].every((char) => char === "-")
      );
    })
  );
}
