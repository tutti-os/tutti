import { ComposerDraftService } from "./composerDraftService";
import { WorkspaceNavigationService } from "./workspaceNavigationService";

describe("workspace state services", () => {
  test("keeps explicit route selection authoritative during reconciliation", () => {
    const service = new WorkspaceNavigationService();
    service.reconcileSessionIds(["session-1", "session-2"]);
    expect(service.getSnapshot().selectedAgentSessionId).toBe("session-1");

    service.selectSession("session-2");
    service.reconcileSessionIds(["session-2", "session-3"]);
    expect(service.getSnapshot().selectedAgentSessionId).toBe("session-2");

    service.reconcileSessionIds(["session-3"]);
    expect(service.getSnapshot().selectedAgentSessionId).toBe("session-2");
  });

  test("keeps process-only drafts isolated by session identity", () => {
    const service = new ComposerDraftService();
    service.set("new", "first prompt");
    service.set("session-1", "follow up");

    expect(service.get("new")).toBe("first prompt");
    expect(service.get("session-1")).toBe("follow up");

    service.clear("new");
    expect(service.get("new")).toBe("");
    expect(service.get("session-1")).toBe("follow up");
  });
});
