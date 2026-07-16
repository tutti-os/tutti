package api

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/google/uuid"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	workflowbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceworkflow"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	tuttimodeplanservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeplan"
)

type TuttiModePlanService interface {
	GetView(context.Context, tuttimodeplanservice.GetInput) (tuttimodeplanservice.SnapshotView, error)
	ListPendingBySourceSession(context.Context, string, string) ([]tuttimodeplanservice.SnapshotView, error)
	Decide(context.Context, tuttimodeplanservice.DecideInput) (tuttimodeplanservice.DecisionResult, error)
}

func (api DaemonAPI) ListWorkspaceWorkflows(ctx context.Context, request tuttigenerated.ListWorkspaceWorkflowsRequestObject) (tuttigenerated.ListWorkspaceWorkflowsResponseObject, error) {
	if status := request.Params.CheckpointStatus; status != nil && !status.Valid() {
		return tuttigenerated.ListWorkspaceWorkflows400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.MalformedRequest(apierrors.WithDeveloperMessage("checkpointStatus must be pending")),
			),
		}, nil
	}
	if api.TuttiModePlanService == nil {
		return tuttigenerated.ListWorkspaceWorkflows503JSONResponse{ServiceUnavailableErrorJSONResponse: workflowServiceUnavailable()}, nil
	}
	views, err := api.TuttiModePlanService.ListPendingBySourceSession(ctx, request.WorkspaceID, request.Params.SourceSessionId)
	if err != nil {
		return listWorkspaceWorkflowsError(err), nil
	}
	workflows := make([]tuttigenerated.WorkspaceWorkflowSnapshot, 0, len(views))
	for _, view := range views {
		projected, projectionErr := generatedWorkspaceWorkflowSnapshot(view)
		if projectionErr != nil {
			return listWorkspaceWorkflowsError(projectionErr), nil
		}
		workflows = append(workflows, projected)
	}
	return tuttigenerated.ListWorkspaceWorkflows200JSONResponse{Workflows: workflows}, nil
}

func (api DaemonAPI) GetWorkspaceWorkflow(ctx context.Context, request tuttigenerated.GetWorkspaceWorkflowRequestObject) (tuttigenerated.GetWorkspaceWorkflowResponseObject, error) {
	if api.TuttiModePlanService == nil {
		return tuttigenerated.GetWorkspaceWorkflow503JSONResponse{ServiceUnavailableErrorJSONResponse: workflowServiceUnavailable()}, nil
	}
	view, err := api.TuttiModePlanService.GetView(ctx, tuttimodeplanservice.GetInput{
		WorkspaceID: request.WorkspaceID,
		WorkflowID:  request.WorkflowID.String(),
	})
	if err != nil {
		return getWorkspaceWorkflowError(err), nil
	}
	projected, err := generatedWorkspaceWorkflowSnapshot(view)
	if err != nil {
		return getWorkspaceWorkflowError(err), nil
	}
	return tuttigenerated.GetWorkspaceWorkflow200JSONResponse(projected), nil
}

func (api DaemonAPI) DecideWorkspaceWorkflowCheckpoint(ctx context.Context, request tuttigenerated.DecideWorkspaceWorkflowCheckpointRequestObject) (tuttigenerated.DecideWorkspaceWorkflowCheckpointResponseObject, error) {
	if request.Body == nil {
		return tuttigenerated.DecideWorkspaceWorkflowCheckpoint400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody())}, nil
	}
	if !request.Body.Decision.Valid() {
		return tuttigenerated.DecideWorkspaceWorkflowCheckpoint400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.MalformedRequest(apierrors.WithDeveloperMessage("decision must be accepted, rejected, or canceled")),
			),
		}, nil
	}
	if api.TuttiModePlanService == nil {
		return tuttigenerated.DecideWorkspaceWorkflowCheckpoint503JSONResponse{ServiceUnavailableErrorJSONResponse: workflowServiceUnavailable()}, nil
	}
	reason := ""
	if request.Body.Reason != nil {
		reason = *request.Body.Reason
	}
	_, err := api.TuttiModePlanService.Decide(ctx, tuttimodeplanservice.DecideInput{
		WorkspaceID:    request.WorkspaceID,
		WorkflowID:     request.WorkflowID.String(),
		CheckpointID:   request.CheckpointID.String(),
		Decision:       workflowbiz.CheckpointStatus(request.Body.Decision),
		DecidedBy:      request.Body.DecidedBy,
		DecisionReason: reason,
	})
	if err != nil {
		return decideWorkspaceWorkflowError(err), nil
	}
	view, err := api.TuttiModePlanService.GetView(ctx, tuttimodeplanservice.GetInput{
		WorkspaceID: request.WorkspaceID,
		WorkflowID:  request.WorkflowID.String(),
	})
	if err != nil {
		return decideWorkspaceWorkflowError(err), nil
	}
	projected, err := generatedWorkspaceWorkflowSnapshot(view)
	if err != nil {
		return decideWorkspaceWorkflowError(err), nil
	}
	return tuttigenerated.DecideWorkspaceWorkflowCheckpoint200JSONResponse(projected), nil
}

func generatedWorkspaceWorkflowSnapshot(view tuttimodeplanservice.SnapshotView) (tuttigenerated.WorkspaceWorkflowSnapshot, error) {
	workflowID, err := uuid.Parse(view.Workflow.ID)
	if err != nil {
		return tuttigenerated.WorkspaceWorkflowSnapshot{}, fmt.Errorf("invalid persisted workflow id %q: %w", view.Workflow.ID, err)
	}
	currentRevisionID, err := uuid.Parse(view.Workflow.CurrentRevisionID)
	if err != nil {
		return tuttigenerated.WorkspaceWorkflowSnapshot{}, fmt.Errorf("invalid persisted current revision id %q: %w", view.Workflow.CurrentRevisionID, err)
	}
	result := tuttigenerated.WorkspaceWorkflowSnapshot{
		Workflow: tuttigenerated.WorkspaceWorkflow{
			Id:                workflowID,
			WorkspaceId:       view.Workflow.WorkspaceID,
			Type:              tuttigenerated.WorkspaceWorkflowType(view.Workflow.Type),
			Owner:             tuttigenerated.WorkspaceWorkflowOwner(view.Workflow.Owner),
			TriggerKind:       tuttigenerated.WorkspaceWorkflowTriggerKind(view.Workflow.TriggerKind),
			SourceSessionId:   view.Workflow.SourceSessionID,
			SourceTurnId:      stringPointerIfNotBlank(view.Workflow.SourceTurnID),
			SourceToolCallId:  stringPointerIfNotBlank(view.Workflow.SourceToolCallID),
			Status:            tuttigenerated.WorkspaceWorkflowStatus(view.Workflow.Status),
			CurrentRevisionId: currentRevisionID,
			CreatedAtUnixMs:   view.Workflow.CreatedAt.UnixMilli(),
			UpdatedAtUnixMs:   view.Workflow.UpdatedAt.UnixMilli(),
		},
		Revisions:       make([]tuttigenerated.WorkspaceWorkflowPlanRevision, 0, len(view.Revisions)),
		Checkpoints:     make([]tuttigenerated.WorkspaceWorkflowCheckpoint, 0, len(view.Checkpoints)),
		TurnLinks:       make([]tuttigenerated.WorkspaceWorkflowTurnLink, 0, len(view.TurnLinks)),
		Operations:      make([]tuttigenerated.WorkspaceWorkflowOperation, 0, len(view.Operations)),
		ActionableItems: make([]tuttigenerated.WorkspaceWorkflowActionableItem, 0, len(view.ActionableItems)),
	}
	for _, revision := range view.Revisions {
		if err := validateFiniteWorkflowBudget(revision.Document.Budget); err != nil {
			return tuttigenerated.WorkspaceWorkflowSnapshot{}, err
		}
		id, parseErr := uuid.Parse(revision.Revision.ID)
		if parseErr != nil {
			return tuttigenerated.WorkspaceWorkflowSnapshot{}, parseErr
		}
		revisionWorkflowID, parseErr := uuid.Parse(revision.Revision.WorkflowID)
		if parseErr != nil {
			return tuttigenerated.WorkspaceWorkflowSnapshot{}, parseErr
		}
		result.Revisions = append(result.Revisions, tuttigenerated.WorkspaceWorkflowPlanRevision{
			Id:               id,
			WorkflowId:       revisionWorkflowID,
			Sequence:         revision.Revision.Sequence,
			SchemaVersion:    tuttigenerated.WorkspaceWorkflowPlanRevisionSchemaVersion(revision.Revision.SchemaVersion),
			DocumentPath:     revision.Revision.DocumentPath,
			Sha256:           revision.Revision.SHA256,
			ProducedByTurnId: stringPointerIfNotBlank(revision.Revision.ProducedByTurnID),
			CreatedAtUnixMs:  revision.Revision.CreatedAt.UnixMilli(),
			Document:         generatedTuttiModePlanDocument(revision.Document),
		})
	}
	for _, checkpoint := range view.Checkpoints {
		id, parseErr := uuid.Parse(checkpoint.ID)
		if parseErr != nil {
			return tuttigenerated.WorkspaceWorkflowSnapshot{}, parseErr
		}
		checkpointWorkflowID, parseErr := uuid.Parse(checkpoint.WorkflowID)
		if parseErr != nil {
			return tuttigenerated.WorkspaceWorkflowSnapshot{}, parseErr
		}
		revisionID, parseErr := uuid.Parse(checkpoint.RevisionID)
		if parseErr != nil {
			return tuttigenerated.WorkspaceWorkflowSnapshot{}, parseErr
		}
		result.Checkpoints = append(result.Checkpoints, tuttigenerated.WorkspaceWorkflowCheckpoint{
			Id:              id,
			WorkflowId:      checkpointWorkflowID,
			Kind:            tuttigenerated.WorkspaceWorkflowCheckpointKind(checkpoint.Kind),
			RevisionId:      revisionID,
			Status:          tuttigenerated.WorkspaceWorkflowCheckpointStatus(checkpoint.Status),
			DecidedBy:       stringPointerIfNotBlank(checkpoint.DecidedBy),
			DecisionReason:  stringPointerIfNotBlank(checkpoint.DecisionReason),
			CreatedAtUnixMs: checkpoint.CreatedAt.UnixMilli(),
			UpdatedAtUnixMs: checkpoint.UpdatedAt.UnixMilli(),
			DecidedAtUnixMs: unixMilliPointer(checkpoint.DecidedAt),
		})
	}
	for _, link := range view.TurnLinks {
		linkWorkflowID, parseErr := uuid.Parse(link.WorkflowID)
		if parseErr != nil {
			return tuttigenerated.WorkspaceWorkflowSnapshot{}, parseErr
		}
		result.TurnLinks = append(result.TurnLinks, tuttigenerated.WorkspaceWorkflowTurnLink{
			WorkflowId:      linkWorkflowID,
			TurnId:          link.TurnID,
			Relation:        tuttigenerated.WorkspaceWorkflowTurnLinkRelation(link.Relation),
			CreatedAtUnixMs: link.CreatedAt.UnixMilli(),
		})
	}
	for _, operation := range view.Operations {
		id, parseErr := uuid.Parse(operation.ID)
		if parseErr != nil {
			return tuttigenerated.WorkspaceWorkflowSnapshot{}, parseErr
		}
		operationWorkflowID, parseErr := uuid.Parse(operation.WorkflowID)
		if parseErr != nil {
			return tuttigenerated.WorkspaceWorkflowSnapshot{}, parseErr
		}
		var revisionID *uuid.UUID
		if strings.TrimSpace(operation.RevisionID) != "" {
			parsed, revisionErr := uuid.Parse(operation.RevisionID)
			if revisionErr != nil {
				return tuttigenerated.WorkspaceWorkflowSnapshot{}, revisionErr
			}
			revisionID = &parsed
		}
		result.Operations = append(result.Operations, tuttigenerated.WorkspaceWorkflowOperation{
			Id:                id,
			WorkflowId:        operationWorkflowID,
			Kind:              tuttigenerated.WorkspaceWorkflowOperationKind(operation.Kind),
			Status:            tuttigenerated.WorkspaceWorkflowOperationStatus(operation.Status),
			RevisionId:        revisionID,
			IssueId:           stringPointerIfNotBlank(operation.IssueID),
			ErrorCode:         stringPointerIfNotBlank(operation.ErrorCode),
			ErrorMessage:      stringPointerIfNotBlank(operation.ErrorMessage),
			CreatedAtUnixMs:   operation.CreatedAt.UnixMilli(),
			UpdatedAtUnixMs:   operation.UpdatedAt.UnixMilli(),
			StartedAtUnixMs:   unixMilliPointer(operation.StartedAt),
			CompletedAtUnixMs: unixMilliPointer(operation.CompletedAt),
		})
	}
	for _, item := range view.ActionableItems {
		if err := validateFiniteWorkflowBudget(item.Budget); err != nil {
			return tuttigenerated.WorkspaceWorkflowSnapshot{}, err
		}
		itemWorkflowID, parseErr := uuid.Parse(item.SourceWorkflowID)
		if parseErr != nil {
			return tuttigenerated.WorkspaceWorkflowSnapshot{}, parseErr
		}
		itemRevisionID, parseErr := uuid.Parse(item.SourceRevisionID)
		if parseErr != nil {
			return tuttigenerated.WorkspaceWorkflowSnapshot{}, parseErr
		}
		result.ActionableItems = append(result.ActionableItems, tuttigenerated.WorkspaceWorkflowActionableItem{
			Id:               item.ID,
			SourceWorkflowId: itemWorkflowID,
			SourceRevisionId: itemRevisionID,
			Ordinal:          item.Ordinal,
			TopicId:          item.TopicID,
			Execution:        generatedTuttiModePlanExecution(item.Execution),
			Budget:           generatedTuttiModePlanBudget(item.Budget),
			Task:             generatedTuttiModePlanTask(item.Task),
		})
	}
	return result, nil
}

func validateFiniteWorkflowBudget(budget tuttimodeplanservice.PlanBudget) error {
	if math.IsNaN(budget.QuotaWaterlinePercent) || math.IsInf(budget.QuotaWaterlinePercent, 0) {
		return fmt.Errorf("invalid persisted workflow quota waterline percentage")
	}
	return nil
}

func generatedTuttiModePlanDocument(document tuttimodeplanservice.PlanDocument) tuttigenerated.TuttiModePlanDocument {
	tasks := make([]tuttigenerated.TuttiModePlanTask, 0, len(document.Tasks))
	for _, task := range document.Tasks {
		tasks = append(tasks, generatedTuttiModePlanTask(task))
	}
	return tuttigenerated.TuttiModePlanDocument{
		Schema:       tuttigenerated.TuttiModePlanDocumentSchema(document.Schema),
		Phase:        tuttigenerated.TuttiModePlanDocumentPhase(document.Phase),
		Title:        document.Title,
		TopicId:      document.TopicID,
		MarkdownBody: document.Body,
		Execution:    generatedTuttiModePlanExecution(document.Execution),
		Budget:       generatedTuttiModePlanBudget(document.Budget),
		Tasks:        tasks,
	}
}

func generatedTuttiModePlanExecution(execution tuttimodeplanservice.PlanExecution) tuttigenerated.TuttiModePlanExecution {
	return tuttigenerated.TuttiModePlanExecution{
		Mode:                   tuttigenerated.TuttiModePlanExecutionMode(execution.Mode),
		ReasoningIntensity:     execution.ReasoningIntensity,
		OrchestrationIntensity: execution.OrchestrationIntensity,
	}
}

func generatedTuttiModePlanBudget(budget tuttimodeplanservice.PlanBudget) tuttigenerated.TuttiModePlanBudget {
	return tuttigenerated.TuttiModePlanBudget{
		Mode:                  tuttigenerated.TuttiModePlanBudgetMode(budget.Mode),
		TokenLimit:            budget.TokenLimit,
		QuotaWaterlinePercent: budget.QuotaWaterlinePercent,
	}
}

func generatedTuttiModePlanTask(task tuttimodeplanservice.PlanTask) tuttigenerated.TuttiModePlanTask {
	return tuttigenerated.TuttiModePlanTask{
		Id:                 task.ID,
		Title:              task.Title,
		Content:            task.Content,
		Priority:           tuttigenerated.TuttiModePlanTaskPriority(task.Priority),
		AgentTargetId:      stringPointerIfNotBlank(task.AgentTargetID),
		ModelPlanId:        stringPointerIfNotBlank(task.ModelPlanID),
		Model:              stringPointerIfNotBlank(task.Model),
		ExecutionDirectory: stringPointerIfNotBlank(task.ExecutionDirectory),
		DependsOn:          append([]string{}, task.DependsOn...),
	}
}

func unixMilliPointer(value time.Time) *int64 {
	if value.IsZero() {
		return nil
	}
	result := value.UnixMilli()
	return &result
}

func workflowServiceUnavailable() tuttigenerated.ServiceUnavailableErrorJSONResponse {
	return serviceUnavailableError(apierrors.ServiceUnavailable("workspace_workflow_service_unavailable"))
}

func workflowProtocolError(err error) *apierrors.ProtocolError {
	switch {
	case errors.Is(err, tuttimodeplanservice.ErrInvalidInput), errors.Is(err, tuttimodeplanservice.ErrInvalidDecision), errors.Is(err, tuttimodeplanservice.ErrInvalidTransition):
		return apierrors.InvalidRequest("invalid_workspace_workflow_request", apierrors.WithCause(err))
	case errors.Is(err, workspacedata.ErrWorkspaceWorkflowNotFound), errors.Is(err, workspacedata.ErrWorkflowCheckpointNotFound), errors.Is(err, tuttimodeplanservice.ErrCheckpointMissing):
		return apierrors.WorkspaceNotFound("workspace_workflow_not_found", apierrors.WithCause(err))
	default:
		return apierrors.WorkspaceOperationFailed(apierrors.WithCause(err))
	}
}

func listWorkspaceWorkflowsError(err error) tuttigenerated.ListWorkspaceWorkflowsResponseObject {
	protocolErr := workflowProtocolError(err)
	if protocolErr.Code == tuttigenerated.InvalidRequest {
		return tuttigenerated.ListWorkspaceWorkflows400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	}
	if protocolErr.Code == tuttigenerated.WorkspaceNotFound {
		return tuttigenerated.ListWorkspaceWorkflows404JSONResponse{WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr)}
	}
	return tuttigenerated.ListWorkspaceWorkflows502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
}

func getWorkspaceWorkflowError(err error) tuttigenerated.GetWorkspaceWorkflowResponseObject {
	protocolErr := workflowProtocolError(err)
	if protocolErr.Code == tuttigenerated.InvalidRequest {
		return tuttigenerated.GetWorkspaceWorkflow400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	}
	if protocolErr.Code == tuttigenerated.WorkspaceNotFound {
		return tuttigenerated.GetWorkspaceWorkflow404JSONResponse{WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr)}
	}
	return tuttigenerated.GetWorkspaceWorkflow502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
}

func decideWorkspaceWorkflowError(err error) tuttigenerated.DecideWorkspaceWorkflowCheckpointResponseObject {
	if errors.Is(err, tuttimodeplanservice.ErrDecisionConflict) {
		return tuttigenerated.DecideWorkspaceWorkflowCheckpoint409JSONResponse(protocolErrorResponse(apierrors.InvalidRequest("workspace_workflow_decision_conflict", apierrors.WithCause(err))))
	}
	protocolErr := workflowProtocolError(err)
	if protocolErr.Code == tuttigenerated.InvalidRequest {
		return tuttigenerated.DecideWorkspaceWorkflowCheckpoint400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	}
	if protocolErr.Code == tuttigenerated.WorkspaceNotFound {
		return tuttigenerated.DecideWorkspaceWorkflowCheckpoint404JSONResponse{WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr)}
	}
	return tuttigenerated.DecideWorkspaceWorkflowCheckpoint502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
}
