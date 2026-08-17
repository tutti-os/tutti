package sessionreplay

import (
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

func TestProjectAndResolvePortableAgentSessionBinding(t *testing.T) {
	recordedRoot := filepath.Join(
		string(filepath.Separator),
		"Users",
		"recording",
		"repo",
	)
	projectPath := filepath.Join(recordedRoot, "packages", "agent")
	agent := TuttiReplayAgent{
		RootSessionID: "session-1",
		Sessions: []agenthost.HistoricalSession{{
			ID: "session-1", Cwd: recordedRoot,
			RailSectionKind: "project", RailProjectPath: projectPath,
			RailSectionKey: "project:" + projectPath,
		}},
	}

	portable := ProjectPortableAgentState(agent, t.TempDir())
	session := portable.Sessions[0]
	if session.Cwd != PortableReplayCWDToken ||
		session.RailProjectPath !=
			PortableReplayCWDToken+"/packages/agent" ||
		session.RailSectionKey !=
			"project:"+PortableReplayCWDToken+"/packages/agent" {
		t.Fatalf("portable binding = %#v", session)
	}
	if agent.Sessions[0].Cwd != recordedRoot {
		t.Fatalf("source binding was mutated: %#v", agent.Sessions[0])
	}

	replayRoot := filepath.Join(
		string(filepath.Separator),
		"runtime",
		"replay",
	)
	resolved, err := ResolvePortableAgentState(portable, replayRoot)
	if err != nil {
		t.Fatal(err)
	}
	session = resolved.Sessions[0]
	if session.Cwd != replayRoot ||
		session.RailProjectPath != filepath.Join(replayRoot, "packages", "agent") ||
		session.RailSectionKey !=
			"project:"+filepath.Join(replayRoot, "packages", "agent") {
		t.Fatalf("resolved binding = %#v", session)
	}
}

func TestProjectPortableAgentStateProjectsSharedWorkspaceRemappedCWD(t *testing.T) {
	logicalProject := "/workspace/agent-session-replay"
	agent := TuttiReplayAgent{
		RootSessionID: "session-1",
		Sessions: []agenthost.HistoricalSession{{
			ID: "session-1",
			Cwd: "/workspace/38cd6084-2a8b-4970-bf18-c559b1dae5dd/" +
				"agent-session-replay",
			RailSectionKind: "project",
			RailProjectPath: logicalProject,
			RailSectionKey:  "project:" + logicalProject,
		}},
	}

	portable := ProjectPortableAgentState(agent, t.TempDir())
	session := portable.Sessions[0]
	if session.Cwd != PortableReplayCWDToken ||
		session.RailProjectPath != PortableReplayCWDToken ||
		session.RailSectionKey != "project:"+PortableReplayCWDToken {
		t.Fatalf("portable shared binding = %#v", session)
	}
}

func TestProjectPortableAgentStateNormalizesSymlinkEquivalentPaths(t *testing.T) {
	rawDir := t.TempDir()
	canonicalDir := storesqlite.NormalizeProjectPath(rawDir)
	if canonicalDir == "" || canonicalDir == rawDir {
		t.Skip("temp dir has no symlink path form to exercise")
	}
	agent := TuttiReplayAgent{
		RootSessionID: "session-1",
		Sessions: []agenthost.HistoricalSession{{
			ID:              "session-1",
			Cwd:             rawDir,
			RailSectionKind: storesqlite.RailSectionKindProject,
			RailProjectPath: canonicalDir,
			RailSectionKey:  "project:" + rawDir,
		}},
	}

	portable := ProjectPortableAgentState(agent, t.TempDir())
	session := portable.Sessions[0]
	if session.Cwd != PortableReplayCWDToken {
		t.Fatalf("portable cwd = %q", session.Cwd)
	}
	if session.RailProjectPath != PortableReplayCWDToken {
		t.Fatalf("portable railProjectPath = %q", session.RailProjectPath)
	}
	if session.RailSectionKey !=
		"project:"+PortableReplayCWDToken {
		t.Fatalf("portable railSectionKey = %q", session.RailSectionKey)
	}
	if filepath.IsAbs(session.RailProjectPath) || filepath.IsAbs(session.Cwd) {
		t.Fatalf("portable paths must not stay absolute: %#v", session)
	}
	if err := validateReplayPortableValue("$", "", map[string]any{
		"agent": map[string]any{
			"sessions": []any{
				map[string]any{
					"cwd":             session.Cwd,
					"railProjectPath": session.RailProjectPath,
					"railSectionKey":  session.RailSectionKey,
				},
			},
		},
	}); err != nil {
		t.Fatalf("portable binding failed path validation: %v", err)
	}
}

func TestResolvePortableAgentStateRejectsPathEscape(t *testing.T) {
	agent := TuttiReplayAgent{
		RootSessionID: "session-1",
		Sessions: []agenthost.HistoricalSession{{
			ID:  "session-1",
			Cwd: PortableReplayCWDToken + "/../outside",
		}},
	}
	if _, err := ResolvePortableAgentState(agent, "/runtime/replay"); err == nil {
		t.Fatal("portable path escape was accepted")
	}
}

func TestProjectPortableAgentStateProjectsTurnFileChangePaths(t *testing.T) {
	recordedRoot := filepath.Join(
		string(filepath.Separator),
		"Users",
		"recording",
		"repo",
	)
	absolutePath := filepath.Join(
		recordedRoot,
		".tmp",
		"agent-session-replay-r09",
		"delete-me.txt",
	)
	agent := TuttiReplayAgent{
		RootSessionID: "session-1",
		Sessions: []agenthost.HistoricalSession{{
			ID:  "session-1",
			Cwd: recordedRoot,
			Turns: []agenthost.HistoricalTurn{{
				ID:    "turn-1",
				Phase: "settled",
				FileChanges: map[string]any{
					"files": []any{
						map[string]any{
							"path":   absolutePath,
							"change": "deleted",
						},
					},
				},
			}},
		}},
	}

	portable := ProjectPortableAgentState(agent, t.TempDir())
	files, _ := portable.Sessions[0].Turns[0].FileChanges["files"].([]any)
	file, _ := files[0].(map[string]any)
	if file["path"] !=
		PortableReplayCWDToken+"/.tmp/agent-session-replay-r09/delete-me.txt" {
		t.Fatalf("portable fileChanges path = %#v", file["path"])
	}
	if agent.Sessions[0].Turns[0].FileChanges["files"].([]any)[0].(map[string]any)["path"] !=
		absolutePath {
		t.Fatalf("source fileChanges was mutated: %#v", agent.Sessions[0].Turns[0].FileChanges)
	}

	replayRoot := filepath.Join(string(filepath.Separator), "runtime", "replay")
	resolved, err := ResolvePortableAgentState(portable, replayRoot)
	if err != nil {
		t.Fatal(err)
	}
	resolvedFiles, _ := resolved.Sessions[0].Turns[0].FileChanges["files"].([]any)
	resolvedFile, _ := resolvedFiles[0].(map[string]any)
	want := filepath.Join(
		replayRoot,
		".tmp",
		"agent-session-replay-r09",
		"delete-me.txt",
	)
	if resolvedFile["path"] != want {
		t.Fatalf("resolved fileChanges path = %#v, want %#v", resolvedFile["path"], want)
	}
}

func TestProjectPortableAgentStateProjectsGeneratedImagePaths(t *testing.T) {
	stateDirectory := t.TempDir()
	generatedPath := filepath.Join(
		stateDirectory,
		"agent",
		"runs",
		"session-1",
		"codex-home",
		"generated_images",
		"call-1",
		"image.png",
	)
	agent := TuttiReplayAgent{
		RootSessionID: "session-1",
		Sessions: []agenthost.HistoricalSession{{
			ID: "session-1", AgentTargetID: "local:codex", Provider: "codex",
			Messages: []agenthost.HistoricalMessage{{
				ID: "tool-message", Kind: "tool_call",
				Payload: map[string]any{
					"name": "Generate image",
					"output": map[string]any{
						"savedPath":     generatedPath,
						"savedPaths":    []any{generatedPath},
						"imageMimeType": "image/png",
					},
				},
			}},
		}},
	}

	projected := ProjectPortableAgentState(agent, stateDirectory)
	output := projected.Sessions[0].Messages[0].Payload["output"].(map[string]any)
	want := PortableReplayHomeToken +
		"/generated_images/call-1/image.png"
	if output["savedPath"] != want ||
		output["savedPaths"].([]any)[0] != want {
		t.Fatalf("portable generated image output = %#v", output)
	}
	if agent.Sessions[0].Messages[0].Payload["output"].(map[string]any)["savedPath"] !=
		generatedPath {
		t.Fatal("source Agent graph was mutated")
	}
}

func TestProjectPortableAgentStateDoesNotApplyCodexHomeToUnregisteredProvider(
	t *testing.T,
) {
	stateDirectory := t.TempDir()
	generatedPath := filepath.Join(
		stateDirectory,
		"agent",
		"runs",
		"session-1",
		"codex-home",
		"generated_images",
		"image.png",
	)
	agent := TuttiReplayAgent{
		RootSessionID: "session-1",
		Sessions: []agenthost.HistoricalSession{{
			ID: "session-1", AgentTargetID: "local:cursor", Provider: "cursor",
			Messages: []agenthost.HistoricalMessage{{
				ID: "tool-message", Kind: "tool_call",
				Payload: map[string]any{
					"output": map[string]any{"savedPath": generatedPath},
				},
			}},
		}},
	}

	projected := ProjectPortableAgentState(agent, stateDirectory)
	output := projected.Sessions[0].Messages[0].Payload["output"].(map[string]any)
	if output["savedPath"] != generatedPath {
		t.Fatalf("unregistered Provider path was projected: %#v", output)
	}
}

func TestProjectPortableAgentStateExcludesOnlyToolRuntimeCWD(t *testing.T) {
	agent := TuttiReplayAgent{
		RootSessionID: "session-1",
		Sessions: []agenthost.HistoricalSession{{
			ID: "session-1",
			Messages: []agenthost.HistoricalMessage{{
				ID: "tool-message", Kind: "tool_call",
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
			}, {
				ID: "ordinary-message", Kind: "text",
				Payload: map[string]any{
					"input": map[string]any{
						"cwd": "/Users/example/user-authored-value",
					},
				},
			}},
			Interactions: []agenthost.HistoricalInteraction{{
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
			}},
		}},
	}

	projected := ProjectPortableAgentState(agent, t.TempDir())
	input := projected.Sessions[0].Messages[0].Payload["input"].(map[string]any)
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
	originalInput := agent.Sessions[0].Messages[0].Payload["input"].(map[string]any)
	if originalInput["cwd"] != "/Users/example/private-workspace" {
		t.Fatalf("source Agent graph was mutated: %#v", originalInput)
	}
	ordinaryInput := projected.Sessions[0].Messages[1].Payload["input"].(map[string]any)
	if ordinaryInput["cwd"] != "/Users/example/user-authored-value" {
		t.Fatalf("ordinary message cwd was projected: %#v", ordinaryInput)
	}
	interactionInput := projected.Sessions[0].Interactions[0].Input
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
	originalInteractionInput := agent.Sessions[0].Interactions[0].Input
	if originalInteractionInput["cwd"] != "/Users/example/private-workspace" {
		t.Fatalf("source Interaction was mutated: %#v", originalInteractionInput)
	}
}

func TestProjectPortableAgentStateProjectsMaterializedMessageFields(t *testing.T) {
	userContent := []any{
		map[string]any{
			"type": "text",
			"text": "See the attached file.",
			"path": "/Users/recording/repo/attached.txt",
		},
		map[string]any{
			"type":         "image",
			"attachmentId": "attachment-recorded",
			"path":         "/Users/recording/repo/attached.png",
		},
	}
	agent := TuttiReplayAgent{
		RootSessionID: "session-1",
		Sessions: []agenthost.HistoricalSession{{
			ID: "session-1",
			Messages: []agenthost.HistoricalMessage{{
				ID:   "user-message",
				Role: "user",
				Kind: "text",
				Payload: map[string]any{
					"clientSubmitId": "submit-1",
					"content":        userContent,
				},
			}, {
				ID:   "assistant-message",
				Role: "assistant",
				Kind: "tool_call",
				Payload: map[string]any{
					"clientSubmitId": "runtime-submit",
					"input":          map[string]any{},
				},
			}},
		}},
	}

	projected := ProjectPortableAgentState(agent, t.TempDir())
	projectedUser := projected.Sessions[0].Messages[0]
	projectedContent := projectedUser.Payload["content"].([]any)
	for index, value := range projectedContent {
		block := value.(map[string]any)
		if _, ok := block["path"]; ok {
			t.Fatalf("materialized content path %d was retained: %#v", index, block)
		}
	}
	if projectedUser.Payload["clientSubmitId"] != "submit-1" {
		t.Fatalf("user clientSubmitId changed: %#v", projectedUser.Payload)
	}
	if _, ok := projected.Sessions[0].Messages[1].Payload["clientSubmitId"]; ok {
		t.Fatalf(
			"assistant runtime clientSubmitId was retained: %#v",
			projected.Sessions[0].Messages[1].Payload,
		)
	}
	originalBlock := agent.Sessions[0].Messages[0].Payload["content"].([]any)[0].(map[string]any)
	if originalBlock["path"] != "/Users/recording/repo/attached.txt" {
		t.Fatalf("source message was mutated: %#v", originalBlock)
	}
}

func TestProjectPortableAgentStateProjectsImagePathWithoutAttachmentID(t *testing.T) {
	agent := TuttiReplayAgent{
		RootSessionID: "session-1",
		Sessions: []agenthost.HistoricalSession{{
			ID: "session-1",
			Messages: []agenthost.HistoricalMessage{{
				ID:   "user-message",
				Role: "user",
				Kind: "text",
				Payload: map[string]any{
					"content": []map[string]any{{
						"type": "image",
						"path": "/var/cache/tsh/local-assets/image.png",
					}},
				},
			}},
		}},
	}

	projected := ProjectPortableAgentState(agent, t.TempDir())
	content, ok := projected.Sessions[0].Messages[0].Payload["content"].([]any)
	if !ok || len(content) != 1 {
		t.Fatalf("projected content = %#v, want one normalized block", projected.Sessions[0].Messages[0].Payload["content"])
	}
	block, ok := content[0].(map[string]any)
	if !ok {
		t.Fatalf("projected block = %#v, want object", content[0])
	}
	if _, ok := block["path"]; ok {
		t.Fatalf("image path was retained without attachment id: %#v", block)
	}
}

func TestProjectPortableAgentStateNormalizesOnlyPlanDecisionRuntimeOperationIDs(
	t *testing.T,
) {
	agent := TuttiReplayAgent{
		RootSessionID: "session-1",
		Sessions: []agenthost.HistoricalSession{{
			ID: "session-1",
			Messages: []agenthost.HistoricalMessage{{
				ID:   "client-submit:user:plan-decision:operation-1",
				Kind: "text",
				Payload: map[string]any{
					"clientSubmitId": "plan-decision:operation-1",
					"text":           "Implement the plan.",
				},
			}, {
				ID:   "plan-decision:operation-1:status",
				Kind: "system",
				Payload: map[string]any{
					"noticeKind":  "plan_implementation_completed",
					"operationId": "operation-1",
				},
			}, {
				ID:   "ordinary-message",
				Kind: "text",
				Payload: map[string]any{
					"clientSubmitId": "submit-1",
					"text":           "Keep this identity.",
				},
			}},
		}},
	}

	projected := ProjectPortableAgentState(agent, t.TempDir())
	planMessage := projected.Sessions[0].Messages[0]
	if planMessage.ID !=
		"client-submit:user:plan-decision:<runtime-operation>" {
		t.Fatalf("portable plan Message ID = %q", planMessage.ID)
	}
	if planMessage.Payload["clientSubmitId"] !=
		"plan-decision:<runtime-operation>" {
		t.Fatalf("portable plan payload = %#v", planMessage.Payload)
	}
	noticeMessage := projected.Sessions[0].Messages[1]
	if noticeMessage.ID != "plan-decision:<runtime-operation>:status" {
		t.Fatalf("portable plan notice Message ID = %q", noticeMessage.ID)
	}
	if noticeMessage.Payload["operationId"] != "<runtime-operation>" {
		t.Fatalf("portable plan notice payload = %#v", noticeMessage.Payload)
	}
	ordinaryMessage := projected.Sessions[0].Messages[2]
	if ordinaryMessage.Payload["clientSubmitId"] != "submit-1" {
		t.Fatalf("ordinary client submit ID was projected: %#v", ordinaryMessage)
	}
	if agent.Sessions[0].Messages[0].Payload["clientSubmitId"] !=
		"plan-decision:operation-1" {
		t.Fatalf("source Agent graph was mutated: %#v", agent)
	}
}

func TestProjectPortableAgentStateExcludesCanceledTurnCompletionWatermarks(
	t *testing.T,
) {
	agent := TuttiReplayAgent{
		RootSessionID: "session-1",
		Sessions: []agenthost.HistoricalSession{{
			ID: "session-1",
			Turns: []agenthost.HistoricalTurn{{
				ID:      "canceled-watermark-only",
				Outcome: "canceled",
				CompletedCommand: map[string]any{
					"finalAssistantMessageId":       "message-1",
					"finalAssistantMessageResolved": true,
				},
			}, {
				ID:      "canceled-semantic-command",
				Outcome: "canceled",
				CompletedCommand: map[string]any{
					"kind":                          "review",
					"status":                        "interrupted",
					"finalAssistantMessageResolved": true,
				},
			}, {
				ID:      "completed-turn",
				Outcome: "completed",
				CompletedCommand: map[string]any{
					"finalAssistantMessageId":       "message-2",
					"finalAssistantMessageResolved": true,
				},
			}},
		}},
	}

	projected := ProjectPortableAgentState(agent, t.TempDir())
	turns := projected.Sessions[0].Turns
	if turns[0].CompletedCommand != nil {
		t.Fatalf(
			"canceled Turn completion watermark was retained: %#v",
			turns[0].CompletedCommand,
		)
	}
	if !reflect.DeepEqual(
		turns[1].CompletedCommand,
		map[string]any{"kind": "review", "status": "interrupted"},
	) {
		t.Fatalf(
			"canceled Turn semantic command = %#v",
			turns[1].CompletedCommand,
		)
	}
	if !reflect.DeepEqual(
		turns[2].CompletedCommand,
		agent.Sessions[0].Turns[2].CompletedCommand,
	) {
		t.Fatalf(
			"completed Turn command was projected: %#v",
			turns[2].CompletedCommand,
		)
	}
	if len(agent.Sessions[0].Turns[0].CompletedCommand) != 2 ||
		len(agent.Sessions[0].Turns[1].CompletedCommand) != 3 {
		t.Fatalf("source Agent graph was mutated: %#v", agent)
	}
}

func TestCompareTuttiReplayStateTreatsRootProviderTurnIDsAsAlphaEquivalent(
	t *testing.T,
) {
	buildState := func(turnID, rootProviderTurnID string) TuttiReplayState {
		return TuttiReplayState{
			SchemaVersion: SchemaVersion,
			Agent: TuttiReplayAgent{
				RootSessionID: "session-1",
				Sessions: []agenthost.HistoricalSession{{
					ID:                "session-1",
					Kind:              "root",
					AgentTargetID:     "local:claude-code",
					Provider:          "claude-code",
					ProviderSessionID: "provider-session-1",
					Turns: []agenthost.HistoricalTurn{{
						ID:                 turnID,
						Phase:              "settled",
						Outcome:            "canceled",
						Origin:             "user_prompt",
						RootProviderTurnID: rootProviderTurnID,
					}},
				}},
			},
			TuttiMode: TuttiReplayTuttiMode{
				Activations:   []TuttiReplayActivation{},
				TurnSnapshots: []TuttiReplayTurnSnapshot{},
			},
			Workflows: []TuttiReplayWorkflow{},
			Issues:    []TuttiReplayIssue{},
		}
	}
	if err := CompareTuttiReplayState(
		buildState("recorded-turn", "recorded-root-provider-turn"),
		buildState("replayed-turn", "replayed-root-provider-turn"),
	); err != nil {
		t.Fatalf(
			"rootProviderTurnId must be alpha-equivalent, got %v",
			err,
		)
	}
}

func TestCompareTuttiReplayStateTreatsGoalControlOperationIDsAsAlphaEquivalent(
	t *testing.T,
) {
	buildState := func(operationID string) TuttiReplayState {
		return TuttiReplayState{
			SchemaVersion: SchemaVersion,
			Agent: TuttiReplayAgent{
				RootSessionID: "session-1",
				Sessions: []agenthost.HistoricalSession{{
					ID:                "session-1",
					Kind:              "root",
					AgentTargetID:     "codex",
					Provider:          "codex",
					ProviderSessionID: "provider-session-1",
					Messages: []agenthost.HistoricalMessage{{
						ID:     "goal-control:" + operationID,
						Role:   "user",
						Kind:   "session_audit",
						Status: "completed",
						Payload: map[string]any{
							"action":         "set",
							"auditId":        "goal-control:" + operationID,
							"clientSubmitId": "submit-1",
							"goalControl":    true,
							"operationId":    operationID,
						},
					}},
				}},
			},
			TuttiMode: TuttiReplayTuttiMode{
				Activations:   []TuttiReplayActivation{},
				TurnSnapshots: []TuttiReplayTurnSnapshot{},
			},
			Workflows: []TuttiReplayWorkflow{},
			Issues:    []TuttiReplayIssue{},
		}
	}
	if err := CompareTuttiReplayState(
		buildState("operation-record"),
		buildState("operation-replay"),
	); err != nil {
		t.Fatalf(
			"goal-control operation identities must be alpha-equivalent, got %v",
			err,
		)
	}
}

func TestCompareTuttiReplayStateCanonicalizesGoalControlIdentityRelations(
	t *testing.T,
) {
	buildState := func(prefix string) TuttiReplayState {
		messages := make([]agenthost.HistoricalMessage, 2)
		turns := make([]agenthost.HistoricalTurn, 2)
		for index, action := range []string{"set", "clear"} {
			operationID := fmt.Sprintf("%s-operation-%d", prefix, index)
			clientSubmitID := fmt.Sprintf("%s-submit-%d", prefix, index)
			turns[index] = agenthost.HistoricalTurn{
				ID:                    fmt.Sprintf("%s-turn-%d", prefix, index),
				Phase:                 "settled",
				Origin:                "user_prompt",
				SourceGoalOperationID: operationID,
			}
			messages[index] = agenthost.HistoricalMessage{
				ID:     "goal-control:" + operationID,
				Role:   "user",
				Kind:   "session_audit",
				Status: "completed",
				Payload: map[string]any{
					"action":         action,
					"auditId":        "goal-control:" + operationID,
					"clientSubmitId": clientSubmitID,
					"content":        "/goal " + action,
					"goalControl":    true,
					"messageId":      "client-submit:user:" + clientSubmitID,
					"operationId":    operationID,
				},
			}
		}
		return TuttiReplayState{
			SchemaVersion: SchemaVersion,
			Agent: TuttiReplayAgent{
				RootSessionID: "session-1",
				Sessions: []agenthost.HistoricalSession{{
					ID:                "session-1",
					Kind:              "root",
					AgentTargetID:     "codex",
					Provider:          "codex",
					ProviderSessionID: "provider-session-1",
					Turns:             turns,
					Messages:          messages,
				}},
			},
			TuttiMode: TuttiReplayTuttiMode{
				Activations:   []TuttiReplayActivation{},
				TurnSnapshots: []TuttiReplayTurnSnapshot{},
			},
			Workflows: []TuttiReplayWorkflow{},
			Issues:    []TuttiReplayIssue{},
		}
	}
	if err := CompareTuttiReplayState(
		buildState("recorded"),
		buildState("replayed"),
	); err != nil {
		t.Fatalf("goal-control identity graph must be alpha-equivalent: %v", err)
	}
}

func TestCompareTuttiReplayStateTreatsPayloadMessageIDsAsAlphaEquivalent(
	t *testing.T,
) {
	buildState := func(clientSubmitID string) TuttiReplayState {
		return TuttiReplayState{
			SchemaVersion: SchemaVersion,
			Agent: TuttiReplayAgent{
				RootSessionID: "session-1",
				Sessions: []agenthost.HistoricalSession{{
					ID:                "session-1",
					Kind:              "root",
					AgentTargetID:     "codex",
					Provider:          "codex",
					ProviderSessionID: "provider-session-1",
					Messages: []agenthost.HistoricalMessage{{
						ID:     "audit-1",
						Role:   "user",
						Kind:   "session_audit",
						Status: "completed",
						Payload: map[string]any{
							"action":         "set",
							"clientSubmitId": clientSubmitID,
							"messageId":      "client-submit:user:" + clientSubmitID,
						},
					}},
				}},
			},
			TuttiMode: TuttiReplayTuttiMode{
				Activations:   []TuttiReplayActivation{},
				TurnSnapshots: []TuttiReplayTurnSnapshot{},
			},
			Workflows: []TuttiReplayWorkflow{},
			Issues:    []TuttiReplayIssue{},
		}
	}
	if err := CompareTuttiReplayState(
		buildState("recorded-submit"),
		buildState("replayed-submit"),
	); err != nil {
		t.Fatalf(
			"payload messageId and its clientSubmitId must be alpha-equivalent, got %v",
			err,
		)
	}
}

func TestCompareTuttiReplayStateTreatsOrdinaryClientSubmitIDsAsAlphaEquivalent(
	t *testing.T,
) {
	if err := CompareTuttiReplayState(
		replayStateWithOrdinaryClientSubmitIDs("recorded-submit"),
		replayStateWithOrdinaryClientSubmitIDs("replayed-submit"),
	); err != nil {
		t.Fatalf("ordinary clientSubmitId must be alpha-equivalent, got %v", err)
	}
}

func TestCompareTuttiReplayStatePreservesClientSubmitIDRelationships(
	t *testing.T,
) {
	err := CompareTuttiReplayState(
		replayStateWithOrdinaryClientSubmitIDs("recorded-shared", "recorded-shared"),
		replayStateWithOrdinaryClientSubmitIDs("replayed-first", "replayed-second"),
	)
	if !errors.Is(err, ErrTuttiReplayStateConflict) {
		t.Fatalf("cross-message clientSubmitId relationship must remain semantic, got %v", err)
	}
}

func replayStateWithOrdinaryClientSubmitIDs(clientSubmitIDs ...string) TuttiReplayState {
	messages := make([]agenthost.HistoricalMessage, len(clientSubmitIDs))
	for index, clientSubmitID := range clientSubmitIDs {
		messages[index] = agenthost.HistoricalMessage{
			ID:     fmt.Sprintf("audit-%d", index+1),
			Role:   "user",
			Kind:   "session_audit",
			Status: "completed",
			Payload: map[string]any{
				"action":         "set",
				"clientSubmitId": clientSubmitID,
			},
		}
	}
	return TuttiReplayState{
		SchemaVersion: SchemaVersion,
		Agent: TuttiReplayAgent{
			RootSessionID: "session-1",
			Sessions: []agenthost.HistoricalSession{{
				ID:                "session-1",
				Kind:              "root",
				AgentTargetID:     "codex",
				Provider:          "codex",
				ProviderSessionID: "provider-session-1",
				Messages:          messages,
			}},
		},
		TuttiMode: TuttiReplayTuttiMode{
			Activations:   []TuttiReplayActivation{},
			TurnSnapshots: []TuttiReplayTurnSnapshot{},
		},
		Workflows: []TuttiReplayWorkflow{},
		Issues:    []TuttiReplayIssue{},
	}
}

func TestCompareTuttiReplayStatePreservesCrossMessageIDRelationships(
	t *testing.T,
) {
	buildState := func(firstID, secondID, referencedID string) TuttiReplayState {
		return TuttiReplayState{
			SchemaVersion: SchemaVersion,
			Agent: TuttiReplayAgent{
				RootSessionID: "session-1",
				Sessions: []agenthost.HistoricalSession{{
					ID:                "session-1",
					Kind:              "root",
					AgentTargetID:     "codex",
					Provider:          "codex",
					ProviderSessionID: "provider-session-1",
					Messages: []agenthost.HistoricalMessage{{
						ID:      firstID,
						Role:    "user",
						Kind:    "session_audit",
						Status:  "completed",
						Payload: map[string]any{"messageId": referencedID},
					}, {
						ID:      secondID,
						Role:    "assistant",
						Kind:    "text",
						Status:  "completed",
						Payload: map[string]any{},
					}},
				}},
			},
			TuttiMode: TuttiReplayTuttiMode{
				Activations:   []TuttiReplayActivation{},
				TurnSnapshots: []TuttiReplayTurnSnapshot{},
			},
			Workflows: []TuttiReplayWorkflow{},
			Issues:    []TuttiReplayIssue{},
		}
	}
	err := CompareTuttiReplayState(
		buildState("recorded-first", "recorded-second", "recorded-second"),
		buildState("replayed-first", "replayed-second", "replayed-first"),
	)
	if !errors.Is(err, ErrTuttiReplayStateConflict) {
		t.Fatalf("cross-message messageId relationship must remain semantic, got %v", err)
	}
}

func TestCompareTuttiReplayStateTreatsAttachmentIDsAsAlphaEquivalent(
	t *testing.T,
) {
	buildState := func(attachmentID string) TuttiReplayState {
		return TuttiReplayState{
			SchemaVersion: SchemaVersion,
			Agent: TuttiReplayAgent{
				RootSessionID: "session-1",
				Sessions: []agenthost.HistoricalSession{{
					ID:                "session-1",
					Kind:              "root",
					AgentTargetID:     "codex",
					Provider:          "codex",
					ProviderSessionID: "provider-session-1",
					Messages: []agenthost.HistoricalMessage{{
						ID:   "message-1",
						Kind: "text",
						Payload: map[string]any{
							"content": []any{map[string]any{
								"type":         "image",
								"mimeType":     "image/png",
								"name":         "shot.png",
								"attachmentId": attachmentID,
							}},
						},
					}},
				}},
			},
			TuttiMode: TuttiReplayTuttiMode{
				Activations:   []TuttiReplayActivation{},
				TurnSnapshots: []TuttiReplayTurnSnapshot{},
			},
			Workflows: []TuttiReplayWorkflow{},
			Issues:    []TuttiReplayIssue{},
		}
	}

	if err := CompareTuttiReplayState(
		buildState("attachment-recorded"),
		buildState("attachment-replayed"),
	); err != nil {
		t.Fatalf(
			"attachment identities must be alpha-equivalent, got %v",
			err,
		)
	}
}

func TestCompareTuttiReplayStateIgnoresSharedObjectUploadImageLocators(
	t *testing.T,
) {
	buildState := func(content map[string]any) TuttiReplayState {
		return TuttiReplayState{
			SchemaVersion: SchemaVersion,
			Agent: TuttiReplayAgent{
				RootSessionID: "session-1",
				Sessions: []agenthost.HistoricalSession{{
					ID:                "session-1",
					Kind:              "root",
					AgentTargetID:     "codex",
					Provider:          "codex",
					ProviderSessionID: "provider-session-1",
					Messages: []agenthost.HistoricalMessage{{
						ID:   "message-1",
						Kind: "text",
						Payload: map[string]any{
							"content": []any{content},
						},
					}},
				}},
			},
			TuttiMode: TuttiReplayTuttiMode{
				Activations:   []TuttiReplayActivation{},
				TurnSnapshots: []TuttiReplayTurnSnapshot{},
			},
			Workflows: []TuttiReplayWorkflow{},
			Issues:    []TuttiReplayIssue{},
		}
	}

	recorded := buildState(map[string]any{
		"type":         "image",
		"mimeType":     "image/png",
		"name":         "r05-image-only.png",
		"attachmentId": "0075df1d-7a65-401f-bba1-8524f5de040b",
	})
	sharedReplay := buildState(map[string]any{
		"type":     "image",
		"mimeType": "image/png",
		"name":     "r05-image-only.png",
		"assetId":  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"url":      "https://example.com/object-uploads/image.png",
		"uri":      "asset://shared/image.png",
	})
	if err := CompareTuttiReplayState(recorded, sharedReplay); err != nil {
		t.Fatalf(
			"shared object-upload image locators must not conflict with recorded attachmentId, got %v",
			err,
		)
	}
}

func TestCompareTuttiReplayStateIgnoresLiveOnlyComposerSettingsDefaults(
	t *testing.T,
) {
	buildState := func(settings map[string]any) TuttiReplayState {
		return TuttiReplayState{
			SchemaVersion: SchemaVersion,
			Agent: TuttiReplayAgent{
				RootSessionID: "session-1",
				Sessions: []agenthost.HistoricalSession{{
					ID:                "session-1",
					Kind:              "root",
					AgentTargetID:     "local:codex",
					Provider:          "codex",
					ProviderSessionID: "provider-session-1",
					Settings:          settings,
				}},
			},
			TuttiMode: TuttiReplayTuttiMode{
				Activations:   []TuttiReplayActivation{},
				TurnSnapshots: []TuttiReplayTurnSnapshot{},
			},
			Workflows: []TuttiReplayWorkflow{},
			Issues:    []TuttiReplayIssue{},
		}
	}

	expected := buildState(map[string]any{
		"model":            "gpt-5.3-codex-spark",
		"permissionModeId": "read-only",
		"planMode":         false,
		"reasoningEffort":  "medium",
	})
	actual := buildState(map[string]any{
		"codexSaverMode":   false,
		"futureDefaultOff": false,
		"model":            "gpt-5.3-codex-spark",
		"permissionModeId": "read-only",
		"planMode":         false,
		"reasoningEffort":  "medium",
		"speed":            "standard",
	})
	if err := CompareTuttiReplayState(expected, actual); err != nil {
		t.Fatalf(
			"live-only composer defaults must match recorded settings, got %v",
			err,
		)
	}
	if !composerSettingsEqual(actual.Agent.Sessions[0].Settings, expected.Agent.Sessions[0].Settings) {
		t.Fatal("final compare and settings.equal must share composer contract")
	}

	err := CompareTuttiReplayState(
		buildState(map[string]any{
			"codexSaverMode": true,
			"model":          "gpt-5.3-codex-spark",
		}),
		buildState(map[string]any{
			"codexSaverMode": false,
			"model":          "gpt-5.3-codex-spark",
		}),
	)
	if err == nil {
		t.Fatal("explicit non-default composer setting must still fail compare")
	}
	var conflict *TuttiReplayStateConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("expected TuttiReplayStateConflictError, got %v", err)
	}
	if conflict.Path != "$.agent.sessions[0].settings.codexSaverMode" {
		t.Fatalf("conflict path = %q", conflict.Path)
	}
}

func TestCompareTuttiReplayStateIgnoresVolatileGoalTimingFields(
	t *testing.T,
) {
	buildState := func(
		desiredStartedAt, observedStartedAt, durationMs int64,
	) TuttiReplayState {
		return TuttiReplayState{
			SchemaVersion: SchemaVersion,
			Agent: TuttiReplayAgent{
				RootSessionID: "session-1",
				Sessions: []agenthost.HistoricalSession{{
					ID:                "session-1",
					Kind:              "root",
					AgentTargetID:     "local:claude-code",
					Provider:          "claude-code",
					ProviderSessionID: "provider-session-1",
					Goal: &agenthost.HistoricalGoal{
						Desired: map[string]any{
							"objective":       "count to three",
							"status":          "active",
							"startedAtUnixMs": desiredStartedAt,
						},
						Observed: map[string]any{
							"objective":       "count to three",
							"status":          "complete",
							"reason":          "done",
							"startedAtUnixMs": observedStartedAt,
							"durationMs":      durationMs,
							"iterations":      1,
						},
						Revision:   1,
						SyncStatus: "synced",
						LastEvidence: map[string]any{
							"confidence": "provider_observed",
						},
					},
				}},
			},
			TuttiMode: TuttiReplayTuttiMode{
				Activations:   []TuttiReplayActivation{},
				TurnSnapshots: []TuttiReplayTurnSnapshot{},
			},
			Workflows: []TuttiReplayWorkflow{},
			Issues:    []TuttiReplayIssue{},
		}
	}

	if err := CompareTuttiReplayState(
		buildState(1_000, 1_001, 50),
		buildState(9_000, 9_500, 999),
	); err != nil {
		t.Fatalf(
			"Goal startedAtUnixMs/durationMs must be ignored for compare, got %v",
			err,
		)
	}

	err := CompareTuttiReplayState(
		buildState(1_000, 1_001, 50),
		func() TuttiReplayState {
			state := buildState(9_000, 9_500, 999)
			state.Agent.Sessions[0].Goal.Observed["status"] = "active"
			return state
		}(),
	)
	if err == nil {
		t.Fatal("Goal status mismatch must still fail comparison")
	}
	var conflict *TuttiReplayStateConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("expected TuttiReplayStateConflictError, got %v", err)
	}
	if conflict.Path != "$.agent.sessions[0].goal.observed.status" {
		t.Fatalf("conflict path = %q", conflict.Path)
	}
}

func TestCompareTuttiReplayStateCanonicalizesAddedFileChangeBodies(
	t *testing.T,
) {
	buildState := func(fileChanges map[string]any) TuttiReplayState {
		return TuttiReplayState{
			SchemaVersion: SchemaVersion,
			Agent: TuttiReplayAgent{
				RootSessionID: "session-1",
				Sessions: []agenthost.HistoricalSession{{
					ID:                "session-1",
					Kind:              "root",
					AgentTargetID:     "local:codex",
					Provider:          "codex",
					ProviderSessionID: "provider-session-1",
					Turns: []agenthost.HistoricalTurn{{
						ID:          "turn-1",
						Phase:       "settled",
						Outcome:     "completed",
						Origin:      "user_prompt",
						FileChanges: fileChanges,
					}},
				}},
			},
			TuttiMode: TuttiReplayTuttiMode{
				Activations:   []TuttiReplayActivation{},
				TurnSnapshots: []TuttiReplayTurnSnapshot{},
			},
			Workflows: []TuttiReplayWorkflow{},
			Issues:    []TuttiReplayIssue{},
		}
	}
	recorded := buildState(map[string]any{
		"files": []any{map[string]any{
			"path":        "${REPLAY_CWD}/notes.md",
			"change":      "added",
			"diff":        "R36_NOTES_BODY",
			"unifiedDiff": "R36_NOTES_BODY",
		}},
	})
	live := buildState(map[string]any{
		"files": []any{map[string]any{
			"path":      "${REPLAY_CWD}/notes.md",
			"change":    "added",
			"newString": "R36_NOTES_BODY\n",
		}},
	})
	if err := CompareTuttiReplayState(recorded, live); err != nil {
		t.Fatalf(
			"added-file bodies under obsolete diff must match live newString, got %v",
			err,
		)
	}
}

func TestCompareTuttiReplayStateCanonicalizesModifiedFileChangeBodies(
	t *testing.T,
) {
	buildState := func(fileChanges map[string]any) TuttiReplayState {
		return TuttiReplayState{
			SchemaVersion: SchemaVersion,
			Agent: TuttiReplayAgent{
				RootSessionID: "session-1",
				Sessions: []agenthost.HistoricalSession{{
					ID:                "session-1",
					Kind:              "root",
					AgentTargetID:     "local:codex",
					Provider:          "codex",
					ProviderSessionID: "provider-session-1",
					Turns: []agenthost.HistoricalTurn{{
						ID:          "turn-1",
						Phase:       "settled",
						Outcome:     "completed",
						Origin:      "user_prompt",
						FileChanges: fileChanges,
					}},
				}},
			},
			TuttiMode: TuttiReplayTuttiMode{
				Activations:   []TuttiReplayActivation{},
				TurnSnapshots: []TuttiReplayTurnSnapshot{},
			},
			Workflows: []TuttiReplayWorkflow{},
			Issues:    []TuttiReplayIssue{},
		}
	}
	recorded := buildState(map[string]any{
		"files": []any{map[string]any{
			"path":        "${REPLAY_CWD}/one.txt",
			"change":      "modified",
			"diff":        "R14_ONE_UPDATED",
			"unifiedDiff": "R14_ONE_UPDATED",
		}},
	})
	live := buildState(map[string]any{
		"files": []any{map[string]any{
			"path":      "${REPLAY_CWD}/one.txt",
			"change":    "modified",
			"newString": "R14_ONE_UPDATED\n",
		}},
	})
	if err := CompareTuttiReplayState(recorded, live); err != nil {
		t.Fatalf(
			"modified-file bodies under obsolete diff must match live newString, got %v",
			err,
		)
	}
}

func TestCompareTuttiReplayStateTreatsToolCallIDsAsAlphaEquivalent(
	t *testing.T,
) {
	buildState := func(callID string) TuttiReplayState {
		return TuttiReplayState{
			SchemaVersion: SchemaVersion,
			Agent: TuttiReplayAgent{
				RootSessionID: "session-1",
				Sessions: []agenthost.HistoricalSession{{
					ID:                "session-1",
					Kind:              "root",
					AgentTargetID:     "local:claude-code",
					Provider:          "claude-code",
					ProviderSessionID: "provider-session-1",
					Messages: []agenthost.HistoricalMessage{{
						ID:     "toolcall:" + callID,
						Role:   "assistant",
						Kind:   "tool_call",
						Status: "completed",
						Payload: map[string]any{
							"callId":   callID,
							"callType": "function",
							"name":     "Bash",
							"provider": "claude-code",
						},
					}},
				}},
			},
			TuttiMode: TuttiReplayTuttiMode{
				Activations:   []TuttiReplayActivation{},
				TurnSnapshots: []TuttiReplayTurnSnapshot{},
			},
			Workflows: []TuttiReplayWorkflow{},
			Issues:    []TuttiReplayIssue{},
		}
	}
	if err := CompareTuttiReplayState(
		buildState("approval:recorded-call"),
		buildState("approval:replayed-call"),
	); err != nil {
		t.Fatalf("tool_call callId must be alpha-equivalent, got %v", err)
	}
}

func TestCompareTuttiReplayStateCanonicalizesTerminalCommandOutputAliases(
	t *testing.T,
) {
	buildState := func(text *string) TuttiReplayState {
		output := map[string]any{"stdout": "command output\n"}
		if text != nil {
			output["text"] = *text
		}
		return TuttiReplayState{
			SchemaVersion: SchemaVersion,
			Agent: TuttiReplayAgent{
				RootSessionID: "session-1",
				Sessions: []agenthost.HistoricalSession{{
					ID:                "session-1",
					Kind:              "root",
					AgentTargetID:     "local:codex",
					Provider:          "codex",
					ProviderSessionID: "provider-session-1",
					Messages: []agenthost.HistoricalMessage{{
						ID:     "toolcall:call-1",
						Role:   "assistant",
						Kind:   "tool_call",
						Status: "completed",
						Payload: map[string]any{
							"callId":   "call-1",
							"toolName": "exec_command",
							"input":    map[string]any{"command": "printf output"},
							"output":   output,
						},
					}},
				}},
			},
			TuttiMode: TuttiReplayTuttiMode{
				Activations:   []TuttiReplayActivation{},
				TurnSnapshots: []TuttiReplayTurnSnapshot{},
			},
			Workflows: []TuttiReplayWorkflow{},
			Issues:    []TuttiReplayIssue{},
		}
	}

	reconstructible := "command output"
	if err := CompareTuttiReplayState(
		buildState(&reconstructible),
		buildState(nil),
	); err != nil {
		t.Fatalf("reconstructible command text alias must compare equal: %v", err)
	}

	distinct := "formatted command output"
	if err := CompareTuttiReplayState(
		buildState(&distinct),
		buildState(nil),
	); !errors.Is(err, ErrTuttiReplayStateConflict) {
		t.Fatalf("distinct command text must remain semantic, got %v", err)
	}
}

func TestCompareTuttiReplayStateCanonicalizesNestedAndBudgetedCommandOutput(
	t *testing.T,
) {
	buildState := func(status string, payload map[string]any) TuttiReplayState {
		return TuttiReplayState{
			SchemaVersion: SchemaVersion,
			Agent: TuttiReplayAgent{
				RootSessionID: "session-1",
				Sessions: []agenthost.HistoricalSession{{
					ID:                "session-1",
					Kind:              "root",
					AgentTargetID:     "local:codex",
					Provider:          "codex",
					ProviderSessionID: "provider-session-1",
					Messages: []agenthost.HistoricalMessage{{
						ID:      "toolcall:call-1",
						Role:    "assistant",
						Kind:    "tool_call",
						Status:  status,
						Payload: payload,
					}},
				}},
			},
			TuttiMode: TuttiReplayTuttiMode{
				Activations:   []TuttiReplayActivation{},
				TurnSnapshots: []TuttiReplayTurnSnapshot{},
			},
			Workflows: []TuttiReplayWorkflow{},
			Issues:    []TuttiReplayIssue{},
		}
	}

	nestedPayload := func(includeAlias bool) map[string]any {
		body := map[string]any{"stdout": "nested output\n"}
		if includeAlias {
			body["text"] = "nested output"
		}
		return map[string]any{
			"toolName": "Task",
			"steps": []any{map[string]any{
				"status":   "running",
				"toolName": "Task",
				"toolResult": map[string]any{"steps": []any{
					map[string]any{
						"status":     "completed",
						"toolName":   "Bash",
						"toolInput":  map[string]any{"command": "printf nested"},
						"toolResult": body,
					},
				}},
			}},
		}
	}
	if err := CompareTuttiReplayState(
		buildState("running", nestedPayload(true)),
		buildState("running", nestedPayload(false)),
	); err != nil {
		t.Fatalf("nested terminal command alias must compare equal: %v", err)
	}

	stream := strings.Repeat("x", canonical.ToolCallPayloadMaxBytes) + "\n"
	rawPayload := map[string]any{
		"toolName": "Bash",
		"input":    map[string]any{"command": "generate output"},
		"output": map[string]any{
			"text":   strings.TrimSpace(stream),
			"stdout": stream,
		},
	}
	budgetedPayload := map[string]any{
		"toolName": "Bash",
		"input":    map[string]any{"command": "generate output"},
		"output":   map[string]any{"stdout": stream},
	}
	if _, fits := canonical.FitToolCallPayloadOutputBudget(
		budgetedPayload,
		canonical.ToolCallPayloadMaxBytes,
	); !fits {
		t.Fatal("expected comparison fixture to fit aggregate payload budget")
	}
	if err := CompareTuttiReplayState(
		buildState("completed", rawPayload),
		buildState("completed", budgetedPayload),
	); err != nil {
		t.Fatalf("pre-budget cassette output must compare equal: %v", err)
	}
}

func TestCompareTuttiReplayStateTreatsInteractionToolCallIDsAsAlphaEquivalent(
	t *testing.T,
) {
	buildState := func(requestID, toolCallID string) TuttiReplayState {
		return TuttiReplayState{
			SchemaVersion: SchemaVersion,
			Agent: TuttiReplayAgent{
				RootSessionID: "session-0",
				Sessions: []agenthost.HistoricalSession{{
					ID:                "session-0",
					Kind:              "root",
					AgentTargetID:     "local:claude-code",
					Provider:          "claude-code",
					ProviderSessionID: "provider-session-0",
				}, {
					ID:                "session-1",
					Kind:              "child",
					RootSessionID:     "session-0",
					ParentSessionID:   "session-0",
					AgentTargetID:     "local:claude-code",
					Provider:          "claude-code",
					ProviderSessionID: "provider-session-1",
					Interactions: []agenthost.HistoricalInteraction{{
						RequestID: requestID,
						TurnID:    "turn-1",
						Kind:      "approval",
						Status:    "answered",
						ToolName:  "Bash",
						Input: map[string]any{
							"toolCall": map[string]any{
								"name":       "Bash",
								"toolName":   "Bash",
								"toolCallId": toolCallID,
								"title":      "echo hi",
							},
						},
						Output:   map[string]any{},
						Metadata: map[string]any{},
					}},
				}},
			},
			TuttiMode: TuttiReplayTuttiMode{
				Activations:   []TuttiReplayActivation{},
				TurnSnapshots: []TuttiReplayTurnSnapshot{},
			},
			Workflows: []TuttiReplayWorkflow{},
			Issues:    []TuttiReplayIssue{},
		}
	}
	if err := CompareTuttiReplayState(
		buildState("req-recorded", "call_recorded"),
		buildState("req-replayed", "call_replayed"),
	); err != nil {
		t.Fatalf(
			"interaction toolCallId must be alpha-equivalent, got %v",
			err,
		)
	}
}
