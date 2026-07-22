package agent

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	userprojectbiz "github.com/tutti-os/tutti/services/tuttid/biz/userproject"
)

const (
	sessionSectionKindConversations = "conversations"
	sessionSectionKindProject       = "project"
	sessionSectionKeyConversations  = "conversations"
	sessionSectionsSlowLogThreshold = 250 * time.Millisecond
)

type sessionSectionsDiagnostics struct {
	currentProjectCount     int
	failureStage            string
	hydrateDuration         time.Duration
	nonEmptyProjectCount    int
	projectDuration         time.Duration
	railVisibleSessionCount int
	returnedSessionCount    int
	sectionCount            int
	storeDuration           time.Duration
}

func (s *Service) ListSessionSections(
	ctx context.Context,
	workspaceID string,
	input ListSessionSectionsInput,
) (result SessionSectionsPage, resultErr error) {
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" || input.LimitPerSection <= 0 {
		return SessionSectionsPage{}, ErrInvalidArgument
	}
	agentTargetID := strings.TrimSpace(input.AgentTargetID)
	startedAt := time.Now()
	diagnostics := &sessionSectionsDiagnostics{failureStage: "projects"}
	defer func() {
		logSessionSectionsDiagnostics(
			ctx,
			workspaceID,
			agentTargetID,
			input.LimitPerSection,
			time.Since(startedAt),
			diagnostics,
			resultErr,
		)
	}()
	projectsStartedAt := time.Now()
	projects, err := s.currentUserProjects(ctx)
	diagnostics.projectDuration = time.Since(projectsStartedAt)
	if err != nil {
		return SessionSectionsPage{}, err
	}
	diagnostics.failureStage = "reader"
	reader, ok := s.SessionReader.(SessionSectionsReader)
	if !ok {
		return SessionSectionsPage{}, ErrInvalidArgument
	}
	result, resultErr = s.listSessionSectionsBatched(
		ctx,
		reader,
		workspaceID,
		projects,
		input.LimitPerSection,
		agentTargetID,
		diagnostics,
	)
	return result, resultErr
}

func (s *Service) listSessionSectionsBatched(
	ctx context.Context,
	reader SessionSectionsReader,
	workspaceID string,
	projects []userprojectbiz.Project,
	limitPerSection int,
	agentTargetID string,
	diagnostics *sessionSectionsDiagnostics,
) (SessionSectionsPage, error) {
	normalizedProjects := make([]userprojectbiz.Project, 0, len(projects))
	sectionKeys := make([]string, 0, len(projects)+2)
	sectionKeys = append(sectionKeys, agentactivitybiz.PinnedSessionPageKey)
	for _, project := range projects {
		project = userProjectWithSectionKey(project)
		if strings.TrimSpace(project.SectionKey) == "" {
			continue
		}
		normalizedProjects = append(normalizedProjects, project)
		sectionKeys = append(sectionKeys, project.SectionKey)
	}
	sectionKeys = append(sectionKeys, sessionSectionKeyConversations)
	diagnostics.currentProjectCount = len(normalizedProjects)
	diagnostics.failureStage = "store"
	storeStartedAt := time.Now()
	page, ok, err := reader.ListSessionSections(ctx, agentactivitybiz.ListSessionSectionsInput{
		WorkspaceID:     workspaceID,
		SectionKeys:     sectionKeys,
		AgentTargetID:   strings.TrimSpace(agentTargetID),
		LimitPerSection: limitPerSection,
	})
	diagnostics.storeDuration = time.Since(storeStartedAt)
	if err != nil {
		return SessionSectionsPage{}, err
	}
	if !ok {
		return SessionSectionsPage{}, ErrInvalidArgument
	}
	rawPagesByKey := make(map[string]agentactivitybiz.SessionSectionPage, len(page.Sections))
	rawSessions := make([]agentactivitybiz.Session, 0, len(page.Sections)*limitPerSection)
	for _, section := range page.Sections {
		sectionKey := strings.TrimSpace(section.SectionKey)
		if sectionKey == "" {
			return SessionSectionsPage{}, ErrInvalidArgument
		}
		rawPagesByKey[sectionKey] = section
		rawSessions = append(rawSessions, section.Sessions...)
		diagnostics.railVisibleSessionCount += section.TotalCount
	}
	diagnostics.sectionCount = len(page.Sections)
	diagnostics.returnedSessionCount = len(rawSessions)
	for _, project := range normalizedProjects {
		if rawPage, ok := rawPagesByKey[project.SectionKey]; ok && rawPage.TotalCount > 0 {
			diagnostics.nonEmptyProjectCount++
		}
	}
	diagnostics.failureStage = "hydrate"
	hydrateStartedAt := time.Now()
	sessions, err := s.sessionsFromActivity(ctx, workspaceID, rawSessions)
	diagnostics.hydrateDuration = time.Since(hydrateStartedAt)
	if err != nil {
		return SessionSectionsPage{}, err
	}
	diagnostics.failureStage = "projection"
	sessionsByID := make(map[string]Session, len(sessions))
	for _, session := range sessions {
		sessionsByID[session.ID] = session
	}

	pinnedPage, ok := rawPagesByKey[agentactivitybiz.PinnedSessionPageKey]
	if !ok {
		return SessionSectionsPage{}, ErrInvalidArgument
	}
	pinnedSessions, ok := sessionsForSectionPage(pinnedPage, sessionsByID)
	if !ok {
		return SessionSectionsPage{}, ErrInvalidArgument
	}
	sections := make([]SessionSection, 0, len(normalizedProjects)+1)
	for i := range normalizedProjects {
		project := normalizedProjects[i]
		rawPage, ok := rawPagesByKey[project.SectionKey]
		if !ok {
			return SessionSectionsPage{}, ErrInvalidArgument
		}
		projectSessions, ok := sessionsForSectionPage(rawPage, sessionsByID)
		if !ok {
			return SessionSectionsPage{}, ErrInvalidArgument
		}
		sections = append(sections, SessionSection{
			Kind:        sessionSectionKindProject,
			SectionKey:  project.SectionKey,
			UserProject: &project,
			Sessions:    projectSessions,
			HasMore:     rawPage.HasMore,
			TotalCount:  rawPage.TotalCount,
			NextCursor:  rawPage.NextCursor,
		})
	}
	conversationsPage, ok := rawPagesByKey[sessionSectionKeyConversations]
	if !ok {
		return SessionSectionsPage{}, ErrInvalidArgument
	}
	conversationSessions, ok := sessionsForSectionPage(conversationsPage, sessionsByID)
	if !ok {
		return SessionSectionsPage{}, ErrInvalidArgument
	}
	sections = append(sections, SessionSection{
		Kind:       sessionSectionKindConversations,
		SectionKey: sessionSectionKeyConversations,
		Sessions:   conversationSessions,
		HasMore:    conversationsPage.HasMore,
		TotalCount: conversationsPage.TotalCount,
		NextCursor: conversationsPage.NextCursor,
	})
	result := SessionSectionsPage{
		WorkspaceID: workspaceID,
		Pinned: SessionPage{
			Sessions:   pinnedSessions,
			HasMore:    pinnedPage.HasMore,
			TotalCount: pinnedPage.TotalCount,
			NextCursor: pinnedPage.NextCursor,
		},
		Sections: sections,
	}
	diagnostics.failureStage = ""
	return result, nil
}

func logSessionSectionsDiagnostics(
	ctx context.Context,
	workspaceID string,
	agentTargetID string,
	limitPerSection int,
	duration time.Duration,
	diagnostics *sessionSectionsDiagnostics,
	err error,
) {
	if errors.Is(err, context.Canceled) || (err == nil && duration < sessionSectionsSlowLogThreshold) {
		return
	}
	status := "slow"
	event := "workspace.agent_session.sections.list_slow"
	message := "workspace agent session sections list slow"
	level := slog.LevelInfo
	if err != nil {
		status = "failed"
		event = "workspace.agent_session.sections.list_failed"
		message = "workspace agent session sections list failed"
		level = slog.LevelWarn
	}
	args := []any{
		"event", event,
		"workspace_id", workspaceID,
		"agent_target_id", agentTargetID,
		"target_filtered", agentTargetID != "",
		"limit_per_section", limitPerSection,
		"status", status,
		"failure_stage", diagnostics.failureStage,
		"duration_ms", duration.Milliseconds(),
		"projects_ms", diagnostics.projectDuration.Milliseconds(),
		"store_ms", diagnostics.storeDuration.Milliseconds(),
		"hydrate_ms", diagnostics.hydrateDuration.Milliseconds(),
		"current_project_count", diagnostics.currentProjectCount,
		"non_empty_project_count", diagnostics.nonEmptyProjectCount,
		"rail_visible_session_count", diagnostics.railVisibleSessionCount,
		"returned_session_count", diagnostics.returnedSessionCount,
		"section_count", diagnostics.sectionCount,
	}
	if err != nil {
		args = append(args, "error", err)
	}
	slog.Log(ctx, level, message, args...)
}

func sessionsForSectionPage(
	page agentactivitybiz.SessionSectionPage,
	sessionsByID map[string]Session,
) ([]Session, bool) {
	sessions := make([]Session, 0, len(page.Sessions))
	for _, rawSession := range page.Sessions {
		session, ok := sessionsByID[strings.TrimSpace(rawSession.ID)]
		if !ok {
			return nil, false
		}
		sessions = append(sessions, session)
	}
	return sessions, true
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

func (s *Service) ListSessionSectionDeletionCandidates(
	ctx context.Context,
	workspaceID string,
	input ListSessionSectionDeletionCandidatesInput,
) (SessionSectionDeletionCandidates, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	sectionKey := strings.TrimSpace(input.SectionKey)
	if workspaceID == "" || sectionKey == "" {
		return SessionSectionDeletionCandidates{}, ErrInvalidArgument
	}
	if _, _, err := s.resolveSessionSectionScope(ctx, sectionKey); err != nil {
		return SessionSectionDeletionCandidates{}, err
	}
	reader, ok := s.SessionReader.(SessionSectionDeletionCandidateReader)
	if !ok {
		return SessionSectionDeletionCandidates{}, fmt.Errorf("%w: session section deletion candidate reader is unavailable", ErrInvalidArgument)
	}
	candidates, ok := reader.ListSessionSectionDeletionCandidates(ctx, agentactivitybiz.ListSessionSectionDeletionCandidatesInput{
		WorkspaceID:   workspaceID,
		SectionKey:    sectionKey,
		AgentTargetID: strings.TrimSpace(input.AgentTargetID),
		ExcludePinned: input.ExcludePinned,
	})
	if !ok {
		return SessionSectionDeletionCandidates{}, ErrInvalidArgument
	}
	return SessionSectionDeletionCandidates{
		WorkspaceID:   workspaceID,
		SectionKey:    sectionKey,
		AgentTargetID: candidates.AgentTargetID,
		ExcludePinned: candidates.ExcludePinned,
		SessionIDs:    candidates.SessionIDs,
	}, nil
}

func (s *Service) DeleteSessionsBatch(
	ctx context.Context,
	workspaceID string,
	input DeleteSessionsBatchInput,
) (DeleteSessionsBatchResult, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	sessionIDs, err := normalizeSessionIDsForBatchDelete(input.SessionIDs)
	if workspaceID == "" || err != nil {
		return DeleteSessionsBatchResult{}, ErrInvalidArgument
	}
	result, err := s.ApplicationHost().DeleteSessions(ctx, agenthost.DeleteSessionsInput{
		WorkspaceID: workspaceID, SessionIDs: sessionIDs,
	})
	if err != nil {
		return DeleteSessionsBatchResult{}, err
	}
	return DeleteSessionsBatchResult{
		RemovedMessages:         result.RemovedMessages,
		RemovedSessions:         result.RemovedSessions,
		RemovedSessionIDs:       result.RemovedSessionIDs,
		CleanupFailedSessionIDs: result.CleanupFailedIDs,
	}, nil
}

func normalizeSessionIDsForBatchDelete(input []string) ([]string, error) {
	if len(input) == 0 {
		return nil, ErrInvalidArgument
	}
	result := make([]string, 0, len(input))
	seen := make(map[string]struct{}, len(input))
	for _, value := range input {
		sessionID := strings.TrimSpace(value)
		if sessionID == "" {
			return nil, ErrInvalidArgument
		}
		if _, exists := seen[sessionID]; exists {
			return nil, ErrInvalidArgument
		}
		seen[sessionID] = struct{}{}
		result = append(result, sessionID)
	}
	return result, nil
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
	page, ok, err := reader.ListSessionSection(ctx, agentactivitybiz.ListSessionSectionInput{
		WorkspaceID:          workspaceID,
		SectionKey:           sectionKey,
		AgentTargetID:        strings.TrimSpace(agentTargetID),
		CursorSortTimeUnixMS: parsedCursor.SortTimeUnixMS,
		CursorSessionID:      parsedCursor.ID,
		Limit:                limit,
	})
	if err != nil {
		return SessionSection{}, err
	}
	if !ok {
		return SessionSection{}, ErrInvalidArgument
	}
	sessions, err := s.sessionsFromActivity(ctx, workspaceID, page.Sessions)
	if err != nil {
		return SessionSection{}, err
	}
	return SessionSection{
		Kind:        kind,
		SectionKey:  sectionKey,
		UserProject: project,
		Sessions:    sessions,
		HasMore:     page.HasMore,
		TotalCount:  page.TotalCount,
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
	page, ok, err := reader.ListSessionSection(ctx, agentactivitybiz.ListSessionSectionInput{
		WorkspaceID:          workspaceID,
		SectionKey:           agentactivitybiz.PinnedSessionPageKey,
		AgentTargetID:        strings.TrimSpace(agentTargetID),
		CursorSortTimeUnixMS: parsedCursor.SortTimeUnixMS,
		CursorSessionID:      parsedCursor.ID,
		Limit:                limit,
	})
	if err != nil {
		return SessionPage{}, err
	}
	if !ok {
		return SessionPage{}, ErrInvalidArgument
	}
	sessions, err := s.sessionsFromActivity(ctx, workspaceID, page.Sessions)
	if err != nil {
		return SessionPage{}, err
	}
	return SessionPage{
		Sessions:   sessions,
		HasMore:    page.HasMore,
		TotalCount: page.TotalCount,
		NextCursor: page.NextCursor,
	}, nil
}

func (s *Service) sessionsFromActivity(ctx context.Context, workspaceID string, sessions []agentactivitybiz.Session) ([]Session, error) {
	result := make([]Session, 0, len(sessions))
	for _, session := range sessions {
		persisted := persistedSessionFromActivity(session)
		result = append(result, sessionFromPersisted(
			persisted,
			s.persistedSessionCanResume(ctx, persisted),
		))
	}
	return s.withProtocolV2TurnStates(ctx, workspaceID, result)
}

func userProjectWithSectionKey(project userprojectbiz.Project) userprojectbiz.Project {
	if strings.TrimSpace(project.SectionKey) == "" {
		project.SectionKey = userprojectbiz.SectionKeyFromPath(project.Path)
	}
	return project
}
