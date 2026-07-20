import { describe, expect, it } from "vitest";
import { createAgentGuiWorkbenchPreviewContent } from "./index.ts";

describe("AgentGUI workbench public exports", () => {
  it("exports the shared preview content builder for host dock adapters", () => {
    expect(createAgentGuiWorkbenchPreviewContent).toBeTypeOf("function");
  });
});
