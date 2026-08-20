package tuttimodeplan

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	workflowbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceworkflow"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	"github.com/tutti-os/tutti/services/tuttid/service/cli/framework"
	tuttimodeexecutionservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeexecution"
	tuttimodeplanservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeplan"
	workspaceservice "github.com/tutti-os/tutti/services/tuttid/service/workspace"
)

const maxPlanFileSize = 1 << 20

// nextActionStop tells the agent to end its turn: the user's review decision
// arrives later as a new user message, never through an agent-side wait.
const nextActionStop = "stop"

type proposeInput struct {
	File      string `cli:"file" validate:"required" description:"Absolute path to the complete tutti-mode-plan/v1 Markdown plan (narrative body plus tasks frontmatter)."`
	RequestID string `cli:"request-id" validate:"required" description:"Stable mutation id. Reuse it when retrying this proposal; use a new value for an intentional new proposal."`
}

type reviseInput struct {
	WorkflowID string `cli:"workflow-id" validate:"required" description:"Workflow id returned by plan propose."`
	File       string `cli:"file" validate:"required" description:"Absolute path to the replacement tutti-mode-plan/v1 Markdown revision file."`
	RequestID  string `cli:"request-id" validate:"required" description:"Stable mutation id. Reuse it when retrying this revision; use a new value for an intentional new revision."`
}

type getInput struct {
	WorkflowID string `cli:"workflow-id" validate:"required" description:"Workflow id returned by plan propose."`
}

type issueScheduleInput struct {
	IssueID               string `cli:"issue-id" validate:"required" description:"Tutti-owned Issue id."`
	CheckpointID          string `cli:"checkpoint-id" validate:"required" description:"Active execution checkpoint being resolved."`
	ExpectedGraphRevision int64  `cli:"expected-graph-revision" validate:"required,min=1" description:"Current execution graph revision."`
	TaskIDsJSON           string `cli:"task-ids-json" validate:"required" description:"JSON array containing exactly the task ids to admit."`
	RequestID             string `cli:"request-id" validate:"required" description:"Stable schedule mutation id. Reuse it only with the identical payload."`
}

type issueMutateInput struct {
	IssueID               string `cli:"issue-id" validate:"required" description:"Tutti-owned Issue id."`
	CheckpointID          string `cli:"checkpoint-id" validate:"required" description:"Active execution checkpoint to rebind."`
	ExpectedGraphRevision int64  `cli:"expected-graph-revision" validate:"required,min=1" description:"Current execution graph revision."`
	OperationsJSON        string `cli:"operations-json" validate:"required" description:"JSON array whose entries use the kind field: add includes task, update includes taskId and task, rework includes taskId plus task whose taskId names the replacement, and supersede includes taskId. The op and replacement keys are invalid."`
	RequestID             string `cli:"request-id" validate:"required" description:"Stable graph mutation id. Reuse it only with the identical payload."`
}

type issueAcknowledgeInput struct {
	IssueID               string `cli:"issue-id" validate:"required" description:"Tutti-owned Issue id."`
	CheckpointID          string `cli:"checkpoint-id" validate:"required" description:"Active task-settlement checkpoint being acknowledged."`
	ExpectedGraphRevision int64  `cli:"expected-graph-revision" validate:"required,min=1" description:"Current execution graph revision."`
	RequestID             string `cli:"request-id" validate:"required" description:"Stable acknowledge mutation id. Reuse it only with the identical payload."`
}

type issueCompleteInput struct {
	IssueID               string `cli:"issue-id" validate:"required" description:"Tutti-owned Issue id."`
	CheckpointID          string `cli:"checkpoint-id" validate:"required" description:"Active Goal Review checkpoint being completed."`
	ExpectedGraphRevision int64  `cli:"expected-graph-revision" validate:"required,min=1" description:"Current execution graph revision."`
	RequestID             string `cli:"request-id" validate:"required" description:"Stable completion mutation id. Reuse it only with the identical payload."`
	Decision              string `cli:"decision" validate:"required" enum:"goal_satisfied" description:"Explicit source-Agent Goal Review decision."`
	DisagreementReason    string `cli:"disagreement-reason" description:"Audited reason required when overriding a negative or inconclusive independent recommendation."`
}

type issueStopInput struct {
	IssueID               string `cli:"issue-id" validate:"required" description:"Tutti-owned Issue id."`
	CheckpointID          string `cli:"checkpoint-id" validate:"required" description:"Active execution checkpoint at which the source Agent decided to stop."`
	ExpectedGraphRevision int64  `cli:"expected-graph-revision" validate:"required,min=1" description:"Current execution graph revision."`
	RequestID             string `cli:"request-id" validate:"required" description:"Stable stop mutation id. Reuse it only with the identical reason."`
	Reason                string `cli:"reason" validate:"required" description:"Audited reason the Issue should stop without Goal Review completion."`
}

func (p Provider) newProposeCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[proposeInput]{
		ID:          appID + ".plan.propose",
		Path:        []string{"plan", "propose"},
		Summary:     "Propose a Tutti Mode plan",
		Description: "Create a durable Tutti-owned workflow from one complete tutti-mode-plan/v1 Markdown document (plan narrative plus the full task graph in the tasks frontmatter) and open the single user review checkpoint.",
		Kind:        framework.KindAction,
		Visibility:  cliservice.CapabilityVisibilityPublic,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[proposeInput](),
		Output:      planJSONOutput(framework.ViewSummary),
		Run:         p.runPropose,
	})
}

func (p Provider) newReviseCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[reviseInput]{
		ID:          appID + ".plan.revise",
		Path:        []string{"plan", "revise"},
		Summary:     "Revise a Tutti Mode plan",
		Description: "Append an immutable replacement plan document (narrative plus full task graph) after the user requests changes, creating the next review checkpoint.",
		Kind:        framework.KindAction,
		Visibility:  cliservice.CapabilityVisibilityPublic,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[reviseInput](),
		Output:      planJSONOutput(framework.ViewSummary),
		Run:         p.runRevise,
	})
}

func (p Provider) newGetCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[getInput]{
		ID:          appID + ".plan.get",
		Path:        []string{"plan", "get"},
		Summary:     "Get a Tutti Mode plan",
		Description: "Read the authoritative durable workflow, current Markdown revision, checkpoint, and follow-up operation state.",
		Kind:        framework.KindGet,
		Visibility:  cliservice.CapabilityVisibilityPublic,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[getInput](),
		Output:      planJSONOutput(framework.ViewDetail),
		Run:         p.runGet,
	})
}

func (p Provider) newIssueScheduleCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[issueScheduleInput]{
		ID:          appID + ".plan.issue.schedule",
		Path:        []string{"plan", "issue", "schedule"},
		Summary:     "Schedule exact Tutti Mode Issue tasks",
		Description: "Atomically admit exactly the requested ready tasks from the active execution checkpoint. Caller authority comes from the invoking Agent session.",
		Kind:        framework.KindAction,
		Visibility:  cliservice.CapabilityVisibilityPublic,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[issueScheduleInput](),
		Output:      planJSONOutput(framework.ViewSummary),
		Run:         p.runIssueSchedule,
	})
}

func (p Provider) newIssueMutateCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[issueMutateInput]{
		ID:          appID + ".plan.issue.mutate",
		Path:        []string{"plan", "issue", "mutate"},
		Summary:     "Mutate a Tutti Mode Issue graph",
		Description: "Atomically mutate the active graph with exact source-session, checkpoint, and revision fencing. Supersession preserves task and Run history.",
		Kind:        framework.KindAction,
		Visibility:  cliservice.CapabilityVisibilityPublic,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[issueMutateInput](),
		Output:      planJSONOutput(framework.ViewSummary),
		Run:         p.runIssueMutate,
	})
}

func (p Provider) newIssueAcknowledgeCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[issueAcknowledgeInput]{
		ID:          appID + ".plan.issue.acknowledge",
		Path:        []string{"plan", "issue", "acknowledge"},
		Summary:     "Acknowledge a Tutti Mode Issue checkpoint",
		Description: "Resolve the active task-settlement checkpoint without admitting work. Caller authority comes from the invoking Agent session; Goal Review cannot be acknowledged with this command.",
		Kind:        framework.KindAction,
		Visibility:  cliservice.CapabilityVisibilityPublic,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[issueAcknowledgeInput](),
		Output:      planJSONOutput(framework.ViewSummary),
		Run:         p.runIssueAcknowledge,
	})
}

func (p Provider) newIssueCompleteCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[issueCompleteInput]{
		ID:          appID + ".plan.issue.complete",
		Path:        []string{"plan", "issue", "complete"},
		Summary:     "Complete a Tutti Mode Goal Review",
		Description: "Complete the active Goal Review only after the source Agent concludes the goal is satisfied. Caller authority comes from the invoking Agent session.",
		Kind:        framework.KindAction,
		Visibility:  cliservice.CapabilityVisibilityPublic,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[issueCompleteInput](),
		Output:      planJSONOutput(framework.ViewSummary),
		Run:         p.runIssueComplete,
	})
}

func (p Provider) newIssueStopCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[issueStopInput]{
		ID:          appID + ".plan.issue.stop",
		Path:        []string{"plan", "issue", "stop"},
		Summary:     "Stop a Tutti Mode Issue",
		Description: "Stop and durably archive an Issue that should not continue, canceling open Runs and closing checkpoint wakes. Caller authority comes from the invoking source Agent session and is fenced by the active checkpoint and graph revision.",
		Kind:        framework.KindAction,
		Visibility:  cliservice.CapabilityVisibilityPublic,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[issueStopInput](),
		Output:      planJSONOutput(framework.ViewSummary),
		Run:         p.runIssueStop,
	})
}

func planJSONOutput(view framework.OutputView) framework.OutputSpec {
	return framework.OutputSpec{
		DefaultMode: cliservice.OutputModeJSON,
		DefaultView: view,
		JSON:        true,
		JSONViews: map[framework.OutputView]func(any) map[string]any{
			view: func(result any) map[string]any {
				return result.(map[string]any)
			},
		},
	}
}

func (p Provider) runPropose(ctx context.Context, invoke framework.InvokeContext, input proposeInput) (any, error) {
	if err := p.requirePlans(); err != nil {
		return nil, err
	}
	sessionID, err := callerAgentSessionID(invoke)
	if err != nil {
		return nil, err
	}
	if err := p.requireTuttiModeActive(ctx, invoke.WorkspaceID, sessionID); err != nil {
		return nil, err
	}
	turnID, err := p.callerActiveTurnID(ctx, invoke.WorkspaceID, sessionID)
	if err != nil {
		return nil, err
	}
	markdown, err := readPlanFile(input.File)
	if err != nil {
		return nil, err
	}
	result, err := p.plans.Propose(ctx, tuttimodeplanservice.ProposeInput{
		WorkspaceID:     invoke.WorkspaceID,
		SourceSessionID: sessionID,
		SourceTurnID:    turnID,
		RequestID:       input.RequestID,
		Markdown:        markdown,
	})
	if err != nil {
		return nil, agentPlanError(err)
	}
	return proposalJSON(result), nil
}

func (p Provider) runRevise(ctx context.Context, invoke framework.InvokeContext, input reviseInput) (any, error) {
	if err := p.requirePlans(); err != nil {
		return nil, err
	}
	sessionID, err := callerAgentSessionID(invoke)
	if err != nil {
		return nil, err
	}
	if err := p.requireTuttiModeActive(ctx, invoke.WorkspaceID, sessionID); err != nil {
		return nil, err
	}
	turnID, err := p.callerActiveTurnID(ctx, invoke.WorkspaceID, sessionID)
	if err != nil {
		return nil, err
	}
	markdown, err := readPlanFile(input.File)
	if err != nil {
		return nil, err
	}
	result, err := p.plans.ReviseFromAgent(ctx, tuttimodeplanservice.AgentReviseInput{
		WorkspaceID:      invoke.WorkspaceID,
		WorkflowID:       input.WorkflowID,
		AgentSessionID:   sessionID,
		ProducedByTurnID: turnID,
		RequestID:        input.RequestID,
		Markdown:         markdown,
	})
	if err != nil {
		return nil, agentPlanError(err)
	}
	return revisionJSON(result), nil
}

func (p Provider) runGet(ctx context.Context, invoke framework.InvokeContext, input getInput) (any, error) {
	if err := p.requirePlans(); err != nil {
		return nil, err
	}
	sessionID, err := callerAgentSessionID(invoke)
	if err != nil {
		return nil, err
	}
	view, err := p.plans.GetViewForAgent(ctx, tuttimodeplanservice.AgentGetInput{
		WorkspaceID: invoke.WorkspaceID, WorkflowID: input.WorkflowID, AgentSessionID: sessionID,
	})
	if err != nil {
		return nil, agentPlanError(err)
	}
	return snapshotJSON(view, ""), nil
}

func (p Provider) runIssueSchedule(
	ctx context.Context,
	invoke framework.InvokeContext,
	input issueScheduleInput,
) (any, error) {
	if err := p.requireSchedules(); err != nil {
		return nil, err
	}
	sessionID, err := callerAgentSessionID(invoke)
	if err != nil {
		return nil, err
	}
	if err := p.requireTuttiModeActive(ctx, invoke.WorkspaceID, sessionID); err != nil {
		return nil, err
	}
	var taskIDs []string
	if err := json.Unmarshal([]byte(input.TaskIDsJSON), &taskIDs); err != nil || len(taskIDs) == 0 {
		return nil, cliservice.InvalidInputKeyError("task-ids-json")
	}
	result, err := p.schedules.ScheduleTuttiModeIssue(
		ctx,
		invoke.WorkspaceID,
		workspaceservice.ScheduleTuttiModeIssueInput{
			IssueID:               input.IssueID,
			SourceSessionID:       sessionID,
			CheckpointID:          input.CheckpointID,
			ExpectedGraphRevision: input.ExpectedGraphRevision,
			TaskIDs:               taskIDs,
			RequestID:             input.RequestID,
		},
	)
	if err != nil {
		return nil, agentScheduleError(err, input.IssueID)
	}
	return map[string]any{
		"executionId":   result.ExecutionID,
		"checkpointId":  result.CheckpointID,
		"graphRevision": result.GraphRevision,
		"runIds":        append([]string(nil), result.RunIDs...),
		"replayed":      result.Replayed,
	}, nil
}

func (p Provider) runIssueMutate(
	ctx context.Context,
	invoke framework.InvokeContext,
	input issueMutateInput,
) (any, error) {
	if err := p.requireMutations(); err != nil {
		return nil, err
	}
	sessionID, err := callerAgentSessionID(invoke)
	if err != nil {
		return nil, err
	}
	if err := p.requireTuttiModeActive(ctx, invoke.WorkspaceID, sessionID); err != nil {
		return nil, err
	}
	operations, err := parseMutationOperationsJSON(input.OperationsJSON)
	if err != nil {
		return nil, err
	}
	result, err := p.mutations.MutateTuttiModeIssue(
		ctx,
		invoke.WorkspaceID,
		workspaceservice.MutateTuttiModeIssueInput{
			IssueID: input.IssueID, SourceSessionID: sessionID,
			CheckpointID:          input.CheckpointID,
			ExpectedGraphRevision: input.ExpectedGraphRevision,
			Operations:            operations, RequestID: input.RequestID,
		},
	)
	if err != nil {
		return nil, agentMutationError(err, input.IssueID)
	}
	return map[string]any{
		"executionId": result.ExecutionID, "checkpointId": result.CheckpointID,
		"graphRevision": result.GraphRevision, "addedTaskIds": result.AddedTaskIDs,
		"updatedTaskIds":    result.UpdatedTaskIDs,
		"supersededTaskIds": result.SupersededTaskIDs, "replayed": result.Replayed,
	}, nil
}

func (p Provider) runIssueAcknowledge(
	ctx context.Context,
	invoke framework.InvokeContext,
	input issueAcknowledgeInput,
) (any, error) {
	if err := p.requireAcknowledgements(); err != nil {
		return nil, err
	}
	sessionID, err := callerAgentSessionID(invoke)
	if err != nil {
		return nil, err
	}
	result, err := p.acknowledgements.Acknowledge(ctx, tuttimodeexecutionservice.AcknowledgeInput{
		WorkspaceID: invoke.WorkspaceID, IssueID: input.IssueID,
		SourceSessionID: sessionID, CheckpointID: input.CheckpointID,
		ExpectedGraphRevision: input.ExpectedGraphRevision, RequestID: input.RequestID,
	})
	if err != nil {
		return nil, agentAcknowledgeError(err)
	}
	return map[string]any{
		"executionId": result.ExecutionID, "checkpointId": result.CheckpointID,
		"graphRevision": result.GraphRevision, "nextCheckpointId": result.NextCheckpointID,
		"nextCheckpointKind":  string(result.NextCheckpointKind),
		"nextCheckpointState": string(result.NextCheckpointState),
		"replayed":            result.Replayed,
	}, nil
}

func (p Provider) runIssueComplete(
	ctx context.Context,
	invoke framework.InvokeContext,
	input issueCompleteInput,
) (any, error) {
	if err := p.requireCompletions(); err != nil {
		return nil, err
	}
	sessionID, err := callerAgentSessionID(invoke)
	if err != nil {
		return nil, err
	}
	result, err := p.completions.Complete(ctx, tuttimodeexecutionservice.CompleteInput{
		WorkspaceID: invoke.WorkspaceID, IssueID: input.IssueID,
		SourceSessionID: sessionID, CheckpointID: input.CheckpointID,
		ExpectedGraphRevision: input.ExpectedGraphRevision,
		RequestID:             input.RequestID, Decision: input.Decision,
		DisagreementReason: input.DisagreementReason,
	})
	if err != nil {
		return nil, agentCompleteError(err)
	}
	return map[string]any{
		"executionId": result.ExecutionID, "checkpointId": result.CheckpointID,
		"graphRevision": result.GraphRevision, "decision": result.Decision,
		"replayed": result.Replayed,
	}, nil
}

func (p Provider) runIssueStop(
	ctx context.Context,
	invoke framework.InvokeContext,
	input issueStopInput,
) (any, error) {
	if err := p.requireArchives(); err != nil {
		return nil, err
	}
	sessionID, err := callerAgentSessionID(invoke)
	if err != nil {
		return nil, err
	}
	operation, err := p.archives.Archive(ctx, tuttimodeexecutionservice.ArchiveInput{
		WorkspaceID: invoke.WorkspaceID, IssueID: input.IssueID,
		SourceSessionID: sessionID, CheckpointID: input.CheckpointID,
		ExpectedGraphRevision: input.ExpectedGraphRevision,
		RequestID:             input.RequestID,
		Reason:                input.Reason,
	})
	if err != nil {
		return nil, agentStopError(err)
	}
	return map[string]any{
		"executionId": operation.ExecutionID, "issueId": operation.IssueID,
		"operationId": operation.OperationID, "requestId": operation.RequestID,
		"status": string(operation.Status), "reason": operation.Reason,
	}, nil
}

// callerActiveTurnID is the authority for the immutable preference snapshot
// that a new proposal or revision must copy. Agent-authored plan mutations fail
// closed when the exact active Turn cannot be proven; otherwise omitting the
// provenance would also bypass preference consistency validation.
func (p Provider) callerActiveTurnID(ctx context.Context, workspaceID string, sessionID string) (string, error) {
	if p.turns == nil {
		return "", cliservice.ServiceUnavailableError(
			"Tutti Mode source Turn resolver is unavailable",
			nil,
		)
	}
	turnID, err := p.turns.PersistedActiveTurnID(ctx, workspaceID, sessionID)
	if err != nil {
		return "", cliservice.ServiceUnavailableError(
			"Tutti Mode source Turn is unavailable",
			err,
		)
	}
	turnID = strings.TrimSpace(turnID)
	if turnID == "" {
		return "", cliservice.InvalidInputReasonError(
			"tutti_mode_source_turn_unavailable",
			"Tutti Mode plan mutations must run inside the active Agent Turn so its exact effect and speed snapshot can be verified. Start a new Tutti Mode Turn and retry.",
			nil,
		)
	}
	return turnID, nil
}

func callerAgentSessionID(invoke framework.InvokeContext) (string, error) {
	sessionID := strings.TrimSpace(invoke.Request.Context.AgentSessionID)
	if sessionID == "" {
		return "", cliservice.MissingRequiredInputError("agent-session-id")
	}
	return sessionID, nil
}

func readPlanFile(path string) ([]byte, error) {
	path = strings.TrimSpace(path)
	if path == "" || !filepath.IsAbs(path) {
		return nil, cliservice.InvalidInputKeyError("file")
	}
	file, err := os.Open(filepath.Clean(path))
	if err != nil {
		return nil, cliservice.WorkspaceOperationError("read Tutti Mode Plan file", err)
	}
	defer file.Close()
	contents, err := io.ReadAll(io.LimitReader(file, maxPlanFileSize+1))
	if err != nil {
		return nil, cliservice.WorkspaceOperationError("read Tutti Mode Plan file", err)
	}
	if len(contents) > maxPlanFileSize {
		return nil, fmt.Errorf("%w: plan file exceeds %d bytes", cliservice.ErrInvalidInput, maxPlanFileSize)
	}
	return contents, nil
}

func proposalJSON(result tuttimodeplanservice.ProposalResult) map[string]any {
	checkpoint := latestCheckpoint(result.Snapshot.Checkpoints, result.Snapshot.Workflow.CurrentRevisionID)
	return map[string]any{
		"workflowId":        result.Snapshot.Workflow.ID,
		"requestId":         result.RequestID,
		"replayed":          result.Replayed,
		"status":            string(result.Snapshot.Workflow.Status),
		"currentRevisionId": result.Snapshot.Workflow.CurrentRevisionID,
		"checkpoint":        checkpointJSON(checkpoint),
		"revision": map[string]any{
			"phase": string(result.Document.Phase),
			"title": result.Document.Title,
		},
		"nextAction": nextActionStop,
	}
}

func revisionJSON(result tuttimodeplanservice.RevisionResult) map[string]any {
	return map[string]any{
		"workflowId":        result.Snapshot.Workflow.ID,
		"requestId":         result.RequestID,
		"replayed":          result.Replayed,
		"status":            string(result.Snapshot.Workflow.Status),
		"currentRevisionId": result.Revision.ID,
		"checkpoint":        checkpointJSON(result.Checkpoint),
		"revision": map[string]any{
			"id":           result.Revision.ID,
			"sequence":     result.Revision.Sequence,
			"phase":        string(result.Document.Phase),
			"title":        result.Document.Title,
			"documentPath": result.Revision.DocumentPath,
			"sha256":       result.Revision.SHA256,
		},
		"nextAction": nextActionStop,
	}
}

func snapshotJSON(view tuttimodeplanservice.SnapshotView, nextAction string) map[string]any {
	checkpoint := latestCheckpoint(view.Checkpoints, view.Workflow.CurrentRevisionID)
	if nextAction == "" {
		nextAction = nextActionForCheckpoint(checkpoint)
	}
	value := map[string]any{
		"workflowId":        view.Workflow.ID,
		"status":            string(view.Workflow.Status),
		"currentRevisionId": view.Workflow.CurrentRevisionID,
		"checkpoint":        checkpointJSON(checkpoint),
		"nextAction":        nextAction,
		"operations":        operationJSON(view.Operations),
	}
	for _, revision := range view.Revisions {
		if revision.Revision.ID == view.Workflow.CurrentRevisionID {
			value["revision"] = map[string]any{
				"id":           revision.Revision.ID,
				"sequence":     revision.Revision.Sequence,
				"phase":        string(revision.Document.Phase),
				"title":        revision.Document.Title,
				"documentPath": revision.Revision.DocumentPath,
				"sha256":       revision.Revision.SHA256,
			}
			break
		}
	}
	return value
}

func checkpointJSON(checkpoint workflowbiz.WorkflowCheckpoint) map[string]any {
	return map[string]any{
		"id":             checkpoint.ID,
		"kind":           string(checkpoint.Kind),
		"status":         string(checkpoint.Status),
		"decisionReason": checkpoint.DecisionReason,
	}
}

func operationJSON(operations []workflowbiz.WorkflowOperation) []map[string]any {
	result := make([]map[string]any, 0, len(operations))
	for _, operation := range operations {
		result = append(result, singleOperationJSON(operation))
	}
	return result
}

func singleOperationJSON(operation workflowbiz.WorkflowOperation) map[string]any {
	return map[string]any{
		"id":           operation.ID,
		"kind":         string(operation.Kind),
		"status":       string(operation.Status),
		"issueId":      operation.IssueID,
		"errorCode":    operation.ErrorCode,
		"errorMessage": operation.ErrorMessage,
	}
}

func latestCheckpoint(checkpoints []workflowbiz.WorkflowCheckpoint, revisionID string) workflowbiz.WorkflowCheckpoint {
	for index := len(checkpoints) - 1; index >= 0; index-- {
		if checkpoints[index].RevisionID == revisionID {
			return checkpoints[index]
		}
	}
	return workflowbiz.WorkflowCheckpoint{}
}

func nextActionForCheckpoint(checkpoint workflowbiz.WorkflowCheckpoint) string {
	if checkpoint.Status == workflowbiz.CheckpointStatusPending {
		return nextActionStop
	}
	next, ok := tuttimodeplanservice.NextActionForCheckpoint(checkpoint)
	if !ok {
		return ""
	}
	return string(next)
}
