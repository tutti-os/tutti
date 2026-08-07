package workspace

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"testing"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func TestCaptureReplayStateExcludesUnrelatedSentinelSession(t *testing.T) {
	store := openTestSQLiteStore(t)
	ctx := context.Background()
	const workspaceID = "workspace-fixture"
	if err := store.Create(ctx, workspacebiz.Summary{ID: workspaceID, Name: "Fixture"}); err != nil {
		t.Fatal(err)
	}
	for _, report := range []agentactivitybiz.SessionStateReport{
		{
			WorkspaceID:       workspaceID,
			AgentSessionID:    "root-session",
			Kind:              "root",
			Origin:            agentsessionstore.WorkspaceAgentSessionOriginRuntime,
			AgentTargetID:     "local:codex",
			Provider:          "codex",
			ProviderSessionID: "provider-root",
			Status:            "ready",
			Title:             workspaceID,
			RuntimeContext: map[string]any{
				canonical.ProviderResumeCheckpointRuntimeContextKey: map[string]any{
					"defaultModel": "gpt-5.5",
					"defaultModeMask": map[string]any{
						"mode": "default",
					},
				},
			},
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
			AgentTargetID:        "local:codex",
			Provider:             "codex",
			ProviderSessionID:    "provider-child",
			Status:               "ready",
			OccurredAtUnixMS:     110,
		},
		{
			WorkspaceID:       workspaceID,
			AgentSessionID:    "unrelated-sentinel-session",
			Kind:              "root",
			Origin:            agentsessionstore.WorkspaceAgentSessionOriginRuntime,
			AgentTargetID:     "local:codex",
			Provider:          "codex",
			ProviderSessionID: "provider-unrelated",
			Status:            "ready",
			Title:             "UNRELATED_SENTINEL_MUST_NOT_EXPORT",
			OccurredAtUnixMS:  120,
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
	if _, accepted, err := store.agentStore().RecordTurnTransition(
		ctx,
		agentactivitybiz.TurnTransition{
			WorkspaceID: workspaceID, AgentSessionID: "root-session",
			TurnID: "root-turn", Phase: agentactivitybiz.TurnPhaseSettled,
			Outcome:          agentactivitybiz.TurnOutcomeCompleted,
			Origin:           agentactivitybiz.TurnOriginLegacyUnknown,
			OccurredAtUnixMS: 130,
		},
	); err != nil || !accepted {
		t.Fatalf("settle root Turn accepted=%v error=%v", accepted, err)
	}

	rootID, err := store.ResolveRootAgentSession(ctx, workspaceID, "child-session")
	if err != nil {
		t.Fatal(err)
	}
	if rootID != "root-session" {
		t.Fatalf("root id = %q", rootID)
	}
	raw, err := store.CaptureReplayState(ctx, workspaceID, rootID)
	if err != nil {
		t.Fatal(err)
	}
	var state TuttiReplayState
	if err := json.Unmarshal(raw, &state); err != nil {
		t.Fatal(err)
	}
	if state.SchemaVersion != tuttiReplayStateSchemaVersion {
		t.Fatalf("semantic state schema version = %d", state.SchemaVersion)
	}
	var sessionIDs []string
	foundSourceIDInUserData := false
	for _, session := range state.Agent.Sessions {
		sessionIDs = append(sessionIDs, session.ID)
		if session.Title == workspaceID {
			foundSourceIDInUserData = true
		}
	}
	if len(sessionIDs) != 2 || sessionIDs[0] != "root-session" || sessionIDs[1] != "child-session" {
		t.Fatalf("exported sessions = %#v", sessionIDs)
	}
	if !foundSourceIDInUserData {
		t.Fatal("fixture export rewrote user data equal to the source Workspace id")
	}
	if checkpoint := state.Agent.Sessions[0].ProviderResumeCheckpoint; checkpoint == nil ||
		checkpoint["defaultModel"] != "gpt-5.5" {
		t.Fatalf("provider resume checkpoint = %#v", checkpoint)
	}
	if string(raw) == "" ||
		jsonContainsKey(t, raw, "workspaceId") ||
		jsonContainsKey(t, raw, "table") ||
		jsonContainsKey(t, raw, "values") {
		t.Fatalf("semantic state leaks persistence vocabulary: %s", raw)
	}

	const replayWorkspaceID = "workspace-fixture-replay"
	if err := store.Create(ctx, workspacebiz.Summary{
		ID: replayWorkspaceID, Name: "Replay",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.AgentCanonicalStore().RestoreHistoricalSessionGraph(
		ctx,
		agenthost.HistoricalSessionGraphRestoreInput{
			WorkspaceID: replayWorkspaceID,
			UserID:      "user-replay",
			Graph:       state.Agent,
		},
	); err != nil {
		t.Fatal(err)
	}
	restored, err := store.AgentCanonicalStore().CaptureHistoricalSessionGraph(
		ctx,
		replayWorkspaceID,
		state.Agent.RootSessionID,
	)
	if err != nil {
		t.Fatal(err)
	}
	restoredRaw, err := json.Marshal(restored)
	if err != nil {
		t.Fatal(err)
	}
	expectedRaw, err := json.Marshal(state.Agent)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(restoredRaw, expectedRaw) {
		t.Fatalf(
			"restored graph differs:\nrestored=%s\nexpected=%s",
			restoredRaw,
			expectedRaw,
		)
	}
	restoredSession, ok, err := store.AgentCanonicalStore().GetSession(
		ctx,
		replayWorkspaceID,
		"root-session",
	)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("restored root Session is missing")
	}
	if checkpoint := restoredSession.InternalRuntimeContext[canonical.ProviderResumeCheckpointRuntimeContextKey]; !bytes.Equal(mustJSON(t, checkpoint), mustJSON(
		t,
		state.Agent.Sessions[0].ProviderResumeCheckpoint,
	)) {
		t.Fatalf("restored provider resume checkpoint = %#v", checkpoint)
	}
	if err := store.AgentCanonicalStore().RestoreHistoricalSessionGraph(
		ctx,
		agenthost.HistoricalSessionGraphRestoreInput{
			WorkspaceID: replayWorkspaceID,
			UserID:      "user-replay",
			Graph:       state.Agent,
		},
	); err != nil {
		t.Fatalf("idempotent restore error = %v", err)
	}
	conflicting := state.Agent
	conflicting.Sessions = append([]agenthost.HistoricalSession(nil), state.Agent.Sessions...)
	conflicting.Sessions[0].Title = "conflicting title"
	if err := store.AgentCanonicalStore().RestoreHistoricalSessionGraph(
		ctx,
		agenthost.HistoricalSessionGraphRestoreInput{
			WorkspaceID: replayWorkspaceID,
			UserID:      "user-replay",
			Graph:       conflicting,
		},
	); !errors.Is(err, agenthost.ErrHistoricalStateConflict) {
		t.Fatalf("conflicting restore error = %v", err)
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestCaptureReplayStateIgnoresUnrelatedSQLiteColumns(t *testing.T) {
	store := openTestSQLiteStore(t)
	ctx := context.Background()
	const workspaceID = "workspace-portability"
	if err := store.Create(ctx, workspacebiz.Summary{ID: workspaceID, Name: "Portable"}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID: workspaceID, AgentSessionID: "session-1", Kind: "root",
		Origin:        agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		AgentTargetID: "local:codex", Provider: "codex",
		ProviderSessionID: "provider-session-1",
		Status:            "ready", OccurredAtUnixMS: 100,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.writeDB.ExecContext(ctx, `
UPDATE workspace_agent_session_goals
SET desired_json = NULL, observed_json = NULL, last_evidence_json = NULL
WHERE workspace_id = ? AND agent_session_id = ?
`, workspaceID, "session-1"); err != nil {
		t.Fatal(err)
	}
	beforeRaw, err := store.CaptureReplayState(ctx, workspaceID, "session-1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.writeDB.ExecContext(ctx, `
ALTER TABLE tutti_mode_turn_snapshots
ADD COLUMN unrelated_future_column TEXT NOT NULL DEFAULT 'speed-mismatch-regression'
`); err != nil {
		t.Fatal(err)
	}
	afterRaw, err := store.CaptureReplayState(ctx, workspaceID, "session-1")
	if err != nil {
		t.Fatal(err)
	}
	if string(beforeRaw) != string(afterRaw) {
		t.Fatalf("unrelated SQLite column changed semantic output\nbefore=%s\nafter=%s", beforeRaw, afterRaw)
	}
}

func jsonContainsKey(t *testing.T, raw []byte, key string) bool {
	t.Helper()
	var visit func(any) bool
	visit = func(value any) bool {
		switch value := value.(type) {
		case map[string]any:
			if _, ok := value[key]; ok {
				return true
			}
			for _, child := range value {
				if visit(child) {
					return true
				}
			}
		case []any:
			for _, child := range value {
				if visit(child) {
					return true
				}
			}
		}
		return false
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	return visit(value)
}
