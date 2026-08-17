package sessionreplay

import (
	"context"
	"path/filepath"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func TestProviderPositionReachedIncludesTriggerUnit(t *testing.T) {
	position := &ProviderObservationPosition{
		ConnectionID: "connection-1", ChunkSeq: 56, UnitIndex: 1, EventIndex: 1,
	}
	handled := map[string]ProviderUnitPosition{
		"connection-1": {
			ConnectionID: "connection-1", ChunkSeq: 56, UnitIndex: 1,
		},
	}
	if !providerPositionReached(handled, position) {
		t.Fatal("handled at trigger unit must count as reached")
	}
	if providerPositionPassed(handled, position) {
		t.Fatal("handled at trigger unit must not count as passed")
	}
	handled["connection-1"] = ProviderUnitPosition{
		ConnectionID: "connection-1", ChunkSeq: 57, UnitIndex: 1,
	}
	if !providerPositionReached(handled, position) ||
		!providerPositionPassed(handled, position) {
		t.Fatal("handled past trigger unit must be reached and passed")
	}
}

func TestHandledLaneClosesProviderObservationTriggerWithoutStamp(
	t *testing.T,
) {
	position := ProviderObservationPosition{
		ConnectionID: "connection-1",
		ChunkSeq:     56,
		UnitIndex:    1,
		EventIndex:   1,
	}
	fingerprint, err := ObservationFingerprint(ProviderObservation{
		SchemaVersion: ObservationSchemaVersion,
		Type:          "root_provider_turn.started",
		Address: EntityAddress{
			Kind: EntityKindTurn,
			Origin: EntityOrigin{
				Source:              EntityOriginProviderObservation,
				ProviderObservation: &position,
			},
		},
		Stable: map[string]any{"turnPhase": "running"},
	})
	if err != nil {
		t.Fatal(err)
	}
	runtime := &SemanticRuntime{
		workspaceID: "workspace-1",
		registrations: map[string]SemanticRegistration{
			"cassette-1": {
				CassetteID: "cassette-1", RootSessionID: "session-1",
				WorkspaceID: "workspace-1",
			},
		},
		plans: map[string]CheckpointPlan{
			"cassette-1": NewCheckpointPlan(
				[]ReplayCheckpoint{{
					ID: "checkpoint-0004", Index: 0,
					Kind: "turn.working", Tags: []string{"turn.working"},
					Trigger: CheckpointTrigger{
						Source:      CheckpointTriggerProviderObservation,
						Position:    &position,
						UnitKind:    ProviderInputUnitProtocolMessage,
						Type:        "root_provider_turn.started",
						Fingerprint: fingerprint,
					},
					// Empty readiness isolates the handled-lane trigger path
					// from Host canonical lookups.
					Readiness: CheckpointReadiness{All: []ReadinessPredicate{}},
				}},
			),
		},
		observations: map[string]*semanticObservationState{
			"cassette-1": {
				matched: map[int]bool{},
				handled: map[string]ProviderUnitPosition{},
			},
		},
	}
	state, err := runtime.VerifyCheckpoint(
		context.Background(), "cassette-1", 0,
	)
	if err != nil || state.TriggerMatched {
		t.Fatalf("before handled lane: state=%#v err=%v", state, err)
	}
	runtime.NoteHandledProviderUnits("cassette-1", map[string]ProviderUnitPosition{
		"connection-1": {
			ConnectionID: "connection-1", ChunkSeq: 56, UnitIndex: 1,
		},
	})
	state, err = runtime.VerifyCheckpoint(
		context.Background(), "cassette-1", 0,
	)
	if err != nil || !state.TriggerMatched || !state.ReadinessSatisfied {
		t.Fatalf(
			"handled lane should close observation trigger: state=%#v err=%v",
			state,
			err,
		)
	}
}

func TestHandledLanePastTriggerWithoutMatchIsOutOfOrder(t *testing.T) {
	position := ProviderObservationPosition{
		ConnectionID: "connection-1",
		ChunkSeq:     56,
		UnitIndex:    1,
		EventIndex:   1,
	}
	runtime := &SemanticRuntime{
		workspaceID: "workspace-1",
		registrations: map[string]SemanticRegistration{
			"cassette-1": {
				CassetteID: "cassette-1", RootSessionID: "session-1",
				WorkspaceID: "workspace-1",
			},
		},
		plans: map[string]CheckpointPlan{
			"cassette-1": NewCheckpointPlan(
				[]ReplayCheckpoint{{
					ID: "checkpoint-0004", Index: 0,
					Kind: "turn.working",
					Trigger: CheckpointTrigger{
						Source:   CheckpointTriggerProviderObservation,
						Position: &position,
						UnitKind: ProviderInputUnitProtocolMessage,
						Type:     "root_provider_turn.started",
						Fingerprint: "sha256:" +
							"0123456789abcdef0123456789abcdef" +
							"0123456789abcdef0123456789abcdef",
					},
					Readiness: CheckpointReadiness{
						All: []ReadinessPredicate{},
					},
				}},
			),
		},
		observations: map[string]*semanticObservationState{
			"cassette-1": {
				matched: map[int]bool{},
				handled: map[string]ProviderUnitPosition{},
			},
		},
	}
	runtime.NoteHandledProviderUnits("cassette-1", map[string]ProviderUnitPosition{
		"connection-1": {
			ConnectionID: "connection-1", ChunkSeq: 57, UnitIndex: 1,
		},
	})
	_, err := runtime.VerifyCheckpoint(context.Background(), "cassette-1", 0)
	if err == nil || err.Error() !=
		`checkpoint_trigger_out_of_order: checkpoint "checkpoint-0004"` {
		t.Fatalf("error = %v, want out_of_order", err)
	}
}

func TestNeutralBootstrapCheckpointNeedsNoCanonicalSession(t *testing.T) {
	runtime := &SemanticRuntime{
		plans: map[string]CheckpointPlan{
			"cassette-1": NewCheckpointPlan(
				[]ReplayCheckpoint{{
					ID: "checkpoint-0000", Index: 0,
					Kind: "replay.bootstrap", Tags: []string{"replay.bootstrap"},
					Trigger: CheckpointTrigger{
						Source: CheckpointTriggerBootstrap,
					},
					Readiness: CheckpointReadiness{
						All: []ReadinessPredicate{},
					},
				}},
			),
		},
	}
	state, err := runtime.VerifyCheckpoint(
		context.Background(),
		"cassette-1",
		0,
	)
	if err != nil || !state.TriggerMatched || !state.ReadinessSatisfied {
		t.Fatalf("bootstrap state=%#v error=%v", state, err)
	}
}

func TestCanonicalTurnPhaseFoldsActivityVocabulary(t *testing.T) {
	tests := map[string]string{
		"working":            storesqlite.TurnPhaseRunning,
		"streaming":          storesqlite.TurnPhaseRunning,
		"waiting_approval":   storesqlite.TurnPhaseWaiting,
		"awaiting_approval":  storesqlite.TurnPhaseWaiting,
		"waiting_input":      storesqlite.TurnPhaseWaiting,
		" waiting_approval ": storesqlite.TurnPhaseWaiting,
		"running":            storesqlite.TurnPhaseRunning,
		"waiting":            storesqlite.TurnPhaseWaiting,
		"submitted":          storesqlite.TurnPhaseSubmitted,
		"settling":           storesqlite.TurnPhaseSettling,
		"settled":            storesqlite.TurnPhaseSettled,
		"idle":               storesqlite.TurnPhaseSettled,
	}
	for recorded, want := range tests {
		if got := canonicalTurnPhase(recorded); got != want {
			t.Fatalf(
				"canonicalTurnPhase(%q) = %q, want %q",
				recorded,
				got,
				want,
			)
		}
	}
}

func TestCanonicalCallStatusFoldsActivityVocabulary(t *testing.T) {
	tests := map[string]string{
		"running":           "running",
		"working":           "running",
		"streaming":         "running",
		"in_progress":       "running",
		"pending":           "running",
		"waiting_approval":  "running",
		"awaiting_approval": "running",
		"waiting_input":     "running",
		" streaming ":       "running",
		"completed":         "completed",
		"failed":            "failed",
	}
	for recorded, want := range tests {
		if got := canonicalCallStatus(recorded); got != want {
			t.Fatalf(
				"canonicalCallStatus(%q) = %q, want %q",
				recorded,
				got,
				want,
			)
		}
	}
}

func TestSemanticTurnStateMatchesTerminalActivityPhase(t *testing.T) {
	if !semanticTurnStateMatches(
		storesqlite.TurnPhaseSettled,
		storesqlite.TurnOutcomeCompleted,
		"idle",
		storesqlite.TurnOutcomeCompleted,
	) {
		t.Fatal("canonical settled Turn should match activity-layer terminal idle")
	}
}

func TestSemanticTurnStateMatchesFoldsWorkingToRunning(t *testing.T) {
	if !semanticTurnStateMatches(
		storesqlite.TurnPhaseRunning,
		"",
		"working",
		"",
	) {
		t.Fatal("canonical running should match activity-layer working")
	}
	if !semanticRootProviderTurnMatches(
		storesqlite.RootProviderTurnPhaseRunning,
		"",
		"working",
		"",
	) {
		t.Fatal("root-provider running should match activity-layer working")
	}
}

func TestProjectBindingMatchesCanonicalCWDAndRailPlacement(t *testing.T) {
	actual := storesqlite.Session{
		AgentTargetID:   "local:codex",
		Provider:        "codex",
		Cwd:             "/runtime/repo",
		RailSectionKind: storesqlite.RailSectionKindProject,
		RailProjectPath: "/runtime/repo/packages/agent",
		RailSectionKey:  "project:/runtime/repo/packages/agent",
	}
	expected := agenthost.HistoricalSession{
		AgentTargetID:   actual.AgentTargetID,
		Provider:        actual.Provider,
		Cwd:             actual.Cwd,
		RailSectionKind: actual.RailSectionKind,
		RailProjectPath: actual.RailProjectPath,
		RailSectionKey:  actual.RailSectionKey,
	}
	if !projectBindingMatches(actual, expected) {
		t.Fatal("matching project binding was rejected")
	}
	tests := map[string]func(*agenthost.HistoricalSession){
		"cwd": func(value *agenthost.HistoricalSession) {
			value.Cwd = "/runtime/other"
		},
		"rail kind": func(value *agenthost.HistoricalSession) {
			value.RailSectionKind = storesqlite.RailSectionKindConversations
		},
		"project path": func(value *agenthost.HistoricalSession) {
			value.RailProjectPath = "/runtime/repo/packages/other"
		},
		"section key": func(value *agenthost.HistoricalSession) {
			value.RailSectionKey = "project:/runtime/repo/packages/other"
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			mismatched := expected
			mutate(&mismatched)
			if projectBindingMatches(actual, mismatched) {
				t.Fatalf("%s mismatch was accepted", name)
			}
		})
	}
}

func TestProjectBindingMatchesSharedWorkspaceRemappedCWD(t *testing.T) {
	expected := agenthost.HistoricalSession{
		AgentTargetID:   "local:codex",
		Provider:        "codex",
		Cwd:             "/workspace/agent-session-replay",
		RailSectionKind: storesqlite.RailSectionKindProject,
		RailProjectPath: "/workspace/agent-session-replay",
		RailSectionKey:  "project:/workspace/agent-session-replay",
	}
	actual := storesqlite.Session{
		AgentTargetID:   expected.AgentTargetID,
		Provider:        expected.Provider,
		Cwd:             "/workspace/24238bb8-983c-4b0e-a516-e9719ab7ea5c/agent-session-replay",
		RailSectionKind: expected.RailSectionKind,
		RailProjectPath: expected.RailProjectPath,
		RailSectionKey:  expected.RailSectionKey,
	}
	if !projectBindingMatches(actual, expected) {
		t.Fatal("shared confined cwd remapping should match recorded project binding")
	}
	actual.Cwd = "/workspace/other-room/other-project"
	if projectBindingMatches(actual, expected) {
		t.Fatal("unrelated remapped cwd must not match")
	}
}

func TestProjectBindingMatchesNormalizesRailSectionKeySymlinks(t *testing.T) {
	rawDir := t.TempDir()
	canonicalDir := storesqlite.NormalizeProjectPath(rawDir)
	if canonicalDir == "" || canonicalDir == rawDir {
		t.Skip("temp dir has no symlink path form to exercise")
	}
	actual := storesqlite.Session{
		AgentTargetID:   "local:codex",
		Provider:        "codex",
		Cwd:             rawDir,
		RailSectionKind: storesqlite.RailSectionKindProject,
		RailProjectPath: rawDir,
		RailSectionKey:  "project:" + rawDir,
	}
	expected := agenthost.HistoricalSession{
		AgentTargetID:   actual.AgentTargetID,
		Provider:        actual.Provider,
		Cwd:             canonicalDir,
		RailSectionKind: actual.RailSectionKind,
		RailProjectPath: canonicalDir,
		RailSectionKey:  storesqlite.RailSectionKeyForProject(canonicalDir),
	}
	if !projectBindingMatches(actual, expected) {
		t.Fatalf(
			"symlink-equivalent rail section keys should match: actual=%q expected=%q",
			actual.RailSectionKey,
			expected.RailSectionKey,
		)
	}
}

func TestProjectBindingReadinessResolvesPortableExpectedState(t *testing.T) {
	replayCWD, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	actual := storesqlite.Session{
		AgentTargetID:   "local:codex",
		Provider:        "codex",
		Cwd:             replayCWD,
		RailSectionKind: storesqlite.RailSectionKindProject,
		RailProjectPath: replayCWD,
		RailSectionKey:  storesqlite.RailSectionKeyForProject(replayCWD),
	}
	portable := agenthost.HistoricalSessionGraph{
		RootSessionID: "session-1",
		Sessions: []agenthost.HistoricalSession{{
			ID:              "session-1",
			AgentTargetID:   "local:codex",
			Provider:        "codex",
			Cwd:             PortableReplayCWDToken,
			RailSectionKind: storesqlite.RailSectionKindProject,
			RailProjectPath: PortableReplayCWDToken,
			RailSectionKey:  "project:" + PortableReplayCWDToken,
		}},
	}
	if projectBindingMatches(actual, portable.Sessions[0]) {
		t.Fatal("portable expected binding must not match a canonical Session")
	}
	resolved, err := ResolvePortableAgentState(portable, replayCWD)
	if err != nil {
		t.Fatal(err)
	}
	if !projectBindingMatches(actual, resolved.Sessions[0]) {
		t.Fatalf(
			"resolved expected binding was rejected: %#v",
			resolved.Sessions[0],
		)
	}
}

func TestSemanticGoalStatusUsesPortableCheckpointVocabulary(t *testing.T) {
	tests := map[string]struct {
		state storesqlite.SessionGoalState
		want  string
	}{
		"running": {
			state: storesqlite.SessionGoalState{
				Observed: map[string]any{"status": "active"},
			},
			want: "running",
		},
		"completed": {
			state: storesqlite.SessionGoalState{
				Observed: map[string]any{"status": "complete"},
			},
			want: "completed",
		},
		"cleared": {
			state: storesqlite.SessionGoalState{Tombstoned: true},
			want:  "cleared",
		},
	}
	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			if got := semanticGoalStatus(test.state); got != test.want {
				t.Fatalf("semanticGoalStatus() = %q, want %q", got, test.want)
			}
		})
	}
}
