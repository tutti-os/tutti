package agent

import (
	"context"
	"strings"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

type ListMessagesInput struct {
	MessageID     string
	TurnID        string
	AfterVersion  uint64
	BeforeVersion uint64
	Limit         int
	Order         agentactivitybiz.MessageOrder
}

const defaultListMessagesLimit = 100

type SessionMessagesPage struct {
	AgentSessionID string
	Messages       []SessionMessage
	LatestVersion  uint64
	HasMore        bool
}

type GeneratedFile struct {
	Path  string
	Label string
}

type GeneratedFileList struct {
	WorkspaceID string
	Files       []GeneratedFile
	HasMore     bool
	NextCursor  string
}

type ListGeneratedFilesInput struct {
	Query          string
	SectionKey     string
	AgentTargetIDs []string
	Cursor         string
	Limit          int
}

const MaxGeneratedFileAgentTargetFilters = 100

type MessageReader interface {
	ListSessionMessages(
		input agentactivitybiz.ListSessionMessagesInput,
	) (SessionMessagesPage, bool)
}

type GeneratedFileTurnReader interface {
	ListWorkspaceGeneratedFileTurns(
		ctx context.Context,
		input agentactivitybiz.ListWorkspaceGeneratedFileTurnsInput,
	) (agentactivitybiz.GeneratedFileTurnList, bool)
}

func (s *Service) ListMessages(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	input ListMessagesInput,
) (SessionMessagesPage, error) {
	if err := ctx.Err(); err != nil {
		return SessionMessagesPage{}, err
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return SessionMessagesPage{}, ErrInvalidArgument
	}
	if input.Limit < 0 {
		return SessionMessagesPage{}, ErrInvalidArgument
	}
	if input.Order == "" {
		input.Order = agentactivitybiz.MessageOrderAsc
	}
	if input.Order != agentactivitybiz.MessageOrderAsc && input.Order != agentactivitybiz.MessageOrderDesc {
		return SessionMessagesPage{}, ErrInvalidArgument
	}
	if input.Order == agentactivitybiz.MessageOrderAsc && input.BeforeVersion > 0 {
		return SessionMessagesPage{}, ErrInvalidArgument
	}
	if input.Order == agentactivitybiz.MessageOrderDesc && input.AfterVersion > 0 {
		return SessionMessagesPage{}, ErrInvalidArgument
	}
	if input.Limit == 0 {
		input.Limit = defaultListMessagesLimit
	}
	if s.MessageReader != nil {
		page, ok := s.MessageReader.ListSessionMessages(agentactivitybiz.ListSessionMessagesInput{
			WorkspaceID:    workspaceID,
			AgentSessionID: agentSessionID,
			MessageID:      strings.TrimSpace(input.MessageID),
			TurnID:         strings.TrimSpace(input.TurnID),
			AfterVersion:   input.AfterVersion,
			BeforeVersion:  input.BeforeVersion,
			Limit:          input.Limit,
			Order:          input.Order,
		})
		if ok {
			if err := ctx.Err(); err != nil {
				return SessionMessagesPage{}, err
			}
			if strings.TrimSpace(page.AgentSessionID) == "" {
				page.AgentSessionID = agentSessionID
			}
			page.Messages = cloneSessionMessages(page.Messages)
			return page, nil
		}
	}

	exists, err := s.sessionExists(ctx, workspaceID, agentSessionID)
	if err != nil {
		return SessionMessagesPage{}, err
	}
	if !exists {
		return SessionMessagesPage{}, ErrSessionNotFound
	}
	return emptySessionMessagesPage(agentSessionID, input), nil
}

func (s *Service) ListGeneratedFiles(
	ctx context.Context,
	workspaceID string,
	input ListGeneratedFilesInput,
) (GeneratedFileList, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	sectionKey := strings.TrimSpace(input.SectionKey)
	if workspaceID == "" || sectionKey == "" || sectionKey == agentactivitybiz.PinnedSessionPageKey || input.Limit < 0 {
		return GeneratedFileList{}, ErrInvalidArgument
	}
	if input.Limit == 0 {
		input.Limit = 30
	}
	if input.Limit > 100 {
		input.Limit = 100
	}
	agentTargetIDs := uniqueNonEmptyStrings(input.AgentTargetIDs)
	if input.AgentTargetIDs != nil && len(agentTargetIDs) == 0 {
		return GeneratedFileList{}, ErrInvalidArgument
	}
	if len(agentTargetIDs) > MaxGeneratedFileAgentTargetFilters {
		return GeneratedFileList{}, ErrInvalidArgument
	}
	offset, err := parseGeneratedFilesCursor(input.Cursor)
	if err != nil {
		return GeneratedFileList{}, ErrInvalidArgument
	}
	reader, ok := s.MessageReader.(GeneratedFileTurnReader)
	if !ok || reader == nil {
		return GeneratedFileList{
			WorkspaceID: workspaceID,
			Files:       []GeneratedFile{},
		}, nil
	}
	base, ok := s.cachedGeneratedFilesBase(ctx, reader, workspaceID, sectionKey)
	if !ok {
		return GeneratedFileList{
			WorkspaceID: workspaceID,
			Files:       []GeneratedFile{},
		}, nil
	}
	return pageGeneratedFiles(workspaceID, base, strings.TrimSpace(input.Query), agentTargetIDs, offset, input.Limit), nil
}

func uniqueNonEmptyStrings(values []string) []string {
	result := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, raw := range values {
		value := strings.TrimSpace(raw)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

func (s *Service) sessionExists(ctx context.Context, workspaceID string, agentSessionID string) (bool, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return false, nil
	}
	if s.SessionReader == nil {
		_, ok := s.controller().Session(workspaceID, agentSessionID)
		return ok, nil
	}
	deleted, err := s.SessionReader.SessionDeleted(ctx, workspaceID, agentSessionID)
	if err != nil {
		return false, err
	}
	if deleted {
		return false, nil
	}
	if _, ok := s.controller().Session(workspaceID, agentSessionID); ok {
		return true, nil
	}
	_, ok := s.SessionReader.GetSession(workspaceID, agentSessionID)
	return ok, nil
}

func emptySessionMessagesPage(agentSessionID string, input ListMessagesInput) SessionMessagesPage {
	latestVersion := input.AfterVersion
	if input.Order == agentactivitybiz.MessageOrderDesc {
		latestVersion = 0
	}
	return SessionMessagesPage{
		AgentSessionID: agentSessionID,
		Messages:       []SessionMessage{},
		LatestVersion:  latestVersion,
		HasMore:        false,
	}
}
