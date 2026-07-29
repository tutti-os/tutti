// Package tuttigoalreview exposes the isolated structured verdict capability
// used by dedicated Tutti Mode review sessions.
package tuttigoalreview

import (
	"context"

	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	tuttimodeexecutionservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeexecution"
)

const appID = "tutti-goal-review"

type Verdicts interface {
	SubmitReviewerVerdict(
		context.Context,
		tuttimodeexecutionservice.ReviewerVerdictInput,
	) (tuttimodeexecutionservice.ReviewerVerdictResult, error)
}

type ActiveTurns interface {
	PersistedActiveTurnID(context.Context, string, string) (string, error)
}

type Provider struct {
	verdicts Verdicts
	turns    ActiveTurns
}

func NewProvider(verdicts Verdicts, turns ActiveTurns) Provider {
	return Provider{verdicts: verdicts, turns: turns}
}

func (Provider) AppID() string {
	return appID
}

func (p Provider) Commands() []cliservice.Command {
	return []cliservice.Command{p.newVerdictCommand()}
}
