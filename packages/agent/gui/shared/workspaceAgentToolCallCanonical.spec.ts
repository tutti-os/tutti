import { describe, expect, it } from "vitest";
import { resolveCanonicalToolName } from "./workspaceAgentToolCallCanonical";

describe("resolveCanonicalToolName", () => {
  it("canonicalizes already-canonical PascalCase tool names", () => {
    expect(resolveCanonicalToolName("Edit")).toBe("Edit");
    expect(resolveCanonicalToolName("Bash")).toBe("Bash");
  });

  it("canonicalizes lowercase/acp-style tool names", () => {
    expect(resolveCanonicalToolName("edit")).toBe("Edit");
    expect(resolveCanonicalToolName("read")).toBe("Read");
  });

  // Codex/Claude Code history import (services/tuttid/service/agent/
  // external_import_parse.go) reconstructs tool_call messages from the raw
  // provider JSONL without running the live daemon's tool-name
  // canonicalization step (packages/agent/daemon/runtime/reporter.go
  // canonicalAgentToolName). Imported tool calls therefore carry Codex's raw
  // snake_case tool name (e.g. "apply_patch" for a file edit via the
  // apply_patch custom tool) verbatim in payload.toolName, instead of the
  // canonical "Edit" that live sessions already normalize to. Without this
  // mapping, resolveAgentToolRendererKind (agentToolRendererKind.ts) can't
  // recognize the call as an edit and falls back to the generic/default tool
  // renderer, which does not resolve file references/diffs the way
  // AgentEditContent does.
  it("canonicalizes Codex's raw snake_case tool names the same way live sessions do", () => {
    expect(resolveCanonicalToolName("apply_patch")).toBe("Edit");
    expect(resolveCanonicalToolName("edit_file")).toBe("Edit");
    expect(resolveCanonicalToolName("edit_notebook")).toBe("Edit");
    expect(resolveCanonicalToolName("read_file")).toBe("Read");
    expect(resolveCanonicalToolName("read_notebook")).toBe("Read");
    expect(resolveCanonicalToolName("list_files")).toBe("Read");
    expect(resolveCanonicalToolName("write_file")).toBe("Write");
    expect(resolveCanonicalToolName("find_files")).toBe("Glob");
    expect(resolveCanonicalToolName("search_files")).toBe("Grep");
    expect(resolveCanonicalToolName("web_search")).toBe("WebSearch");
    expect(resolveCanonicalToolName("web_fetch")).toBe("WebFetch");
    expect(resolveCanonicalToolName("update_todos")).toBe("TodoWrite");
    expect(resolveCanonicalToolName("delegate_agent")).toBe("Agent");
    expect(resolveCanonicalToolName("run_command")).toBe("Bash");
    expect(resolveCanonicalToolName("read_command_output")).toBe("Bash");
    expect(resolveCanonicalToolName("stop_command")).toBe("Bash");
  });

  it("returns null for unknown or opaque tool names", () => {
    expect(resolveCanonicalToolName("some_totally_unknown_tool")).toBeNull();
    expect(resolveCanonicalToolName(null)).toBeNull();
    expect(resolveCanonicalToolName("")).toBeNull();
  });
});
