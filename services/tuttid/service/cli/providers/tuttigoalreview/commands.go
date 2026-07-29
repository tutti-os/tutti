package tuttigoalreview

import (
	"context"
	"errors"
	"fmt"
	"strings"

	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	"github.com/tutti-os/tutti/services/tuttid/service/cli/framework"
	tuttimodeexecutionservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeexecution"
)

type verdictInput struct {
	IssueID               string `cli:"issue-id" validate:"required" description:"Tutti-owned Issue id."`
	ReviewID              string `cli:"review-id" validate:"required" description:"Durable review operation id from the reviewer prompt."`
	CheckpointID          string `cli:"checkpoint-id" validate:"required" description:"Exact Goal Review checkpoint."`
	ExpectedGraphRevision int64  `cli:"expected-graph-revision" validate:"required,min=1" description:"Current execution graph revision."`
	RequestID             string `cli:"request-id" validate:"required" description:"Stable verdict mutation id. Reuse it only with the identical payload."`
	Verdict               string `cli:"verdict" validate:"required" enum:"goal_satisfied,more_work_required,inconclusive" description:"Structured advisory Goal Review verdict."`
	Summary               string `cli:"summary" validate:"required" description:"Concise evidence supporting the verdict."`
}

func (p Provider) newVerdictCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[verdictInput]{
		ID:          appID + ".goal-review.verdict",
		Path:        []string{"goal-review", "verdict"},
		Summary:     "Submit a structured Goal Review verdict",
		Description: "Submit advisory evidence from the exact dedicated reviewer Session and Turn. This capability cannot mutate or complete the Tutti Mode execution.",
		Kind:        framework.KindAction,
		Visibility:  cliservice.CapabilityVisibilityIntegration,
		Workspace:   framework.WorkspaceRequired,
		Inputs:      framework.FromStruct[verdictInput](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeJSON,
			DefaultView: framework.ViewSummary,
			JSON:        true,
			JSONViews: map[framework.OutputView]func(any) map[string]any{
				framework.ViewSummary: func(result any) map[string]any {
					return result.(map[string]any)
				},
			},
		},
		Run: p.runVerdict,
	})
}

func (p Provider) runVerdict(
	ctx context.Context,
	invoke framework.InvokeContext,
	input verdictInput,
) (any, error) {
	if p.verdicts == nil || p.turns == nil {
		return nil, cliservice.ServiceUnavailableError("Tutti Goal Review service is unavailable", nil)
	}
	sessionID := strings.TrimSpace(invoke.Request.Context.AgentSessionID)
	if sessionID == "" {
		return nil, cliservice.MissingRequiredInputError("agent-session-id")
	}
	turnID, err := p.turns.PersistedActiveTurnID(ctx, invoke.WorkspaceID, sessionID)
	if err != nil || strings.TrimSpace(turnID) == "" {
		return nil, fmt.Errorf("%w: reviewer active turn is unavailable", cliservice.ErrInvalidInput)
	}
	result, err := p.verdicts.SubmitReviewerVerdict(ctx, tuttimodeexecutionservice.ReviewerVerdictInput{
		WorkspaceID: invoke.WorkspaceID, IssueID: input.IssueID,
		ReviewID: input.ReviewID, ReviewSessionID: sessionID,
		ReviewTurnID: strings.TrimSpace(turnID), CheckpointID: input.CheckpointID,
		ExpectedGraphRevision: input.ExpectedGraphRevision,
		RequestID:             input.RequestID, Verdict: input.Verdict, Summary: input.Summary,
	})
	if err != nil {
		return nil, verdictError(err)
	}
	return map[string]any{
		"reviewId": result.ReviewID, "verdict": result.Verdict,
		"replayed": result.Replayed,
	}, nil
}

func verdictError(err error) error {
	if errors.Is(err, executionbiz.ErrExecutionNotFound) {
		return fmt.Errorf("%w: Goal Review was not found or is no longer current", cliservice.ErrInvalidInput)
	}
	if errors.Is(err, executionbiz.ErrReviewerVerdictMutationConflict) {
		return fmt.Errorf("%w: request-id was already used with a different verdict payload", cliservice.ErrInvalidInput)
	}
	if errors.Is(err, executionbiz.ErrExecutionConflict) ||
		errors.Is(err, executionbiz.ErrReviewerVerdictRejected) {
		return fmt.Errorf("%w: reviewer identity, checkpoint, revision, or review state is not current", cliservice.ErrInvalidInput)
	}
	return err
}
