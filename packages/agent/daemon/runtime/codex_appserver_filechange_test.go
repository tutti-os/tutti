package agentruntime

import (
	"encoding/json"
	"testing"
)

func TestAppServerFileChangePreservesCwdInRawInput(t *testing.T) {
	item := map[string]any{
		"id":     "item-file-change",
		"type":   "fileChange",
		"status": "completed",
		"cwd":    "/workspace/project",
		"changes": []any{
			map[string]any{
				"path": "/workspace/project/src/app.ts",
				"kind": map[string]any{"type": "update"},
				"diff": "@@ -1 +1 @@\n-old\n+new\n",
			},
		},
	}

	update, ok := appServerItemToolCallUpdate(item, true)
	if !ok {
		t.Fatalf("expected fileChange item to produce an update")
	}
	rawInput, ok := update["rawInput"].(map[string]any)
	if !ok {
		t.Fatalf("rawInput = %#v, want map", update["rawInput"])
	}
	if got := asString(rawInput["cwd"]); got != "/workspace/project" {
		t.Fatalf("rawInput.cwd = %q, want /workspace/project", got)
	}
	if rawInput["changes"] == nil {
		t.Fatalf("rawInput.changes was not preserved")
	}
}

func TestAppServerFileChangeApprovalUsesStartedItemChanges(t *testing.T) {
	t.Parallel()

	session := Session{
		Provider:       ProviderCodex,
		AgentSessionID: "session-file-change-approval",
	}
	normalizer := newACPTurnNormalizer()
	item := map[string]any{
		"id":     "item-file-change",
		"type":   "fileChange",
		"status": "inProgress",
		"cwd":    "/workspace/project",
		"changes": []any{
			map[string]any{
				"path": "/workspace/project/src/app.ts",
				"kind": map[string]any{"type": "update"},
			},
		},
	}
	update, ok := appServerItemToolCallUpdate(item, false)
	if !ok {
		t.Fatal("fileChange item did not produce a tool-call update")
	}
	if events, _ := normalizer.ToolCallEvents(session, "turn-1", update); len(events) == 0 {
		t.Fatal("fileChange item did not populate the turn normalizer")
	}

	adapter := &CodexAppServerAdapter{}
	events, pending, err := adapter.appServerApprovalRequested(
		session,
		"turn-1",
		json.RawMessage(`1`),
		appServerMethodFileChangeApproval,
		map[string]any{
			"itemId":    "item-file-change",
			"reason":    nil,
			"grantRoot": nil,
		},
		normalizer,
	)
	if err != nil {
		t.Fatalf("appServerApprovalRequested: %v", err)
	}
	if pending == nil {
		t.Fatal("pending approval is nil")
	}
	if pending.approvalPurpose != approvalPurposeEditFiles {
		t.Fatalf("pending approval purpose = %q, want %q", pending.approvalPurpose, approvalPurposeEditFiles)
	}
	interaction := events[len(events)-1].Payload.Interaction
	if interaction == nil || asString(interaction.Metadata["approvalPurpose"]) != approvalPurposeEditFiles {
		t.Fatalf("interaction approval purpose = %#v, want %q", interaction, approvalPurposeEditFiles)
	}
	changes, ok := pending.input["changes"].([]any)
	if !ok || len(changes) != 1 {
		t.Fatalf("pending approval changes = %#v, want the started item changes", pending.input["changes"])
	}
	if got := asString(payloadObject(changes[0])["path"]); got != "/workspace/project/src/app.ts" {
		t.Fatalf("pending approval change path = %q", got)
	}
}
