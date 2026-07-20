package eventstream

import (
	"context"
	"encoding/json"
	"fmt"

	eventprotocol "github.com/tutti-os/tutti/services/tuttid/api/events/generated"
	agentquickpromptbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentquickprompt"
)

type AgentQuickPromptPublisher struct {
	Service *Service
}

func (p AgentQuickPromptPublisher) PublishAgentQuickPromptUpdated(ctx context.Context, event agentquickpromptbiz.UpdatedEvent) error {
	if p.Service == nil {
		return nil
	}
	payload, err := json.Marshal(eventprotocol.AgentQuickpromptUpdatedPayload{
		PromptId:         event.PromptID,
		ChangeKind:       string(event.ChangeKind),
		Version:          int(event.Version),
		OccurredAtUnixMs: int(event.OccurredAtUnixMS),
	})
	if err != nil {
		return fmt.Errorf("marshal agent quick prompt updated payload: %w", err)
	}
	if err := p.Service.PublishFromServer(ctx, TopicAgentQuickPromptUpdated, payload); err != nil {
		return fmt.Errorf("publish %s: %w", TopicAgentQuickPromptUpdated, err)
	}
	return nil
}
