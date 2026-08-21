package tuttimodeplan

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	activationbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeactivation"
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
		"tutti-mode-plan.plan.issue.stop",
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

type recordingIssueDetails struct {
	detail                workspaceissues.IssueDetail
	err                   error
	resumeWorkspaceID     string
	resumeIssueID         string
	resumeSourceSessionID string
	resumeErr             error
}

func (reader *recordingIssueDetails) GetIssueDetail(
	_ context.Context,
	_ string,
	_ string,
) (workspaceissues.IssueDetail, error) {
	return reader.detail, reader.err
}

func (reader *recordingIssueDetails) ResumeTuttiModeIssueExecution(
	_ context.Context,
	workspaceID string,
	issueID string,
	sourceSessionID string,
) (workspaceissues.Issue, error) {
	reader.resumeWorkspaceID = workspaceID
	reader.resumeIssueID = issueID
	reader.resumeSourceSessionID = sourceSessionID
	if reader.resumeErr != nil {
		return workspaceissues.Issue{}, reader.resumeErr
	}
	reader.detail.Issue.DispatchPaused = false
	return reader.detail.Issue, nil
}

type recordingExecutionReads struct {
	aggregate executionbiz.Aggregate
	err       error
}

func (reader *recordingExecutionReads) GetByIssue(
	_ context.Context,
	_ string,
	_ string,
) (executionbiz.Aggregate, error) {
	return reader.aggregate, reader.err
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
	if len(commands) != 8 {
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

func TestProviderExposesSourceScopedIssueExecutionSnapshot(t *testing.T) {
	provider := NewProviderWithExecutionSnapshot(
		nil,
		&recordingPlans{},
		nil,
		&recordingIssueScheduler{},
		&recordingIssueMutator{},
		&recordingIssueAcknowledger{},
		&recordingIssueDetails{},
		&recordingExecutionReads{},
	)
	commands := provider.Commands()
	if len(commands) != 10 {
		t.Fatalf("commands = %#v, want execution snapshot and resume commands", commands)
	}
	command := commands[8]
	if command.Capability.ID != "tutti-mode-plan.plan.issue.get" {
		t.Fatalf("execution snapshot command id = %q", command.Capability.ID)
	}
	properties := command.Capability.InputSchema["properties"].(map[string]any)
	if _, ok := properties["issue-id"]; !ok {
		t.Fatalf("execution snapshot properties = %#v", properties)
	}
	if _, exists := properties["source-session-id"]; exists {
		t.Fatalf("execution snapshot exposes untrusted source-session-id: %#v", properties)
	}
	resume := commands[9]
	if resume.Capability.ID != "tutti-mode-plan.plan.issue.resume" {
		t.Fatalf("resume command id = %q", resume.Capability.ID)
	}
	resumeProperties := resume.Capability.InputSchema["properties"].(map[string]any)
	if _, ok := resumeProperties["issue-id"]; !ok {
		t.Fatalf("resume properties = %#v", resumeProperties)
	}
	if _, exists := resumeProperties["source-session-id"]; exists {
		t.Fatalf("resume exposes untrusted source-session-id: %#v", resumeProperties)
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
	if len(commands) != 8 {
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
	if len(commands) != 8 {
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

func TestProviderExposesSourceScopedIssueStopCommand(t *testing.T) {
	commands := NewProvider(nil, &recordingPlans{}, nil).Commands()
	command := commands[7]
	if command.Capability.ID != "tutti-mode-plan.plan.issue.stop" {
		t.Fatalf("stop command id = %q", command.Capability.ID)
	}
	properties := command.Capability.InputSchema["properties"].(map[string]any)
	for _, name := range []string{
		"issue-id", "checkpoint-id", "expected-graph-revision",
		"request-id", "reason",
	} {
		if _, ok := properties[name]; !ok {
			t.Fatalf("stop properties = %#v, missing %q", properties, name)
		}
	}
	if _, exists := properties["source-session-id"]; exists {
		t.Fatalf("stop exposes untrusted source-session-id: %#v", properties)
	}
}

type recordingIssueCompleter struct {
	input tuttimodeexecutionservice.CompleteInput
	err   error
}

type recordingIssueArchiver struct {
	input tuttimodeexecutionservice.ArchiveInput
	err   error
}

func (archiver *recordingIssueArchiver) Archive(
	_ context.Context,
	input tuttimodeexecutionservice.ArchiveInput,
) (executionbiz.ArchiveOperation, error) {
	archiver.input = input
	if archiver.err != nil {
		return executionbiz.ArchiveOperation{}, archiver.err
	}
	return executionbiz.ArchiveOperation{
		ExecutionID: "execution-1", IssueID: input.IssueID,
		OperationID: "archive:execution-1:" + input.RequestID,
		RequestID:   input.RequestID, Status: executionbiz.ArchiveStatusCompleted,
		RequestedBy: input.SourceSessionID, Reason: input.Reason,
	}, nil
}

func TestRunIssueStopDerivesTrustedCallerAndReturnsStructuredResult(t *testing.T) {
	archiver := &recordingIssueArchiver{}
	result, err := (Provider{archives: archiver}).runIssueStop(
		context.Background(),
		framework.InvokeContext{
			WorkspaceID: "workspace-1",
			Request: cliservice.InvokeRequest{Context: cliservice.InvokeContext{
				AgentSessionID: " source-session ",
			}},
		},
		issueStopInput{
			IssueID: "issue-1", CheckpointID: "checkpoint-1",
			ExpectedGraphRevision: 7, RequestID: "stop-1",
			Reason: "superseded by replacement plan",
		},
	)
	if err != nil {
		t.Fatalf("runIssueStop() error = %v", err)
	}
	if archiver.input.WorkspaceID != "workspace-1" ||
		archiver.input.SourceSessionID != "source-session" ||
		archiver.input.IssueID != "issue-1" ||
		archiver.input.CheckpointID != "checkpoint-1" ||
		archiver.input.ExpectedGraphRevision != 7 ||
		archiver.input.RequestID != "stop-1" ||
		archiver.input.Reason != "superseded by replacement plan" ||
		archiver.input.RequestedBy != "" {
		t.Fatalf("Archive input = %#v", archiver.input)
	}
	value := result.(map[string]any)
	if value["executionId"] != "execution-1" ||
		value["issueId"] != "issue-1" ||
		value["operationId"] != "archive:execution-1:stop-1" ||
		value["status"] != string(executionbiz.ArchiveStatusCompleted) ||
		value["reason"] != "superseded by replacement plan" {
		t.Fatalf("stop result = %#v", value)
	}
}

func TestRunIssueStopMapsFenceErrorsWithoutLeakingDetails(t *testing.T) {
	for _, contractErr := range []error{
		executionbiz.ErrInvalidExecution,
		executionbiz.ErrExecutionNotFound,
		executionbiz.ErrExecutionConflict,
	} {
		archiver := &recordingIssueArchiver{
			err: fmt.Errorf("%w: secret durable row", contractErr),
		}
		_, err := (Provider{archives: archiver}).runIssueStop(
			context.Background(),
			framework.InvokeContext{
				WorkspaceID: "workspace-1",
				Request: cliservice.InvokeRequest{Context: cliservice.InvokeContext{
					AgentSessionID: "source-session",
				}},
			},
			issueStopInput{
				IssueID: "issue-1", CheckpointID: "checkpoint-1",
				ExpectedGraphRevision: 7, RequestID: "stop-errors",
				Reason: "replaced",
			},
		)
		if !errors.Is(err, cliservice.ErrInvalidInput) ||
			strings.Contains(err.Error(), "secret durable row") {
			t.Fatalf("stop error %v mapped to %v", contractErr, err)
		}
	}
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
			OperationsJSON: `[{"kind":"add","task":{"taskId":"task-c","title":"Task C",` +
				`"agentTargetId":"codex"}}]`,
			RequestID: "mutate-1",
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

func TestParseMutationOperationsPreservesExplicitZeroValues(t *testing.T) {
	operations, err := parseMutationOperationsJSON(
		`[{"kind":"update","taskId":"task-a","task":{` +
			`"title":"","dependencyTaskIds":[],"parallelizable":false,"autoAccept":false}}]`,
	)
	if err != nil {
		t.Fatalf("parseMutationOperationsJSON() error = %v", err)
	}
	if len(operations) != 1 {
		t.Fatalf("operations = %#v", operations)
	}
	operation := operations[0]
	if !operation.TaskFields.Title ||
		!operation.TaskFields.DependencyTaskIDs ||
		!operation.TaskFields.Parallelizable ||
		!operation.TaskFields.AutoAccept ||
		operation.Task.Title != "" ||
		operation.Task.Parallelizable ||
		operation.Task.AutoAccept {
		t.Fatalf("presence-aware operation = %#v", operation)
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

func TestIssueMutateRejectsOpAliasBeforeCallingMutator(t *testing.T) {
	mutator := &recordingIssueMutator{}
	provider := Provider{mutations: mutator}
	_, err := provider.runIssueMutate(
		context.Background(),
		framework.InvokeContext{
			WorkspaceID: "workspace-1",
			Request: cliservice.InvokeRequest{Context: cliservice.InvokeContext{
				AgentSessionID: "source-session",
			}},
		},
		issueMutateInput{
			IssueID: "issue-1", CheckpointID: "checkpoint-1",
			ExpectedGraphRevision: 3,
			OperationsJSON:        `[{"op":"supersede","taskId":"task-a"}]`,
			RequestID:             "mutate-invalid-op",
		},
	)
	if !errors.Is(err, cliservice.ErrInvalidInput) || !strings.Contains(err.Error(), `"kind"`) {
		t.Fatalf("op alias error = %v, want actionable kind validation", err)
	}
	if !reflect.DeepEqual(mutator.input, workspaceservice.MutateTuttiModeIssueInput{}) {
		t.Fatalf("invalid operation reached mutation service: %#v", mutator.input)
	}
}

func TestIssueMutateRejectsReplacementAliasBeforeCallingMutator(t *testing.T) {
	mutator := &recordingIssueMutator{}
	provider := Provider{mutations: mutator}
	_, err := provider.runIssueMutate(
		context.Background(),
		framework.InvokeContext{
			WorkspaceID: "workspace-1",
			Request: cliservice.InvokeRequest{Context: cliservice.InvokeContext{
				AgentSessionID: "source-session",
			}},
		},
		issueMutateInput{
			IssueID: "issue-1", CheckpointID: "checkpoint-1",
			ExpectedGraphRevision: 3,
			OperationsJSON:        `[{"kind":"rework","taskId":"task-a","replacement":{"taskId":"task-b"}}]`,
			RequestID:             "mutate-invalid-replacement",
		},
	)
	if !errors.Is(err, cliservice.ErrInvalidInput) ||
		!strings.Contains(err.Error(), `"replacement"`) ||
		!strings.Contains(err.Error(), `"task" object with "taskId"`) {
		t.Fatalf("replacement alias error = %v, want actionable task validation", err)
	}
	if !reflect.DeepEqual(mutator.input, workspaceservice.MutateTuttiModeIssueInput{}) {
		t.Fatalf("invalid operation reached mutation service: %#v", mutator.input)
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

func TestAgentPlanPreferenceMismatchMapsToActionableInvalidInput(t *testing.T) {
	actualEffect := 90
	actualSpeed := 55
	err := agentPlanError(&tuttimodeplanservice.PreferenceSnapshotMismatchError{
		ExpectedEffect: 50,
		ExpectedSpeed:  50,
		ActualEffect:   &actualEffect,
		ActualSpeed:    &actualSpeed,
	})
	if !errors.Is(err, cliservice.ErrInvalidInput) {
		t.Fatalf("preference mismatch mapped to %v, want invalid input", err)
	}
	if got := cliservice.InvokeErrorReason(err); got != "tutti_mode_preference_snapshot_mismatch" {
		t.Fatalf("preference mismatch reason = %q", got)
	}
	for _, expected := range []string{"execution.effect to 50", "execution.speed to 50"} {
		if !strings.Contains(err.Error(), expected) {
			t.Fatalf("preference mismatch error = %v, want %q", err, expected)
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
		!strings.Contains(strings.ToLower(err.Error()), "execution") ||
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

func TestRunIssueGetReturnsAuthoritativeRecoverySnapshot(t *testing.T) {
	reader := &recordingExecutionReads{aggregate: executionbiz.Aggregate{
		Execution: executionbiz.Execution{
			ID:                 "execution-1",
			IssueID:            "issue-1",
			SourceSessionID:    "source-session",
			Status:             executionbiz.StatusAwaitingMain,
			GraphRevision:      4,
			ActiveCheckpointID: "checkpoint-canceled",
			ReviewMode:         executionbiz.ReviewModeSelf,
		},
		Checkpoints: []executionbiz.Checkpoint{{
			ID:             "checkpoint-canceled",
			Kind:           executionbiz.CheckpointKindTaskCanceled,
			Status:         executionbiz.CheckpointStatusActive,
			Sequence:       2,
			GraphRevision:  4,
			SubjectTaskID:  "task-a",
			SubjectRunID:   "run-a",
			CreationReason: "run_canceled",
		}},
	}}
	details := &recordingIssueDetails{detail: workspaceissues.IssueDetail{
		Tasks: []workspaceissues.Task{
			{
				TaskID: "task-a", Status: workspaceissues.StatusCanceled,
				SupersededAtUnixMS: 1, SupersededByTaskID: "task-a-retry",
			},
			{
				TaskID: "task-a-retry", Status: workspaceissues.StatusNotStarted,
				AgentTargetID: "local:codex", Model: "gpt-5.4-codex",
			},
			{
				TaskID: "task-b", Status: workspaceissues.StatusNotStarted,
				AgentTargetID: "local:codex", DependencyTaskIDs: []string{"task-a-retry"},
			},
		},
	}}
	provider := Provider{issueDetails: details, executionReads: reader}
	result, err := provider.runIssueGet(
		context.Background(),
		framework.InvokeContext{
			WorkspaceID: "workspace-1",
			Request: cliservice.InvokeRequest{Context: cliservice.InvokeContext{
				AgentSessionID: " source-session ",
			}},
		},
		issueGetInput{IssueID: "issue-1"},
	)
	if err != nil {
		t.Fatalf("runIssueGet() error = %v", err)
	}
	value := result.(map[string]any)
	execution := value["execution"].(map[string]any)
	active := value["activeCheckpoint"].(map[string]any)
	ready := value["readyTaskIds"].([]string)
	tasks := value["tasks"].([]map[string]any)
	if execution["graphRevision"] != int64(4) ||
		active["checkpointId"] != "checkpoint-canceled" ||
		!reflect.DeepEqual(ready, []string{"task-a-retry"}) ||
		tasks[0]["blockerReason"] != "task_superseded" ||
		tasks[1]["agentTargetId"] != "local:codex" ||
		tasks[2]["blockerReason"] != "dependency_unsatisfied" ||
		!strings.Contains(value["recoveryHint"].(string), "new taskId") {
		t.Fatalf("execution snapshot = %#v", value)
	}
}

func TestPausedIssueSnapshotAdvertisesResumeInsteadOfSchedule(t *testing.T) {
	value := issueExecutionSnapshotJSON(
		executionbiz.Aggregate{
			Execution: executionbiz.Execution{
				ID:                 "execution-paused",
				IssueID:            "issue-paused",
				Status:             executionbiz.StatusAwaitingMain,
				GraphRevision:      3,
				ActiveCheckpointID: "checkpoint-paused",
			},
			Checkpoints: []executionbiz.Checkpoint{{
				ID:            "checkpoint-paused",
				Kind:          executionbiz.CheckpointKindTaskSettled,
				Status:        executionbiz.CheckpointStatusActive,
				GraphRevision: 3,
			}},
		},
		workspaceissues.IssueDetail{
			Issue: workspaceissues.Issue{DispatchPaused: true},
			Tasks: []workspaceissues.Task{{
				TaskID: "task-ready", Status: workspaceissues.StatusNotStarted,
				AgentTargetID: "local:codex",
			}},
		},
	)
	actions := value["allowedActions"].([]string)
	if value["dispatchPaused"] != true ||
		slices.Contains(actions, "plan issue schedule") ||
		!slices.Contains(actions, "plan issue resume") ||
		!strings.Contains(
			value["recoveryHint"].(string),
			"tutti plan issue resume --issue-id issue-paused --json",
		) {
		t.Fatalf("paused execution snapshot = %#v", value)
	}
}

func TestRunIssueResumeDerivesSourceAndReturnsRefreshedSnapshot(t *testing.T) {
	details := &recordingIssueDetails{detail: workspaceissues.IssueDetail{
		Issue: workspaceissues.Issue{DispatchPaused: true},
		Tasks: []workspaceissues.Task{{
			TaskID: "task-ready", Status: workspaceissues.StatusNotStarted,
			AgentTargetID: "local:codex",
		}},
	}}
	executions := &recordingExecutionReads{aggregate: executionbiz.Aggregate{
		Execution: executionbiz.Execution{
			ID:                 "execution-resume",
			IssueID:            "issue-resume",
			SourceSessionID:    "source-resume",
			Status:             executionbiz.StatusAwaitingMain,
			GraphRevision:      2,
			ActiveCheckpointID: "checkpoint-resume",
		},
		Checkpoints: []executionbiz.Checkpoint{{
			ID:            "checkpoint-resume",
			Kind:          executionbiz.CheckpointKindInitialSchedule,
			Status:        executionbiz.CheckpointStatusActive,
			GraphRevision: 2,
		}},
	}}
	provider := Provider{
		issueDetails:   details,
		executionReads: executions,
		resumes:        details,
	}
	result, err := provider.runIssueResume(
		context.Background(),
		framework.InvokeContext{
			WorkspaceID: "workspace-resume",
			Request: cliservice.InvokeRequest{Context: cliservice.InvokeContext{
				AgentSessionID: " source-resume ",
			}},
		},
		issueResumeInput{IssueID: " issue-resume "},
	)
	if err != nil {
		t.Fatalf("runIssueResume() error = %v", err)
	}
	if details.resumeWorkspaceID != "workspace-resume" ||
		details.resumeIssueID != "issue-resume" ||
		details.resumeSourceSessionID != "source-resume" {
		t.Fatalf(
			"resume scope = %q/%q/%q",
			details.resumeWorkspaceID,
			details.resumeIssueID,
			details.resumeSourceSessionID,
		)
	}
	value := result.(map[string]any)
	if value["dispatchPaused"] != false ||
		!slices.Contains(value["allowedActions"].([]string), "plan issue schedule") {
		t.Fatalf("resumed snapshot = %#v", value)
	}
}

func TestRunIssueGetRejectsDifferentSourceSessionWithStableReason(t *testing.T) {
	provider := Provider{
		issueDetails: &recordingIssueDetails{},
		executionReads: &recordingExecutionReads{aggregate: executionbiz.Aggregate{
			Execution: executionbiz.Execution{
				IssueID: "issue-1", SourceSessionID: "other-session",
			},
		}},
	}
	_, err := provider.runIssueGet(
		context.Background(),
		framework.InvokeContext{
			WorkspaceID: "workspace-1",
			Request: cliservice.InvokeRequest{Context: cliservice.InvokeContext{
				AgentSessionID: "source-session",
			}},
		},
		issueGetInput{IssueID: "issue-1"},
	)
	if !errors.Is(err, cliservice.ErrInvalidInput) ||
		cliservice.InvokeErrorReason(err) != string(executionbiz.RejectionWrongSourceSession) {
		t.Fatalf("runIssueGet() error = %v, reason = %q", err, cliservice.InvokeErrorReason(err))
	}
}

func TestIssueExecutionSnapshotProjectsReviewedSettlementForReadiness(t *testing.T) {
	value := issueExecutionSnapshotJSON(
		executionbiz.Aggregate{
			Execution: executionbiz.Execution{
				ID:                 "execution-1",
				IssueID:            "issue-1",
				Status:             executionbiz.StatusAwaitingMain,
				GraphRevision:      2,
				ActiveCheckpointID: "checkpoint-settled",
			},
			Checkpoints: []executionbiz.Checkpoint{{
				ID:            "checkpoint-settled",
				Kind:          executionbiz.CheckpointKindTaskSettled,
				Status:        executionbiz.CheckpointStatusActive,
				GraphRevision: 2,
				SubjectTaskID: "task-a",
			}},
		},
		workspaceissues.IssueDetail{Tasks: []workspaceissues.Task{
			{
				TaskID: "task-a", Status: workspaceissues.StatusPendingAcceptance,
				AgentTargetID: "local:codex",
			},
			{
				TaskID: "task-b", Status: workspaceissues.StatusNotStarted,
				AgentTargetID: "local:codex", DependencyTaskIDs: []string{"task-a"},
			},
		}},
	)
	if ready := value["readyTaskIds"].([]string); !reflect.DeepEqual(
		ready, []string{"task-b"},
	) {
		t.Fatalf("readyTaskIds = %#v", ready)
	}
	tasks := value["tasks"].([]map[string]any)
	if tasks[0]["status"] != string(workspaceissues.StatusPendingAcceptance) ||
		tasks[1]["ready"] != true {
		t.Fatalf("tasks = %#v", tasks)
	}
}

func TestScheduleRejectionCarriesStableReasonAndHint(t *testing.T) {
	err := agentScheduleError(
		executionbiz.Reject(
			executionbiz.ErrScheduleRejected,
			executionbiz.RejectionMissingAgentTarget,
			"task-a",
		),
		"issue-1",
	)
	if !errors.Is(err, cliservice.ErrInvalidInput) ||
		cliservice.InvokeErrorReason(err) != string(executionbiz.RejectionMissingAgentTarget) ||
		!strings.Contains(err.Error(), "agentTargetId") {
		t.Fatalf("agentScheduleError() = %v, reason = %q", err, cliservice.InvokeErrorReason(err))
	}
	paused := agentScheduleError(
		executionbiz.Reject(
			executionbiz.ErrScheduleRejected,
			executionbiz.RejectionDispatchPaused,
			"",
		),
		"issue-paused",
	)
	if !strings.Contains(
		paused.Error(),
		"tutti plan issue resume --issue-id issue-paused --json",
	) {
		t.Fatalf("dispatch-paused hint = %v", paused)
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
	result, err := NewProvider(nil, plans, &stubActiveTurns{turnID: "turn-1"}).runPropose(context.Background(), framework.InvokeContext{
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

func TestRunProposeRequiresAndStampsCallerActiveTurn(t *testing.T) {
	path := filepath.Join(t.TempDir(), "proposal.md")
	if err := os.WriteFile(path, configurationMarkdownFixture(), 0o600); err != nil {
		t.Fatalf("write proposal: %v", err)
	}
	for name, testCase := range map[string]struct {
		turns   *stubActiveTurns
		want    string
		wantErr bool
	}{
		"stamps the persisted active turn": {
			turns: &stubActiveTurns{turnID: " turn-9 "},
			want:  "turn-9",
		},
		"resolver failure fails closed": {
			turns:   &stubActiveTurns{err: errors.New("pointer read failed")},
			wantErr: true,
		},
		"missing pointer fails closed": {
			turns:   &stubActiveTurns{},
			wantErr: true,
		},
	} {
		t.Run(name, func(t *testing.T) {
			plans := &recordingPlans{}
			_, err := NewProvider(nil, plans, testCase.turns).runPropose(context.Background(), framework.InvokeContext{
				WorkspaceID: "workspace-1",
				Request:     cliservice.InvokeRequest{Context: cliservice.InvokeContext{AgentSessionID: "session-1"}},
			}, proposeInput{File: path, RequestID: "proposal-request-1"})
			if testCase.wantErr {
				if err == nil {
					t.Fatal("runPropose() error = nil, want missing source Turn error")
				}
				if plans.proposeInput.RequestID != "" {
					t.Fatalf("plan service was called without exact source Turn: %#v", plans.proposeInput)
				}
				return
			}
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
	provider = NewProvider(nil, plans, &stubActiveTurns{turnID: "turn-9"})
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
	if plans.reviseInput.ProducedByTurnID != "turn-9" {
		t.Fatalf("revision source turn = %q, want turn-9", plans.reviseInput.ProducedByTurnID)
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

type stubActivationReader struct {
	activation *activationbiz.Activation
	err        error
	calls      int
}

func (r *stubActivationReader) Get(_ context.Context, _, _ string) (*activationbiz.Activation, error) {
	r.calls++
	return r.activation, r.err
}

func activeActivation() *activationbiz.Activation {
	return &activationbiz.Activation{
		ID: "activation-1",
		CurrentRevision: activationbiz.Revision{
			Revision: 1, State: activationbiz.StateActive, Source: activationbiz.SourceSlashCommand,
		},
	}
}

func TestTuttiModeGateRejectsInactiveSessionsAndAllowsActive(t *testing.T) {
	path := filepath.Join(t.TempDir(), "proposal.md")
	if err := os.WriteFile(path, configurationMarkdownFixture(), 0o600); err != nil {
		t.Fatalf("write proposal: %v", err)
	}
	invoke := framework.InvokeContext{
		WorkspaceID: "workspace-1",
		Request:     cliservice.InvokeRequest{Context: cliservice.InvokeContext{AgentSessionID: "session-1"}},
	}

	// A never-activated (nil) session is rejected before the plan service runs.
	inactivePlans := &recordingPlans{}
	inactiveReader := &stubActivationReader{activation: nil}
	_, err := NewProvider(nil, inactivePlans, nil).
		WithTuttiModeActivations(inactiveReader).
		runPropose(context.Background(), invoke, proposeInput{File: path, RequestID: "request-1"})
	if !errors.Is(err, cliservice.ErrInvalidInput) ||
		!strings.Contains(err.Error(), "only the user can turn it on") {
		t.Fatalf("inactive propose error = %v, want tutti-mode-inactive invalid input", err)
	}
	if strings.Contains(err.Error(), "tutti mode set") {
		t.Fatalf("inactive propose error = %v, must not offer an Agent activation command", err)
	}
	if inactivePlans.proposeInput.RequestID != "" {
		t.Fatalf("inactive session reached plan service: %#v", inactivePlans.proposeInput)
	}
	if inactiveReader.calls != 1 {
		t.Fatalf("activation reader calls = %d, want 1", inactiveReader.calls)
	}

	// An active session proceeds to the plan service.
	activePlans := &recordingPlans{}
	_, err = NewProvider(nil, activePlans, &stubActiveTurns{turnID: "turn-1"}).
		WithTuttiModeActivations(&stubActivationReader{activation: activeActivation()}).
		runPropose(context.Background(), invoke, proposeInput{File: path, RequestID: "request-2"})
	if err != nil {
		t.Fatalf("active propose error = %v", err)
	}
	if activePlans.proposeInput.RequestID != "request-2" {
		t.Fatalf("active session did not reach plan service: %#v", activePlans.proposeInput)
	}

	// An unwired reader leaves the gate open (best-effort semantics).
	openPlans := &recordingPlans{}
	if _, err := NewProvider(nil, openPlans, &stubActiveTurns{turnID: "turn-1"}).
		runPropose(context.Background(), invoke, proposeInput{File: path, RequestID: "request-3"}); err != nil {
		t.Fatalf("unwired gate error = %v", err)
	}
	if openPlans.proposeInput.RequestID != "request-3" {
		t.Fatalf("unwired gate blocked propose: %#v", openPlans.proposeInput)
	}
}

func TestTuttiModeGateAppliesToExecutionDrivingCommands(t *testing.T) {
	invoke := framework.InvokeContext{
		WorkspaceID: "workspace-1",
		Request:     cliservice.InvokeRequest{Context: cliservice.InvokeContext{AgentSessionID: "session-1"}},
	}
	provider := NewProviderWithExecutionSnapshot(
		nil, &recordingPlans{}, nil,
		&recordingIssueScheduler{}, &recordingIssueMutator{}, &recordingIssueAcknowledger{},
		&recordingIssueDetails{}, &recordingExecutionReads{},
	).WithTuttiModeActivations(&stubActivationReader{activation: nil})

	scheduleErr := func() error {
		_, err := provider.runIssueSchedule(context.Background(), invoke, issueScheduleInput{
			IssueID: "issue-1", CheckpointID: "checkpoint-1", ExpectedGraphRevision: 1,
			TaskIDsJSON: `["task-1"]`, RequestID: "request-1",
		})
		return err
	}
	mutateErr := func() error {
		_, err := provider.runIssueMutate(context.Background(), invoke, issueMutateInput{
			IssueID: "issue-1", CheckpointID: "checkpoint-1", ExpectedGraphRevision: 1,
			OperationsJSON: `[{"kind":"supersede","taskId":"task-1"}]`, RequestID: "request-1",
		})
		return err
	}
	for name, run := range map[string]func() error{"schedule": scheduleErr, "mutate": mutateErr} {
		t.Run(name, func(t *testing.T) {
			if err := run(); !errors.Is(err, cliservice.ErrInvalidInput) ||
				!strings.Contains(err.Error(), "Tutti Mode is not active") {
				t.Fatalf("%s inactive error = %v, want tutti-mode-inactive invalid input", name, err)
			}
		})
	}
}
