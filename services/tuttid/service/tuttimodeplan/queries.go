package tuttimodeplan

import (
	"context"
	"fmt"
	"strings"

	workflowbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceworkflow"
)

func (s *Service) Get(ctx context.Context, input GetInput) (workflowbiz.Snapshot, error) {
	if err := s.ready(); err != nil {
		return workflowbiz.Snapshot{}, err
	}
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.WorkflowID = strings.TrimSpace(input.WorkflowID)
	if input.WorkspaceID == "" || input.WorkflowID == "" {
		return workflowbiz.Snapshot{}, fmt.Errorf("%w: workspace and workflow are required", ErrInvalidInput)
	}
	return s.Store.GetWorkspaceWorkflowSnapshot(ctx, input.WorkspaceID, input.WorkflowID)
}

func (s *Service) GetView(ctx context.Context, input GetInput) (SnapshotView, error) {
	snapshot, err := s.Get(ctx, input)
	if err != nil {
		return SnapshotView{}, err
	}
	return s.viewFromSnapshot(snapshot)
}

func (s *Service) viewFromSnapshot(snapshot workflowbiz.Snapshot) (SnapshotView, error) {
	view := SnapshotView{
		Workflow:    snapshot.Workflow,
		Plan:        snapshot.Plan,
		Revisions:   make([]RevisionView, 0, len(snapshot.Revisions)),
		Checkpoints: append([]workflowbiz.WorkflowCheckpoint(nil), snapshot.Checkpoints...),
		TurnLinks:   append([]workflowbiz.WorkflowTurnLink(nil), snapshot.TurnLinks...),
		Operations:  append([]workflowbiz.WorkflowOperation(nil), snapshot.Operations...),
	}
	for _, revision := range snapshot.Revisions {
		raw, readErr := s.Revisions.Read(snapshot.Workflow.ID, revision.DocumentPath, revision.SHA256)
		if readErr != nil {
			return SnapshotView{}, readErr
		}
		document, parseErr := ParsePlanMarkdown(raw)
		if parseErr != nil {
			return SnapshotView{}, parseErr
		}
		if document.Schema != revision.SchemaVersion {
			return SnapshotView{}, ErrRevisionDigestMismatch
		}
		view.Revisions = append(view.Revisions, RevisionView{Revision: revision, Document: document})
	}
	view.ActionableItems = ProjectActionableItems(view)
	return view, nil
}

func (s *Service) ListPendingBySourceSession(ctx context.Context, workspaceID string, sourceSessionID string) ([]SnapshotView, error) {
	if err := s.ready(); err != nil {
		return nil, err
	}
	workspaceID = strings.TrimSpace(workspaceID)
	sourceSessionID = strings.TrimSpace(sourceSessionID)
	if workspaceID == "" || sourceSessionID == "" {
		return nil, fmt.Errorf("%w: workspace and source session are required", ErrInvalidInput)
	}
	pending, err := s.Store.ListPendingWorkflowCheckpointsBySourceSession(ctx, workspaceID, sourceSessionID)
	if err != nil {
		return nil, err
	}
	result := make([]SnapshotView, 0, len(pending))
	seen := make(map[string]struct{}, len(pending))
	for _, item := range pending {
		workflowID := strings.TrimSpace(item.Workflow.ID)
		if workflowID == "" {
			continue
		}
		if _, exists := seen[workflowID]; exists {
			continue
		}
		seen[workflowID] = struct{}{}
		view, viewErr := s.GetView(ctx, GetInput{WorkspaceID: workspaceID, WorkflowID: workflowID})
		if viewErr != nil {
			return nil, viewErr
		}
		result = append(result, view)
	}
	return result, nil
}

func (s *Service) ListBySourceSession(ctx context.Context, workspaceID string, sourceSessionID string) ([]SnapshotView, error) {
	if err := s.ready(); err != nil {
		return nil, err
	}
	workspaceID = strings.TrimSpace(workspaceID)
	sourceSessionID = strings.TrimSpace(sourceSessionID)
	if workspaceID == "" || sourceSessionID == "" {
		return nil, fmt.Errorf("%w: workspace and source session are required", ErrInvalidInput)
	}
	workflows, err := s.Store.ListWorkflowsBySourceSession(ctx, workspaceID, sourceSessionID)
	if err != nil {
		return nil, err
	}
	result := make([]SnapshotView, 0, len(workflows))
	for _, workflow := range workflows {
		workflowID := strings.TrimSpace(workflow.ID)
		if workflowID == "" {
			continue
		}
		view, viewErr := s.GetView(ctx, GetInput{WorkspaceID: workspaceID, WorkflowID: workflowID})
		if viewErr != nil {
			return nil, viewErr
		}
		result = append(result, view)
	}
	return result, nil
}
