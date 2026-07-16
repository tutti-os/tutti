package main

import (
	"context"
	"errors"

	automationruleservice "github.com/tutti-os/tutti/services/tuttid/service/automationrule"
	modelpolicyservice "github.com/tutti-os/tutti/services/tuttid/service/modelpolicy"
	workspaceservice "github.com/tutti-os/tutti/services/tuttid/service/workspace"
)

// automationReviewOutcomeRecorder keeps the compatibility session acceptance
// projection and the Issue task acceptance ladder consistent after one fixed
// AutomationRule review consult.
type automationReviewOutcomeRecorder struct {
	Policies *modelpolicyservice.Service
	Issues   *workspaceservice.IssueManagerService
}

func (r automationReviewOutcomeRecorder) RecordAutomationReviewOutcome(ctx context.Context, outcome automationruleservice.ReviewOutcome) error {
	var policyErr error
	if r.Policies != nil {
		_, _, policyErr = r.Policies.RecordAutomatedReviewOutcome(
			ctx,
			outcome.WorkspaceID,
			outcome.SourceSessionID,
			outcome.ReviewRunID,
			outcome.Passed && outcome.VerdictValid,
		)
	}
	var issueErr error
	if r.Issues != nil {
		issueErr = r.Issues.RecordAutomationReviewOutcome(
			ctx,
			outcome.WorkspaceID,
			outcome.SourceSessionID,
			outcome.ResultText,
			outcome.Passed,
			outcome.VerdictValid,
		)
	}
	return errors.Join(policyErr, issueErr)
}
