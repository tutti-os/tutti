package agent

import (
	"context"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

type EventTypeDefinition = agenthost.EventTypeDefinition
type EventSubscription = storesqlite.EventSubscription

func EventTypeCatalog() []EventTypeDefinition {
	return agenthost.EventTypeCatalog()
}

func (s *Service) CreateEventSubscription(ctx context.Context, input agenthost.CreateEventSubscriptionInput) (EventSubscription, error) {
	return s.ApplicationHost().CreateEventSubscription(ctx, input)
}

func (s *Service) ListEventSubscriptions(ctx context.Context, workspaceID, subscriberAgentSessionID string) ([]EventSubscription, error) {
	return s.ApplicationHost().ListEventSubscriptions(ctx, agenthost.SessionRef{WorkspaceID: workspaceID, AgentSessionID: subscriberAgentSessionID})
}

func (s *Service) CancelEventSubscription(ctx context.Context, workspaceID, subscriberAgentSessionID, subscriptionID string) (EventSubscription, error) {
	return s.ApplicationHost().CancelEventSubscription(ctx, agenthost.SessionRef{WorkspaceID: workspaceID, AgentSessionID: subscriberAgentSessionID}, subscriptionID)
}
