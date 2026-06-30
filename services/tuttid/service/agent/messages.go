package agent

import (
	"context"
	"strings"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

type ListMessagesInput struct {
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
}

type ListGeneratedFilesInput struct {
	Query      string
	SessionCwd string
	Limit      int
}

type MessageReader interface {
	ListSessionMessages(
		input agentactivitybiz.ListSessionMessagesInput,
	) (SessionMessagesPage, bool)
}

type GeneratedFileReader interface {
	ListWorkspaceGeneratedFiles(
		input agentactivitybiz.ListWorkspaceGeneratedFilesInput,
	) (GeneratedFileList, bool)
}

func (s *Service) ListMessages(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	input ListMessagesInput,
) (SessionMessagesPage, error) {
	_ = ctx
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
			TurnID:         strings.TrimSpace(input.TurnID),
			AfterVersion:   input.AfterVersion,
			BeforeVersion:  input.BeforeVersion,
			Limit:          input.Limit,
			Order:          input.Order,
		})
		if ok {
			if strings.TrimSpace(page.AgentSessionID) == "" {
				page.AgentSessionID = agentSessionID
			}
			page.Messages = cloneSessionMessages(page.Messages)
			return page, nil
		}
	}

	if !s.sessionExists(workspaceID, agentSessionID) {
		return SessionMessagesPage{}, ErrSessionNotFound
	}
	return emptySessionMessagesPage(agentSessionID, input), nil
}

func (s *Service) ListGeneratedFiles(
	ctx context.Context,
	workspaceID string,
	input ListGeneratedFilesInput,
) (GeneratedFileList, error) {
	_ = ctx
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" || input.Limit < 0 {
		return GeneratedFileList{}, ErrInvalidArgument
	}
	if input.Limit == 0 {
		input.Limit = 30
	}
	if input.Limit > 100 {
		input.Limit = 100
	}
	reader, ok := s.MessageReader.(GeneratedFileReader)
	if !ok || reader == nil {
		return GeneratedFileList{
			WorkspaceID: workspaceID,
			Files:       []GeneratedFile{},
		}, nil
	}
	files, ok := reader.ListWorkspaceGeneratedFiles(agentactivitybiz.ListWorkspaceGeneratedFilesInput{
		WorkspaceID: workspaceID,
		Query:       strings.TrimSpace(input.Query),
		SessionCwd:  strings.TrimSpace(input.SessionCwd),
		Limit:       input.Limit,
	})
	if !ok {
		return GeneratedFileList{
			WorkspaceID: workspaceID,
			Files:       []GeneratedFile{},
		}, nil
	}
	files.WorkspaceID = workspaceID
	files.Files = cloneGeneratedFiles(files.Files)
	return files, nil
}

func (s *Service) sessionExists(workspaceID string, agentSessionID string) bool {
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return false
	}
	if _, ok := s.controller().Session(workspaceID, agentSessionID); ok {
		return true
	}
	if s.SessionReader == nil {
		return false
	}
	_, ok := s.SessionReader.GetSession(workspaceID, agentSessionID)
	return ok
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
