package agentcontext

import (
	"context"
	"fmt"
	"strings"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	"github.com/tutti-os/tutti/services/tuttid/service/cli/framework"
)

type eventSubscriptionCreateInput struct {
	SessionID       string `cli:"session-id" description:"Subscriber agent session id. Defaults to the calling Agent session."`
	SubscriptionID  string `cli:"subscription-id" description:"Optional caller-owned idempotency id."`
	EventType       string `cli:"event-type" validate:"required" description:"Exact type from agent event-types."`
	SourceSessionID string `cli:"source-session-id" validate:"required" description:"Agent session that emits the terminal turn event."`
	SourceTurnID    string `cli:"source-turn-id" description:"Optional exact source turn; otherwise the next matching terminal turn is used."`
}

type eventSubscriptionsInput struct {
	SessionID string `cli:"session-id" description:"Subscriber agent session id. Defaults to the calling Agent session."`
}

type eventSubscriptionCancelInput struct {
	SessionID      string `cli:"session-id" description:"Subscriber agent session id. Defaults to the calling Agent session."`
	SubscriptionID string `cli:"subscription-id" validate:"required"`
}

var eventTypeColumns = []cliservice.TableColumn{
	{Key: "type", Label: "Type"}, {Key: "version", Label: "Version"},
	{Key: "sourceKind", Label: "Source"}, {Key: "oneShot", Label: "One Shot"},
}

var eventSubscriptionColumns = []cliservice.TableColumn{
	{Key: "id", Label: "ID"}, {Key: "eventType", Label: "Event Type"},
	{Key: "sourceSessionId", Label: "Source Session"}, {Key: "sourceTurnId", Label: "Source Turn"},
	{Key: "status", Label: "Status"},
}

func (Provider) newEventTypesCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[struct{}]{
		ID: appID + ".agent.event-types", Path: []string{"agent", "event-types"},
		Summary:     "List subscribable agent event types",
		Description: "List the versioned system event types that can create a follow-up Agent turn.",
		Kind:        framework.KindList, Workspace: framework.WorkspaceOptional,
		Inputs: framework.FromStruct[struct{}](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeTable, DefaultView: framework.ViewSummary, JSON: true,
			Table: &framework.TableOutputSpec{Columns: eventTypeColumns, Rows: func(result any) []map[string]any {
				return eventTypeRows(result.([]agentservice.EventTypeDefinition))
			}},
			JSONViews: map[framework.OutputView]func(any) map[string]any{framework.ViewSummary: func(result any) map[string]any {
				return map[string]any{"eventTypes": eventTypeRows(result.([]agentservice.EventTypeDefinition))}
			}}, ListCompact: true,
		},
		Run: func(context.Context, framework.InvokeContext, struct{}) (any, error) {
			return agentservice.EventTypeCatalog(), nil
		},
	})
}

func (p Provider) newEventSubscriptionCreateCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[eventSubscriptionCreateInput]{
		ID: appID + ".agent.subscriptions.create", Path: []string{"agent", "subscriptions", "create"},
		Summary:     "Subscribe an Agent session to a system event",
		Description: "Create a durable one-shot subscription. When the source turn reaches the selected terminal outcome, Tutti starts a follow-up turn in the subscriber session.",
		Kind:        framework.KindAction, Workspace: framework.WorkspaceRequired,
		Inputs: framework.FromStruct[eventSubscriptionCreateInput](), Output: eventSubscriptionOutputSpec(),
		Run: func(ctx context.Context, invoke framework.InvokeContext, input eventSubscriptionCreateInput) (any, error) {
			service, err := p.requireEventSubscriptions()
			if err != nil {
				return nil, err
			}
			subscriber, err := subscriberSessionID(input.SessionID, invoke)
			if err != nil {
				return nil, err
			}
			return service.CreateEventSubscription(ctx, agenthost.CreateEventSubscriptionInput{
				SubscriptionID: input.SubscriptionID, WorkspaceID: invoke.WorkspaceID,
				SubscriberAgentSessionID: subscriber, EventType: input.EventType,
				SourceAgentSessionID: input.SourceSessionID, SourceTurnID: input.SourceTurnID,
			})
		},
	})
}

func (p Provider) newEventSubscriptionsCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[eventSubscriptionsInput]{
		ID: appID + ".agent.subscriptions.list", Path: []string{"agent", "subscriptions", "list"},
		Summary:     "List Agent event subscriptions",
		Description: "List durable event subscriptions owned by an Agent session.",
		Kind:        framework.KindList, Workspace: framework.WorkspaceRequired,
		Inputs: framework.FromStruct[eventSubscriptionsInput](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeTable, DefaultView: framework.ViewSummary, JSON: true,
			Table: &framework.TableOutputSpec{Columns: eventSubscriptionColumns, Rows: func(result any) []map[string]any {
				return eventSubscriptionRows(result.([]agentservice.EventSubscription))
			}},
			JSONViews: map[framework.OutputView]func(any) map[string]any{framework.ViewSummary: func(result any) map[string]any {
				return map[string]any{"subscriptions": eventSubscriptionRows(result.([]agentservice.EventSubscription))}
			}},
			ListCompact: true,
		},
		Run: func(ctx context.Context, invoke framework.InvokeContext, input eventSubscriptionsInput) (any, error) {
			service, err := p.requireEventSubscriptions()
			if err != nil {
				return nil, err
			}
			subscriber, err := subscriberSessionID(input.SessionID, invoke)
			if err != nil {
				return nil, err
			}
			return service.ListEventSubscriptions(ctx, invoke.WorkspaceID, subscriber)
		},
	})
}

func (p Provider) newEventSubscriptionCancelCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[eventSubscriptionCancelInput]{
		ID: appID + ".agent.subscriptions.cancel", Path: []string{"agent", "subscriptions", "cancel"},
		Summary:     "Cancel an Agent event subscription",
		Description: "Cancel an active one-shot event subscription owned by the subscriber session.",
		Kind:        framework.KindAction, Workspace: framework.WorkspaceRequired,
		Inputs: framework.FromStruct[eventSubscriptionCancelInput](), Output: eventSubscriptionOutputSpec(),
		Run: func(ctx context.Context, invoke framework.InvokeContext, input eventSubscriptionCancelInput) (any, error) {
			service, err := p.requireEventSubscriptions()
			if err != nil {
				return nil, err
			}
			subscriber, err := subscriberSessionID(input.SessionID, invoke)
			if err != nil {
				return nil, err
			}
			return service.CancelEventSubscription(ctx, invoke.WorkspaceID, subscriber, input.SubscriptionID)
		},
	})
}

func (p Provider) requireEventSubscriptions() (AgentSessions, error) {
	if p.sessions == nil {
		return nil, agentservice.ErrInvalidArgument
	}
	return p.sessions, nil
}

func subscriberSessionID(explicit string, invoke framework.InvokeContext) (string, error) {
	if value := strings.TrimSpace(explicit); value != "" {
		return value, nil
	}
	if value := strings.TrimSpace(invoke.Request.Context.AgentSessionID); value != "" {
		return value, nil
	}
	return "", fmt.Errorf("%w: session-id is required outside an Agent session", cliservice.ErrInvalidInput)
}

func eventSubscriptionOutputSpec() framework.OutputSpec {
	return framework.OutputSpec{DefaultMode: cliservice.OutputModeJSON, DefaultView: framework.ViewSummary, JSON: true,
		JSONViews: map[framework.OutputView]func(any) map[string]any{framework.ViewSummary: func(result any) map[string]any {
			return eventSubscriptionValue(result.(agentservice.EventSubscription))
		}}}
}

func eventTypeRows(items []agentservice.EventTypeDefinition) []map[string]any {
	rows := make([]map[string]any, 0, len(items))
	for _, item := range items {
		rows = append(rows, map[string]any{"type": item.Type, "version": item.Version, "sourceKind": item.SourceKind, "oneShot": item.OneShot})
	}
	return rows
}

func eventSubscriptionRows(items []agentservice.EventSubscription) []map[string]any {
	rows := make([]map[string]any, 0, len(items))
	for _, item := range items {
		rows = append(rows, eventSubscriptionValue(item))
	}
	return rows
}

func eventSubscriptionValue(item agentservice.EventSubscription) map[string]any {
	return map[string]any{
		"id": item.SubscriptionID, "workspaceId": item.WorkspaceID,
		"subscriberSessionId": item.SubscriberAgentSessionID, "eventType": item.EventType,
		"eventVersion": item.EventVersion, "sourceKind": item.SourceKind,
		"sourceId": item.SourceID, "sourceSubjectId": item.SourceSubjectID,
		"sourceSessionId": item.SourceID, "sourceTurnId": item.SourceSubjectID,
		"status": item.Status, "matchedEventId": item.MatchedEventID,
		"createdAtUnixMs": item.CreatedAtUnixMS, "updatedAtUnixMs": item.UpdatedAtUnixMS,
	}
}
