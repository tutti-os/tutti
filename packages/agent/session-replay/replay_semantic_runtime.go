package sessionreplay

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
)

type SemanticRegistration struct {
	CassetteID    string
	RootSessionID string
	WorkspaceID   string
}

type SemanticCassetteSource interface {
	ReadSemanticCassette(
		context.Context,
		string,
	) (SemanticCassetteArtifact, error)
}

type SemanticWorkspaceStore interface {
	ReplayWorkspaceExists(context.Context, string) (bool, error)
	Create(context.Context, ReplayScopeSummary) error
	PutWorkbenchSnapshot(context.Context, ReplayWorkbenchSnapshot) error
	RestoreTuttiReplayProductState(
		context.Context,
		string,
		TuttiReplayMergedState,
	) error
	CaptureTuttiReplayStateWithAgent(
		context.Context,
		string,
		agenthost.HistoricalSessionGraph,
	) (TuttiReplayState, error)
}

type SemanticRuntime struct {
	host          *agenthost.Host
	store         SemanticWorkspaceStore
	workspaceID   string
	registrations map[string]SemanticRegistration
	plans         map[string]CheckpointPlan
	expected      map[string]TuttiReplayState
	// expectedBindings holds the expected Agent graphs with portable Session
	// binding paths (cwd, rail project path, rail section key) resolved against
	// the replay runtime cwd. Checkpoint readiness compares them against
	// canonical Sessions, whose binding paths are always absolute; the portable
	// form in `expected` stays reserved for final-state comparison.
	expectedBindings map[string]agenthost.HistoricalSessionGraph
	observations     map[string]*semanticObservationState
	mu               sync.Mutex
}

func PrepareSemanticRuntime(
	ctx context.Context,
	store SemanticWorkspaceStore,
	host *agenthost.Host,
	reader SemanticCassetteSource,
	registrations []SemanticRegistration,
) (*SemanticRuntime, error) {
	if len(registrations) == 0 {
		return nil, nil
	}
	if store == nil || host == nil || reader == nil {
		return nil, errors.New("agent session replay semantic runtime is unavailable")
	}
	byID := make(map[string]SemanticRegistration, len(registrations))
	plans := make(map[string]CheckpointPlan, len(registrations))
	expectedStates := make(
		map[string]TuttiReplayState,
		len(registrations),
	)
	expectedBindings := make(
		map[string]agenthost.HistoricalSessionGraph,
		len(registrations),
	)
	observationStates := make(
		map[string]*semanticObservationState,
		len(registrations),
	)
	// The replay runner resolves portable `${REPLAY_CWD}` activity payloads
	// against the repository workspace root and passes the same anchor through
	// TUTTI_AGENT_SESSION_REPLAY_CWD. The daemon process cwd is only a
	// fallback: desktop launchers may start tuttid from a different directory
	// (for example `apps/desktop`), which would desynchronize the two anchors.
	replayCWD := strings.TrimSpace(
		os.Getenv("TUTTI_AGENT_SESSION_REPLAY_CWD"),
	)
	if replayCWD == "" {
		var err error
		replayCWD, err = os.Getwd()
		if err != nil {
			return nil, fmt.Errorf("resolve Replay runtime cwd: %w", err)
		}
	}
	initialStates := make([]TuttiReplayState, 0, len(registrations))
	workspaceID := ""
	for _, registration := range registrations {
		registration.CassetteID = strings.TrimSpace(registration.CassetteID)
		registration.RootSessionID = strings.TrimSpace(registration.RootSessionID)
		registration.WorkspaceID = strings.TrimSpace(registration.WorkspaceID)
		if registration.CassetteID == "" || registration.RootSessionID == "" ||
			registration.WorkspaceID == "" {
			return nil, errors.New(
				"agent session replay registration requires cassette, root Session, and Workspace",
			)
		}
		if workspaceID == "" {
			workspaceID = registration.WorkspaceID
		} else if workspaceID != registration.WorkspaceID {
			return nil, errors.New("agent session replay registrations must share one Workspace")
		}
		if _, duplicate := byID[registration.CassetteID]; duplicate {
			return nil, fmt.Errorf("duplicate Agent Session Replay cassette %q", registration.CassetteID)
		}
		artifact, err := reader.ReadSemanticCassette(ctx, registration.CassetteID)
		if err != nil {
			return nil, fmt.Errorf("load Replay Cassette %q: %w", registration.CassetteID, err)
		}
		manifest := artifact.Manifest
		if manifest.ID != registration.CassetteID ||
			manifest.RootSessionID != registration.RootSessionID {
			return nil, fmt.Errorf(
				"agent session replay registration %q does not match cassette identity",
				registration.CassetteID,
			)
		}
		if manifest.Mode == ScenarioModeContinueSession {
			if artifact.InitialState == nil {
				return nil, fmt.Errorf(
					"replay Cassette %q is missing initial state",
					registration.CassetteID,
				)
			}
			state := *artifact.InitialState
			if state.Agent.RootSessionID != registration.RootSessionID {
				return nil, fmt.Errorf(
					"replay cassette %q initial-state root Session mismatch",
					registration.CassetteID,
				)
			}
			initialStates = append(initialStates, state)
		}
		// Expected state stays in its portable form for final comparison. The
		// captured actual state is projected to the same form before Compare.
		expected := artifact.ExpectedState
		plan := artifact.CheckpointPlan
		byID[registration.CassetteID] = registration
		plans[registration.CassetteID] = plan
		expectedStates[registration.CassetteID] = expected
		// Checkpoint readiness (session settings and project binding) compares
		// expected Sessions against canonical Sessions whose binding paths are
		// absolute, so resolve the portable form once per Cassette here.
		expectedBindings[registration.CassetteID], err =
			ResolvePortableAgentState(expected.Agent, replayCWD)
		if err != nil {
			return nil, fmt.Errorf(
				"resolve Replay Cassette %q expected binding: %w",
				registration.CassetteID,
				err,
			)
		}
		observationState := newSemanticObservationState(
			plan,
			registration.RootSessionID,
			artifact.InitialStateRaw,
		)
		if observationState.failure != nil {
			return nil, fmt.Errorf(
				"seed Replay Cassette %q entity addresses: %w",
				registration.CassetteID,
				observationState.failure,
			)
		}
		observationStates[registration.CassetteID] = observationState
	}
	merged, err := MergeTuttiReplayStates(initialStates)
	if err != nil {
		return nil, fmt.Errorf("merge Agent Session Replay initial states: %w", err)
	}
	for index := range merged.Agents {
		merged.Agents[index], err = ResolvePortableAgentState(
			merged.Agents[index],
			replayCWD,
		)
		if err != nil {
			return nil, fmt.Errorf(
				"resolve Agent Session Replay initial binding: %w",
				err,
			)
		}
	}
	exists, err := store.ReplayWorkspaceExists(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	if exists {
		return nil, fmt.Errorf("agent session replay Workspace %q already exists", workspaceID)
	}
	if err := store.Create(ctx, ReplayScopeSummary{
		ID: workspaceID, Name: "Agent Session Replay",
	}); err != nil {
		return nil, fmt.Errorf("create Agent Session Replay Workspace: %w", err)
	}
	if err := store.PutWorkbenchSnapshot(
		ctx,
		replayWorkbenchSnapshot(workspaceID, time.Now().UTC()),
	); err != nil {
		return nil, fmt.Errorf("initialize Agent Session Replay Workbench: %w", err)
	}
	for _, graph := range merged.Agents {
		if err := host.RestoreHistoricalSessionGraph(ctx, workspaceID, graph); err != nil {
			return nil, fmt.Errorf(
				"restore Agent Session Replay root %q: %w",
				graph.RootSessionID,
				err,
			)
		}
	}
	if err := store.RestoreTuttiReplayProductState(ctx, workspaceID, merged); err != nil {
		return nil, err
	}
	return &SemanticRuntime{
		host: host, store: store, workspaceID: workspaceID, registrations: byID,
		plans: plans, expected: expectedStates,
		expectedBindings: expectedBindings, observations: observationStates,
	}, nil
}

func replayWorkbenchSnapshot(
	workspaceID string,
	autoOpenedAt time.Time,
) ReplayWorkbenchSnapshot {
	snapshot := map[string]any{
		"schemaVersion": 1,
		"nodes":         []any{},
		"nodeStack":     []any{},
		"activeNodeId":  nil,
		"metadata": map[string]any{
			"workspaceOnboarding": map[string]any{
				"autoOpened":    true,
				"autoOpenedAt":  autoOpenedAt.Format(time.RFC3339Nano),
				"schemaVersion": 1,
			},
		},
	}
	raw, err := json.Marshal(snapshot)
	if err != nil {
		panic(err)
	}
	return ReplayWorkbenchSnapshot{
		WorkspaceID:   workspaceID,
		SchemaVersion: 1,
		JSON:          raw,
	}
}

func (r *SemanticRuntime) Verify(
	ctx context.Context,
	cassetteID string,
) error {
	if r == nil {
		return errors.New("agent session replay semantic verification is unavailable")
	}
	registration, ok := r.registrations[strings.TrimSpace(cassetteID)]
	if !ok {
		return fmt.Errorf("unknown agent Session Replay cassette %q", cassetteID)
	}
	expected, ok := r.expected[registration.CassetteID]
	if !ok {
		return fmt.Errorf(
			"replay Cassette %q expected state is unavailable",
			registration.CassetteID,
		)
	}
	actualAgent, err := r.host.CaptureHistoricalSessionGraph(ctx, agenthost.SessionRef{
		WorkspaceID: r.workspaceID, AgentSessionID: registration.RootSessionID,
	})
	if err != nil {
		return err
	}
	actual, err := r.store.CaptureTuttiReplayStateWithAgent(
		ctx,
		r.workspaceID,
		actualAgent,
	)
	if err != nil {
		return err
	}
	return CompareTuttiReplayState(expected, actual)
}
