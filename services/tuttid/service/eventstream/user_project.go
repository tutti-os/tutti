package eventstream

import (
	"context"
	"encoding/json"
	"fmt"

	eventprotocol "github.com/tutti-os/tutti/services/tuttid/api/events/generated"
	userprojectbiz "github.com/tutti-os/tutti/services/tuttid/biz/userproject"
)

type UserProjectPublisher struct {
	Service *Service
}

func (p UserProjectPublisher) PublishUserProjectUpdated(ctx context.Context, projects []userprojectbiz.Project) error {
	if p.Service == nil {
		return nil
	}

	generatedProjects := make([]eventprotocol.UserUserProject, 0, len(projects))
	for _, project := range projects {
		generatedProjects = append(generatedProjects, eventprotocol.UserUserProject{
			Id:               project.ID,
			Path:             project.Path,
			Label:            project.Label,
			SectionKey:       userprojectbiz.SectionKeyFromPath(project.Path),
			CreatedAtUnixMs:  project.CreatedAtUnixMS,
			UpdatedAtUnixMs:  project.UpdatedAtUnixMS,
			LastUsedAtUnixMs: project.LastUsedAtUnixMS,
			PinnedAtUnixMs:   project.PinnedAtUnixMS,
		})
	}

	payload, err := json.Marshal(eventprotocol.UserProjectUpdatedPayload{
		Projects: generatedProjects,
	})
	if err != nil {
		return fmt.Errorf("marshal user project updated payload: %w", err)
	}
	if err := p.Service.PublishFromServer(ctx, TopicUserProjectUpdated, payload); err != nil {
		return fmt.Errorf("publish %s: %w", TopicUserProjectUpdated, err)
	}
	return nil
}
