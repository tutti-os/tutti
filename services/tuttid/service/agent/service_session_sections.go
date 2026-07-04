package agent

import (
	"context"
	"fmt"
	"strings"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	userprojectbiz "github.com/tutti-os/tutti/services/tuttid/biz/userproject"
)

const (
	sessionSectionKindConversations = "conversations"
	sessionSectionKindProject       = "project"
	sessionSectionKeyConversations  = "conversations"
)

func (s *Service) ListSessionSections(
	ctx context.Context,
	workspaceID string,
	input ListSessionSectionsInput,
) (SessionSectionsPage, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" || input.LimitPerSection <= 0 {
		return SessionSectionsPage{}, ErrInvalidArgument
	}
	agentTargetID := strings.TrimSpace(input.AgentTargetID)
	projects, err := s.currentUserProjects(ctx)
	if err != nil {
		return SessionSectionsPage{}, err
	}
	sections := make([]SessionSection, 0, len(projects)+1)
	for _, project := range projects {
		project = userProjectWithSectionKey(project)
		section, err := s.sessionSectionPage(ctx, workspaceID, sessionSectionKindProject, project.SectionKey, &project, "", input.LimitPerSection, agentTargetID)
		if err != nil {
			return SessionSectionsPage{}, err
		}
		sections = append(sections, section)
	}
	conversations, err := s.sessionSectionPage(ctx, workspaceID, sessionSectionKindConversations, sessionSectionKeyConversations, nil, "", input.LimitPerSection, agentTargetID)
	if err != nil {
		return SessionSectionsPage{}, err
	}
	sections = append(sections, conversations)
	return SessionSectionsPage{
		WorkspaceID: workspaceID,
		Sections:    sections,
	}, nil
}

func (s *Service) ListSessionSectionPage(
	ctx context.Context,
	workspaceID string,
	input ListSessionSectionPageInput,
) (SessionSection, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	sectionKey := strings.TrimSpace(input.SectionKey)
	if workspaceID == "" || sectionKey == "" || input.Limit <= 0 {
		return SessionSection{}, ErrInvalidArgument
	}
	agentTargetID := strings.TrimSpace(input.AgentTargetID)
	if sectionKey == sessionSectionKeyConversations {
		return s.sessionSectionPage(ctx, workspaceID, sessionSectionKindConversations, sectionKey, nil, input.Cursor, input.Limit, agentTargetID)
	}
	projects, err := s.currentUserProjects(ctx)
	if err != nil {
		return SessionSection{}, err
	}
	for _, project := range projects {
		project = userProjectWithSectionKey(project)
		if project.SectionKey == sectionKey {
			return s.sessionSectionPage(ctx, workspaceID, sessionSectionKindProject, sectionKey, &project, input.Cursor, input.Limit, agentTargetID)
		}
	}
	return SessionSection{}, ErrInvalidArgument
}

func (s *Service) currentUserProjects(ctx context.Context) ([]userprojectbiz.Project, error) {
	if s.UserProjectReader == nil {
		return nil, fmt.Errorf("%w: user project reader is unavailable", ErrInvalidArgument)
	}
	projects, err := s.UserProjectReader.List(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]userprojectbiz.Project, 0, len(projects))
	for _, project := range projects {
		project = userProjectWithSectionKey(project)
		if strings.TrimSpace(project.SectionKey) != "" {
			result = append(result, project)
		}
	}
	return result, nil
}

func (s *Service) sessionSectionPage(
	ctx context.Context,
	workspaceID string,
	kind string,
	sectionKey string,
	project *userprojectbiz.Project,
	cursor string,
	limit int,
	agentTargetID string,
) (SessionSection, error) {
	reader, ok := s.SessionReader.(SessionSectionReader)
	if !ok {
		return SessionSection{}, fmt.Errorf("%w: session section reader is unavailable", ErrInvalidArgument)
	}
	parsedCursor := sessionPageCursor{}
	if strings.TrimSpace(cursor) != "" {
		var err error
		parsedCursor, err = parseSessionListCursor(cursor)
		if err != nil {
			return SessionSection{}, err
		}
	}
	page, ok := reader.ListSessionSection(ctx, agentactivitybiz.ListSessionSectionInput{
		WorkspaceID:       workspaceID,
		SectionKey:        sectionKey,
		AgentTargetID:     strings.TrimSpace(agentTargetID),
		CursorUpdatedAtMS: parsedCursor.UpdatedAtUnixMS,
		CursorSessionID:   parsedCursor.ID,
		Limit:             limit,
	})
	if !ok {
		return SessionSection{}, ErrInvalidArgument
	}
	return SessionSection{
		Kind:        kind,
		SectionKey:  sectionKey,
		UserProject: project,
		Sessions:    s.sessionsFromActivity(page.Sessions),
		HasMore:     page.HasMore,
		NextCursor:  page.NextCursor,
	}, nil
}

func (s *Service) sessionsFromActivity(sessions []agentactivitybiz.Session) []Session {
	result := make([]Session, 0, len(sessions))
	for _, session := range sessions {
		persisted := persistedSessionFromActivity(session)
		result = append(result, sessionFromPersisted(
			persisted,
			persistedSessionCanResume(s.controller(), persisted),
		))
	}
	return result
}

func userProjectWithSectionKey(project userprojectbiz.Project) userprojectbiz.Project {
	if strings.TrimSpace(project.SectionKey) == "" {
		project.SectionKey = userprojectbiz.SectionKeyFromPath(project.Path)
	}
	return project
}
