package workspace

import (
	"context"
	"errors"
	"strings"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	replaybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentsessionreplay"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func TestMergeTuttiReplayStatesMergesIdenticalObjectsAndRejectsConflicts(t *testing.T) {
	first := testTuttiReplayState("session-1", "workflow-1")
	second := testTuttiReplayState("session-2", "workflow-1")
	merged, err := replaybiz.MergeTuttiReplayStates([]TuttiReplayState{first, second})
	if err != nil {
		t.Fatal(err)
	}
	if len(merged.Agents) != 2 || len(merged.Workflows) != 1 {
		t.Fatalf("merged = %#v", merged)
	}
	second.Workflows[0].Status = "failed"
	_, err = replaybiz.MergeTuttiReplayStates([]TuttiReplayState{first, second})
	var conflict *replaybiz.TuttiReplayStateConflictError
	if !errors.As(err, &conflict) ||
		conflict.Path != "$.workflows[workflow-1].status" {
		t.Fatalf("merge conflict = %#v, error = %v", conflict, err)
	}
}

func TestCompareTuttiReplayStateReportsExactSemanticPath(t *testing.T) {
	expected := testTuttiReplayState("session-1", "workflow-1")
	actual := expected
	actual.Agent.Sessions = append(
		[]agenthost.HistoricalSession(nil),
		expected.Agent.Sessions...,
	)
	actual.Agent.Sessions[0].Settings = map[string]any{"reasoningEffort": "low"}
	err := replaybiz.CompareTuttiReplayState(expected, actual)
	var conflict *replaybiz.TuttiReplayStateConflictError
	if !errors.As(err, &conflict) ||
		conflict.Path != "$.agent.sessions[0].settings.reasoningEffort" {
		t.Fatalf("compare conflict = %#v, error = %v", conflict, err)
	}
}

func TestCompareTuttiReplayStateAcceptsAlphaEquivalentRuntimeIDs(t *testing.T) {
	expected := testTuttiReplayState("recorded-session", "recorded-workflow")
	expected.Agent.Sessions[0].Turns = []agenthost.HistoricalTurn{{
		ID: "recorded-turn", Phase: "settled", Outcome: "completed",
		Origin: "user_prompt",
		CompletedCommand: map[string]any{
			"finalAssistantMessageId": "recorded-message",
		},
	}}
	expected.Agent.Sessions[0].Messages = []agenthost.HistoricalMessage{{
		ID: "recorded-message", TurnID: "recorded-turn", Role: "assistant",
		Payload: map[string]any{"text": "same result", "seq": float64(100)},
	}}
	actual := testTuttiReplayState("replayed-session", "replayed-workflow")
	actual.Agent.Sessions[0].ProviderSessionID =
		expected.Agent.Sessions[0].ProviderSessionID
	actual.Agent.Sessions[0].Turns = []agenthost.HistoricalTurn{{
		ID: "replayed-turn", Phase: "settled", Outcome: "completed",
		Origin: "user_prompt",
		CompletedCommand: map[string]any{
			"finalAssistantMessageId": "replayed-message",
		},
	}}
	actual.Agent.Sessions[0].Messages = []agenthost.HistoricalMessage{{
		ID: "replayed-message", TurnID: "replayed-turn", Role: "assistant",
		Payload: map[string]any{"text": "same result", "seq": float64(200)},
	}}
	if err := replaybiz.CompareTuttiReplayState(expected, actual); err != nil {
		t.Fatal(err)
	}
}

func TestValidateTuttiReplayStateRejectsAbsolutePaths(t *testing.T) {
	state := testTuttiReplayState("session-1", "workflow-1")
	state.Agent.Sessions[0].Messages = []agenthost.HistoricalMessage{{
		ID: "message-1", Role: "user",
		Payload: map[string]any{"path": "/Users/example/secret.png"},
	}}
	err := replaybiz.ValidateTuttiReplayState(state)
	if err == nil || !strings.Contains(err.Error(), "absolute path") {
		t.Fatalf("absolute path error = %v", err)
	}
}

func TestCaptureTuttiReplayStateExcludesToolRuntimeCWD(t *testing.T) {
	store := openTestSQLiteStore(t)
	ctx := context.Background()
	const workspaceID = "workspace-tool-runtime-cwd"
	if err := store.Create(ctx, workspacebiz.Summary{
		ID: workspaceID, Name: "Replay",
	}); err != nil {
		t.Fatal(err)
	}
	state := testTuttiReplayState("session-1", "workflow-1")
	state.Agent.Sessions[0].Messages = []agenthost.HistoricalMessage{{
		ID: "tool-message", Role: "assistant", Kind: "tool_call",
		Payload: map[string]any{
			"name": "AnyTool",
			"input": map[string]any{
				"cwd":     "/Users/example/private-workspace",
				"command": "/bin/zsh -lc 'sleep 1'",
				"toolCall": map[string]any{
					"input": map[string]any{
						"cwd":     "/Users/example/private-workspace",
						"command": "/bin/zsh -lc 'sleep 1'",
					},
					"title": "/bin/zsh -lc 'sleep 1'",
				},
				"arguments": map[string]any{
					"cwd": "tool-owned-relative-value",
				},
			},
		},
	}}
	state.Agent.Sessions[0].Interactions = []agenthost.HistoricalInteraction{{
		RequestID: "approval-1",
		TurnID:    "turn-1",
		Kind:      "approval",
		Status:    "answered",
		Input: map[string]any{
			"cwd":     "/Users/example/private-workspace",
			"command": "/bin/zsh -lc 'sleep 1'",
			"toolCall": map[string]any{
				"input": map[string]any{
					"cwd":     "/Users/example/private-workspace",
					"command": "/bin/zsh -lc 'sleep 1'",
				},
				"title": "/bin/zsh -lc 'sleep 1'",
			},
		},
		Output:   map[string]any{},
		Metadata: map[string]any{},
	}}

	captured, err := store.CaptureTuttiReplayStateWithAgent(
		ctx,
		workspaceID,
		state.Agent,
	)
	if err != nil {
		t.Fatal(err)
	}
	input := captured.Agent.Sessions[0].Messages[0].Payload["input"].(map[string]any)
	if _, ok := input["cwd"]; ok {
		t.Fatalf("tool runtime cwd was retained: %#v", input)
	}
	toolCall := input["toolCall"].(map[string]any)
	toolCallInput := toolCall["input"].(map[string]any)
	if _, ok := toolCallInput["cwd"]; ok {
		t.Fatalf("normalized approval tool runtime cwd was retained: %#v", toolCallInput)
	}
	if toolCallInput["command"] != "zsh -lc 'sleep 1'" {
		t.Fatalf("normalized approval command = %#v", toolCallInput["command"])
	}
	if toolCall["title"] != "zsh -lc 'sleep 1'" {
		t.Fatalf("normalized approval title = %#v", toolCall["title"])
	}
	if input["command"] != "zsh -lc 'sleep 1'" {
		t.Fatalf("approval display command = %#v", input["command"])
	}
	arguments := input["arguments"].(map[string]any)
	if arguments["cwd"] != "tool-owned-relative-value" {
		t.Fatalf("tool-owned nested cwd = %#v", arguments["cwd"])
	}
	interactionInput := captured.Agent.Sessions[0].Interactions[0].Input
	if _, ok := interactionInput["cwd"]; ok {
		t.Fatalf("Interaction runtime cwd was retained: %#v", interactionInput)
	}
	interactionToolCall := interactionInput["toolCall"].(map[string]any)
	interactionToolInput := interactionToolCall["input"].(map[string]any)
	if _, ok := interactionToolInput["cwd"]; ok {
		t.Fatalf(
			"Interaction normalized tool runtime cwd was retained: %#v",
			interactionToolInput,
		)
	}
	if interactionInput["command"] != "zsh -lc 'sleep 1'" {
		t.Fatalf(
			"Interaction approval display command = %#v",
			interactionInput["command"],
		)
	}
	if err := replaybiz.ValidateTuttiReplayState(captured); err != nil {
		t.Fatal(err)
	}
}

func TestRestoreTuttiReplayProductStateRoundTripsSemanticRelationships(t *testing.T) {
	store := openTestSQLiteStore(t)
	ctx := context.Background()
	const workspaceID = "workspace-semantic-restore"
	if err := store.Create(ctx, workspacebiz.Summary{
		ID: workspaceID, Name: "Replay",
	}); err != nil {
		t.Fatal(err)
	}
	state := testTuttiReplayState("session-1", "workflow-1")
	state.Workflows[0].SourceSessionID = "session-1"
	state.Workflows[0].IssueIDs = []string{"issue-1"}
	state.Issues = []TuttiReplayIssue{{
		ID: "issue-1", Title: "Visible issue", Status: "not_started",
		Tasks: []TuttiReplayIssueTask{{
			ID: "task-1", Title: "Visible task", Status: "not_started",
			Priority: "medium", Position: 0,
		}},
	}}
	if err := store.AgentCanonicalStore().RestoreHistoricalSessionGraph(
		ctx,
		agenthost.HistoricalSessionGraphRestoreInput{
			WorkspaceID: workspaceID,
			UserID:      "user-replay",
			Graph:       state.Agent,
		},
	); err != nil {
		t.Fatal(err)
	}
	merged, err := replaybiz.MergeTuttiReplayStates([]TuttiReplayState{state})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.RestoreTuttiReplayProductState(ctx, workspaceID, merged); err != nil {
		t.Fatal(err)
	}
	actual, err := store.CaptureTuttiReplayStateWithAgent(
		ctx,
		workspaceID,
		state.Agent,
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := replaybiz.CompareTuttiReplayState(state, actual); err != nil {
		t.Fatal(err)
	}
}

func TestHistoricalSessionGraphRoundTripsCanonicalProjectBinding(t *testing.T) {
	store := openTestSQLiteStore(t)
	ctx := context.Background()
	const workspaceID = "workspace-project-binding"
	if err := store.Create(ctx, workspacebiz.Summary{
		ID: workspaceID, Name: "Replay",
	}); err != nil {
		t.Fatal(err)
	}
	projectPath := "/runtime/repo/packages/agent"
	graph := testTuttiReplayState("session-project", "workflow-1").Agent
	graph.Sessions[0].Cwd = "/runtime/repo"
	graph.Sessions[0].RailSectionKind = "project"
	graph.Sessions[0].RailProjectPath = projectPath
	graph.Sessions[0].RailSectionKey = "project:" + projectPath
	canonicalStore := store.AgentCanonicalStore()
	if err := canonicalStore.RestoreHistoricalSessionGraph(
		ctx,
		agenthost.HistoricalSessionGraphRestoreInput{
			WorkspaceID: workspaceID,
			UserID:      "user-replay",
			Graph:       graph,
		},
	); err != nil {
		t.Fatal(err)
	}
	captured, err := canonicalStore.CaptureHistoricalSessionGraph(
		ctx,
		workspaceID,
		graph.RootSessionID,
	)
	if err != nil {
		t.Fatal(err)
	}
	session := captured.Sessions[0]
	if session.Cwd != graph.Sessions[0].Cwd ||
		session.RailSectionKind != graph.Sessions[0].RailSectionKind ||
		session.RailProjectPath != graph.Sessions[0].RailProjectPath ||
		session.RailSectionKey != graph.Sessions[0].RailSectionKey {
		t.Fatalf("captured project binding = %#v", session)
	}
}

func testTuttiReplayState(sessionID, workflowID string) TuttiReplayState {
	return TuttiReplayState{
		SchemaVersion: tuttiReplayStateSchemaVersion,
		Agent: agenthost.HistoricalSessionGraph{
			RootSessionID: sessionID,
			Sessions: []agenthost.HistoricalSession{{
				ID: sessionID, Kind: "root", AgentTargetID: "local:codex",
				Provider: "codex", ProviderSessionID: "provider-" + sessionID,
				Settings:     map[string]any{"reasoningEffort": "high"},
				Turns:        []agenthost.HistoricalTurn{},
				Messages:     []agenthost.HistoricalMessage{},
				Interactions: []agenthost.HistoricalInteraction{},
			}},
		},
		TuttiMode: TuttiReplayTuttiMode{
			Activations:   []TuttiReplayActivation{},
			TurnSnapshots: []TuttiReplayTurnSnapshot{},
		},
		Workflows: []TuttiReplayWorkflow{{
			ID: workflowID, Type: "tutti_mode_plan", TriggerKind: "agent_cli",
			SourceSessionID: "shared-source", SourceTurnID: "turn-1",
			SourceToolCallID: "tool-1", Status: "completed",
			CurrentRevisionID: "revision-1", IssueIDs: []string{},
		}},
		Issues: []TuttiReplayIssue{},
	}
}
