package tuttimodeplan

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"

	workflowbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceworkflow"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

const maxMutationRequestIDLength = 256

func validateMutationRequestID(requestID string) error {
	if requestID == "" || len(requestID) > maxMutationRequestIDLength {
		return fmt.Errorf("%w: request id must contain 1-%d bytes", ErrInvalidInput, maxMutationRequestIDLength)
	}
	return nil
}

func mutationInputSHA256(markdown []byte) string {
	digest := sha256.Sum256(markdown)
	return fmt.Sprintf("%x", digest[:])
}

func (s *Service) findMutation(
	ctx context.Context,
	input workspacedata.GetWorkspaceWorkflowMutationInput,
	inputSHA256 string,
) (workflowbiz.WorkflowMutation, bool, error) {
	mutation, found, err := s.Store.GetWorkspaceWorkflowMutation(ctx, input)
	if err != nil {
		return workflowbiz.WorkflowMutation{}, false, err
	}
	if !found {
		return workflowbiz.WorkflowMutation{}, false, nil
	}
	if !strings.EqualFold(mutation.InputSHA256, inputSHA256) {
		return workflowbiz.WorkflowMutation{}, false, ErrMutationConflict
	}
	return mutation, true, nil
}

func mutationStoreError(err error) error {
	if errors.Is(err, workspacedata.ErrWorkflowMutationConflict) {
		return ErrMutationConflict
	}
	return err
}

func (s *Service) proposalResultFromMutation(
	ctx context.Context,
	mutation workflowbiz.WorkflowMutation,
	replayed bool,
) (ProposalResult, error) {
	snapshot, err := s.Get(ctx, GetInput{WorkspaceID: mutation.WorkspaceID, WorkflowID: mutation.WorkflowID})
	if err != nil {
		return ProposalResult{}, err
	}
	revision, _, document, err := s.mutationRevisionResult(snapshot, mutation)
	if err != nil {
		return ProposalResult{}, err
	}
	// The checkpoint binding to the revision is already verified inside
	// mutationRevisionResult. Legacy two-phase proposals recorded a
	// configuration review, so replay accepts either review kind as long as
	// it is the initial revision.
	if revision.Sequence != 1 {
		return ProposalResult{}, fmt.Errorf("%w: proposal mutation does not reference an initial revision", ErrInvalidTransition)
	}
	return ProposalResult{
		Snapshot:  snapshot,
		Document:  document,
		RequestID: mutation.RequestID,
		Replayed:  replayed,
	}, nil
}

func (s *Service) revisionResultFromMutation(
	ctx context.Context,
	mutation workflowbiz.WorkflowMutation,
	replayed bool,
) (RevisionResult, error) {
	snapshot, err := s.Get(ctx, GetInput{WorkspaceID: mutation.WorkspaceID, WorkflowID: mutation.WorkflowID})
	if err != nil {
		return RevisionResult{}, err
	}
	revision, checkpoint, document, err := s.mutationRevisionResult(snapshot, mutation)
	if err != nil {
		return RevisionResult{}, err
	}
	return RevisionResult{
		Snapshot:   snapshot,
		Revision:   revision,
		Checkpoint: checkpoint,
		Document:   document,
		RequestID:  mutation.RequestID,
		Replayed:   replayed,
	}, nil
}

func (s *Service) mutationRevisionResult(
	snapshot workflowbiz.Snapshot,
	mutation workflowbiz.WorkflowMutation,
) (workflowbiz.PlanRevision, workflowbiz.WorkflowCheckpoint, PlanDocument, error) {
	revision, found := revisionByID(snapshot.Revisions, mutation.RevisionID)
	if !found {
		return workflowbiz.PlanRevision{}, workflowbiz.WorkflowCheckpoint{}, PlanDocument{},
			fmt.Errorf("%w: mutation revision was not found", ErrInvalidTransition)
	}
	checkpoint, found := checkpointByID(snapshot.Checkpoints, mutation.CheckpointID)
	if !found || checkpoint.RevisionID != revision.ID {
		return workflowbiz.PlanRevision{}, workflowbiz.WorkflowCheckpoint{}, PlanDocument{},
			fmt.Errorf("%w: mutation checkpoint was not found", ErrInvalidTransition)
	}
	raw, err := s.Revisions.Read(snapshot.Workflow.ID, revision.DocumentPath, revision.SHA256)
	if err != nil {
		return workflowbiz.PlanRevision{}, workflowbiz.WorkflowCheckpoint{}, PlanDocument{}, err
	}
	document, err := ParsePlanMarkdown(raw)
	if err != nil {
		return workflowbiz.PlanRevision{}, workflowbiz.WorkflowCheckpoint{}, PlanDocument{}, err
	}
	if document.Schema != revision.SchemaVersion {
		return workflowbiz.PlanRevision{}, workflowbiz.WorkflowCheckpoint{}, PlanDocument{}, ErrRevisionDigestMismatch
	}
	return revision, checkpoint, document, nil
}

func revisionByID(revisions []workflowbiz.PlanRevision, revisionID string) (workflowbiz.PlanRevision, bool) {
	for _, revision := range revisions {
		if revision.ID == revisionID {
			return revision, true
		}
	}
	return workflowbiz.PlanRevision{}, false
}
