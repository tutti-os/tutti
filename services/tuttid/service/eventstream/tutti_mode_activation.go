package eventstream

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	eventprotocol "github.com/tutti-os/tutti/services/tuttid/api/events/generated"
	tuttimodeactivationbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeactivation"
)

type TuttiModeActivationPublisher struct {
	Service *Service
}

func (p TuttiModeActivationPublisher) PublishTuttiModeActivationUpdated(ctx context.Context, update tuttimodeactivationbiz.Update) error {
	if p.Service == nil {
		return nil
	}
	update.WorkspaceID = strings.TrimSpace(update.WorkspaceID)
	update.AgentSessionID = strings.TrimSpace(update.AgentSessionID)
	update.ActivationID = strings.TrimSpace(update.ActivationID)
	if update.WorkspaceID == "" || update.AgentSessionID == "" || update.ActivationID == "" || update.Revision <= 0 {
		return nil
	}
	payload, err := json.Marshal(eventprotocol.WorkspaceTuttimodeUpdatedPayload{
		AgentSessionId: update.AgentSessionID,
		ActivationId:   update.ActivationID,
		Revision:       int(update.Revision),
		Status:         string(update.State),
		ChangeKind:     string(update.ChangeKind),
	})
	if err != nil {
		return fmt.Errorf("marshal workspace Tutti mode updated payload: %w", err)
	}
	return p.Service.PublishFromServerScoped(ctx, TopicWorkspaceTuttiModeUpdated, payload, EventScope{WorkspaceID: update.WorkspaceID})
}
