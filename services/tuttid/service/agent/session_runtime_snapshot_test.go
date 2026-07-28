package agent

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	modelbindingbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelbinding"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	modelgatewayservice "github.com/tutti-os/tutti/services/tuttid/service/modelgateway"
)

type revisionPlanSource struct {
	current   modelplanbiz.Plan
	revisions map[uint64]modelplanbiz.Plan
}

func (s revisionPlanSource) GetModelPlan(context.Context, string, string) (modelplanbiz.Plan, error) {
	if strings.TrimSpace(s.current.ID) == "" {
		return modelplanbiz.Plan{}, workspacedata.ErrModelPlanNotFound
	}
	return s.current, nil
}

func (s revisionPlanSource) GetModelPlanRevision(_ context.Context, _ string, _ string, revision uint64) (modelplanbiz.Plan, error) {
	plan, ok := s.revisions[revision]
	if !ok {
		return modelplanbiz.Plan{}, workspacedata.ErrModelPlanRevisionNotFound
	}
	return plan, nil
}

func TestSessionRuntimeSnapshotIsVersionedAndRedactionSafe(t *testing.T) {
	t.Parallel()

	plan := snapshotTestPlan(7, "https://old-relay.example/v1", "sk-old-secret")
	resolution, err := resolveProvidedModelPlan("codex", "workspace-agent:writer", plan, "gpt-new", "gpt-new")
	if err != nil {
		t.Fatalf("resolveProvidedModelPlan() error = %v", err)
	}
	model := "gpt-new"
	permissionMode := "full-access"
	contextPayload := runtimeContextWithSessionRuntimeSnapshot(nil, CreateSessionInput{
		AgentTargetID:             "workspace-agent:writer",
		WorkspaceAgentRevision:    3,
		HarnessAgentTargetID:      "local:codex",
		AgentName:                 "Focused Writer",
		AgentDescription:          "Make narrow repository changes.",
		AgentInstructions:         "Use the repository conventions.",
		AgentCapabilitiesExplicit: true,
		AgentSkills:               []string{"go", "tests"},
		AgentTools:                []string{"shell"},
		Model:                     &model,
		PermissionModeID:          &permissionMode,
	}, "codex", resolution)

	encoded, err := json.Marshal(contextPayload)
	if err != nil {
		t.Fatalf("marshal runtime context error = %v", err)
	}
	serialized := string(encoded)
	if strings.Contains(serialized, plan.APIKey) || strings.Contains(serialized, plan.BaseURL) {
		t.Fatalf("runtime snapshot leaked endpoint secret: %s", serialized)
	}

	var persistedContext map[string]any
	if err := json.Unmarshal(encoded, &persistedContext); err != nil {
		t.Fatalf("unmarshal persisted runtime context error = %v", err)
	}
	snapshot, exists, err := sessionRuntimeSnapshotFromContext(persistedContext)
	if err != nil || !exists {
		t.Fatalf("sessionRuntimeSnapshotFromContext() = %#v, %v, exists=%v", snapshot, err, exists)
	}
	if snapshot.Version != sessionRuntimeSnapshotVersion || snapshot.AgentTargetID != "workspace-agent:writer" || snapshot.WorkspaceAgentRevision != 3 || snapshot.HarnessAgentTargetID != "local:codex" {
		t.Fatalf("snapshot launch identity = %#v", snapshot)
	}
	if snapshot.ModelPlanID != "mp-1" || snapshot.ModelPlanRevision != 7 || snapshot.Model != "gpt-new" || snapshot.ModelFingerprint == "" {
		t.Fatalf("snapshot model identity = %#v", snapshot)
	}
	if snapshot.Instructions == "" || len(snapshot.Skills) != 2 || len(snapshot.Tools) != 1 {
		t.Fatalf("snapshot agent definition = %#v", snapshot)
	}
	if !snapshot.CapabilitiesExplicit {
		t.Fatal("snapshot lost explicit capability selection")
	}
	if snapshot.Name != "Focused Writer" || snapshot.Description != "Make narrow repository changes." {
		t.Fatalf("snapshot name/description = %q/%q", snapshot.Name, snapshot.Description)
	}
}

// Sessions created before the Wave 4-2 contract cleanup persisted the Agent
// description under the retired purpose key. Their durable snapshots must
// keep resuming without a rewrite.
func TestSessionRuntimeSnapshotReadsLegacyPurposeKeyAsDescription(t *testing.T) {
	t.Parallel()

	plan := snapshotTestPlan(7, "https://old-relay.example/v1", "sk-old-secret")
	resolution, err := resolveProvidedModelPlan("codex", "workspace-agent:writer", plan, "gpt-new", "gpt-new")
	if err != nil {
		t.Fatalf("resolveProvidedModelPlan() error = %v", err)
	}
	model := "gpt-new"
	contextPayload := runtimeContextWithSessionRuntimeSnapshot(nil, CreateSessionInput{
		AgentTargetID:          "workspace-agent:writer",
		WorkspaceAgentRevision: 3,
		HarnessAgentTargetID:   "local:codex",
		AgentName:              "Focused Writer",
		Model:                  &model,
	}, "codex", resolution)
	legacy := contextPayload[sessionRuntimeSnapshotContextKey].(map[string]any)
	legacy["agentDefinition"] = map[string]any{
		"name":    "Focused Writer",
		"purpose": "Legacy purpose text.",
	}

	snapshot, exists, err := sessionRuntimeSnapshotFromContext(contextPayload)
	if err != nil || !exists {
		t.Fatalf("sessionRuntimeSnapshotFromContext() = %#v, %v, exists=%v", snapshot, err, exists)
	}
	if snapshot.Description != "Legacy purpose text." {
		t.Fatalf("snapshot description = %q, want legacy purpose fallback", snapshot.Description)
	}
}

func TestServiceSessionProjectsImmutableModelPlanID(t *testing.T) {
	t.Parallel()

	plan := snapshotTestPlan(7, "https://relay.example/v1", "sk-secret")
	model := "gpt-new"
	resolution, err := resolveProvidedModelPlan(
		"codex",
		"workspace-agent:writer",
		plan,
		model,
		model,
	)
	if err != nil {
		t.Fatalf("resolveProvidedModelPlan() error = %v", err)
	}
	runtimeContext := runtimeContextWithSessionRuntimeSnapshot(
		nil,
		CreateSessionInput{AgentTargetID: "workspace-agent:writer", Model: &model},
		"codex",
		resolution,
	)

	session := serviceSession(ProviderRuntimeSession{
		ID:             "session-1",
		WorkspaceID:    "ws",
		AgentTargetID:  "workspace-agent:writer",
		Provider:       "codex",
		Settings:       &ComposerSettings{Model: model},
		RuntimeContext: runtimeContext,
		Visible:        true,
	}, true)

	if session.Settings == nil || session.Settings.ModelPlanID != plan.ID {
		t.Fatalf("service session settings = %#v, want model plan %q", session.Settings, plan.ID)
	}
}

func TestPrepareRuntimeForResumeUsesExactModelPlanRevision(t *testing.T) {
	t.Parallel()

	oldPlan := snapshotTestPlan(1, "https://old-relay.example/v1", "sk-old-secret")
	oldPlan.Models = append(oldPlan.Models, modelplanbiz.Model{ID: "gpt-alt", Name: "gpt-alt"})
	currentPlan := snapshotTestPlan(2, "https://new-relay.example/v1", "sk-new-secret")
	plans := revisionPlanSource{current: currentPlan, revisions: map[uint64]modelplanbiz.Plan{1: oldPlan, 2: currentPlan}}
	service := &Service{}
	service.AgentTargetStore = fakeAgentTargetStore{targets: defaultTestAgentTargets()}
	var preparedInput runtimeprep.PrepareInput
	service.RuntimePreparer = fakeRuntimePreparer{input: &preparedInput}
	var registeredRoute modelgatewayservice.Route
	service.ModelGateway = fakeModelGateway{
		endpoint: modelgatewayservice.ClientEndpoint{
			BaseURL: "http://127.0.0.1:43123/v1",
			Token:   "temporary-gateway-token",
			WireAPI: "responses",
		},
		registeredRoute: &registeredRoute,
	}
	service.ConfigureModelPlanBinding(staticBindingSource{binding: modelbindingbiz.Binding{
		WorkspaceID:   "ws",
		AgentTargetID: "workspace-agent:writer",
		ModelPlanID:   currentPlan.ID,
		DefaultModel:  "gpt-new",
	}}, plans)

	model := "gpt-old"
	resolution, err := resolveProvidedModelPlan("codex", "workspace-agent:writer", oldPlan, model, model)
	if err != nil {
		t.Fatalf("resolve old plan error = %v", err)
	}
	runtimeContext := runtimeContextWithSessionRuntimeSnapshot(nil, CreateSessionInput{
		AgentTargetID:          "workspace-agent:writer",
		WorkspaceAgentRevision: 4,
		HarnessAgentTargetID:   "local:codex",
		AgentName:              "Old Writer",
		AgentDescription:       "Use the original description.",
		AgentInstructions:      "old instructions",
		AgentSkills:            []string{"old-skill"},
		Model:                  &model,
	}, "codex", resolution)
	resumedModel := "gpt-alt"
	_, err = service.prepareRuntimeForResume(context.Background(), PersistedSession{
		ID:                     "session-1",
		WorkspaceID:            "ws",
		AgentTargetID:          "workspace-agent:writer",
		Provider:               "codex",
		Cwd:                    "/repo",
		Settings:               ComposerSettings{Model: resumedModel},
		InternalRuntimeContext: runtimeContext,
	})
	if err != nil {
		t.Fatalf("prepareRuntimeForResume() error = %v", err)
	}
	if preparedInput.ModelEndpoint == nil {
		t.Fatal("prepared model endpoint is nil")
	}
	if registeredRoute.UpstreamAPIKey != oldPlan.APIKey || registeredRoute.UpstreamURL != oldPlan.BaseURL {
		t.Fatalf("registered route = %#v, want exact old revision", registeredRoute)
	}
	if preparedInput.ModelEndpoint.APIKey != "temporary-gateway-token" ||
		preparedInput.ModelEndpoint.BaseURL != "http://127.0.0.1:43123/v1" ||
		preparedInput.ModelEndpoint.WireAPI != "responses" ||
		preparedInput.ModelEndpoint.Model != resumedModel {
		t.Fatalf("prepared endpoint = %#v, want temporary gateway endpoint", preparedInput.ModelEndpoint)
	}
	if preparedInput.AgentInstructions != "old instructions" || len(preparedInput.AgentSkills) != 1 || preparedInput.AgentSkills[0] != "old-skill" {
		t.Fatalf("prepared agent definition = %#v", preparedInput)
	}
	if preparedInput.AgentName != "Old Writer" || preparedInput.AgentDescription != "Use the original description." {
		t.Fatalf("prepared name/description = %q/%q", preparedInput.AgentName, preparedInput.AgentDescription)
	}
}

func TestPrepareRuntimeForResumeProviderNativeSnapshotIgnoresNewBinding(t *testing.T) {
	t.Parallel()

	currentPlan := snapshotTestPlan(2, "https://new-relay.example/v1", "sk-new-secret")
	service := &Service{}
	service.AgentTargetStore = fakeAgentTargetStore{targets: defaultTestAgentTargets()}
	var preparedInput runtimeprep.PrepareInput
	service.RuntimePreparer = fakeRuntimePreparer{input: &preparedInput}
	service.ConfigureModelPlanBinding(staticBindingSource{binding: modelbindingbiz.Binding{
		WorkspaceID:   "ws",
		AgentTargetID: "local:codex",
		ModelPlanID:   currentPlan.ID,
	}}, revisionPlanSource{current: currentPlan, revisions: map[uint64]modelplanbiz.Plan{2: currentPlan}})

	model := "gpt-native"
	runtimeContext := runtimeContextWithSessionRuntimeSnapshot(nil, CreateSessionInput{
		AgentTargetID: "local:codex",
		Model:         &model,
	}, "codex", modelPlanResolution{ModelConfiguration: newProviderNativeModelConfiguration("codex", "local:codex")})
	_, err := service.prepareRuntimeForResume(context.Background(), PersistedSession{
		ID:                     "session-native",
		WorkspaceID:            "ws",
		AgentTargetID:          "local:codex",
		Provider:               "codex",
		Settings:               ComposerSettings{Model: model},
		InternalRuntimeContext: runtimeContext,
	})
	if err != nil {
		t.Fatalf("prepareRuntimeForResume() error = %v", err)
	}
	if preparedInput.ModelEndpoint != nil {
		t.Fatalf("provider-native resume used new binding endpoint %#v", preparedInput.ModelEndpoint)
	}
}

func TestPrepareRuntimeForResumeFailsWhenExactRevisionIsMissing(t *testing.T) {
	t.Parallel()

	plan := snapshotTestPlan(1, "https://relay.example/v1", "sk-secret")
	service := &Service{}
	service.AgentTargetStore = fakeAgentTargetStore{targets: defaultTestAgentTargets()}
	service.RuntimePreparer = fakeRuntimePreparer{}
	service.ConfigureModelPlanBinding(staticBindingSource{}, revisionPlanSource{current: plan, revisions: map[uint64]modelplanbiz.Plan{}})
	model := "gpt-old"
	resolution, err := resolveProvidedModelPlan("codex", "local:codex", plan, model, model)
	if err != nil {
		t.Fatalf("resolve plan error = %v", err)
	}
	runtimeContext := runtimeContextWithSessionRuntimeSnapshot(nil, CreateSessionInput{
		AgentTargetID: "local:codex",
		Model:         &model,
	}, "codex", resolution)
	_, err = service.prepareRuntimeForResume(context.Background(), PersistedSession{
		ID:                     "session-missing-revision",
		WorkspaceID:            "ws",
		AgentTargetID:          "local:codex",
		Provider:               "codex",
		InternalRuntimeContext: runtimeContext,
	})
	if !errors.Is(err, ErrSessionRuntimeSnapshotUnavailable) {
		t.Fatalf("prepareRuntimeForResume() error = %v, want snapshot unavailable", err)
	}
}

func TestPrepareRuntimeForResumeRejectsMismatchedRevisionFingerprint(t *testing.T) {
	t.Parallel()

	launchPlan := snapshotTestPlan(1, "https://relay.example/v1", "sk-secret")
	model := "gpt-old"
	resolution, err := resolveProvidedModelPlan("codex", "local:codex", launchPlan, model, model)
	if err != nil {
		t.Fatalf("resolve plan error = %v", err)
	}
	runtimeContext := runtimeContextWithSessionRuntimeSnapshot(nil, CreateSessionInput{
		AgentTargetID: "local:codex",
		Model:         &model,
	}, "codex", resolution)

	corruptedRevision := launchPlan
	corruptedRevision.Models = append(corruptedRevision.Models, modelplanbiz.Model{ID: "unexpected-model", Name: "Unexpected"})
	service := &Service{RuntimePreparer: fakeRuntimePreparer{}}
	service.AgentTargetStore = fakeAgentTargetStore{targets: defaultTestAgentTargets()}
	service.ConfigureModelPlanBinding(staticBindingSource{}, revisionPlanSource{
		current:   launchPlan,
		revisions: map[uint64]modelplanbiz.Plan{1: corruptedRevision},
	})

	_, err = service.prepareRuntimeForResume(context.Background(), PersistedSession{
		ID:                     "session-fingerprint-mismatch",
		WorkspaceID:            "ws",
		AgentTargetID:          "local:codex",
		Provider:               "codex",
		InternalRuntimeContext: runtimeContext,
	})
	if !errors.Is(err, ErrSessionRuntimeSnapshotUnavailable) || !strings.Contains(err.Error(), "fingerprint") {
		t.Fatalf("prepareRuntimeForResume() error = %v, want fingerprint mismatch", err)
	}
}

func TestPrepareRuntimeForResumeRejectsRevokedCurrentPlan(t *testing.T) {
	t.Parallel()

	oldPlan := snapshotTestPlan(1, "https://old-relay.example/v1", "sk-old-secret")
	model := "gpt-old"
	resolution, err := resolveProvidedModelPlan("codex", "local:codex", oldPlan, model, model)
	if err != nil {
		t.Fatalf("resolve plan error = %v", err)
	}
	runtimeContext := runtimeContextWithSessionRuntimeSnapshot(nil, CreateSessionInput{
		AgentTargetID: "local:codex",
		Model:         &model,
	}, "codex", resolution)

	tests := []struct {
		name    string
		current modelplanbiz.Plan
	}{
		{name: "disabled", current: func() modelplanbiz.Plan {
			plan := snapshotTestPlan(2, "https://new-relay.example/v1", "sk-new-secret")
			plan.Enabled = false
			return plan
		}()},
		{name: "deleted", current: modelplanbiz.Plan{}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			service := &Service{RuntimePreparer: fakeRuntimePreparer{}}
			service.AgentTargetStore = fakeAgentTargetStore{targets: defaultTestAgentTargets()}
			service.ConfigureModelPlanBinding(staticBindingSource{}, revisionPlanSource{
				current:   test.current,
				revisions: map[uint64]modelplanbiz.Plan{1: oldPlan},
			})
			_, err := service.prepareRuntimeForResume(context.Background(), PersistedSession{
				ID:                     "session-revoked",
				WorkspaceID:            "ws",
				AgentTargetID:          "local:codex",
				Provider:               "codex",
				InternalRuntimeContext: runtimeContext,
			})
			if !errors.Is(err, ErrSessionRuntimeAccessRevoked) {
				t.Fatalf("prepareRuntimeForResume() error = %v, want access revoked", err)
			}
		})
	}
}

func TestUpdateSettingsValidatesModelAgainstSnapshottedPlanRevision(t *testing.T) {
	t.Parallel()

	oldPlan := snapshotTestPlan(1, "https://old-relay.example/v1", "sk-old-secret")
	currentPlan := snapshotTestPlan(2, "https://new-relay.example/v1", "sk-new-secret")
	model := "gpt-old"
	resolution, err := resolveProvidedModelPlan("codex", "local:codex", oldPlan, model, model)
	if err != nil {
		t.Fatalf("resolve plan error = %v", err)
	}
	runtimeContext := runtimeContextWithSessionRuntimeSnapshot(nil, CreateSessionInput{
		AgentTargetID: "local:codex",
		Model:         &model,
	}, "codex", resolution)
	runtime := newFakeRuntime()
	runtime.sessions["ws:session-1"] = ProviderRuntimeSession{
		ID:             "session-1",
		WorkspaceID:    "ws",
		AgentTargetID:  "local:codex",
		Provider:       "codex",
		Settings:       &ComposerSettings{Model: model},
		RuntimeContext: runtimeContext,
	}
	service := NewService(runtime)
	seedPersistedLiveSettingsSession(service, runtime.sessions["ws:session-1"])
	configureTestApplicationHost(service)
	service.ConfigureModelPlanBinding(staticBindingSource{}, revisionPlanSource{
		current:   currentPlan,
		revisions: map[uint64]modelplanbiz.Plan{1: oldPlan, 2: currentPlan},
	})

	invalid := "gpt-new"
	_, err = service.UpdateSettings(context.Background(), "ws", "session-1", ComposerSettingsPatch{Model: &invalid})
	var invalidModel *InvalidModelError
	if !errors.As(err, &invalidModel) {
		t.Fatalf("UpdateSettings() error = %v, want InvalidModelError", err)
	}
	if got := runtime.sessions["ws:session-1"].Settings.Model; got != model {
		t.Fatalf("runtime model changed to %q after rejected update, want %q", got, model)
	}
}

func snapshotTestPlan(revision uint64, baseURL string, apiKey string) modelplanbiz.Plan {
	modelID := "gpt-old"
	if revision > 1 {
		modelID = "gpt-new"
	}
	return modelplanbiz.Plan{
		ID:           "mp-1",
		WorkspaceID:  "ws",
		Revision:     revision,
		Name:         "Plan",
		Protocol:     modelplanbiz.ProtocolOpenAI,
		APIKey:       apiKey,
		BaseURL:      baseURL,
		Models:       []modelplanbiz.Model{{ID: modelID, Name: modelID}},
		DefaultModel: modelID,
		Enabled:      true,
	}
}
