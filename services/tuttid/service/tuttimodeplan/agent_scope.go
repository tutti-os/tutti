package tuttimodeplan

import (
	"context"
	"fmt"
	"strings"

	workflowbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceworkflow"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

// AgentReviseInput carries the caller Agent session separately from workflow
// provenance. Agent CLI operations may only mutate workflows sourced from the
// exact same session.
type AgentReviseInput struct {
	WorkspaceID      string
	WorkflowID       string
	AgentSessionID   string
	ProducedByTurnID string
	RequestID        string
	Markdown         []byte
}

type AgentGetInput struct {
	WorkspaceID    string
	WorkflowID     string
	AgentSessionID string
}

type AgentWaitInput struct {
	WorkspaceID    string
	WorkflowID     string
	CheckpointID   string
	AgentSessionID string
}

func (s *Service) ReviseFromAgent(ctx context.Context, input AgentReviseInput) (RevisionResult, error) {
	sessionID, err := requiredAgentSessionID(input.AgentSessionID)
	if err != nil {
		return RevisionResult{}, err
	}
	return s.revise(ctx, ReviseInput{
		WorkspaceID:      input.WorkspaceID,
		WorkflowID:       input.WorkflowID,
		ProducedByTurnID: input.ProducedByTurnID,
		RequestID:        input.RequestID,
		Markdown:         input.Markdown,
	}, sessionID)
}

func (s *Service) GetViewForAgent(ctx context.Context, input AgentGetInput) (SnapshotView, error) {
	sessionID, err := requiredAgentSessionID(input.AgentSessionID)
	if err != nil {
		return SnapshotView{}, err
	}
	snapshot, err := s.Get(ctx, GetInput{WorkspaceID: input.WorkspaceID, WorkflowID: input.WorkflowID})
	if err != nil {
		return SnapshotView{}, err
	}
	if err := requireWorkflowSourceSession(snapshot, sessionID); err != nil {
		return SnapshotView{}, err
	}
	return s.viewFromSnapshot(snapshot)
}

func (s *Service) WaitForAgent(ctx context.Context, input AgentWaitInput) (WaitResult, error) {
	sessionID, err := requiredAgentSessionID(input.AgentSessionID)
	if err != nil {
		return WaitResult{}, err
	}
	return s.wait(ctx, WaitInput{
		WorkspaceID:  input.WorkspaceID,
		WorkflowID:   input.WorkflowID,
		CheckpointID: input.CheckpointID,
	}, sessionID)
}

func requiredAgentSessionID(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", fmt.Errorf("%w: agent session is required", ErrInvalidInput)
	}
	return value, nil
}

func requireWorkflowSourceSession(snapshot workflowbiz.Snapshot, expectedSourceSessionID string) error {
	expectedSourceSessionID = strings.TrimSpace(expectedSourceSessionID)
	if expectedSourceSessionID == "" {
		return nil
	}
	if strings.TrimSpace(snapshot.Workflow.SourceSessionID) != expectedSourceSessionID {
		// Deliberately collapse a scope mismatch into not-found so Agent CLI
		// callers cannot use workflow ids to probe another session's plans.
		return workspacedata.ErrWorkspaceWorkflowNotFound
	}
	return nil
}
