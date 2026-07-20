package conformance

import (
	"context"
	"fmt"
	"strings"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
)

type EventSubscriptionObservation struct {
	SubscriptionStatus string
	DeliveryStatus     string
	RuntimeExecCalls   int
	LastClientSubmitID string
	LastGuidance       bool
	LastInitialTitle   string
	LastSubmissionKind string
}

// EventSubscriptionDriver is deliberately separate from Driver so downstream
// adapters can adopt the durable event contract without changing their
// existing lifecycle conformance surface in lockstep.
type EventSubscriptionDriver interface {
	Reset(context.Context, Fixture) error
	CreateEventSubscription(context.Context, agenthost.CreateEventSubscriptionInput) error
	EmitTerminalTurn(context.Context, string, string, string, string) error
	FailNextEventDeliveryCompletion()
	StepEventDelivery(context.Context) (bool, error)
	RecoverEventDeliveries(context.Context) error
	ObserveEventSubscription(context.Context, string, string) (EventSubscriptionObservation, error)
}

type EventSubscriptionScenario struct {
	Name string
	run  func(context.Context, EventSubscriptionDriver) error
}

func RunEventSubscription(ctx context.Context, driver EventSubscriptionDriver, scenario EventSubscriptionScenario) error {
	if driver == nil {
		return fmt.Errorf("agent host event subscription conformance driver is required")
	}
	if scenario.run == nil {
		return fmt.Errorf("agent host event subscription conformance scenario %q has no runner", scenario.Name)
	}
	return scenario.run(ctx, driver)
}

func EventSubscriptionScenarios() []EventSubscriptionScenario {
	return []EventSubscriptionScenario{{
		Name: "terminal turn resumes subscriber exactly once",
		run: func(ctx context.Context, driver EventSubscriptionDriver) error {
			const (
				workspaceID    = "workspace-events"
				subscriberID   = "subscriber-session"
				sourceID       = "source-session"
				subscriptionID = "subscription-completed"
			)
			if err := driver.Reset(ctx, Fixture{
				Session: &SessionSeed{
					WorkspaceID: workspaceID, AgentSessionID: subscriberID, Provider: "codex",
					ProviderSessionID: "provider-subscriber", Cwd: "/workspace", Live: true,
				},
				AdditionalSessions: []SessionSeed{{
					WorkspaceID: workspaceID, AgentSessionID: sourceID, Provider: "codex",
					ProviderSessionID: "provider-source", Cwd: "/workspace", Live: true,
				}},
			}); err != nil {
				return err
			}
			if err := driver.CreateEventSubscription(ctx, agenthost.CreateEventSubscriptionInput{
				SubscriptionID: subscriptionID, WorkspaceID: workspaceID,
				SubscriberAgentSessionID: subscriberID, EventType: agenthost.EventTypeAgentTurnCompleted,
				SourceAgentSessionID: sourceID,
			}); err != nil {
				return err
			}
			if err := driver.EmitTerminalTurn(ctx, workspaceID, sourceID, "source-turn", "completed"); err != nil {
				return err
			}
			before, err := driver.ObserveEventSubscription(ctx, workspaceID, subscriptionID)
			if err != nil {
				return err
			}
			if before.SubscriptionStatus != "matched" || before.DeliveryStatus != "prepared" || before.RuntimeExecCalls != 0 {
				return fmt.Errorf("terminal match observation = %#v, want matched/prepared before runtime delivery", before)
			}
			driver.FailNextEventDeliveryCompletion()
			processed, err := driver.StepEventDelivery(ctx)
			if !processed {
				return fmt.Errorf("event delivery worker did not process the prepared delivery")
			}
			if err == nil {
				return fmt.Errorf("fault-injected delivery completion unexpectedly succeeded")
			}
			crashed, err := driver.ObserveEventSubscription(ctx, workspaceID, subscriptionID)
			if err != nil {
				return err
			}
			if crashed.DeliveryStatus != "leased" || crashed.RuntimeExecCalls != 1 {
				return fmt.Errorf("crash-window observation = %#v, want leased after one accepted runtime exec", crashed)
			}
			if err := driver.RecoverEventDeliveries(ctx); err != nil {
				return err
			}
			after, err := driver.ObserveEventSubscription(ctx, workspaceID, subscriptionID)
			if err != nil {
				return err
			}
			if after.SubscriptionStatus != "matched" || after.DeliveryStatus != "completed" || after.RuntimeExecCalls != 1 ||
				!strings.HasPrefix(after.LastClientSubmitID, "event-delivery:") || after.LastGuidance || after.LastInitialTitle != "" ||
				after.LastSubmissionKind != "event_continuation" {
				return fmt.Errorf("delivered observation = %#v, want one idempotent continuation turn", after)
			}
			processed, err = driver.StepEventDelivery(ctx)
			if err != nil {
				return err
			}
			if processed {
				return fmt.Errorf("completed one-shot delivery was processed twice")
			}
			final, err := driver.ObserveEventSubscription(ctx, workspaceID, subscriptionID)
			if err != nil {
				return err
			}
			if final.RuntimeExecCalls != 1 {
				return fmt.Errorf("runtime exec calls = %d, want exactly one", final.RuntimeExecCalls)
			}
			return nil
		},
	}}
}
