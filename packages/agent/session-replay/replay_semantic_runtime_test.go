package sessionreplay

import (
	"encoding/json"
	"testing"
	"time"
)

func TestReplayWorkbenchSnapshotSuppressesOnboardingWithoutRestoringNodes(t *testing.T) {
	openedAt := time.Date(2026, 7, 29, 10, 11, 12, 0, time.UTC)
	snapshot := replayWorkbenchSnapshot("workspace-1", openedAt)
	var document struct {
		ActiveNodeID any   `json:"activeNodeId"`
		NodeStack    []any `json:"nodeStack"`
		Nodes        []any `json:"nodes"`
		Metadata     struct {
			WorkspaceOnboarding struct {
				AutoOpened    bool   `json:"autoOpened"`
				AutoOpenedAt  string `json:"autoOpenedAt"`
				SchemaVersion int    `json:"schemaVersion"`
			} `json:"workspaceOnboarding"`
		} `json:"metadata"`
	}
	if err := json.Unmarshal(snapshot.JSON, &document); err != nil {
		t.Fatal(err)
	}
	if snapshot.WorkspaceID != "workspace-1" || snapshot.SchemaVersion != 1 {
		t.Fatalf("snapshot identity = %#v", snapshot)
	}
	if len(document.Nodes) != 0 || len(document.NodeStack) != 0 || document.ActiveNodeID != nil {
		t.Fatalf("snapshot restored Workbench nodes: %#v", document)
	}
	onboarding := document.Metadata.WorkspaceOnboarding
	if !onboarding.AutoOpened ||
		onboarding.AutoOpenedAt != "2026-07-29T10:11:12Z" ||
		onboarding.SchemaVersion != 1 {
		t.Fatalf("onboarding metadata = %#v", onboarding)
	}
}
