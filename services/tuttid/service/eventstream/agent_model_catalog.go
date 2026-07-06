package eventstream

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	agentproviderbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

// AgentModelCatalogPublisher broadcasts that the daemon-side model catalog for
// one or more agent providers can no longer be trusted (for example because an
// external tool rewrote the provider's auth or config files). Subscribers are
// expected to drop cached model lists and re-request composer options.
type AgentModelCatalogPublisher struct {
	Service *Service
	Now     func() time.Time
}

func (p AgentModelCatalogPublisher) PublishAgentModelCatalogInvalidated(
	ctx context.Context,
	providers []string,
) error {
	if p.Service == nil {
		return nil
	}
	normalized := make([]string, 0, len(providers))
	seen := make(map[string]struct{}, len(providers))
	for _, provider := range providers {
		canonical := agentproviderbiz.Normalize(provider)
		if canonical == "" {
			continue
		}
		if _, ok := seen[canonical]; ok {
			continue
		}
		seen[canonical] = struct{}{}
		normalized = append(normalized, canonical)
	}
	if len(normalized) == 0 {
		return nil
	}
	now := time.Now()
	if p.Now != nil {
		now = p.Now()
	}
	payload, err := json.Marshal(agentModelCatalogInvalidatedPayload{
		Providers:        normalized,
		OccurredAtUnixMS: now.UnixMilli(),
	})
	if err != nil {
		return fmt.Errorf("marshal agent model catalog invalidated payload: %w", err)
	}
	if err := p.Service.PublishFromServer(ctx, TopicAgentModelCatalogInvalidated, payload); err != nil {
		return fmt.Errorf("publish %s: %w", strings.TrimSpace(TopicAgentModelCatalogInvalidated), err)
	}
	return nil
}
