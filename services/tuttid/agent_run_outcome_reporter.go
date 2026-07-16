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
// authentication failure (e.g. a 401 sending a message) is fed back into the
// status probe: it flips the provider's cached auth to "needs login", which the
// stateless marker / `auth status` check would otherwise miss (the local
// credentials file still says "logged in"). A successfully completed turn clears
// the flag, so a re-login that works stops being reported as broken. Embedding
// the required durable reporter promotes its provenance receipt method without
// a second, manually forwarded optional seam.
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
	if provider != "" && r.store != nil {
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
	ledger, ok := r.inner.(agentsessionstore.GoalProvenanceLedger)
	if !ok {
		return agentsessionstore.GoalProvenanceBinding{}, errors.New("agent activity reporter does not support goal provenance")
	}
	return ledger.BindGoalProvenance(ctx, input)
}

func (r agentRunOutcomeReporter) LookupGoalProvenance(ctx context.Context, input agentsessionstore.LookupGoalProvenanceInput) (agentsessionstore.GoalProvenanceBinding, bool, error) {
	ledger, ok := r.inner.(agentsessionstore.GoalProvenanceLedger)
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
	consider := func(status string, payload map[string]any) {
		switch {
		case messageLooksLikeAuthFailure(status, payload):
			// An auth failure anywhere in the batch wins over a stray completion.
			outcome = runOutcomeAuthFailed
		case outcome == runOutcomeNone && status == "completed":
			outcome = runOutcomeSuccess
		}
	}
	for _, message := range input.MessageUpdates {
		consider(message.Status, message.Payload)
	}
	for _, item := range input.TimelineItems {
		consider(item.Status, item.Payload)
	}
	return outcome
}

func messageLooksLikeAuthFailure(status string, payload map[string]any) bool {
	if status != "failed" {
		return false
	}
	if code, ok := payload["code"].(string); ok &&
		strings.EqualFold(code, "auth_required") {
		return true
	}
	var text strings.Builder
	for _, key := range []string{"content", "text", "detail"} {
		if value, ok := payload[key].(string); ok {
			text.WriteString(" ")
			text.WriteString(value)
		}
	}
	lower := strings.ToLower(text.String())
	for _, marker := range []string{
		"authentication_failed",
		"invalid authentication credentials",
		"401 invalid authentication",
		"unauthorized",
		"not logged in",
		"please run /login",
		"invalid api key",
		"could not load the default credentials",
		"api key is missing or not configured",
	} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}
