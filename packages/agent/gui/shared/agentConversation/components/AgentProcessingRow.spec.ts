import { describe, expect, it } from "vitest";
import { effectivePhase } from "./AgentProcessingRow";

describe("effectivePhase", () => {
  it("falls back from a stalled submit to waiting for response", () => {
    expect(effectivePhase("submitting", 3, null)).toBe("waiting_response");
  });

  it("falls back from stalled model and tool progress without guessing", () => {
    expect(effectivePhase("thinking", 9, 3)).toBe("waiting_continuation");
    expect(effectivePhase("generating", 9, 3)).toBe("waiting_continuation");
    expect(effectivePhase("using_tool", 9, 3)).toBe("waiting_tool");
  });

  it("keeps reconnecting authoritative", () => {
    expect(effectivePhase("reconnecting", 30, 30)).toBe("reconnecting");
  });
});
