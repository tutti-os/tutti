package tuttimodeplan

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	workflowbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceworkflow"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	"github.com/tutti-os/tutti/services/tuttid/service/cli/framework"
	tuttimodeplanservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeplan"
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

func TestProviderExposesOnlyAgentProposalObservationCommands(t *testing.T) {
	commands := NewProvider(nil, &recordingPlans{}, nil).Commands()
	wantIDs := []string{
		"tutti-mode-plan.plan.propose",
		"tutti-mode-plan.plan.revise",
		"tutti-mode-plan.plan.get",
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
