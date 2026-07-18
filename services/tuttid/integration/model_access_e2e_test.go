package integration

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
	collabrunbiz "github.com/tutti-os/tutti/services/tuttid/biz/collabrun"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	modelpolicybiz "github.com/tutti-os/tutti/services/tuttid/biz/modelpolicy"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	collabrunservice "github.com/tutti-os/tutti/services/tuttid/service/collabrun"
	modelbindingservice "github.com/tutti-os/tutti/services/tuttid/service/modelbinding"
	modelplanservice "github.com/tutti-os/tutti/services/tuttid/service/modelplan"
	modelpolicyservice "github.com/tutti-os/tutti/services/tuttid/service/modelpolicy"
)

// newFakeOpenAIProvider serves a minimal OpenAI-compatible surface: a model
// catalog and a chat completion endpoint gated by one bearer key.
func newFakeOpenAIProvider(t *testing.T, apiKey string, completionText string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+apiKey {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/v1/models":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"data":[{"id":"fake-pro","display_name":"Fake Pro"},{"id":"fake-mini","display_name":"Fake Mini"}]}`))
		case "/v1/chat/completions":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"choices":[{"message":{"content":` + jsonString(completionText) + `}}],"usage":{"prompt_tokens":12,"completion_tokens":5}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func jsonString(value string) string {
	replaced := strings.ReplaceAll(value, `\`, `\\`)
	replaced = strings.ReplaceAll(replaced, `"`, `\"`)
	replaced = strings.ReplaceAll(replaced, "\n", `\n`)
	return `"` + replaced + `"`
}

// TestModelAccessVerticalLoop drives the whole first-iteration loop against a
// real SQLite store and a fake OpenAI-compatible provider: plan creation,
// staged detection, agent binding, plan-endpoint resolution, first real use,
// a user consult with timeline projection, and the fixed review rule raising
// the acceptance ladder to auto_checked.
func TestModelAccessVerticalLoop(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store, err := workspacedata.OpenSQLiteStore(filepath.Join(t.TempDir(), "tuttid.db"))
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-e2e", Name: "E2E"}); err != nil {
		t.Fatalf("create workspace error = %v", err)
	}

	fake := newFakeOpenAIProvider(t, "sk-e2e", "Advice: looks good.\nVERDICT: PASS")

	plans := &modelplanservice.Service{Store: store, HTTPClient: fake.Client()}
	bindings := &modelbindingservice.Service{Store: store, Plans: store, Targets: store}
	policies := &modelpolicyservice.Service{Store: store}
	plans.References = modelplanservice.CompositeReferenceResolver{bindings, policies}
	collabRuns := &collabrunservice.Service{Store: store, Plans: store, Completer: plans}
	policies.ConfigureReviewAutomation(store, nil, collabRuns, collabRuns)

	// 1. Create the plan and run the staged detection.
	apiKey := "sk-e2e"
	created, err := plans.CreatePlan(ctx, modelplanservice.PutPlanInput{
		WorkspaceID:  "ws-e2e",
		Name:         "Fake Coding Plan",
		TemplateKind: "coding_plan",
		Protocol:     "openai",
		APIKey:       &apiKey,
		BaseURL:      fake.URL + "/v1",
		Enabled:      true,
	})
	if err != nil {
		t.Fatalf("CreatePlan() error = %v", err)
	}
	detect, err := plans.Detect(ctx, modelplanservice.DetectInput{WorkspaceID: "ws-e2e", PlanID: created.ID, Model: "fake-pro"})
	if err != nil {
		t.Fatalf("Detect() error = %v", err)
	}
	if !detect.Detection.CorePassed() {
		t.Fatalf("detection did not pass: %#v", detect.Detection)
	}
	if len(detect.DiscoveredModels) != 2 {
		t.Fatalf("discovered models = %#v", detect.DiscoveredModels)
	}
	// Adopt the discovered models and a default. Credentials are unchanged, so
	// the passed detection persists and the plan reads pending first use.
	if _, err := plans.UpdatePlan(ctx, modelplanservice.PutPlanInput{
		WorkspaceID:  "ws-e2e",
		PlanID:       created.ID,
		Name:         "Fake Coding Plan",
		TemplateKind: "coding_plan",
		Protocol:     "openai",
		BaseURL:      fake.URL + "/v1",
		Models:       detect.DiscoveredModels,
		DefaultModel: "fake-pro",
		Enabled:      true,
	}); err != nil {
		t.Fatalf("UpdatePlan() error = %v", err)
	}
	pending, err := plans.GetPlan(ctx, "ws-e2e", created.ID)
	if err != nil {
		t.Fatalf("GetPlan() error = %v", err)
	}
	if pending.Status != modelplanbiz.StatusPendingFirstUse {
		t.Fatalf("plan status = %q, want pending_first_use", pending.Status)
	}

	// 2. Bind the codex target to the plan with a policy carrying the fixed
	// review rule.
	policy, err := policies.PutPolicy(ctx, modelpolicyservice.PutPolicyInput{
		WorkspaceID: "ws-e2e",
		Name:        "Careful",
		Review:      modelpolicybiz.PlanModelRef{ModelPlanID: created.ID, Model: "fake-mini"},
		ReviewRule:  modelpolicybiz.ReviewRule{Enabled: true, MaxRunsPerSession: 2},
	})
	if err != nil {
		t.Fatalf("PutPolicy() error = %v", err)
	}
	if _, err := bindings.SetBinding(ctx, modelbindingservice.SetBindingInput{
		WorkspaceID:   "ws-e2e",
		AgentTargetID: "local:codex",
		ModelPlanID:   created.ID,
		DefaultModel:  "fake-pro",
		ModelPolicyID: policy.ID,
	}); err != nil {
		t.Fatalf("SetBinding() error = %v", err)
	}

	// Reference protection: the bound plan cannot be deleted.
	if err := plans.DeletePlan(ctx, "ws-e2e", created.ID); err == nil {
		t.Fatalf("DeletePlan() should be blocked while referenced")
	}
	references, err := plans.PlanReferences(ctx, "ws-e2e", created.ID)
	if err != nil {
		t.Fatalf("PlanReferences() error = %v", err)
	}
	if len(references) != 2 {
		t.Fatalf("references = %#v, want binding + policy", references)
	}

	// 3. First real use: a completed turn on a plan-bound session marks the
	// plan's first use (the agent service observer path is unit-tested; here
	// we drive the marker directly to keep the loop at the domain level).
	if err := plans.MarkFirstUse(ctx, "ws-e2e", created.ID, "local:codex", "session-e2e", "fake-pro"); err != nil {
		t.Fatalf("MarkFirstUse() error = %v", err)
	}
	ready, err := plans.GetPlan(ctx, "ws-e2e", created.ID)
	if err != nil {
		t.Fatalf("GetPlan(ready) error = %v", err)
	}
	if ready.Status != modelplanbiz.StatusReady {
		t.Fatalf("plan status after first use = %q, want ready", ready.Status)
	}

	// 4. User consult executes a real (fake-served) completion and records
	// full accounting.
	consult, err := collabRuns.StartConsult(ctx, collabrunservice.StartConsultInput{
		WorkspaceID:     "ws-e2e",
		SourceSessionID: "session-e2e",
		ModelPlanID:     created.ID,
		Question:        "Is this approach sound?",
		TriggerSource:   string(collabrunbiz.TriggerUser),
		TriggerReason:   "composer_consult",
	})
	if err != nil {
		t.Fatalf("StartConsult() error = %v", err)
	}
	if consult.Status != collabrunbiz.StatusCompleted || !strings.Contains(consult.ResultText, "Advice") {
		t.Fatalf("consult run = %#v", consult)
	}
	if consult.Usage.InputTokens != 12 || consult.Usage.OutputTokens != 5 {
		t.Fatalf("consult usage = %#v", consult.Usage)
	}
	if consult.Model != "fake-pro" {
		t.Fatalf("consult model = %q, want plan default", consult.Model)
	}

	// 5. The fixed review rule: a settled completed turn triggers the policy
	// review consult and raises acceptance to auto_checked.
	completed := "completed"
	turnID := "turn-e2e-1"
	policies.ObserveAgentSessionState(ctx, canonical.ReportSessionStateInput{
		WorkspaceID:    "ws-e2e",
		AgentSessionID: "session-e2e",
		State: canonical.WorkspaceAgentSessionStateUpdate{
			AgentTargetID: "local:codex",
			TurnLifecycle: &canonical.WorkspaceAgentTurnLifecycle{
				ActiveTurnID: &turnID,
				Phase:        "settled",
				Outcome:      &completed,
			},
		},
	}, canonical.ReportSessionStateReply{})

	deadline := time.Now().Add(10 * time.Second)
	for {
		acceptance, ok, err := policies.GetAcceptance(ctx, "ws-e2e", "session-e2e")
		if err != nil {
			t.Fatalf("GetAcceptance() error = %v", err)
		}
		if ok && acceptance.State == modelpolicybiz.AcceptanceAutoChecked {
			if acceptance.ReviewRunID == "" {
				t.Fatalf("auto_checked without review run id: %#v", acceptance)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("acceptance never reached auto_checked: %#v ok=%v", acceptance, ok)
		}
		time.Sleep(20 * time.Millisecond)
	}

	// The review run is recorded as a policy-triggered consult.
	runs, err := collabRuns.ListRuns(ctx, "ws-e2e", "session-e2e", 0)
	if err != nil {
		t.Fatalf("ListRuns() error = %v", err)
	}
	policyRuns := 0
	for _, run := range runs {
		if run.TriggerSource == collabrunbiz.TriggerPolicy {
			policyRuns++
			if run.Model != "fake-mini" {
				t.Fatalf("review run model = %q, want policy review model", run.Model)
			}
		}
	}
	if policyRuns != 1 {
		t.Fatalf("policy review runs = %d, want 1 (all runs: %#v)", policyRuns, runs)
	}

	// 6. Only the user closes work: user acceptance is explicit.
	accepted, err := policies.MarkUserAccepted(ctx, "ws-e2e", "session-e2e")
	if err != nil {
		t.Fatalf("MarkUserAccepted() error = %v", err)
	}
	if accepted.State != modelpolicybiz.AcceptanceUserAccepted {
		t.Fatalf("acceptance = %#v", accepted)
	}

	// 7. Session-level override disables further automated review.
	if _, err := policies.SetSessionOverride(ctx, modelpolicybiz.SessionOverride{
		WorkspaceID:    "ws-e2e",
		AgentSessionID: "session-e2e",
		Disabled:       true,
	}); err != nil {
		t.Fatalf("SetSessionOverride() error = %v", err)
	}
	turn2 := "turn-e2e-2"
	policies.ObserveAgentSessionState(ctx, canonical.ReportSessionStateInput{
		WorkspaceID:    "ws-e2e",
		AgentSessionID: "session-e2e",
		State: canonical.WorkspaceAgentSessionStateUpdate{
			AgentTargetID: "local:codex",
			TurnLifecycle: &canonical.WorkspaceAgentTurnLifecycle{
				ActiveTurnID: &turn2,
				Phase:        "settled",
				Outcome:      &completed,
			},
		},
	}, canonical.ReportSessionStateReply{})
	time.Sleep(200 * time.Millisecond)
	runs, err = collabRuns.ListRuns(ctx, "ws-e2e", "session-e2e", 0)
	if err != nil {
		t.Fatalf("ListRuns(after override) error = %v", err)
	}
	policyRuns = 0
	for _, run := range runs {
		if run.TriggerSource == collabrunbiz.TriggerPolicy {
			policyRuns++
		}
	}
	if policyRuns != 1 {
		t.Fatalf("override should stop further reviews; policy runs = %d", policyRuns)
	}

	// Credential never leaks through any read surface.
	for _, run := range runs {
		if strings.Contains(run.ResultText, "sk-e2e") || strings.Contains(run.FailureReason, "sk-e2e") {
			t.Fatalf("credential leaked into run record: %#v", run)
		}
	}
	if strings.Contains(ready.BaseURL+ready.Name, "sk-e2e") {
		t.Fatalf("credential leaked into plan projection")
	}
}
