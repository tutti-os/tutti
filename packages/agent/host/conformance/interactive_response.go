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
		agenthost.InteractionRef{
			WorkspaceID: "workspace-1", AgentSessionID: "session-interactive",
			TurnID: "turn-interactive", RequestID: "request-1",
		},
		agenthost.SubmitInteractiveInput{OptionID: &optionID},
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

func runInteractiveResponseReusedRequestID(ctx context.Context, driver Driver) error {
	fixture := liveSessionFixture("session-interactive-reused", "turn-current")
	fixture.Turn = &TurnSeed{TurnID: "turn-current", Phase: canonical.TurnPhaseWaiting}
	fixture.AdditionalTurns = []TurnSeed{{
		TurnID: "turn-previous", Phase: canonical.TurnPhaseWaiting,
	}}
	fixture.Interaction = &InteractionSeed{
		RequestID: "provider-request", TurnID: "turn-current",
		Kind: canonical.InteractionKindApproval, Status: canonical.InteractionStatusPending,
	}
	fixture.AdditionalInteractions = []InteractionSeed{{
		RequestID: "provider-request", TurnID: "turn-previous",
		Kind: canonical.InteractionKindApproval, Status: canonical.InteractionStatusPending,
	}}
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}
	previousRef := agenthost.InteractionRef{
		WorkspaceID: "workspace-1", AgentSessionID: "session-interactive-reused",
		TurnID: "turn-previous", RequestID: "provider-request",
	}
	currentRef := previousRef
	currentRef.TurnID = "turn-current"
	previousOption := "deny"
	previous, err := driver.SubmitInteractive(ctx, previousRef, agenthost.SubmitInteractiveInput{OptionID: &previousOption})
	if err != nil {
		return fmt.Errorf("submit previous reused provider request id: %w", err)
	}
	if previous.Disposition != agenthost.RuntimeInteractiveDispositionAnswered || previous.TurnID != previousRef.TurnID || previous.RequestID != previousRef.RequestID {
		return fmt.Errorf("previous reused provider request result=%#v, want exact answered operation", previous)
	}
	if status, found, statusErr := driver.GetInteractionStatus(ctx, currentRef); statusErr != nil || !found || status != canonical.InteractionStatusPending {
		return fmt.Errorf("current interaction before response status=%q found=%v error=%v, want pending", status, found, statusErr)
	}
	currentOption := "approve"
	current, err := driver.SubmitInteractive(ctx, currentRef, agenthost.SubmitInteractiveInput{OptionID: &currentOption})
	if err != nil {
		return fmt.Errorf("submit current reused provider request id: %w", err)
	}
	if current.Disposition != agenthost.RuntimeInteractiveDispositionAnswered || current.TurnID != currentRef.TurnID || current.RequestID != currentRef.RequestID {
		return fmt.Errorf("current reused provider request result=%#v, want exact answered operation", current)
	}
	if previous.OperationID == "" || current.OperationID == "" || previous.OperationID == current.OperationID {
		return fmt.Errorf("reused provider request operation ids previous=%q current=%q, want distinct", previous.OperationID, current.OperationID)
	}
	for _, ref := range []agenthost.InteractionRef{previousRef, currentRef} {
		if status, found, statusErr := driver.GetInteractionStatus(ctx, ref); statusErr != nil || !found || status != canonical.InteractionStatusAnswered {
			return fmt.Errorf("interaction %q status=%q found=%v error=%v, want answered", ref.TurnID, status, found, statusErr)
		}
	}
	metrics := driver.Metrics()
	if metrics.InteractiveCalls != 2 || metrics.LastInteractiveTurnID != "turn-current" || metrics.LastInteractiveRequestID != "provider-request" {
		return fmt.Errorf("reused provider request metrics=%#v", metrics)
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
					agenthost.InteractionRef{
						WorkspaceID: "workspace-1", AgentSessionID: "session-interactive-race",
						TurnID: "turn-interactive-race", RequestID: "request-race",
					},
					agenthost.SubmitInteractiveInput{OptionID: &option},
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
