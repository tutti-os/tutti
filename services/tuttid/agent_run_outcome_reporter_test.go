package main

import (
	"context"
	"testing"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
	agentstatusservice "github.com/tutti-os/tutti/services/tuttid/service/agentstatus"
)

type submitProvenanceCaptureReporter struct {
	report agentsessionstore.ReportActivityInput
}

func (*submitProvenanceCaptureReporter) Report(context.Context, agentsessionstore.ReportActivityInput) error {
	return nil
}

func (r *submitProvenanceCaptureReporter) ReportSubmitProvenance(_ context.Context, input agentsessionstore.ReportActivityInput) error {
	r.report = input
	return nil
}

func TestReportRunOutcomeAuthFailureWinsOverCompletion(t *testing.T) {
	input := agentsessionstore.ReportActivityInput{
		Source: canonical.EventSource{Provider: "claude-code"},
		StatePatches: []agentsessionstore.WorkspaceAgentStatePatch{
			{RootProviderTurn: &canonical.WorkspaceAgentRootProviderTurnTransition{Phase: agentsessionstore.RootProviderTurnPhaseCompleted, Outcome: "completed"}},
			{RootProviderTurn: &canonical.WorkspaceAgentRootProviderTurnTransition{Phase: agentsessionstore.RootProviderTurnPhaseCompleted, Outcome: "failed", ErrorCode: "auth_required"}},
		},
	}
	if got := reportRunOutcome(input); got != runOutcomeAuthFailed {
		t.Fatalf("reportRunOutcome = %v, want authFailed", got)
	}
}

func TestReportRunOutcomeSuccessClears(t *testing.T) {
	input := agentsessionstore.ReportActivityInput{
		Source: canonical.EventSource{Provider: "codex"},
		StatePatches: []agentsessionstore.WorkspaceAgentStatePatch{
			{RootProviderTurn: &canonical.WorkspaceAgentRootProviderTurnTransition{Phase: agentsessionstore.RootProviderTurnPhaseCompleted, Outcome: "completed"}},
		},
	}
	if got := reportRunOutcome(input); got != runOutcomeSuccess {
		t.Fatalf("reportRunOutcome = %v, want success", got)
	}
}

func TestReportRunOutcomeIgnoresMessageTextAndToolCompletion(t *testing.T) {
	input := agentsessionstore.ReportActivityInput{
		MessageUpdates: []agentsessionstore.WorkspaceAgentMessageUpdate{{Status: "failed", Payload: map[string]any{"text": "401 unauthorized auth token"}}},
		TimelineItems:  []agentsessionstore.WorkspaceAgentTimelineItem{{Status: "completed"}},
	}
	if got := reportRunOutcome(input); got != runOutcomeNone {
		t.Fatalf("reportRunOutcome = %v, want none", got)
	}
}

func TestAgentRunOutcomeReporterScopesProviderGlobalAuthentication(t *testing.T) {
	store := agentstatusservice.NewRunOutcomeStore()
	reporter := agentRunOutcomeReporter{
		DurableActivityReporter: &submitProvenanceCaptureReporter{},
		store:                   store,
	}
	failure := []agentsessionstore.WorkspaceAgentStatePatch{{
		RootProviderTurn: &canonical.WorkspaceAgentRootProviderTurnTransition{
			Phase: agentsessionstore.RootProviderTurnPhaseCompleted, Outcome: "failed", ErrorCode: "auth_required",
		},
	}}
	if err := reporter.Report(context.Background(), agentsessionstore.ReportActivityInput{
		Source: canonical.EventSource{Provider: "claude-code"}, StatePatches: failure,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, found := store.AuthEvidence("claude-code"); found {
		t.Fatal("model-plan/extension scoped failure must not mutate provider-global authentication")
	}
	if err := reporter.Report(context.Background(), agentsessionstore.ReportActivityInput{
		Source: canonical.EventSource{Provider: "claude-code", ProviderGlobalAuthEligible: true}, StatePatches: failure,
	}); err != nil {
		t.Fatal(err)
	}
	if !store.AuthInvalidated("claude-code") {
		t.Fatal("provider-native typed authentication failure must invalidate provider authentication")
	}
}

func TestAgentRunOutcomeReporterPreservesRequiredAtomicSubmitProvenance(t *testing.T) {
	inner := &submitProvenanceCaptureReporter{}
	reporter := agentRunOutcomeReporter{DurableActivityReporter: inner}
	input := agentsessionstore.ReportActivityInput{WorkspaceID: "ws-1"}
	if err := reporter.ReportSubmitProvenance(context.Background(), input); err != nil {
		t.Fatalf("ReportSubmitProvenance() error = %v", err)
	}
	if inner.report.WorkspaceID != "ws-1" {
		t.Fatalf("forwarded report = %#v", inner.report)
	}
}
