package eventstream

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"time"

	eventsgenerated "github.com/tutti-os/tutti/services/tuttid/api/events/generated"
	collabrunbiz "github.com/tutti-os/tutti/services/tuttid/biz/collabrun"
)

// AgentCollaborationPublisher broadcasts collaboration run lifecycle changes
// (consult started/settled, fork/delegate/handoff recorded, adoption changes)
// so GUI surfaces can refresh run accounting without polling. The signature
// matches the collabrun service Publisher contract: publish failures are
// logged, never surfaced into the run workflow.
type AgentCollaborationPublisher struct {
	Service *Service
	Now     func() time.Time
}

func (p AgentCollaborationPublisher) PublishCollaborationRunUpdated(workspaceID string, run collabrunbiz.Run) {
	if p.Service == nil {
		return
	}
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" || strings.TrimSpace(run.ID) == "" {
		return
	}
	now := time.Now()
	if p.Now != nil {
		now = p.Now()
	}
	payload, err := json.Marshal(eventsgenerated.AgentCollaborationUpdatedPayload{
		WorkspaceId:      workspaceID,
		RunId:            run.ID,
		Mode:             string(run.Mode),
		Status:           string(run.Status),
		SourceSessionId:  optionalEventString(run.SourceSessionID),
		TargetSessionId:  optionalEventString(run.TargetSessionID),
		ModelPlanId:      optionalEventString(run.ModelPlanID),
		Model:            optionalEventString(run.Model),
		TriggerSource:    string(run.TriggerSource),
		Adoption:         optionalEventString(string(run.Adoption)),
		OccurredAtUnixMs: int(now.UnixMilli()),
	})
	if err != nil {
		slog.Warn("agent collaboration updated payload marshal failed",
			"event", "agent.collaboration.updated_publish_failed",
			"workspaceId", workspaceID,
			"runId", run.ID,
			"error", err,
		)
		return
	}
	if err := p.Service.PublishFromServerScoped(
		context.Background(),
		TopicAgentCollaborationUpdated,
		payload,
		EventScope{WorkspaceID: workspaceID},
	); err != nil {
		slog.Warn("agent collaboration updated publish failed",
			"event", "agent.collaboration.updated_publish_failed",
			"workspaceId", workspaceID,
			"runId", run.ID,
			"error", err,
		)
	}
}

func optionalEventString(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}
