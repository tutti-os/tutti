// Package modelconsult exposes the daemon-side model consult (advisor mode)
// mechanism as CLI commands, so an agent session can dispatch a registered
// model access plan's model for advice on its own initiative — not only
// through the AgentGUI composer's human-triggered popover. See
// docs/architecture/model-access-plans.md, "Collaboration Runs".
package modelconsult

import (
	"context"

	collabrunbiz "github.com/tutti-os/tutti/services/tuttid/biz/collabrun"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	collabrunservice "github.com/tutti-os/tutti/services/tuttid/service/collabrun"
)

const appID = "model-consult"

// ModelPlans lists the workspace model access plans a consult may target.
type ModelPlans interface {
	ListPlans(ctx context.Context, workspaceID string) ([]modelplanbiz.PublicPlan, error)
}

// CollaborationRuns starts a daemon-side advisory completion and records it.
type CollaborationRuns interface {
	StartConsult(ctx context.Context, input collabrunservice.StartConsultInput) (collabrunbiz.Run, error)
}

type Provider struct {
	workspaces cliservice.WorkspaceCatalog
	plans      ModelPlans
	runs       CollaborationRuns
}

func NewProvider(workspaces cliservice.WorkspaceCatalog, plans ModelPlans, runs CollaborationRuns) Provider {
	return Provider{workspaces: workspaces, plans: plans, runs: runs}
}

func (Provider) AppID() string {
	return appID
}

func (p Provider) Commands() []cliservice.Command {
	return []cliservice.Command{
		p.newModelPlansCommand(),
		p.newRecommendModelsCommand(),
		p.newConsultCommand(),
	}
}

func (p Provider) requirePlans() error {
	if p.plans == nil {
		return cliservice.ServiceUnavailableError("model plan service is unavailable", nil)
	}
	return nil
}

func (p Provider) requireRuns() error {
	if p.runs == nil {
		return cliservice.ServiceUnavailableError("collaboration run service is unavailable", nil)
	}
	return nil
}
