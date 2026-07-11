import assert from "node:assert/strict";
import test from "node:test";

import { desktopAgentProbeIncludesUsage } from "./useDesktopAgentProbes.ts";

test("AgentGUI mount stays local-only until an explicit refresh request", () => {
  assert.equal(desktopAgentProbeIncludesUsage(0), false);
  assert.equal(desktopAgentProbeIncludesUsage(1), true);
});
