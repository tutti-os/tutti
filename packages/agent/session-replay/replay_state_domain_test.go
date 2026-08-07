package sessionreplay

import (
	"errors"
	"path/filepath"
	"reflect"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
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
