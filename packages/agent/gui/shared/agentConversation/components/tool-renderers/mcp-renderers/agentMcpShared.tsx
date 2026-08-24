import type { AgentToolCallVM } from "../../../contracts/agentToolCallVM";
import { extractAgentMcpToolTarget } from "../../../../agentMcpToolTarget";
import {
  arrayValue,
  objectValue,
  stringValue
} from "../agentToolContentShared";
import { structuredToolText } from "../render-data/structuredToolText";

export interface AgentMcpNormalizedPayload {
  server: string | null;
  tool: string | null;
  inputSummary: string | null;
  structured: unknown;
  text: string | null;
  errorText: string | null;
}

export function normalizeMcpPayload(
  call: AgentToolCallVM
): AgentMcpNormalizedPayload {
  const target = extractAgentMcpToolTarget({
    input: call.input,
    metadata: call.metadata,
    payload: call.payload,
    toolName: call.toolName,
    name: call.name
  });
  const server =
    target?.server ??
    stringValue(call.metadata?.server) ??
    stringValue(call.metadata?.serverName) ??
    stringValue(call.metadata?.mcpServer) ??
    null;
  const tool =
    target?.tool ??
    stringValue(call.metadata?.tool) ??
    stringValue(call.metadata?.toolName) ??
    call.toolName;

  const structured = firstStructuredValue(
    call.output?.structuredContent,
    parseJsonString(call.output?.text),
    parseJsonString(call.output?.stdout)
  );
  const status = (call.status ?? "").trim().toLowerCase();
  const failed =
    call.statusKind === "failed" || status === "failed" || status === "error";

  return {
    server,
    tool,
    inputSummary: firstString(
      stringValue(call.input?.query),
      stringValue(call.input?.url),
      stringValue(call.input?.path),
      stringValue(call.input?.prompt),
      stringValue(call.input?.command)
    ),
    structured,
    text: firstString(
      stringValue(call.output?.text),
      stringValue(call.output?.stdout)
    ),
    errorText:
      structuredToolText(call.error) ??
      (failed ? structuredToolText(call.output) : null)
  };
}

export function parsedItems(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const record = objectValue(entry);
      return record ? [record] : [];
    });
  }
  const record = objectValue(value);
  if (!record) {
    return [];
  }
  const candidateArrays = [
    arrayValue(record.issues),
    arrayValue(record.pages),
    arrayValue(record.results),
    arrayValue(record.resources),
    arrayValue(record.documents),
    arrayValue(record.docs),
    arrayValue(record.items)
  ];
  for (const candidate of candidateArrays) {
    if (candidate && candidate.length > 0) {
      return candidate.flatMap((entry) => {
        const item = objectValue(entry);
        return item ? [item] : [];
      });
    }
  }
  return [];
}

export function itemPrimaryText(item: Record<string, unknown>): string | null {
  return firstString(
    stringValue(item.key),
    stringValue(item.title),
    stringValue(item.name),
    stringValue(item.path),
    stringValue(item.url),
    stringValue(item.id)
  );
}

export function itemSecondaryText(
  item: Record<string, unknown>
): string | null {
  return firstString(
    stringValue(item.summary),
    stringValue(item.description),
    stringValue(item.status),
    stringValue(item.type)
  );
}

function firstStructuredValue(...values: unknown[]): unknown {
  for (const value of values) {
    if (Array.isArray(value)) {
      return value;
    }
    if (value && typeof value === "object") {
      return value;
    }
  }
  return null;
}

function parseJsonString(value: unknown): unknown {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function firstString(...values: Array<string | null>): string | null {
  for (const value of values) {
    if (value) {
      return value;
    }
  }
  return null;
}
