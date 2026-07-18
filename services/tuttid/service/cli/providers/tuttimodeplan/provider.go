// Package tuttimodeplan exposes Tutti-owned planning workflows to Agents as
// daemon-backed CLI capabilities. The commands create and observe durable
// Workflow state; they never mutate Agent Interaction records.
package tuttimodeplan

import (
	"context"

	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	tuttimodeplanservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeplan"
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

type Provider struct {
	workspaces cliservice.WorkspaceCatalog
	plans      Plans
	turns      ActiveTurns
}

func NewProvider(workspaces cliservice.WorkspaceCatalog, plans Plans, turns ActiveTurns) Provider {
	return Provider{workspaces: workspaces, plans: plans, turns: turns}
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
	}
}

func (p Provider) requirePlans() error {
	if p.plans == nil {
		return cliservice.ServiceUnavailableError("Tutti Mode Plan service is unavailable", nil)
	}
	return nil
}
