package tuttimodeplan

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	workflowbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceworkflow"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	"github.com/tutti-os/tutti/services/tuttid/service/cli/framework"
	tuttimodeplanservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeplan"
)

const (
	defaultWaitTimeout = 30 * time.Second
	maxWaitTimeout     = 60 * time.Second
	maxPlanFileSize    = 1 << 20
)

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

type waitInput struct {
	WorkflowID   string `cli:"workflow-id" validate:"required" description:"Workflow id returned by plan propose."`
	CheckpointID string `cli:"checkpoint-id" validate:"required" description:"Checkpoint id whose durable decision should be observed."`
	TimeoutMS    *int   `cli:"timeout-ms" default:"30000" validate:"min=0,max=60000" description:"Bounded long-poll timeout in milliseconds; defaults to 30000."`
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

func (p Provider) newWaitCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[waitInput]{
		ID:          appID + ".plan.wait",
		Path:        []string{"plan", "wait"},
		Summary:     "Wait for a Tutti Mode plan checkpoint",
		Description: "Long-poll a user-owned checkpoint for at most 60 seconds. This command can observe decisions but cannot approve its own proposal.",
		Kind:        framework.KindGet,
		Visibility:  cliservice.CapabilityVisibilityPublic,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[waitInput](),
		Output:      planJSONOutput(framework.ViewDetail),
		Run:         p.runWait,
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
	markdown, err := readPlanFile(input.File)
	if err != nil {
		return nil, err
	}
	result, err := p.plans.Propose(ctx, tuttimodeplanservice.ProposeInput{
		WorkspaceID:     invoke.WorkspaceID,
		SourceSessionID: sessionID,
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
	markdown, err := readPlanFile(input.File)
	if err != nil {
		return nil, err
	}
	result, err := p.plans.ReviseFromAgent(ctx, tuttimodeplanservice.AgentReviseInput{
		WorkspaceID:    invoke.WorkspaceID,
		WorkflowID:     input.WorkflowID,
		AgentSessionID: sessionID,
		RequestID:      input.RequestID,
		Markdown:       markdown,
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

func (p Provider) runWait(ctx context.Context, invoke framework.InvokeContext, input waitInput) (any, error) {
	if err := p.requirePlans(); err != nil {
		return nil, err
	}
	sessionID, err := callerAgentSessionID(invoke)
	if err != nil {
		return nil, err
	}
	timeout := defaultWaitTimeout
	if input.TimeoutMS != nil {
		timeout = time.Duration(*input.TimeoutMS) * time.Millisecond
	}
	if timeout > maxWaitTimeout {
		return nil, cliservice.InvalidInputKeyError("timeout-ms")
	}
	waitCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	result, err := p.plans.WaitForAgent(waitCtx, tuttimodeplanservice.AgentWaitInput{
		WorkspaceID:    invoke.WorkspaceID,
		WorkflowID:     input.WorkflowID,
		CheckpointID:   input.CheckpointID,
		AgentSessionID: sessionID,
	})
	if err == nil {
		return waitResultJSON(input.WorkflowID, result), nil
	}
	if !errors.Is(err, context.DeadlineExceeded) || ctx.Err() != nil {
		return nil, agentPlanError(err)
	}
	view, getErr := p.plans.GetViewForAgent(ctx, tuttimodeplanservice.AgentGetInput{
		WorkspaceID: invoke.WorkspaceID, WorkflowID: input.WorkflowID, AgentSessionID: sessionID,
	})
	if getErr != nil {
		return nil, agentPlanError(getErr)
	}
	return snapshotJSON(view, "wait"), nil
}

func callerAgentSessionID(invoke framework.InvokeContext) (string, error) {
	sessionID := strings.TrimSpace(invoke.Request.Context.AgentSessionID)
	if sessionID == "" {
		return "", cliservice.MissingRequiredInputError("agent-session-id")
	}
	return sessionID, nil
}

func agentPlanError(err error) error {
	if errors.Is(err, workspacedata.ErrWorkspaceWorkflowNotFound) {
		return fmt.Errorf("%w: Tutti Mode plan was not found", cliservice.ErrInvalidInput)
	}
	if errors.Is(err, tuttimodeplanservice.ErrMutationConflict) {
		return fmt.Errorf("%w: request-id was already used with different content; reuse the original content or choose a new request-id", cliservice.ErrInvalidInput)
	}
	return err
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
		"nextAction": "wait",
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
		"nextAction": "wait",
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

func waitResultJSON(workflowID string, result tuttimodeplanservice.WaitResult) map[string]any {
	value := map[string]any{
		"workflowId": workflowID,
		"checkpoint": checkpointJSON(result.Checkpoint),
		"nextAction": string(result.NextAction),
	}
	if result.Operation != nil {
		value["operation"] = singleOperationJSON(*result.Operation)
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
		return "wait"
	}
	next, ok := tuttimodeplanservice.NextActionForCheckpoint(checkpoint)
	if !ok {
		return ""
	}
	return string(next)
}
