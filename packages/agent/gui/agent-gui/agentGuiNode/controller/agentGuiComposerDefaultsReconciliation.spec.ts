import { describe, expect, it } from "vitest";
import {
  acknowledgeAgentGUIComposerDefaultsMutation,
  createAgentGUIComposerDefaultsLedger,
  prepareAcknowledgedComposerDefaultsAuthorityRead,
  registerAgentGUIComposerDefaultsMutation,
  retireAcknowledgedComposerDefaultsForRead
} from "./agentGuiComposerDefaultsReconciliation";

const draftKey = "__agent_gui_node_defaults__:target:local:opencode";

describe("agentGuiComposerDefaultsReconciliation", () => {
  it("does not let an older A read retire a later A generation", () => {
    const ledger = createAgentGUIComposerDefaultsLedger();
    const firstA = registerAgentGUIComposerDefaultsMutation(ledger, draftKey, {
      permissionModeId: "ask"
    });
    acknowledgeAgentGUIComposerDefaultsMutation(ledger, firstA, {
      acknowledgedFields: ["permissionModeId"],
      supersededFields: []
    });
    const firstRead = prepareAcknowledgedComposerDefaultsAuthorityRead(
      ledger,
      draftKey,
      { permissionModeId: "ask" }
    );
    expect(firstRead.settings).toEqual({});
    expect(firstRead.receipt).not.toBeNull();

    const mutationB = registerAgentGUIComposerDefaultsMutation(
      ledger,
      draftKey,
      { permissionModeId: "full-access" }
    );
    acknowledgeAgentGUIComposerDefaultsMutation(ledger, mutationB, {
      acknowledgedFields: ["permissionModeId"],
      supersededFields: []
    });
    const latestA = registerAgentGUIComposerDefaultsMutation(ledger, draftKey, {
      permissionModeId: "ask"
    });
    acknowledgeAgentGUIComposerDefaultsMutation(ledger, latestA, {
      acknowledgedFields: ["permissionModeId"],
      supersededFields: []
    });

    expect(
      retireAcknowledgedComposerDefaultsForRead(ledger, firstRead.receipt!, {
        permissionModeId: "ask"
      })
    ).toEqual([]);
    const latestRead = prepareAcknowledgedComposerDefaultsAuthorityRead(
      ledger,
      draftKey,
      { permissionModeId: "ask" }
    );
    expect(latestRead.receipt).not.toBeNull();
    expect(
      retireAcknowledgedComposerDefaultsForRead(ledger, latestRead.receipt!, {
        permissionModeId: "ask"
      })
    ).toEqual([{ field: "permissionModeId", value: "ask" }]);
  });

  it("does not let a read started before ack retire that later ack", () => {
    const ledger = createAgentGUIComposerDefaultsLedger();
    const mutation = registerAgentGUIComposerDefaultsMutation(
      ledger,
      draftKey,
      { model: "opencode/model-a" }
    );
    const preAckRead = prepareAcknowledgedComposerDefaultsAuthorityRead(
      ledger,
      draftKey,
      { model: "opencode/model-a" }
    );
    expect(preAckRead).toEqual({
      force: false,
      receipt: null,
      settings: { model: "opencode/model-a" }
    });

    acknowledgeAgentGUIComposerDefaultsMutation(ledger, mutation, {
      acknowledgedFields: ["model"],
      supersededFields: []
    });
    const postAckRead = prepareAcknowledgedComposerDefaultsAuthorityRead(
      ledger,
      draftKey,
      { model: "opencode/model-a" }
    );
    expect(postAckRead).toMatchObject({
      force: true,
      receipt: {
        draftKey,
        fields: { model: { value: "opencode/model-a" } }
      },
      settings: {}
    });
  });

  it("keeps authority receipts isolated by target draft key", () => {
    const ledger = createAgentGUIComposerDefaultsLedger();
    const otherDraftKey =
      "__agent_gui_node_defaults__:target:local:claude-code";
    const opencodeMutation = registerAgentGUIComposerDefaultsMutation(
      ledger,
      draftKey,
      { speed: "fast" }
    );
    const claudeMutation = registerAgentGUIComposerDefaultsMutation(
      ledger,
      otherDraftKey,
      { speed: "normal" }
    );
    acknowledgeAgentGUIComposerDefaultsMutation(ledger, opencodeMutation, {
      acknowledgedFields: ["speed"],
      supersededFields: []
    });
    acknowledgeAgentGUIComposerDefaultsMutation(ledger, claudeMutation, {
      acknowledgedFields: ["speed"],
      supersededFields: []
    });
    const opencodeRead = prepareAcknowledgedComposerDefaultsAuthorityRead(
      ledger,
      draftKey,
      { speed: "fast" }
    );

    expect(
      retireAcknowledgedComposerDefaultsForRead(ledger, opencodeRead.receipt!, {
        speed: "fast"
      })
    ).toEqual([{ field: "speed", value: "fast" }]);
    expect(
      prepareAcknowledgedComposerDefaultsAuthorityRead(ledger, otherDraftKey, {
        speed: "normal"
      }).receipt
    ).not.toBeNull();
  });
});
