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
	sessionSectionDeletePageLimit   = 100
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
	pinned, err := s.sessionPinnedPage(ctx, workspaceID, "", input.LimitPerSection, agentTargetID)
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
		Pinned:      pinned,
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

func (s *Service) CountSessionSection(
	ctx context.Context,
	workspaceID string,
	input CountSessionSectionInput,
) (SessionSectionCount, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	sectionKey := strings.TrimSpace(input.SectionKey)
	if workspaceID == "" || sectionKey == "" {
		return SessionSectionCount{}, ErrInvalidArgument
	}
	if _, _, err := s.resolveSessionSectionScope(ctx, sectionKey); err != nil {
		return SessionSectionCount{}, err
	}
	counter, ok := s.SessionReader.(SessionSectionCounter)
	if !ok {
		return SessionSectionCount{}, fmt.Errorf("%w: session section counter is unavailable", ErrInvalidArgument)
	}
	count, ok := counter.CountSessionSection(ctx, agentactivitybiz.CountSessionSectionInput{
		WorkspaceID:   workspaceID,
		SectionKey:    sectionKey,
		AgentTargetID: strings.TrimSpace(input.AgentTargetID),
	})
	if !ok {
		return SessionSectionCount{}, ErrInvalidArgument
	}
	return SessionSectionCount{
		WorkspaceID:   workspaceID,
		SectionKey:    sectionKey,
		AgentTargetID: count.AgentTargetID,
		Count:         count.Count,
	}, nil
}

func (s *Service) DeleteSessionSection(
	ctx context.Context,
	workspaceID string,
	input DeleteSessionSectionInput,
) (DeleteSessionSectionResult, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	sectionKey := strings.TrimSpace(input.SectionKey)
	if workspaceID == "" || sectionKey == "" {
		return DeleteSessionSectionResult{}, ErrInvalidArgument
	}
	kind, project, err := s.resolveSessionSectionScope(ctx, sectionKey)
	if err != nil {
		return DeleteSessionSectionResult{}, err
	}
	agentTargetID := strings.TrimSpace(input.AgentTargetID)
	targetSessionIDs, err := s.sessionSectionIDsForDelete(ctx, workspaceID, kind, sectionKey, project, agentTargetID)
	if err != nil {
		return DeleteSessionSectionResult{}, err
	}
	for _, agentSessionID := range targetSessionIDs {
		if _, ok := s.controller().Session(workspaceID, agentSessionID); ok {
			if err := s.controller().Close(ctx, RuntimeCloseInput{
				WorkspaceID:    workspaceID,
				AgentSessionID: agentSessionID,
			}); err != nil {
				return DeleteSessionSectionResult{}, normalizeRuntimeError(err)
			}
		}
	}
	deleter, ok := s.SessionReader.(SessionSectionDeleter)
	if !ok {
		return DeleteSessionSectionResult{}, fmt.Errorf("%w: session section deleter is unavailable", ErrInvalidArgument)
	}
	result, ok := deleter.DeleteSessionSection(ctx, agentactivitybiz.DeleteSessionSectionInput{
		WorkspaceID:   workspaceID,
		SectionKey:    sectionKey,
		AgentTargetID: agentTargetID,
	})
	if !ok {
		return DeleteSessionSectionResult{}, ErrInvalidArgument
	}
	for _, agentSessionID := range result.RemovedSessionIDs {
		agentSessionID = strings.TrimSpace(agentSessionID)
		if agentSessionID == "" {
			continue
		}
		if err := s.cleanupRuntime(ctx, workspaceID, agentSessionID); err != nil {
			return DeleteSessionSectionResult{}, err
		}
	}
	return DeleteSessionSectionResult{
		WorkspaceID:       workspaceID,
		SectionKey:        sectionKey,
		AgentTargetID:     result.AgentTargetID,
		RemovedMessages:   result.RemovedMessages,
		RemovedSessions:   result.RemovedSessions,
		RemovedSessionIDs: result.RemovedSessionIDs,
	}, nil
}

func (s *Service) sessionSectionIDsForDelete(
	ctx context.Context,
	workspaceID string,
	kind string,
	sectionKey string,
	project *userprojectbiz.Project,
	agentTargetID string,
) ([]string, error) {
	ids := make([]string, 0)
	cursor := ""
	for {
		page, err := s.sessionSectionPage(
			ctx,
			workspaceID,
			kind,
			sectionKey,
			project,
			cursor,
			sessionSectionDeletePageLimit,
			agentTargetID,
		)
		if err != nil {
			return nil, err
		}
		for _, session := range page.Sessions {
			sessionID := strings.TrimSpace(session.ID)
			if sessionID != "" {
				ids = append(ids, sessionID)
			}
		}
		nextCursor := strings.TrimSpace(page.NextCursor)
		if !page.HasMore || nextCursor == "" || nextCursor == cursor {
			break
		}
		cursor = nextCursor
	}
	return ids, nil
}

func (s *Service) ListPinnedSessionPage(
	ctx context.Context,
	workspaceID string,
	input ListPinnedSessionPageInput,
) (SessionPage, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" || input.Limit <= 0 {
		return SessionPage{}, ErrInvalidArgument
	}
	return s.sessionPinnedPage(
		ctx,
		workspaceID,
		input.Cursor,
		input.Limit,
		strings.TrimSpace(input.AgentTargetID),
	)
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

func (s *Service) resolveSessionSectionScope(
	ctx context.Context,
	sectionKey string,
) (string, *userprojectbiz.Project, error) {
	sectionKey = strings.TrimSpace(sectionKey)
	if sectionKey == sessionSectionKeyConversations {
		return sessionSectionKindConversations, nil, nil
	}
	if sectionKey == "" || sectionKey == agentactivitybiz.PinnedSessionPageKey {
		return "", nil, ErrInvalidArgument
	}
	projects, err := s.currentUserProjects(ctx)
	if err != nil {
		return "", nil, err
	}
	for _, project := range projects {
		project = userProjectWithSectionKey(project)
		if project.SectionKey == sectionKey {
			return sessionSectionKindProject, &project, nil
		}
	}
	return "", nil, ErrInvalidArgument
}

func (s *Service) sessionPinnedPage(
	ctx context.Context,
	workspaceID string,
	cursor string,
	limit int,
	agentTargetID string,
) (SessionPage, error) {
	reader, ok := s.SessionReader.(SessionSectionReader)
	if !ok {
		return SessionPage{}, fmt.Errorf("%w: session section reader is unavailable", ErrInvalidArgument)
	}
	parsedCursor := sessionPageCursor{}
	if strings.TrimSpace(cursor) != "" {
		var err error
		parsedCursor, err = parseSessionListCursor(cursor)
		if err != nil {
			return SessionPage{}, err
		}
	}
	page, ok := reader.ListSessionSection(ctx, agentactivitybiz.ListSessionSectionInput{
		WorkspaceID:       workspaceID,
		SectionKey:        agentactivitybiz.PinnedSessionPageKey,
		AgentTargetID:     strings.TrimSpace(agentTargetID),
		CursorUpdatedAtMS: parsedCursor.UpdatedAtUnixMS,
		CursorSessionID:   parsedCursor.ID,
		Limit:             limit,
	})
	if !ok {
		return SessionPage{}, ErrInvalidArgument
	}
	return SessionPage{
		Sessions:   s.sessionsFromActivity(page.Sessions),
		HasMore:    page.HasMore,
		NextCursor: page.NextCursor,
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
