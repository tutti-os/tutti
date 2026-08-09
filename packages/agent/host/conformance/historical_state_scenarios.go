package conformance

import (
	"context"
	"errors"
	"fmt"
	"reflect"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
)

type HistoricalStateMetrics struct {
	ProviderStartCalls           int
	ProviderResumeCalls          int
	ProviderExecCalls            int
	LastResumeProviderCheckpoint map[string]any
}

// HistoricalStateDriver adapts only the Host historical-state and normal
// resume/send contracts needed by Replay conformance.
type HistoricalStateDriver interface {
	ResetHistoricalState(context.Context) error
	RestoreHistoricalSessionGraph(
		context.Context,
		agenthost.HistoricalSessionGraphRestoreInput,
	) error
	CaptureHistoricalSessionGraph(
		context.Context,
		agenthost.SessionRef,
	) (agenthost.HistoricalSessionGraph, error)
	HistoricalSessionUserID(context.Context, agenthost.SessionRef) (string, error)
	EnsureHistoricalSession(
		context.Context,
		agenthost.SessionRef,
	) error
	SendHistoricalInput(
		context.Context,
		agenthost.SessionRef,
		agenthost.SendInput,
	) error
	HistoricalStateMetrics() HistoricalStateMetrics
}

type HistoricalStateScenario struct {
	Name string
	run  func(context.Context, HistoricalStateDriver) error
}

func HistoricalStateScenarios() []HistoricalStateScenario {
	return []HistoricalStateScenario{{
		Name: "restore settled historical graph before resume and send",
		run:  runRestoreHistoricalSessionGraph,
	}}
}

func RunHistoricalState(
	ctx context.Context,
	driver HistoricalStateDriver,
	scenario HistoricalStateScenario,
) error {
	if driver == nil {
		return fmt.Errorf("historical Agent state conformance driver is required")
	}
	if scenario.run == nil {
		return fmt.Errorf("historical Agent state scenario %q has no runner", scenario.Name)
	}
	return scenario.run(ctx, driver)
}

func runRestoreHistoricalSessionGraph(
	ctx context.Context,
	driver HistoricalStateDriver,
) error {
	if err := driver.ResetHistoricalState(ctx); err != nil {
		return err
	}
	graph := historicalStateScenarioGraph()
	const workspaceID = "historical-state-workspace"
	const userID = "historical-state-user"
	restoreInput := agenthost.HistoricalSessionGraphRestoreInput{
		WorkspaceID: workspaceID,
		UserID:      userID,
		Graph:       graph,
	}
	missingOwner := restoreInput
	missingOwner.UserID = ""
	if err := driver.RestoreHistoricalSessionGraph(
		ctx,
		missingOwner,
	); !errors.Is(err, agenthost.ErrInvalidArgument) {
		return fmt.Errorf("missing historical owner restore error = %v", err)
	}
	if err := driver.RestoreHistoricalSessionGraph(ctx, restoreInput); err != nil {
		return fmt.Errorf("restore historical graph: %w", err)
	}
	if metrics := driver.HistoricalStateMetrics(); metrics.ProviderStartCalls != 0 ||
		metrics.ProviderResumeCalls != 0 || metrics.ProviderExecCalls != 0 {
		return fmt.Errorf("historical restore started Provider work: %#v", metrics)
	}
	captured, err := driver.CaptureHistoricalSessionGraph(ctx, agenthost.SessionRef{
		WorkspaceID: workspaceID, AgentSessionID: graph.RootSessionID,
	})
	if err != nil {
		return fmt.Errorf("capture restored historical graph: %w", err)
	}
	if !reflect.DeepEqual(captured, graph) {
		return fmt.Errorf("restored historical graph differs: %#v", captured)
	}
	boundUserID, err := driver.HistoricalSessionUserID(ctx, agenthost.SessionRef{
		WorkspaceID: workspaceID, AgentSessionID: graph.RootSessionID,
	})
	if err != nil {
		return fmt.Errorf("read restored historical Session ownership: %w", err)
	}
	if boundUserID != userID {
		return fmt.Errorf("restored historical Session user = %q, want %q", boundUserID, userID)
	}
	if err := driver.RestoreHistoricalSessionGraph(ctx, restoreInput); err != nil {
		return fmt.Errorf("idempotent historical restore: %w", err)
	}
	conflictingOwner := restoreInput
	conflictingOwner.UserID = "different-user"
	if err := driver.RestoreHistoricalSessionGraph(
		ctx,
		conflictingOwner,
	); !errors.Is(err, agenthost.ErrHistoricalStateConflict) {
		return fmt.Errorf("conflicting historical owner restore error = %v", err)
	}
	conflicting := graph
	conflicting.Sessions = append([]agenthost.HistoricalSession(nil), graph.Sessions...)
	conflicting.Sessions[0].Title = "conflicting title"
	if err := driver.RestoreHistoricalSessionGraph(
		ctx,
		agenthost.HistoricalSessionGraphRestoreInput{
			WorkspaceID: workspaceID,
			UserID:      userID,
			Graph:       conflicting,
		},
	); !errors.Is(err, agenthost.ErrHistoricalStateConflict) {
		return fmt.Errorf("conflicting historical restore error = %v", err)
	}
	ref := agenthost.SessionRef{
		WorkspaceID: workspaceID, AgentSessionID: graph.RootSessionID,
	}
	if err := driver.EnsureHistoricalSession(ctx, ref); err != nil {
		return fmt.Errorf("resume restored historical Session: %w", err)
	}
	if metrics := driver.HistoricalStateMetrics(); !reflect.DeepEqual(
		metrics.LastResumeProviderCheckpoint,
		graph.Sessions[0].ProviderResumeCheckpoint,
	) {
		return fmt.Errorf(
			"restored Session resume checkpoint = %#v, want %#v",
			metrics.LastResumeProviderCheckpoint,
			graph.Sessions[0].ProviderResumeCheckpoint,
		)
	}
	if err := driver.SendHistoricalInput(ctx, ref, agenthost.SendInput{
		TurnID: "turn-new", ClientSubmitID: "submit-new",
		Content:       []agenthost.PromptContentBlock{{Type: "text", Text: "continue"}},
		DisplayPrompt: "continue",
	}); err != nil {
		return fmt.Errorf("send restored historical Session: %w", err)
	}
	metrics := driver.HistoricalStateMetrics()
	if metrics.ProviderStartCalls != 0 ||
		metrics.ProviderResumeCalls != 1 ||
		metrics.ProviderExecCalls != 1 {
		return fmt.Errorf("restored Session lifecycle metrics = %#v", metrics)
	}
	return nil
}

func historicalStateScenarioGraph() agenthost.HistoricalSessionGraph {
	return agenthost.HistoricalSessionGraph{
		RootSessionID: "session-root",
		Sessions: []agenthost.HistoricalSession{{
			ID: "session-root", Kind: "root", Origin: "runtime",
			AgentTargetID: "local:codex", Provider: "codex",
			ProviderSessionID: "provider-session-root", Model: "codex-current",
			Settings: map[string]any{
				"model": "codex-current", "reasoningEffort": "high",
			},
			ProviderResumeCheckpoint: map[string]any{
				"defaultModel": "codex-current",
				"defaultModeMask": map[string]any{
					"mode": "default",
				},
			},
			Title: "Restored session",
			Turns: []agenthost.HistoricalTurn{{
				ID: "turn-settled", Phase: "settled", Outcome: "completed",
				Origin:             "user_prompt",
				RootProviderTurnID: "provider-turn-settled",
				CapabilityRefs:     []agenthost.CapabilityReference{},
			}},
			Messages: []agenthost.HistoricalMessage{{
				ID: "message-user", TurnID: "turn-settled", Role: "user",
				Status:  "completed",
				Payload: map[string]any{"text": "before replay"},
			}},
			Interactions: []agenthost.HistoricalInteraction{},
		}},
	}
}
