package main

import (
	"context"
	"errors"
	"strings"

	agentdaemon "github.com/tutti-os/tutti/packages/agent/daemon"
	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	agentstatusservice "github.com/tutti-os/tutti/services/tuttid/service/agentstatus"
)

// agentRunOutcomeReporter decorates the activity reporter so a runtime
// authentication result is fed back into the status probe. A 401 overrides a
// stale local "logged in" marker with required; a successfully completed turn
// promotes locally configured credentials to authenticated. Embedding the
// required durable reporter promotes its provenance receipt method without a
// second, manually forwarded optional seam.
type agentRunOutcomeReporter struct {
	agentdaemon.DurableActivityReporter
	store *agentstatusservice.RunOutcomeStore
}

var _ agentdaemon.DurableActivityReporter = agentRunOutcomeReporter{}

func (r agentRunOutcomeReporter) Report(
	ctx context.Context,
	input agentsessionstore.ReportActivityInput,
) error {
	provider := strings.TrimSpace(input.Source.Provider)
	if provider != "" && input.Source.ProviderGlobalAuthEligible && r.store != nil {
		switch reportRunOutcome(input) {
		case runOutcomeAuthFailed:
			r.store.RecordAuthFailure(provider)
		case runOutcomeSuccess:
			r.store.RecordSuccess(provider)
		}
	}
	return r.DurableActivityReporter.Report(ctx, input)
}

func (r agentRunOutcomeReporter) BindGoalProvenance(ctx context.Context, input agentsessionstore.BindGoalProvenanceInput) (agentsessionstore.GoalProvenanceBinding, error) {
	ledger, ok := r.DurableActivityReporter.(agentsessionstore.GoalProvenanceLedger)
	if !ok {
		return agentsessionstore.GoalProvenanceBinding{}, errors.New("agent activity reporter does not support goal provenance")
	}
	return ledger.BindGoalProvenance(ctx, input)
}

func (r agentRunOutcomeReporter) LookupGoalProvenance(ctx context.Context, input agentsessionstore.LookupGoalProvenanceInput) (agentsessionstore.GoalProvenanceBinding, bool, error) {
	ledger, ok := r.DurableActivityReporter.(agentsessionstore.GoalProvenanceLedger)
	if !ok {
		return agentsessionstore.GoalProvenanceBinding{}, false, errors.New("agent activity reporter does not support goal provenance")
	}
	return ledger.LookupGoalProvenance(ctx, input)
}

type runOutcome int

const (
	runOutcomeNone runOutcome = iota
	runOutcomeAuthFailed
	runOutcomeSuccess
)

func reportRunOutcome(input agentsessionstore.ReportActivityInput) runOutcome {
	outcome := runOutcomeNone
	for _, patch := range input.StatePatches {
		root := patch.RootProviderTurn
		if root == nil || root.Phase != agentsessionstore.RootProviderTurnPhaseCompleted {
			continue
		}
		switch {
		case strings.EqualFold(root.Outcome, "failed") && strings.EqualFold(root.ErrorCode, "auth_required"):
			// A typed root-provider authentication failure wins over every other
			// projection in the report batch.
			outcome = runOutcomeAuthFailed
		case outcome == runOutcomeNone && strings.EqualFold(root.Outcome, "completed"):
			outcome = runOutcomeSuccess
		}
	}
	return outcome
}
