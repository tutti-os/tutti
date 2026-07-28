package tuttimodeplan

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
	workflowbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceworkflow"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	"github.com/tutti-os/tutti/services/tuttid/service/cli/framework"
	tuttimodeexecutionservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeexecution"
	tuttimodeplanservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeplan"
	workspaceservice "github.com/tutti-os/tutti/services/tuttid/service/workspace"
)

type recordingPlans struct {
	proposeInput     tuttimodeplanservice.ProposeInput
	reviseInput      tuttimodeplanservice.AgentReviseInput
	getInput         tuttimodeplanservice.AgentGetInput
	getForAgentError error
}

func (plans *recordingPlans) Propose(_ context.Context, input tuttimodeplanservice.ProposeInput) (tuttimodeplanservice.ProposalResult, error) {
	plans.proposeInput = input
	return tuttimodeplanservice.ProposalResult{
		Snapshot: workflowbiz.Snapshot{
			Workflow:    workflowbiz.Workflow{ID: "workflow-1", CurrentRevisionID: "revision-1", Status: workflowbiz.WorkflowStatusPendingReview},
			Checkpoints: []workflowbiz.WorkflowCheckpoint{{ID: "checkpoint-1", RevisionID: "revision-1", Kind: workflowbiz.CheckpointKindConfigurationReview, Status: workflowbiz.CheckpointStatusPending}},
		},
		Document:  tuttimodeplanservice.PlanDocument{Phase: tuttimodeplanservice.PhaseConfiguration, Title: "Proposal"},
		RequestID: input.RequestID,
	}, nil
}

func (plans *recordingPlans) ReviseFromAgent(_ context.Context, input tuttimodeplanservice.AgentReviseInput) (tuttimodeplanservice.RevisionResult, error) {
	plans.reviseInput = input
	return tuttimodeplanservice.RevisionResult{
		Snapshot: workflowbiz.Snapshot{Workflow: workflowbiz.Workflow{
			ID: "workflow-1", CurrentRevisionID: "revision-2", Status: workflowbiz.WorkflowStatusPendingReview,
		}},
		Revision: workflowbiz.PlanRevision{ID: "revision-2", Sequence: 2},
		Checkpoint: workflowbiz.WorkflowCheckpoint{
			ID: "checkpoint-2", RevisionID: "revision-2", Kind: workflowbiz.CheckpointKindConfigurationReview, Status: workflowbiz.CheckpointStatusPending,
		},
		Document:  tuttimodeplanservice.PlanDocument{Phase: tuttimodeplanservice.PhaseConfiguration, Title: "Revision"},
		RequestID: input.RequestID,
	}, nil
}

func (plans *recordingPlans) GetViewForAgent(_ context.Context, input tuttimodeplanservice.AgentGetInput) (tuttimodeplanservice.SnapshotView, error) {
	plans.getInput = input
	if plans.getForAgentError != nil {
		return tuttimodeplanservice.SnapshotView{}, plans.getForAgentError
	}
	return tuttimodeplanservice.SnapshotView{
		Workflow:    workflowbiz.Workflow{ID: "workflow-1", CurrentRevisionID: "revision-1", Status: workflowbiz.WorkflowStatusPendingReview},
		Checkpoints: []workflowbiz.WorkflowCheckpoint{{ID: "checkpoint-1", RevisionID: "revision-1", Kind: workflowbiz.CheckpointKindConfigurationReview, Status: workflowbiz.CheckpointStatusPending}},
	}, nil
}

func TestProviderExposesAgentPlanAndExecutionCommands(t *testing.T) {
	commands := NewProvider(nil, &recordingPlans{}, nil).Commands()
	wantIDs := []string{
		"tutti-mode-plan.plan.propose",
		"tutti-mode-plan.plan.revise",
		"tutti-mode-plan.plan.get",
		"tutti-mode-plan.plan.issue.mutate",
		"tutti-mode-plan.plan.issue.schedule",
		"tutti-mode-plan.plan.issue.acknowledge",
		"tutti-mode-plan.plan.issue.complete",
	}
	if len(commands) != len(wantIDs) {
		t.Fatalf("commands = %#v", commands)
	}
	for index, command := range commands {
		if command.Capability.ID != wantIDs[index] {
			t.Fatalf("command[%d].id = %q", index, command.Capability.ID)
		}
		if command.Capability.Visibility != cliservice.CapabilityVisibilityPublic {
			t.Fatalf("command[%d].visibility = %q", index, command.Capability.Visibility)
		}
		// The review decision reaches the agent as a new user message; no
		// wait/poll capability may reappear in this catalog.
		if strings.Contains(command.Capability.ID, "wait") {
			t.Fatalf("command[%d].id = %q, wait capability is retired", index, command.Capability.ID)
		}
	}
	for _, index := range []int{0, 1} {
		properties := commands[index].Capability.InputSchema["properties"].(map[string]any)
		if _, exists := properties["request-id"]; !exists {
			t.Fatalf("command[%d] request-id schema = %#v", index, properties)
		}
	}
}

type recordingIssueScheduler struct {
	input       workspaceservice.ScheduleTuttiModeIssueInput
	workspaceID string
	err         error
}

type recordingIssueAcknowledger struct {
	input tuttimodeexecutionservice.AcknowledgeInput
	err   error
}

type recordingIssueMutator struct {
	workspaceID string
	input       workspaceservice.MutateTuttiModeIssueInput
	err         error
}

func (mutator *recordingIssueMutator) MutateTuttiModeIssue(
	_ context.Context,
	workspaceID string,
	input workspaceservice.MutateTuttiModeIssueInput,
) (executionbiz.MutationResult, error) {
	mutator.workspaceID = workspaceID
	mutator.input = input
	if mutator.err != nil {
		return executionbiz.MutationResult{}, mutator.err
	}
	return executionbiz.MutationResult{
		ExecutionID: "execution-1", CheckpointID: input.CheckpointID,
		GraphRevision: input.ExpectedGraphRevision + 1,
		AddedTaskIDs:  []string{"task-c"}, UpdatedTaskIDs: []string{},
		SupersededTaskIDs: []string{}, Replayed: true,
	}, nil
}

func (acknowledger *recordingIssueAcknowledger) Acknowledge(
	_ context.Context,
	input tuttimodeexecutionservice.AcknowledgeInput,
) (tuttimodeexecutionservice.AcknowledgeResult, error) {
	acknowledger.input = input
	if acknowledger.err != nil {
		return tuttimodeexecutionservice.AcknowledgeResult{}, acknowledger.err
	}
	return tuttimodeexecutionservice.AcknowledgeResult{
		ExecutionID: "execution-1", CheckpointID: input.CheckpointID,
		GraphRevision:       input.ExpectedGraphRevision,
		NextCheckpointID:    "checkpoint-2",
		NextCheckpointKind:  executionbiz.CheckpointKindTaskSettled,
		NextCheckpointState: executionbiz.CheckpointStatusActive,
		Replayed:            true,
	}, nil
}

func (scheduler *recordingIssueScheduler) ScheduleTuttiModeIssue(
	_ context.Context,
	workspaceID string,
	input workspaceservice.ScheduleTuttiModeIssueInput,
) (workspaceservice.ScheduleTuttiModeIssueResult, error) {
	scheduler.workspaceID = workspaceID
	scheduler.input = input
	if scheduler.err != nil {
		return workspaceservice.ScheduleTuttiModeIssueResult{}, scheduler.err
	}
	return workspaceservice.ScheduleTuttiModeIssueResult{
		ExecutionID: "execution-1", CheckpointID: input.CheckpointID,
		GraphRevision: input.ExpectedGraphRevision,
		RunIDs:        []string{"run-a", "run-c"},
	}, nil
}

func TestProviderExposesSourceScopedIssueScheduleCommand(t *testing.T) {
	commands := NewProvider(nil, &recordingPlans{}, nil, &recordingIssueScheduler{}).Commands()
	if len(commands) != 7 {
		t.Fatalf("commands = %#v, want schedule and acknowledge commands", commands)
	}
	command := commands[4]
	if command.Capability.ID != "tutti-mode-plan.plan.issue.schedule" {
		t.Fatalf("schedule command id = %q", command.Capability.ID)
	}
	properties := command.Capability.InputSchema["properties"].(map[string]any)
	for _, name := range []string{
		"issue-id", "checkpoint-id", "expected-graph-revision",
		"task-ids-json", "request-id",
	} {
		if _, ok := properties[name]; !ok {
			t.Fatalf("schedule properties = %#v, missing %q", properties, name)
		}
	}
	if _, exists := properties["source-session-id"]; exists {
		t.Fatalf("schedule properties expose untrusted source-session-id: %#v", properties)
	}
}

func TestProviderExposesSourceScopedIssueMutateCommand(t *testing.T) {
	commands := NewProvider(nil, &recordingPlans{}, nil).Commands()
	command := commands[3]
	if command.Capability.ID != "tutti-mode-plan.plan.issue.mutate" {
		t.Fatalf("mutate command id = %q", command.Capability.ID)
	}
	properties := command.Capability.InputSchema["properties"].(map[string]any)
	for _, name := range []string{
		"issue-id", "checkpoint-id", "expected-graph-revision",
		"operations-json", "request-id",
	} {
		if _, ok := properties[name]; !ok {
			t.Fatalf("mutate properties = %#v, missing %q", properties, name)
		}
	}
	if _, exists := properties["source-session-id"]; exists {
		t.Fatalf("mutate properties expose untrusted source-session-id: %#v", properties)
	}
}

func TestProviderExposesSourceScopedIssueAcknowledgeCommand(t *testing.T) {
	acknowledger := &recordingIssueAcknowledger{}
	provider := NewProviderWithExecution(
		nil,
		&recordingPlans{},
		nil,
		&recordingIssueScheduler{},
		nil,
		acknowledger,
	)
	commands := provider.Commands()
	if len(commands) != 7 {
		t.Fatalf("commands = %#v, want acknowledge command", commands)
	}
	command := commands[5]
	if command.Capability.ID != "tutti-mode-plan.plan.issue.acknowledge" {
		t.Fatalf("acknowledge command id = %q", command.Capability.ID)
	}
	properties := command.Capability.InputSchema["properties"].(map[string]any)
	for _, name := range []string{
		"issue-id", "checkpoint-id", "expected-graph-revision", "request-id",
	} {
		if _, ok := properties[name]; !ok {
			t.Fatalf("acknowledge properties = %#v, missing %q", properties, name)
		}
	}
	if _, exists := properties["source-session-id"]; exists {
		t.Fatalf("acknowledge exposes untrusted source-session-id: %#v", properties)
	}
	if provider.acknowledgements != acknowledger {
		t.Fatal("acknowledge service was not injected")
	}
}

func TestProviderExposesSourceScopedGoalReviewCompleteCommand(t *testing.T) {
	commands := NewProvider(nil, &recordingPlans{}, nil).Commands()
	if len(commands) != 7 {
		t.Fatalf("commands = %#v, want source-main complete command", commands)
	}
	command := commands[6]
	if command.Capability.ID != "tutti-mode-plan.plan.issue.complete" {
		t.Fatalf("complete command id = %q", command.Capability.ID)
	}
	properties := command.Capability.InputSchema["properties"].(map[string]any)
	for _, name := range []string{
		"issue-id", "checkpoint-id", "expected-graph-revision",
		"request-id", "decision", "disagreement-reason",
	} {
		if _, ok := properties[name]; !ok {
			t.Fatalf("complete properties = %#v, missing %q", properties, name)
		}
	}
	if _, exists := properties["source-session-id"]; exists {
		t.Fatalf("complete exposes untrusted source-session-id: %#v", properties)
	}
	decision := properties["decision"].(map[string]any)
	if !reflect.DeepEqual(decision["enum"], []string{"goal_satisfied"}) {
		t.Fatalf("complete decision schema = %#v", decision)
	}
}

type recordingIssueCompleter struct {
	input tuttimodeexecutionservice.CompleteInput
	err   error
}

func (completer *recordingIssueCompleter) Complete(
	_ context.Context,
	input tuttimodeexecutionservice.CompleteInput,
) (tuttimodeexecutionservice.CompleteResult, error) {
	completer.input = input
	if completer.err != nil {
		return tuttimodeexecutionservice.CompleteResult{}, completer.err
	}
	return tuttimodeexecutionservice.CompleteResult{
		ExecutionID: "execution-1", CheckpointID: input.CheckpointID,
		GraphRevision: input.ExpectedGraphRevision, Decision: input.Decision,
		Replayed: true,
	}, nil
}

func TestRunIssueCompleteDerivesTrustedCallerAndReturnsStructuredResult(t *testing.T) {
	completer := &recordingIssueCompleter{}
	provider := NewProviderWithExecution(
		nil, &recordingPlans{}, nil, &recordingIssueScheduler{},
		nil, &recordingIssueAcknowledger{}, completer,
	)
	result, err := provider.runIssueComplete(
		context.Background(),
		framework.InvokeContext{
			WorkspaceID: "workspace-1",
			Request: cliservice.InvokeRequest{Context: cliservice.InvokeContext{
				AgentSessionID: " source-session ",
			}},
		},
		issueCompleteInput{
			IssueID: "issue-1", CheckpointID: "checkpoint-goal",
			ExpectedGraphRevision: 7, RequestID: "complete-1",
			Decision: "goal_satisfied", DisagreementReason: " evidence differs ",
		},
	)
	if err != nil {
		t.Fatalf("runIssueComplete() error = %v", err)
	}
	if completer.input.WorkspaceID != "workspace-1" ||
		completer.input.SourceSessionID != "source-session" ||
		completer.input.IssueID != "issue-1" ||
		completer.input.CheckpointID != "checkpoint-goal" ||
		completer.input.ExpectedGraphRevision != 7 ||
		completer.input.RequestID != "complete-1" ||
		completer.input.Decision != "goal_satisfied" ||
		completer.input.DisagreementReason != " evidence differs " {
		t.Fatalf("Complete input = %#v", completer.input)
	}
	value := result.(map[string]any)
	if value["executionId"] != "execution-1" ||
		value["checkpointId"] != "checkpoint-goal" ||
		value["graphRevision"] != int64(7) ||
		value["decision"] != "goal_satisfied" ||
		value["replayed"] != true {
		t.Fatalf("Complete result = %#v", value)
	}
}

func TestRunIssueCompleteRejectsMissingOrReviewerCaller(t *testing.T) {
	completer := &recordingIssueCompleter{}
	provider := Provider{completions: completer}
	_, err := provider.runIssueComplete(
		context.Background(),
		framework.InvokeContext{WorkspaceID: "workspace-1"},
		issueCompleteInput{
			IssueID: "issue-1", CheckpointID: "checkpoint-goal",
			ExpectedGraphRevision: 7, RequestID: "complete-missing",
			Decision: "goal_satisfied",
		},
	)
	if !errors.Is(err, cliservice.ErrInvalidInput) ||
		!strings.Contains(err.Error(), "agent-session-id") {
		t.Fatalf("missing Complete caller error = %v", err)
	}
	if completer.input != (tuttimodeexecutionservice.CompleteInput{}) {
		t.Fatalf("missing caller reached service: %#v", completer.input)
	}

	completer.err = fmt.Errorf("%w: internal reviewer-session-42", executionbiz.ErrCompleteRejected)
	_, err = provider.runIssueComplete(
		context.Background(),
		framework.InvokeContext{
			WorkspaceID: "workspace-1",
			Request: cliservice.InvokeRequest{Context: cliservice.InvokeContext{
				AgentSessionID: "reviewer-session-42",
			}},
		},
		issueCompleteInput{
			IssueID: "issue-1", CheckpointID: "checkpoint-goal",
			ExpectedGraphRevision: 7, RequestID: "complete-reviewer",
			Decision: "goal_satisfied",
		},
	)
	if !errors.Is(err, cliservice.ErrInvalidInput) ||
		strings.Contains(err.Error(), "reviewer-session-42") {
		t.Fatalf("reviewer Complete error leaked trusted identity: %v", err)
	}
}

func TestRunIssueCompleteMapsProductErrorsWithoutLeakingDetails(t *testing.T) {
	for _, contractErr := range []error{
		executionbiz.ErrExecutionNotFound,
		executionbiz.ErrExecutionConflict,
		executionbiz.ErrCompleteRejected,
		executionbiz.ErrCompleteMutationConflict,
	} {
		completer := &recordingIssueCompleter{
			err: fmt.Errorf("%w: secret durable row", contractErr),
		}
		_, err := (Provider{completions: completer}).runIssueComplete(
			context.Background(),
			framework.InvokeContext{
				WorkspaceID: "workspace-1",
				Request: cliservice.InvokeRequest{Context: cliservice.InvokeContext{
					AgentSessionID: "source-session",
				}},
			},
			issueCompleteInput{
				IssueID: "issue-1", CheckpointID: "checkpoint-goal",
				ExpectedGraphRevision: 7, RequestID: "complete-errors",
				Decision: "goal_satisfied",
			},
		)
		if !errors.Is(err, cliservice.ErrInvalidInput) ||
			strings.Contains(err.Error(), "secret durable row") {
			t.Fatalf("Complete error %v mapped to %v", contractErr, err)
		}
	}
}

func TestRunIssueMutateDerivesCallerAndReturnsNewRevision(t *testing.T) {
	mutator := &recordingIssueMutator{}
	provider := Provider{mutations: mutator}
	result, err := provider.runIssueMutate(
		context.Background(),
		framework.InvokeContext{
			WorkspaceID: "workspace-1",
			Request: cliservice.InvokeRequest{Context: cliservice.InvokeContext{
				AgentSessionID: " source-session ",
			}},
		},
		issueMutateInput{
			IssueID: "issue-1", CheckpointID: "checkpoint-1",
			ExpectedGraphRevision: 3,
			OperationsJSON:        `[{"kind":"add","task":{"TaskID":"task-c","Title":"Task C"}}]`,
			RequestID:             "mutate-1",
		},
	)
	if err != nil {
		t.Fatalf("runIssueMutate() error = %v", err)
	}
	if mutator.workspaceID != "workspace-1" ||
		mutator.input.SourceSessionID != "source-session" ||
		mutator.input.CheckpointID != "checkpoint-1" ||
		mutator.input.ExpectedGraphRevision != 3 ||
		len(mutator.input.Operations) != 1 ||
		mutator.input.Operations[0].Task.TaskID != "task-c" {
		t.Fatalf("mutation input = %#v in workspace %q", mutator.input, mutator.workspaceID)
	}
	value := result.(map[string]any)
	if value["graphRevision"] != int64(4) || value["replayed"] != true {
		t.Fatalf("mutation result = %#v", value)
	}
}

func TestIssueMutateRejectsInvalidJSONAndMapsFenceErrors(t *testing.T) {
	invoke := framework.InvokeContext{
		WorkspaceID: "workspace-1",
		Request: cliservice.InvokeRequest{Context: cliservice.InvokeContext{
			AgentSessionID: "source-session",
		}},
	}
	provider := Provider{mutations: &recordingIssueMutator{}}
	_, err := provider.runIssueMutate(context.Background(), invoke, issueMutateInput{
		IssueID: "issue-1", CheckpointID: "checkpoint-1",
		ExpectedGraphRevision: 3, OperationsJSON: `{}`, RequestID: "mutate-1",
	})
	if !errors.Is(err, cliservice.ErrInvalidInput) {
		t.Fatalf("invalid operations JSON error = %v", err)
	}
	for _, contractError := range []error{
		executionbiz.ErrMutationRejected, executionbiz.ErrMutationConflict,
		executionbiz.ErrExecutionNotFound,
	} {
		provider.mutations = &recordingIssueMutator{err: contractError}
		_, err := provider.runIssueMutate(context.Background(), invoke, issueMutateInput{
			IssueID: "issue-1", CheckpointID: "checkpoint-1",
			ExpectedGraphRevision: 3,
			OperationsJSON:        `[{"kind":"supersede","taskId":"task-a"}]`,
			RequestID:             "mutate-1",
		})
		if !errors.Is(err, cliservice.ErrInvalidInput) {
			t.Fatalf("mutation error %v mapped to %v", contractError, err)
		}
	}
}

func TestRunIssueAcknowledgeDerivesCallerOnlyFromInvokeContext(t *testing.T) {
	acknowledger := &recordingIssueAcknowledger{}
	result, err := (Provider{acknowledgements: acknowledger}).runIssueAcknowledge(
		context.Background(),
		framework.InvokeContext{
			WorkspaceID: "workspace-1",
			Request: cliservice.InvokeRequest{Context: cliservice.InvokeContext{
				AgentSessionID: " source-session ",
			}},
		},
		issueAcknowledgeInput{
			IssueID: "issue-1", CheckpointID: "checkpoint-1",
			ExpectedGraphRevision: 3, RequestID: "acknowledge-1",
		},
	)
	if err != nil {
		t.Fatalf("runIssueAcknowledge() error = %v", err)
	}
	if acknowledger.input.WorkspaceID != "workspace-1" ||
		acknowledger.input.SourceSessionID != "source-session" ||
		acknowledger.input.IssueID != "issue-1" ||
		acknowledger.input.CheckpointID != "checkpoint-1" ||
		acknowledger.input.ExpectedGraphRevision != 3 ||
		acknowledger.input.RequestID != "acknowledge-1" {
		t.Fatalf("acknowledge input = %#v", acknowledger.input)
	}
	value := result.(map[string]any)
	if value["executionId"] != "execution-1" ||
		value["checkpointId"] != "checkpoint-1" ||
		value["graphRevision"] != int64(3) ||
		value["nextCheckpointId"] != "checkpoint-2" ||
		value["nextCheckpointKind"] != "task_settled" ||
		value["nextCheckpointState"] != "active" ||
		value["replayed"] != true {
		t.Fatalf("acknowledge result = %#v", value)
	}
}

func TestRunIssueAcknowledgeRejectsMissingCaller(t *testing.T) {
	_, err := (Provider{acknowledgements: &recordingIssueAcknowledger{}}).runIssueAcknowledge(
		context.Background(),
		framework.InvokeContext{
			WorkspaceID: "workspace-1",
			Request:     cliservice.InvokeRequest{},
		},
		issueAcknowledgeInput{
			IssueID: "issue-1", CheckpointID: "checkpoint-1",
			ExpectedGraphRevision: 3, RequestID: "acknowledge-1",
		},
	)
	if !errors.Is(err, cliservice.ErrInvalidInput) ||
		!strings.Contains(err.Error(), "agent-session-id") {
		t.Fatalf("missing acknowledge caller error = %v", err)
	}
}

func TestIssueAcknowledgeConflictAndRejectedFenceMapToInvalidInput(t *testing.T) {
	for _, contractError := range []error{
		executionbiz.ErrExecutionConflict,
		executionbiz.ErrScheduleRejected,
		executionbiz.ErrAcknowledgeMutationConflict,
		executionbiz.ErrAcknowledgeRejected,
	} {
		err := agentPlanError(fmt.Errorf("%w: source-session request-secret", contractError))
		if !errors.Is(err, cliservice.ErrInvalidInput) {
			t.Fatalf("acknowledge contract error %v mapped to %v, want invalid input", contractError, err)
		}
		if strings.Contains(err.Error(), "source-session") ||
			strings.Contains(err.Error(), "request-secret") {
			t.Fatalf("acknowledge error leaked payload: %v", err)
		}
	}
}

func TestRunIssueAcknowledgeMapsMissingExecutionWithoutScheduleCopy(t *testing.T) {
	_, err := (Provider{
		acknowledgements: &recordingIssueAcknowledger{
			err: executionbiz.ErrExecutionNotFound,
		},
	}).runIssueAcknowledge(
		context.Background(),
		framework.InvokeContext{
			WorkspaceID: "workspace-1",
			Request: cliservice.InvokeRequest{Context: cliservice.InvokeContext{
				AgentSessionID: "source-session",
			}},
		},
		issueAcknowledgeInput{
			IssueID: "issue-1", CheckpointID: "checkpoint-1",
			ExpectedGraphRevision: 3, RequestID: "acknowledge-missing",
		},
	)
	if !errors.Is(err, cliservice.ErrInvalidInput) ||
		!strings.Contains(strings.ToLower(err.Error()), "acknowledge") ||
		strings.Contains(strings.ToLower(err.Error()), "schedule") {
		t.Fatalf("missing execution acknowledge error = %v", err)
	}
}

func TestRunScheduleDerivesCallerOnlyFromInvokeContext(t *testing.T) {
	scheduler := &recordingIssueScheduler{}
	result, err := NewProvider(nil, &recordingPlans{}, nil, scheduler).runIssueSchedule(
		context.Background(),
		framework.InvokeContext{
			WorkspaceID: "workspace-1",
			Request: cliservice.InvokeRequest{Context: cliservice.InvokeContext{
				AgentSessionID: " source-session ",
			}},
		},
		issueScheduleInput{
			IssueID: "issue-1", CheckpointID: "checkpoint-1",
			ExpectedGraphRevision: 3,
			TaskIDsJSON:           `["task-a","task-c"]`,
			RequestID:             "schedule-1",
		},
	)
	if err != nil {
		t.Fatalf("runIssueSchedule() error = %v", err)
	}
	if scheduler.workspaceID != "workspace-1" ||
		scheduler.input.SourceSessionID != "source-session" ||
		scheduler.input.IssueID != "issue-1" ||
		scheduler.input.CheckpointID != "checkpoint-1" ||
		scheduler.input.ExpectedGraphRevision != 3 ||
		scheduler.input.RequestID != "schedule-1" ||
		strings.Join(scheduler.input.TaskIDs, ",") != "task-a,task-c" {
		t.Fatalf("schedule input = %#v in workspace %q", scheduler.input, scheduler.workspaceID)
	}
	value := result.(map[string]any)
	if value["executionId"] != "execution-1" ||
		value["checkpointId"] != "checkpoint-1" ||
		value["graphRevision"] != int64(3) {
		t.Fatalf("schedule result = %#v", value)
	}
}

func TestRunScheduleRejectsMissingCallerAndInvalidTaskJSON(t *testing.T) {
	provider := NewProvider(nil, &recordingPlans{}, nil, &recordingIssueScheduler{})
	_, err := provider.runIssueSchedule(context.Background(), framework.InvokeContext{
		WorkspaceID: "workspace-1",
	}, issueScheduleInput{
		IssueID: "issue-1", CheckpointID: "checkpoint-1",
		ExpectedGraphRevision: 1, TaskIDsJSON: `["task-a"]`, RequestID: "schedule-1",
	})
	if !errors.Is(err, cliservice.ErrInvalidInput) || !strings.Contains(err.Error(), "agent-session-id") {
		t.Fatalf("missing caller error = %v", err)
	}
	_, err = provider.runIssueSchedule(context.Background(), framework.InvokeContext{
		WorkspaceID: "workspace-1",
		Request: cliservice.InvokeRequest{Context: cliservice.InvokeContext{
			AgentSessionID: "source-session",
		}},
	}, issueScheduleInput{
		IssueID: "issue-1", CheckpointID: "checkpoint-1",
		ExpectedGraphRevision: 1, TaskIDsJSON: `{"task":"a"}`, RequestID: "schedule-1",
	})
	if !errors.Is(err, cliservice.ErrInvalidInput) {
		t.Fatalf("invalid task JSON error = %v", err)
	}
}

func TestRunScheduleReportsRejectedFenceAsInvalidInput(t *testing.T) {
	scheduler := &recordingIssueScheduler{err: tuttimodeexecutionservice.ErrScheduleRejected}
	_, err := NewProvider(nil, &recordingPlans{}, nil, scheduler).runIssueSchedule(
		context.Background(),
		framework.InvokeContext{
			WorkspaceID: "workspace-1",
			Request: cliservice.InvokeRequest{Context: cliservice.InvokeContext{
				AgentSessionID: "source-session",
			}},
		},
		issueScheduleInput{
			IssueID: "issue-1", CheckpointID: "checkpoint-1",
			ExpectedGraphRevision: 1, TaskIDsJSON: `["task-a"]`, RequestID: "schedule-1",
		},
	)
	if !errors.Is(err, cliservice.ErrInvalidInput) {
		t.Fatalf("schedule rejection error = %v, want invalid input", err)
	}
}

func TestRunProposeUsesAgentSessionWithoutInventingToolCallProvenance(t *testing.T) {
	path := filepath.Join(t.TempDir(), "proposal.md")
	markdown := []byte("---\nschema: tutti-mode-plan/v1\nphase: configuration\ntitle: Proposal\ntopicId: topic-1\n---\nBody\n")
	if err := os.WriteFile(path, markdown, 0o600); err != nil {
		t.Fatalf("write proposal: %v", err)
	}
	plans := &recordingPlans{}
	result, err := NewProvider(nil, plans, nil).runPropose(context.Background(), framework.InvokeContext{
		WorkspaceID: "workspace-1",
		Request: cliservice.InvokeRequest{Context: cliservice.InvokeContext{
			AgentSessionID:  "session-1",
			ParentCommandID: "tool-call-1",
		}},
	}, proposeInput{File: path, RequestID: "proposal-request-1"})
	if err != nil {
		t.Fatalf("runPropose() error = %v", err)
	}
	if plans.proposeInput.WorkspaceID != "workspace-1" || plans.proposeInput.SourceSessionID != "session-1" || plans.proposeInput.RequestID != "proposal-request-1" || plans.proposeInput.SourceToolCallID != "" || string(plans.proposeInput.Markdown) != string(markdown) {
		t.Fatalf("propose input = %#v", plans.proposeInput)
	}
	if result.(map[string]any)["nextAction"] != nextActionStop {
		t.Fatalf("result = %#v", result)
	}
	if result.(map[string]any)["requestId"] != "proposal-request-1" || result.(map[string]any)["replayed"] != false {
		t.Fatalf("mutation result = %#v", result)
	}
}

type stubActiveTurns struct {
	turnID         string
	err            error
	gotWorkspaceID string
	gotSessionID   string
}

func (turns *stubActiveTurns) PersistedActiveTurnID(_ context.Context, workspaceID string, agentSessionID string) (string, error) {
	turns.gotWorkspaceID = workspaceID
	turns.gotSessionID = agentSessionID
	return turns.turnID, turns.err
}

func TestRunProposeStampsCallerActiveTurnBestEffort(t *testing.T) {
	path := filepath.Join(t.TempDir(), "proposal.md")
	if err := os.WriteFile(path, configurationMarkdownFixture(), 0o600); err != nil {
		t.Fatalf("write proposal: %v", err)
	}
	for name, testCase := range map[string]struct {
		turns *stubActiveTurns
		want  string
	}{
		"stamps the persisted active turn": {turns: &stubActiveTurns{turnID: " turn-9 "}, want: "turn-9"},
		// Anchoring is decoration; a pointer read failure must not fail propose.
		"resolver failure degrades to no anchor": {turns: &stubActiveTurns{err: errors.New("pointer read failed")}, want: ""},
	} {
		t.Run(name, func(t *testing.T) {
			plans := &recordingPlans{}
			_, err := NewProvider(nil, plans, testCase.turns).runPropose(context.Background(), framework.InvokeContext{
				WorkspaceID: "workspace-1",
				Request:     cliservice.InvokeRequest{Context: cliservice.InvokeContext{AgentSessionID: "session-1"}},
			}, proposeInput{File: path, RequestID: "proposal-request-1"})
			if err != nil {
				t.Fatalf("runPropose() error = %v", err)
			}
			if plans.proposeInput.SourceTurnID != testCase.want {
				t.Fatalf("SourceTurnID = %q, want %q", plans.proposeInput.SourceTurnID, testCase.want)
			}
			if testCase.turns.gotWorkspaceID != "workspace-1" || testCase.turns.gotSessionID != "session-1" {
				t.Fatalf("resolver scope = (%q, %q)", testCase.turns.gotWorkspaceID, testCase.turns.gotSessionID)
			}
		})
	}
}

func TestAgentPlanCommandsRequireAndPropagateCallerSession(t *testing.T) {
	path := filepath.Join(t.TempDir(), "revision.md")
	if err := os.WriteFile(path, configurationMarkdownFixture(), 0o600); err != nil {
		t.Fatalf("write revision: %v", err)
	}
	provider := NewProvider(nil, &recordingPlans{}, nil)
	missingSession := framework.InvokeContext{WorkspaceID: "workspace-1"}
	for name, invoke := range map[string]func() error{
		"revise": func() error {
			_, err := provider.runRevise(context.Background(), missingSession, reviseInput{WorkflowID: "workflow-1", File: path, RequestID: "revision-request-1"})
			return err
		},
		"get": func() error {
			_, err := provider.runGet(context.Background(), missingSession, getInput{WorkflowID: "workflow-1"})
			return err
		},
	} {
		t.Run(name, func(t *testing.T) {
			err := invoke()
			if !errors.Is(err, cliservice.ErrInvalidInput) || !strings.Contains(err.Error(), "agent-session-id") {
				t.Fatalf("error = %v, want missing agent-session-id", err)
			}
		})
	}

	plans := &recordingPlans{}
	provider = NewProvider(nil, plans, nil)
	invoke := framework.InvokeContext{
		WorkspaceID: "workspace-1",
		Request:     cliservice.InvokeRequest{Context: cliservice.InvokeContext{AgentSessionID: " session-1 "}},
	}
	if _, err := provider.runRevise(context.Background(), invoke, reviseInput{WorkflowID: "workflow-1", File: path, RequestID: "revision-request-1"}); err != nil {
		t.Fatalf("runRevise() error = %v", err)
	}
	if _, err := provider.runGet(context.Background(), invoke, getInput{WorkflowID: "workflow-1"}); err != nil {
		t.Fatalf("runGet() error = %v", err)
	}
	if plans.reviseInput.AgentSessionID != "session-1" || plans.reviseInput.RequestID != "revision-request-1" || plans.getInput.AgentSessionID != "session-1" {
		t.Fatalf("caller session was not propagated: revise=%#v get=%#v", plans.reviseInput, plans.getInput)
	}
}

func TestAgentPlanScopeMismatchIsReportedAsNotFoundInput(t *testing.T) {
	plans := &recordingPlans{getForAgentError: workspacedata.ErrWorkspaceWorkflowNotFound}
	_, err := NewProvider(nil, plans, nil).runGet(context.Background(), framework.InvokeContext{
		WorkspaceID: "workspace-1",
		Request:     cliservice.InvokeRequest{Context: cliservice.InvokeContext{AgentSessionID: "session-2"}},
	}, getInput{WorkflowID: "workflow-1"})
	if !errors.Is(err, cliservice.ErrInvalidInput) || !strings.Contains(strings.ToLower(err.Error()), "not found") {
		t.Fatalf("runGet() error = %v, want non-leaking not-found input error", err)
	}
}

func configurationMarkdownFixture() []byte {
	return []byte("---\nschema: tutti-mode-plan/v1\nphase: configuration\ntitle: Proposal\ntopicId: topic-1\n---\nBody\n")
}
