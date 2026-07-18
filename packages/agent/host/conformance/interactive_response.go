package conformance

import (
	"context"
	"fmt"
	"sync"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

func runInteractiveResponse(ctx context.Context, driver Driver) error {
	fixture := liveSessionFixture("session-interactive", "turn-interactive")
	fixture.Turn = &TurnSeed{TurnID: "turn-interactive", Phase: canonical.TurnPhaseWaiting}
	fixture.Interaction = &InteractionSeed{
		RequestID: "request-1", TurnID: "turn-interactive", Kind: canonical.InteractionKindApproval, Status: canonical.InteractionStatusPending,
	}
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}
	optionID := "approve"
	result, err := driver.SubmitInteractive(ctx,
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-interactive"},
		"request-1", agenthost.SubmitInteractiveInput{TurnID: "turn-interactive", OptionID: &optionID},
	)
	if err != nil {
		return fmt.Errorf("submit interactive: %w", err)
	}
	if result.Disposition != agenthost.RuntimeInteractiveDispositionAnswered {
		return fmt.Errorf("interactive disposition=%q, want answered", result.Disposition)
	}
	metrics := driver.Metrics()
	if metrics.InteractiveCalls != 1 || metrics.LastInteractiveTurnID != "turn-interactive" || metrics.LastInteractiveRequestID != "request-1" {
		return fmt.Errorf("interactive metrics=%#v", metrics)
	}
	return nil
}

func runInteractiveResponseRace(ctx context.Context, driver Driver) error {
	for _, test := range []struct {
		name       string
		options    [2]string
		wantCounts map[agenthost.RuntimeInteractiveDisposition]int
	}{
		{name: "same answer", options: [2]string{"approve", "approve"}, wantCounts: map[agenthost.RuntimeInteractiveDisposition]int{agenthost.RuntimeInteractiveDispositionAnswered: 2}},
		{name: "different answers", options: [2]string{"approve", "deny"}, wantCounts: map[agenthost.RuntimeInteractiveDisposition]int{agenthost.RuntimeInteractiveDispositionAnswered: 1, agenthost.RuntimeInteractiveDispositionSuperseded: 1}},
	} {
		fixture := liveSessionFixture("session-interactive-race", "turn-interactive-race")
		fixture.Turn = &TurnSeed{TurnID: "turn-interactive-race", Phase: canonical.TurnPhaseWaiting}
		fixture.Interaction = &InteractionSeed{
			RequestID: "request-race", TurnID: "turn-interactive-race",
			Kind: canonical.InteractionKindApproval, Status: canonical.InteractionStatusPending,
		}
		if err := driver.Reset(ctx, fixture); err != nil {
			return fmt.Errorf("%s reset: %w", test.name, err)
		}
		start := make(chan struct{})
		results := make(chan InteractiveObservation, 2)
		errorsByCall := make(chan error, 2)
		var group sync.WaitGroup
		for _, option := range test.options {
			option := option
			group.Add(1)
			go func() {
				defer group.Done()
				<-start
				result, err := driver.SubmitInteractive(ctx,
					agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-interactive-race"},
					"request-race", agenthost.SubmitInteractiveInput{TurnID: "turn-interactive-race", OptionID: &option},
				)
				if err != nil {
					errorsByCall <- err
					return
				}
				results <- result
			}()
		}
		close(start)
		group.Wait()
		close(errorsByCall)
		close(results)
		for err := range errorsByCall {
			return fmt.Errorf("%s returned raw competing response error: %w", test.name, err)
		}
		counts := make(map[agenthost.RuntimeInteractiveDisposition]int)
		for result := range results {
			counts[result.Disposition]++
		}
		for disposition, want := range test.wantCounts {
			if counts[disposition] != want {
				return fmt.Errorf("%s dispositions=%v, want %v=%d", test.name, counts, disposition, want)
			}
		}
		if counts[agenthost.RuntimeInteractiveDispositionAnswered]+counts[agenthost.RuntimeInteractiveDispositionSuperseded] != 2 {
			return fmt.Errorf("%s dispositions=%v, want only answered/superseded", test.name, counts)
		}
	}
	return nil
}
