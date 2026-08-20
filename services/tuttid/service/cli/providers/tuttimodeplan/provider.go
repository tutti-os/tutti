// Package tuttimodeplan exposes Tutti-owned planning workflows to Agents as
// daemon-backed CLI capabilities. The commands create and observe durable
// Workflow state; they never mutate Agent Interaction records.
package tuttimodeplan

import (
	"context"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	activationbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeactivation"
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

// ActiveTurns resolves the caller session's persisted active Turn. The plan
// service uses that identity to read the immutable effect/speed snapshot and
// rejects any proposal or revision that does not copy it exactly.
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

type IssueArchives interface {
	Archive(
		context.Context,
		tuttimodeexecutionservice.ArchiveInput,
	) (executionbiz.ArchiveOperation, error)
}

type IssueMutations interface {
	MutateTuttiModeIssue(
		context.Context,
		string,
		workspaceservice.MutateTuttiModeIssueInput,
	) (executionbiz.MutationResult, error)
}

type IssueDetails interface {
	GetIssueDetail(
		context.Context,
		string,
		string,
	) (workspaceissues.IssueDetail, error)
}

type IssueResumes interface {
	ResumeTuttiModeIssueExecution(
		context.Context,
		string,
		string,
		string,
	) (workspaceissues.Issue, error)
}

type IssueExecutionReads interface {
	GetByIssue(
		context.Context,
		string,
		string,
	) (executionbiz.Aggregate, error)
}

// TuttiModeActivations reads the caller session's durable Tutti Mode
// activation so the plan and execution mutations can be gated on an active
// session. It is optional wiring: an unset reader leaves the gate open.
type TuttiModeActivations interface {
	Get(context.Context, string, string) (*activationbiz.Activation, error)
}

type Provider struct {
	workspaces       cliservice.WorkspaceCatalog
	plans            Plans
	turns            ActiveTurns
	issueDetails     IssueDetails
	executionReads   IssueExecutionReads
	schedules        IssueSchedules
	mutations        IssueMutations
	acknowledgements IssueAcknowledgements
	completions      IssueCompletions
	archives         IssueArchives
	resumes          IssueResumes
	activations      TuttiModeActivations
}

// WithTuttiModeActivations wires the Tutti Mode activation reader used to gate
// plan and execution mutations on an active session. It is a fluent optional
// setter so existing constructors and their many call sites stay unchanged.
func (p Provider) WithTuttiModeActivations(activations TuttiModeActivations) Provider {
	p.activations = activations
	return p
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
		if archives, ok := completions[0].(IssueArchives); ok {
			provider.archives = archives
		}
	}
	return provider
}

func NewProviderWithExecutionSnapshot(
	workspaces cliservice.WorkspaceCatalog,
	plans Plans,
	turns ActiveTurns,
	schedules IssueSchedules,
	mutations IssueMutations,
	acknowledgements IssueAcknowledgements,
	issueDetails IssueDetails,
	executionReads IssueExecutionReads,
	completions ...IssueCompletions,
) Provider {
	provider := NewProviderWithExecution(
		workspaces,
		plans,
		turns,
		schedules,
		mutations,
		acknowledgements,
		completions...,
	)
	provider.issueDetails = issueDetails
	provider.executionReads = executionReads
	if resumes, ok := issueDetails.(IssueResumes); ok {
		provider.resumes = resumes
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
	commands := []cliservice.Command{
		p.newProposeCommand(),
		p.newReviseCommand(),
		p.newGetCommand(),
		p.newIssueMutateCommand(),
		p.newIssueScheduleCommand(),
		p.newIssueAcknowledgeCommand(),
		p.newIssueCompleteCommand(),
		p.newIssueStopCommand(),
	}
	if p.issueDetails != nil && p.executionReads != nil {
		commands = append(commands, p.newIssueGetCommand())
	}
	if p.resumes != nil {
		commands = append(commands, p.newIssueResumeCommand())
	}
	return commands
}

func (p Provider) requireArchives() error {
	if p.archives == nil {
		return cliservice.ServiceUnavailableError("Tutti Mode execution service is unavailable", nil)
	}
	return nil
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

func (p Provider) requireResumes() error {
	if p.resumes == nil {
		return cliservice.ServiceUnavailableError("Tutti Mode execution service is unavailable", nil)
	}
	return nil
}

// requireTuttiModeActive rejects a plan or execution mutation when the user has
// not enabled Tutti Mode for the caller session. The reader is optional wiring:
// when it is unset the gate is skipped so the command surface degrades open
// rather than failing closed.
func (p Provider) requireTuttiModeActive(ctx context.Context, workspaceID string, sessionID string) error {
	if p.activations == nil {
		return nil
	}
	activation, err := p.activations.Get(ctx, workspaceID, sessionID)
	if err != nil {
		return cliservice.ServiceUnavailableError("Tutti Mode activation state is unavailable", err)
	}
	if activation == nil || activation.CurrentRevision.State != activationbiz.StateActive {
		return cliservice.InvalidInputReasonError(
			"tutti_mode_inactive",
			"Tutti Mode is not active for this session; only the user can turn it on. Ask the user to enable Tutti Mode manually before driving a Tutti Mode plan or execution.",
			nil,
		)
	}
	return nil
}
