package conformance

import (
	"context"
	"errors"
	"fmt"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

var (
	guidanceTargetRequiredScenario = Scenario{
		Name: "guidance requires exact target before dispatch",
		run:  runGuidanceTargetRequired,
	}
	guidanceExactTargetScenario = Scenario{
		Name: "guidance forwards exact target",
		run:  runGuidanceExactTarget,
	}
	guidanceTargetMismatchScenario = Scenario{
		Name: "guidance target mismatch does not dispatch provider and cleans claim",
		run:  runGuidanceTargetMismatch,
	}
)

func GuidanceScenarios() []Scenario {
	return []Scenario{
		guidanceTargetRequiredScenario,
		guidanceExactTargetScenario,
		guidanceTargetMismatchScenario,
	}
}

func guidanceFixture(mismatch bool) Fixture {
	const (
		sessionID = "session-guidance"
		turnID    = "turn-guidance-active"
	)
	fixture := liveSessionFixture(sessionID, turnID)
	fixture.Turn = &TurnSeed{TurnID: turnID, Phase: canonical.TurnPhaseRunning}
	fixture.GuidanceTargetMismatch = mismatch
	return fixture
}

func guidanceInput(turnID, clientSubmitID string) agenthost.SendInput {
	return agenthost.SendInput{
		Content:  []agenthost.PromptContentBlock{{Type: "text", Text: "continue the active turn"}},
		Guidance: true, TurnID: turnID, ClientSubmitID: clientSubmitID,
	}
}

func runGuidanceTargetRequired(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, guidanceFixture(false)); err != nil {
		return err
	}
	_, err := driver.SendInput(ctx,
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-guidance"},
		guidanceInput("", "guidance-required"),
	)
	if !errors.Is(err, agenthost.ErrActiveTurnTargetRequired) {
		return fmt.Errorf("missing guidance target error=%v, want ErrActiveTurnTargetRequired", err)
	}
	metrics := driver.Metrics()
	if metrics.ExecCalls != 0 || metrics.GuidanceProviderCalls != 0 {
		return fmt.Errorf("missing guidance target dispatched exec=%d provider=%d, want 0/0", metrics.ExecCalls, metrics.GuidanceProviderCalls)
	}
	return nil
}

func runGuidanceExactTarget(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, guidanceFixture(false)); err != nil {
		return err
	}
	result, err := driver.SendInput(ctx,
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-guidance"},
		guidanceInput("turn-guidance-active", "guidance-exact"),
	)
	if err != nil {
		return fmt.Errorf("exact guidance target: %w", err)
	}
	if result.TurnID != "turn-guidance-active" {
		return fmt.Errorf("exact guidance target result turn=%q, want turn-guidance-active", result.TurnID)
	}
	metrics := driver.Metrics()
	if metrics.ExecCalls != 1 || metrics.GuidanceProviderCalls != 1 {
		return fmt.Errorf("exact guidance target dispatched exec=%d provider=%d, want 1/1", metrics.ExecCalls, metrics.GuidanceProviderCalls)
	}
	return nil
}

func runGuidanceTargetMismatch(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, guidanceFixture(true)); err != nil {
		return err
	}
	ref := agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-guidance"}
	_, err := driver.SendInput(ctx, ref, guidanceInput("turn-guidance-stale", "guidance-mismatch"))
	if !errors.Is(err, agenthost.ErrActiveTurnTargetMismatch) {
		return fmt.Errorf("stale guidance target error=%v, want ErrActiveTurnTargetMismatch", err)
	}
	metrics := driver.Metrics()
	if metrics.GuidanceProviderCalls != 0 {
		return fmt.Errorf("stale guidance target dispatched provider=%d, want 0", metrics.GuidanceProviderCalls)
	}

	// Reusing the same client submit id must prepare a fresh claim after the
	// known pre-provider rejection. A retained prepared claim would turn this
	// retry into an outcome-unknown error before runtime dispatch.
	retried, err := driver.SendInput(ctx, ref, guidanceInput("turn-guidance-active", "guidance-mismatch"))
	if err != nil {
		return fmt.Errorf("retry guidance after target mismatch: %w", err)
	}
	if retried.TurnID != "turn-guidance-active" {
		return fmt.Errorf("retried guidance turn=%q, want turn-guidance-active", retried.TurnID)
	}
	metrics = driver.Metrics()
	if metrics.GuidanceProviderCalls != 1 {
		return fmt.Errorf("retried guidance dispatched provider=%d, want 1", metrics.GuidanceProviderCalls)
	}
	return nil
}
