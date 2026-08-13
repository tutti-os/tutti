package agent

import (
	"context"
	"strings"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	userprojectbiz "github.com/tutti-os/tutti/services/tuttid/biz/userproject"
)

const maximumDeletedSessionPageLimit = 100

type ListDeletedSessionsInput struct {
	SearchQuery    string
	RailSectionKey *string
	Cursor         string
	Limit          int
}

type DeletedSessionSummary struct {
	AgentSessionID    string
	Title             string
	RailSectionKey    string
	ProjectPath       string
	UpdatedAtUnixMS   int64
	DeletedAtUnixMS   int64
	Restorable        bool
	UnavailableReason string
}

type DeletedSessionProjectOption struct {
	RailSectionKey   string
	ProjectPath      string
	ProjectLabel     string
	ProjectAvailable bool
}

type DeletedSessionPage struct {
	Sessions            []DeletedSessionSummary
	ProjectOptions      []DeletedSessionProjectOption
	TotalCount          int
	WorkspaceTotalCount int
	HasMore             bool
	NextCursor          string
}

type RestoreDeletedSessionResult struct {
	Restored bool
}

func (s *Service) ListDeletedSessions(
	ctx context.Context,
	workspaceID string,
	input ListDeletedSessionsInput,
) (DeletedSessionPage, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" || input.Limit < 0 || input.Limit > maximumDeletedSessionPageLimit {
		return DeletedSessionPage{}, ErrInvalidArgument
	}

	cursor := sessionPageCursor{}
	if strings.TrimSpace(input.Cursor) != "" {
		parsed, err := parseSessionListCursor(input.Cursor)
		if err != nil {
			return DeletedSessionPage{}, err
		}
		cursor = parsed
	}

	var railSectionKey *string
	if input.RailSectionKey != nil {
		value := strings.TrimSpace(*input.RailSectionKey)
		if value == "" {
			return DeletedSessionPage{}, ErrInvalidArgument
		}
		railSectionKey = &value
	}
	page, err := s.ApplicationHost().ListDeletedSessions(ctx, agenthost.ListDeletedSessionsInput{
		WorkspaceID:           workspaceID,
		SearchQuery:           strings.TrimSpace(input.SearchQuery),
		RailSectionKey:        railSectionKey,
		CursorUpdatedAtUnixMS: cursor.SortTimeUnixMS,
		CursorAgentSessionID:  cursor.ID,
		Limit:                 input.Limit,
	})
	if err != nil {
		return DeletedSessionPage{}, err
	}

	projectsBySectionKey := make(map[string]userprojectbiz.Project)
	if s.UserProjectReader != nil {
		projects, err := s.UserProjectReader.List(ctx)
		if err != nil {
			return DeletedSessionPage{}, err
		}
		for _, project := range projects {
			sectionKey := strings.TrimSpace(project.SectionKey)
			if sectionKey != "" {
				projectsBySectionKey[sectionKey] = project
			}
		}
	}

	projectOptions := make([]DeletedSessionProjectOption, 0, len(page.RailSections))
	for _, originalSection := range page.RailSections {
		sectionKey := strings.TrimSpace(originalSection.RailSectionKey)
		if sectionKey == "" || sectionKey == "conversations" {
			continue
		}
		originalPath := strings.TrimSpace(originalSection.ProjectPath)
		label := userprojectbiz.LabelFromPath(originalPath)
		available := false
		if project, found := projectsBySectionKey[sectionKey]; found {
			available = true
			if currentLabel := strings.TrimSpace(project.Label); currentLabel != "" {
				label = currentLabel
			}
		}
		if label == "" {
			label = sectionKey
		}
		projectOptions = append(projectOptions, DeletedSessionProjectOption{
			RailSectionKey:   sectionKey,
			ProjectPath:      originalPath,
			ProjectLabel:     label,
			ProjectAvailable: available,
		})
	}

	sessions := make([]DeletedSessionSummary, 0, len(page.Sessions))
	for _, session := range page.Sessions {
		sessions = append(sessions, DeletedSessionSummary{
			AgentSessionID:    session.AgentSessionID,
			Title:             session.Title,
			RailSectionKey:    session.RailSectionKey,
			ProjectPath:       session.ProjectPath,
			UpdatedAtUnixMS:   session.UpdatedAtUnixMS,
			DeletedAtUnixMS:   session.DeletedAtUnixMS,
			Restorable:        session.Restorable,
			UnavailableReason: session.UnavailableReason,
		})
	}

	return DeletedSessionPage{
		Sessions:            sessions,
		ProjectOptions:      projectOptions,
		TotalCount:          page.TotalCount,
		WorkspaceTotalCount: page.WorkspaceTotalCount,
		HasMore:             page.HasMore,
		NextCursor:          page.NextCursor,
	}, nil
}

func (s *Service) RestoreDeletedSession(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
) (RestoreDeletedSessionResult, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return RestoreDeletedSessionResult{}, ErrInvalidArgument
	}
	result, err := s.ApplicationHost().RestoreDeletedSession(ctx, agenthost.RestoreDeletedSessionInput{
		WorkspaceID: workspaceID, AgentSessionID: agentSessionID,
	})
	if err != nil {
		return RestoreDeletedSessionResult{}, err
	}
	return RestoreDeletedSessionResult{Restored: result.Restored}, nil
}
