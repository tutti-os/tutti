package eventstream

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

type WorkspaceAppFactoryPublisher struct {
	Service *Service
}

func (p WorkspaceAppFactoryPublisher) PublishWorkspaceAppFactoryJobUpdated(ctx context.Context, workspaceID string, job workspacebiz.AppFactoryJob) error {
	if p.Service == nil {
		return nil
	}
	payload, err := json.Marshal(map[string]any{
		"job": map[string]any{
			"jobId":            job.JobID,
			"workspaceId":      job.WorkspaceID,
			"status":           string(job.Status),
			"prompt":           job.Prompt,
			"appId":            nullableString(strings.TrimSpace(job.AppID)),
			"displayName":      strings.TrimSpace(job.DisplayName),
			"description":      nullableString(strings.TrimSpace(job.Description)),
			"agentTargetId":    nullableString(strings.TrimSpace(job.AgentTargetID)),
			"provider":         nullableString(strings.TrimSpace(job.Provider)),
			"model":            nullableString(strings.TrimSpace(job.Model)),
			"reasoningEffort":  nullableString(strings.TrimSpace(job.ReasoningEffort)),
			"agentSessionId":   nullableString(strings.TrimSpace(job.AgentSessionID)),
			"validationResult": validationResultPayload(job.ValidationResultJSON),
			"failureReason":    nullableString(strings.TrimSpace(job.FailureReason)),
			"publishedVersion": nullableString(strings.TrimSpace(job.PublishedVersion)),
			"createdAtUnixMs":  job.CreatedAtUnixMs,
			"updatedAtUnixMs":  job.UpdatedAtUnixMs,
		},
	})
	if err != nil {
		return fmt.Errorf("marshal workspace app factory job updated payload: %w", err)
	}
	return p.Service.PublishFromServerScoped(ctx, TopicWorkspaceAppFactoryJobUpdated, payload, EventScope{
		WorkspaceID: workspaceID,
	})
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func validationResultPayload(raw string) any {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	var result map[string]any
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		return nil
	}
	return result
}
