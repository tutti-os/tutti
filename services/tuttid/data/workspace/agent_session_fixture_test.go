package workspace

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func TestExportAgentSessionGraphExcludesUnrelatedSentinelSession(t *testing.T) {
	store := openTestSQLiteStore(t)
	ctx := context.Background()
	const workspaceID = "workspace-fixture"
	if err := store.Create(ctx, workspacebiz.Summary{ID: workspaceID, Name: "Fixture"}); err != nil {
		t.Fatal(err)
	}
	for _, report := range []agentactivitybiz.SessionStateReport{
		{
			WorkspaceID:      workspaceID,
			AgentSessionID:   "root-session",
			Kind:             "root",
			Origin:           agentsessionstore.WorkspaceAgentSessionOriginRuntime,
			Provider:         "codex",
			Status:           "ready",
			OccurredAtUnixMS: 100,
		},
		{
			WorkspaceID:          workspaceID,
			AgentSessionID:       "child-session",
			Kind:                 "child",
			RootAgentSessionID:   "root-session",
			RootTurnID:           "root-turn",
			ParentAgentSessionID: "root-session",
			ParentTurnID:         "root-turn",
			ParentToolCallID:     "tool-call",
			Origin:               agentsessionstore.WorkspaceAgentSessionOriginRuntime,
			Provider:             "codex",
			Status:               "ready",
			OccurredAtUnixMS:     110,
		},
		{
			WorkspaceID:      workspaceID,
			AgentSessionID:   "unrelated-sentinel-session",
			Kind:             "root",
			Origin:           agentsessionstore.WorkspaceAgentSessionOriginRuntime,
			Provider:         "codex",
			Status:           "ready",
			Title:            "UNRELATED_SENTINEL_MUST_NOT_EXPORT",
			OccurredAtUnixMS: 120,
		},
	} {
		if report.AgentSessionID == "child-session" {
			seedTestAgentTurn(
				t,
				store,
				ctx,
				workspaceID,
				"root-session",
				"root-turn",
				"codex",
				105,
			)
		}
		if _, err := store.ReportSessionState(ctx, report); err != nil {
			t.Fatal(err)
		}
	}

	rootID, err := store.ResolveRootAgentSession(ctx, workspaceID, "child-session")
	if err != nil {
		t.Fatal(err)
	}
	if rootID != "root-session" {
		t.Fatalf("root id = %q", rootID)
	}
	destination := filepath.Join(t.TempDir(), "state.jsonl")
	if err := store.ExportAgentSessionGraph(ctx, workspaceID, rootID, destination); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(destination)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = file.Close() }()
	var sessionIDs []string
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		var record agentSessionFixtureRecord
		if err := json.Unmarshal(scanner.Bytes(), &record); err != nil {
			t.Fatal(err)
		}
		if record.Table == "workspace_agent_sessions" {
			sessionIDs = append(sessionIDs, record.Values["agent_session_id"].(string))
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	if len(sessionIDs) != 2 || sessionIDs[0] != "root-session" || sessionIDs[1] != "child-session" {
		t.Fatalf("exported sessions = %#v", sessionIDs)
	}
}
