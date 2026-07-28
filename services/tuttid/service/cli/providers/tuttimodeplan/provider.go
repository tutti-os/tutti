// Package tuttimodeplan exposes Tutti-owned planning workflows to Agents as
// daemon-backed CLI capabilities. The commands create and observe durable
// Workflow state; they never mutate Agent Interaction records.
package tuttimodeplan

import (
	"context"

	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	tuttimodeexecutionservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeexecution"
	tuttimodeplanservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeplan"
	workspaceservice "github.com/tutti-os/tutti/services/tuttid/service/workspace"
)

const appID = "tutti-mode-plan"

type Plans interface {
	Propose(context.Context, tuttimodeplanservice.ProposeInput) (tuttimodeplanservice.ProposalResult, error)
	ReviseFromAgent(context.Context, tuttimodeplanservice.AgentReviseInput) (tuttimodeplanservice.RevisionResult, error)
	GetViewForAgent(context.Context, tuttimodeplanservice.AgentGetInput) (tuttimodeplanservice.SnapshotView, error)
}

// ActiveTurns resolves the caller session's persisted active turn pointer so
// propose can stamp the workflow with the turn it was created in.
type ActiveTurns interface {
	PersistedActiveTurnID(ctx context.Context, workspaceID string, agentSessionID string) (string, error)
}

type IssueSchedules interface {
	ScheduleTuttiModeIssue(
		context.Context,
		string,
		workspaceservice.ScheduleTuttiModeIssueInput,
	) (workspaceservice.ScheduleTuttiModeIssueResult, error)
}

type IssueAcknowledgements interface {
	Acknowledge(
		context.Context,
		tuttimodeexecutionservice.AcknowledgeInput,
	) (tuttimodeexecutionservice.AcknowledgeResult, error)
}

type IssueCompletions interface {
	Complete(
		context.Context,
		tuttimodeexecutionservice.CompleteInput,
	) (tuttimodeexecutionservice.CompleteResult, error)
}

type IssueMutations interface {
	MutateTuttiModeIssue(
		context.Context,
		string,
		workspaceservice.MutateTuttiModeIssueInput,
	) (executionbiz.MutationResult, error)
}

type Provider struct {
	workspaces       cliservice.WorkspaceCatalog
	plans            Plans
	turns            ActiveTurns
	schedules        IssueSchedules
	mutations        IssueMutations
	acknowledgements IssueAcknowledgements
	completions      IssueCompletions
}

func NewProvider(
	workspaces cliservice.WorkspaceCatalog,
	plans Plans,
	turns ActiveTurns,
	schedules ...IssueSchedules,
) Provider {
	var scheduleService IssueSchedules
	if len(schedules) > 0 {
		scheduleService = schedules[0]
	}
	return Provider{
		workspaces: workspaces,
		plans:      plans,
		turns:      turns,
		schedules:  scheduleService,
	}
}

// NewProviderWithExecution preserves the schedule-only constructor while
// wiring the execution checkpoint commands to their dedicated service.
func NewProviderWithExecution(
	workspaces cliservice.WorkspaceCatalog,
	plans Plans,
	turns ActiveTurns,
	schedules IssueSchedules,
	mutations IssueMutations,
	acknowledgements IssueAcknowledgements,
	completions ...IssueCompletions,
) Provider {
	provider := NewProvider(workspaces, plans, turns, schedules)
	provider.mutations = mutations
	provider.acknowledgements = acknowledgements
	if len(completions) > 0 {
		provider.completions = completions[0]
	}
	return provider
}

func (Provider) AppID() string {
	return appID
}

// Commands deliberately exposes no wait/poll capability: an agent's turn ends
// after propose/revise, and the user's review decision comes back as a new
// user message (feedback dispatch), never as something the agent blocks on.
func (p Provider) Commands() []cliservice.Command {
	return []cliservice.Command{
		p.newProposeCommand(),
		p.newReviseCommand(),
		p.newGetCommand(),
		p.newIssueMutateCommand(),
		p.newIssueScheduleCommand(),
		p.newIssueAcknowledgeCommand(),
		p.newIssueCompleteCommand(),
	}
}

func (p Provider) requireCompletions() error {
	if p.completions == nil {
		return cliservice.ServiceUnavailableError("Tutti Mode execution service is unavailable", nil)
	}
	return nil
}

func (p Provider) requireMutations() error {
	if p.mutations == nil {
		return cliservice.ServiceUnavailableError("Tutti Mode execution service is unavailable", nil)
	}
	return nil
}

func (p Provider) requireSchedules() error {
	if p.schedules == nil {
		return cliservice.ServiceUnavailableError("Tutti Mode execution service is unavailable", nil)
	}
	return nil
}

func (p Provider) requireAcknowledgements() error {
	if p.acknowledgements == nil {
		return cliservice.ServiceUnavailableError("Tutti Mode execution service is unavailable", nil)
	}
	return nil
}

func (p Provider) requirePlans() error {
	if p.plans == nil {
		return cliservice.ServiceUnavailableError("Tutti Mode Plan service is unavailable", nil)
	}
	return nil
}
