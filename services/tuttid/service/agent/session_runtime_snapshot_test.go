package agent

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	modelbindingbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelbinding"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	modelgatewayservice "github.com/tutti-os/tutti/services/tuttid/service/modelgateway"
)

type revisionPlanSource struct {
	current   modelplanbiz.Plan
	revisions map[uint64]modelplanbiz.Plan
}

type snapshotCommandCatalog []runtimeprep.CommandCapability

func (catalog snapshotCommandCatalog) Capabilities(
	context.Context,
	runtimeprep.CommandContext,
) []runtimeprep.CommandCapability {
	return append([]runtimeprep.CommandCapability(nil), catalog...)
}

func legacyEmptyOpenProviderRuntimeContext(
	provider string,
	agentTargetID string,
	projection *runtimeprep.CommandCapabilityProjection,
) map[string]any {
	runtimeContext := runtimeContextWithSessionRuntimeSnapshot(
		nil,
		CreateSessionInput{
			AgentTargetID:               agentTargetID,
			HarnessAgentTargetID:        agentTargetID,
			CommandCapabilityProjection: projection,
		},
		provider,
		modelPlanResolution{
			ModelConfiguration: newProviderNativeModelConfiguration(
				provider,
				agentTargetID,
			),
		},
	)
	snapshot := runtimeContext[sessionRuntimeSnapshotContextKey].(map[string]any)
	snapshot["provider"] = ""
	configuration := snapshot["modelConfiguration"].(map[string]any)
	configuration["fingerprint"] = legacyEmptyProviderNativeModelFingerprint(
		agentTargetID,
	)
	return runtimeContext
}

func legacyFingerprintOpenProviderRuntimeContext(
	provider string,
	agentTargetID string,
) map[string]any {
	runtimeContext := legacyEmptyOpenProviderRuntimeContext(
		provider,
		agentTargetID,
		nil,
	)
	snapshot := runtimeContext[sessionRuntimeSnapshotContextKey].(map[string]any)
	snapshot["provider"] = provider
	return runtimeContext
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
		CommandCapabilityProjection: &runtimeprep.CommandCapabilityProjection{
			AllowedIDs: []string{
				"issue-manager.issue.get",
				"tutti-goal-review.goal-review.verdict",
			},
			IncludeIntegrationIDs: []string{"tutti-goal-review.goal-review.verdict"},
			ExcludeIDs:            []string{"tutti-mode-plan.plan.issue.complete"},
		},
		Model:            &model,
		PermissionModeID: &permissionMode,
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
	if snapshot.CommandCapabilityProjection == nil ||
		!reflect.DeepEqual(snapshot.CommandCapabilityProjection.AllowedIDs, []string{
			"issue-manager.issue.get",
			"tutti-goal-review.goal-review.verdict",
		}) ||
		len(snapshot.CommandCapabilityProjection.IncludeIntegrationIDs) != 1 ||
		snapshot.CommandCapabilityProjection.IncludeIntegrationIDs[0] !=
			"tutti-goal-review.goal-review.verdict" ||
		len(snapshot.CommandCapabilityProjection.ExcludeIDs) != 1 ||
		snapshot.CommandCapabilityProjection.ExcludeIDs[0] !=
			"tutti-mode-plan.plan.issue.complete" {
		t.Fatalf(
			"snapshot command capability projection = %#v",
			snapshot.CommandCapabilityProjection,
		)
	}
	if snapshot.Name != "Focused Writer" || snapshot.Description != "Make narrow repository changes." {
		t.Fatalf("snapshot name/description = %q/%q", snapshot.Name, snapshot.Description)
	}
}

func TestSessionRuntimeSnapshotPreservesOpenProviderIdentity(t *testing.T) {
	t.Parallel()

	const (
		provider      = "acp:kimi-code"
		agentTargetID = "extension:kimi-code"
	)
	runtimeContext := runtimeContextWithSessionRuntimeSnapshot(
		nil,
		CreateSessionInput{
			AgentTargetID:        agentTargetID,
			HarnessAgentTargetID: agentTargetID,
		},
		provider,
		modelPlanResolution{
			ModelConfiguration: newProviderNativeModelConfiguration(
				provider,
				agentTargetID,
			),
		},
	)
	raw := runtimeContext[sessionRuntimeSnapshotContextKey].(map[string]any)
	if raw["provider"] != provider {
		t.Fatalf("persisted provider = %#v, want %q", raw["provider"], provider)
	}
	snapshot, exists, err := sessionRuntimeSnapshotFromContext(runtimeContext)
	if err != nil || !exists {
		t.Fatalf(
			"sessionRuntimeSnapshotFromContext() = %#v, exists=%v, error=%v",
			snapshot,
			exists,
			err,
		)
	}
	if snapshot.Provider != provider || snapshot.LegacyEmptyProviderFingerprint {
		t.Fatalf("snapshot provider identity = %#v", snapshot)
	}
}

func TestSessionRuntimeSnapshotRecoversVerifiedLegacyEmptyOpenProvider(
	t *testing.T,
) {
	t.Parallel()

	const (
		provider      = "acp:kimi-code"
		agentTargetID = "extension:kimi-code"
	)
	runtimeContext := legacyEmptyOpenProviderRuntimeContext(
		provider,
		agentTargetID,
		nil,
	)
	if _, _, err := sessionRuntimeSnapshotFromContext(runtimeContext); !errors.Is(
		err,
		ErrSessionRuntimeSnapshotUnavailable,
	) {
		t.Fatalf("snapshot without canonical fallback error = %v", err)
	}
	if _, _, err := sessionRuntimeSnapshotFromContext(
		runtimeContext,
		"codex",
	); !errors.Is(err, ErrSessionRuntimeSnapshotUnavailable) {
		t.Fatalf("snapshot with registered fallback error = %v", err)
	}

	snapshot, exists, err := sessionRuntimeSnapshotFromContext(
		runtimeContext,
		provider,
	)
	if err != nil || !exists {
		t.Fatalf(
			"legacy sessionRuntimeSnapshotFromContext() = %#v, exists=%v, error=%v",
			snapshot,
			exists,
			err,
		)
	}
	if snapshot.Provider != provider || !snapshot.LegacyEmptyProviderFingerprint {
		t.Fatalf("recovered legacy snapshot = %#v", snapshot)
	}
	service := &Service{}
	if _, err := service.modelEndpointFromSessionRuntimeSnapshot(
		context.Background(),
		"workspace-1",
		snapshot,
		"",
	); err != nil {
		t.Fatalf("legacy provider-native fingerprint recovery error = %v", err)
	}
}

func TestSessionRuntimeSnapshotRecoversVerifiedLegacyFingerprintWithOpenProvider(
	t *testing.T,
) {
	t.Parallel()

	const (
		provider      = "acp:kimi-code"
		agentTargetID = "extension:kimi-code"
	)
	runtimeContext := legacyFingerprintOpenProviderRuntimeContext(
		provider,
		agentTargetID,
	)
	for _, fallbackProvider := range []string{"", "codex", "acp:other"} {
		snapshot, exists, err := sessionRuntimeSnapshotFromContext(
			runtimeContext,
			fallbackProvider,
		)
		if err != nil || !exists {
			t.Fatalf(
				"snapshot with fallback %q = %#v, exists=%v, error=%v",
				fallbackProvider,
				snapshot,
				exists,
				err,
			)
		}
		if snapshot.LegacyEmptyProviderFingerprint {
			t.Fatalf(
				"snapshot with fallback %q trusted a mismatched provider: %#v",
				fallbackProvider,
				snapshot,
			)
		}
		service := &Service{}
		if _, err := service.modelEndpointFromSessionRuntimeSnapshot(
			context.Background(),
			"workspace-1",
			snapshot,
			"",
		); !errors.Is(err, ErrSessionRuntimeSnapshotUnavailable) {
			t.Fatalf(
				"snapshot with fallback %q model endpoint error = %v",
				fallbackProvider,
				err,
			)
		}
	}

	snapshot, exists, err := sessionRuntimeSnapshotFromContext(
		runtimeContext,
		provider,
	)
	if err != nil || !exists {
		t.Fatalf(
			"matching legacy snapshot = %#v, exists=%v, error=%v",
			snapshot,
			exists,
			err,
		)
	}
	if snapshot.Provider != provider || !snapshot.LegacyEmptyProviderFingerprint {
		t.Fatalf("recovered legacy fingerprint snapshot = %#v", snapshot)
	}
	service := &Service{}
	if _, err := service.modelEndpointFromSessionRuntimeSnapshot(
		context.Background(),
		"workspace-1",
		snapshot,
		"",
	); err != nil {
		t.Fatalf("legacy fingerprint recovery error = %v", err)
	}
}

func TestPersistedReviewerProjectionResolvesExactCommandSetAfterResume(
	t *testing.T,
) {
	t.Parallel()

	model := "gpt-review"
	runtimeContext := runtimeContextWithSessionRuntimeSnapshot(
		nil,
		CreateSessionInput{
			AgentTargetID:        "local:codex",
			HarnessAgentTargetID: "local:codex",
			Model:                &model,
			CommandCapabilityProjection: &runtimeprep.CommandCapabilityProjection{
				AllowedIDs: []string{
					"issue-manager.issue.get",
					"issue-manager.issue.task.list",
					"issue-manager.issue.task.get",
					"issue-manager.issue.task.run.list",
					"issue-manager.issue.task.run.get",
					"tutti-goal-review.goal-review.verdict",
				},
				IncludeIntegrationIDs: []string{
					"tutti-goal-review.goal-review.verdict",
				},
			},
		},
		"codex",
		modelPlanResolution{
			ModelConfiguration: newProviderNativeModelConfiguration(
				"codex", "local:codex",
			),
		},
	)
	encoded, err := json.Marshal(runtimeContext)
	if err != nil {
		t.Fatal(err)
	}
	var persisted map[string]any
	if err := json.Unmarshal(encoded, &persisted); err != nil {
		t.Fatal(err)
	}
	snapshot, exists, err := sessionRuntimeSnapshotFromContext(persisted)
	if err != nil || !exists {
		t.Fatalf("persisted snapshot = %#v, exists=%v, error=%v", snapshot, exists, err)
	}

	preparer := runtimeprep.NewDefaultPreparer(t.TempDir())
	preparer.CLICommand = "tutti"
	preparer.CommandCatalog = snapshotCommandCatalog{
		{
			ID: "issue-manager.issue.get", Path: []string{"issue", "get"},
			Visibility: "public",
		},
		{
			ID: "issue-manager.issue.update", Path: []string{"issue", "update"},
			Visibility: "public",
		},
		{
			ID: "issue-manager.issue.task.list", Path: []string{"issue", "task", "list"},
			Visibility: "public",
		},
		{
			ID: "issue-manager.issue.task.get", Path: []string{"issue", "task", "get"},
			Visibility: "public",
		},
		{
			ID:   "issue-manager.issue.task.run.list",
			Path: []string{"issue", "task", "run", "list"}, Visibility: "public",
		},
		{
			ID:   "issue-manager.issue.task.run.get",
			Path: []string{"issue", "task", "run", "get"}, Visibility: "public",
		},
		{
			ID: "agent-context.agent.start", Path: []string{"agent", "start"},
			Visibility: "public",
		},
		{
			ID:   "tutti-mode-plan.plan.issue.schedule",
			Path: []string{"plan", "issue", "schedule"}, Visibility: "public",
		},
		{
			ID:   "tutti-mode-plan.plan.issue.mutate",
			Path: []string{"plan", "issue", "mutate"}, Visibility: "public",
		},
		{
			ID:   "tutti-mode-plan.plan.issue.acknowledge",
			Path: []string{"plan", "issue", "acknowledge"}, Visibility: "public",
		},
		{
			ID:   "tutti-mode-plan.plan.issue.complete",
			Path: []string{"plan", "issue", "complete"}, Visibility: "public",
		},
		{
			ID:   "tutti-goal-review.goal-review.verdict",
			Path: []string{"goal-review", "verdict"}, Visibility: "integration",
		},
		{
			ID: "browser.hidden", Path: []string{"browser", "navigate"},
			Visibility: "integration",
		},
	}
	bundle, err := preparer.RenderSkillBundle(
		context.Background(),
		runtimeprep.PrepareInput{
			WorkspaceID: "workspace-1", AgentSessionID: "review-session-1",
			AgentTargetID: "local:codex", Provider: "codex",
			CommandCapabilityProjection: cloneCommandCapabilityProjection(
				snapshot.CommandCapabilityProjection,
			),
		},
	)
	if err != nil {
		t.Fatalf("RenderSkillBundle(resumed reviewer) error = %v", err)
	}
	var rendered strings.Builder
	for _, skill := range bundle.Skills {
		rendered.WriteString(skill.Content)
		for _, file := range skill.Files {
			rendered.WriteString(file.Content)
		}
	}
	guide := rendered.String()
	for _, allowed := range []string{
		"tutti issue get",
		"tutti goal-review verdict",
	} {
		if !strings.Contains(guide, allowed) {
			t.Fatalf("resumed reviewer guide missing %q:\n%s", allowed, guide)
		}
	}
	for _, forbidden := range []string{
		"tutti issue update",
		"tutti plan issue schedule",
		"tutti plan issue mutate",
		"tutti plan issue acknowledge",
		"tutti plan issue complete",
		"tutti agent start",
		"tutti browser navigate",
	} {
		if strings.Contains(guide, forbidden) {
			t.Fatalf("resumed reviewer guide leaked %q:\n%s", forbidden, guide)
		}
	}
}

func TestAgentSessionCommandCapabilityProjectionReadsCanonicalSnapshot(t *testing.T) {
	t.Parallel()

	runtimeContext := runtimeContextWithSessionRuntimeSnapshot(
		nil,
		CreateSessionInput{
			AgentTargetID: "local:codex",
			CommandCapabilityProjection: &runtimeprep.CommandCapabilityProjection{
				AllowedIDs: []string{
					"issue-manager.issue.get",
					"tutti-goal-review.goal-review.verdict",
				},
				IncludeIntegrationIDs: []string{
					"tutti-goal-review.goal-review.verdict",
				},
				ExcludeIDs: []string{"issue-manager.issue.update"},
			},
		},
		"codex",
		modelPlanResolution{
			ModelConfiguration: newProviderNativeModelConfiguration(
				"codex", "local:codex",
			),
		},
	)
	service := NewService(newFakeRuntime())
	service.SessionReader = fakeSessionReader{sessions: map[string]PersistedSession{
		"workspace-1:review-session-1": {
			ID: "review-session-1", WorkspaceID: "workspace-1",
			AgentTargetID: "local:codex", Provider: "codex",
			InternalRuntimeContext: runtimeContext,
		},
	}}
	configureTestApplicationHost(service)

	projection, err := service.AgentSessionCommandCapabilityProjection(
		context.Background(), "workspace-1", "review-session-1",
	)
	if err != nil {
		t.Fatalf("AgentSessionCommandCapabilityProjection() error = %v", err)
	}
	if projection == nil ||
		!reflect.DeepEqual(projection.AllowedIDs, []string{
			"issue-manager.issue.get",
			"tutti-goal-review.goal-review.verdict",
		}) ||
		!reflect.DeepEqual(projection.IncludeIntegrationIDs, []string{
			"tutti-goal-review.goal-review.verdict",
		}) ||
		!reflect.DeepEqual(projection.ExcludeIDs, []string{
			"issue-manager.issue.update",
		}) {
		t.Fatalf("projection = %#v", projection)
	}

	projection.AllowedIDs[0] = "mutated"
	projection.IncludeIntegrationIDs[0] = "mutated"
	reloaded, err := service.AgentSessionCommandCapabilityProjection(
		context.Background(), "workspace-1", "review-session-1",
	)
	if err != nil ||
		reloaded.AllowedIDs[0] != "issue-manager.issue.get" ||
		reloaded.IncludeIntegrationIDs[0] !=
			"tutti-goal-review.goal-review.verdict" {
		t.Fatalf("canonical projection mutated: %#v error=%v", reloaded, err)
	}
}

func TestAgentSessionCommandCapabilityProjectionRecoversLegacyOpenProvider(
	t *testing.T,
) {
	t.Parallel()

	const (
		provider      = "acp:hermes"
		agentTargetID = "extension:hermes"
	)
	runtimeContext := legacyEmptyOpenProviderRuntimeContext(
		provider,
		agentTargetID,
		&runtimeprep.CommandCapabilityProjection{
			AllowedIDs: []string{"issue-manager.issue.get"},
		},
	)
	service := NewService(newFakeRuntime())
	service.SessionReader = fakeSessionReader{sessions: map[string]PersistedSession{
		"workspace-1:session-1": {
			ID: "session-1", WorkspaceID: "workspace-1",
			AgentTargetID: agentTargetID, Provider: provider,
			InternalRuntimeContext: runtimeContext,
		},
	}}
	configureTestApplicationHost(service)

	projection, err := service.AgentSessionCommandCapabilityProjection(
		context.Background(),
		"workspace-1",
		"session-1",
	)
	if err != nil {
		t.Fatalf("AgentSessionCommandCapabilityProjection() error = %v", err)
	}
	if projection == nil || !reflect.DeepEqual(
		projection.AllowedIDs,
		[]string{"issue-manager.issue.get"},
	) {
		t.Fatalf("legacy extension projection = %#v", projection)
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
		CommandCapabilityProjection: &runtimeprep.CommandCapabilityProjection{
			AllowedIDs:            []string{"issue-manager.issue.get"},
			IncludeIntegrationIDs: []string{"tutti-goal-review.goal-review.verdict"},
			ExcludeIDs:            []string{"tutti-mode-plan.plan.issue.complete"},
		},
		Model: &model,
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
	if preparedInput.CommandCapabilityProjection == nil ||
		len(preparedInput.CommandCapabilityProjection.AllowedIDs) != 1 ||
		len(preparedInput.CommandCapabilityProjection.IncludeIntegrationIDs) != 1 ||
		len(preparedInput.CommandCapabilityProjection.ExcludeIDs) != 1 {
		t.Fatalf(
			"prepared command capability projection = %#v",
			preparedInput.CommandCapabilityProjection,
		)
	}
}

func TestPrepareRuntimeForResumeUsesRecordedAgentExtensionInstallation(t *testing.T) {
	t.Parallel()

	const (
		provider               = "acp:example"
		agentTargetID          = "workspace-agent:writer"
		harnessAgentTargetID   = "extension:example"
		recordedInstallationID = "example@1.0.0"
	)
	targets := defaultTestAgentTargets()
	targets[harnessAgentTargetID] = agenttargetbiz.Target{
		ID:            harnessAgentTargetID,
		Provider:      provider,
		LaunchRefJSON: `{"type":"agent_extension","extensionInstallationId":"example@2.0.0"}`,
		Name:          "Example",
		Enabled:       true,
		Source:        agenttargetbiz.SourceUser,
	}
	service := &Service{}
	service.AgentTargetStore = fakeAgentTargetStore{targets: targets}
	var preparedInput runtimeprep.PrepareInput
	service.RuntimePreparer = fakeRuntimePreparer{input: &preparedInput}

	runtimeContext := runtimeContextWithSessionRuntimeSnapshot(
		nil,
		CreateSessionInput{
			AgentTargetID:        agentTargetID,
			HarnessAgentTargetID: harnessAgentTargetID,
		},
		provider,
		modelPlanResolution{ModelConfiguration: newProviderNativeModelConfiguration(provider, agentTargetID)},
	)
	runtimeContext = stampAgentExtensionComposerScope(
		runtimeContext,
		map[string]any{
			"kind":                    agenttargetbiz.LaunchRefTypeAgentExtension,
			"extensionInstallationId": recordedInstallationID,
		},
		"/repo",
		ComposerSettings{},
	)

	_, err := service.prepareRuntimeForResume(context.Background(), PersistedSession{
		ID:                     "session-1",
		WorkspaceID:            "workspace-1",
		AgentTargetID:          agentTargetID,
		Provider:               provider,
		Cwd:                    "/repo",
		InternalRuntimeContext: runtimeContext,
	})
	if err != nil {
		t.Fatalf("prepareRuntimeForResume() error = %v", err)
	}
	if got := stringFromAny(preparedInput.ProviderTargetRef["extensionInstallationId"]); got != recordedInstallationID {
		t.Fatalf("prepared extension installation = %q, want %q", got, recordedInstallationID)
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

func TestPrepareRuntimeForResumeRecoversLegacyEmptyOpenProvider(t *testing.T) {
	t.Parallel()

	const (
		provider      = "acp:kimi-code"
		agentTargetID = "extension:kimi-code"
	)
	targets := defaultTestAgentTargets()
	targets[agentTargetID] = agenttargetbiz.Target{
		ID:            agentTargetID,
		Provider:      provider,
		LaunchRefJSON: `{"type":"agent_extension","extensionInstallationId":"installation-1"}`,
		Name:          "Kimi Code",
		Enabled:       true,
		Source:        agenttargetbiz.SourceUser,
	}
	service := &Service{}
	service.AgentTargetStore = fakeAgentTargetStore{targets: targets}
	var preparedInput runtimeprep.PrepareInput
	service.RuntimePreparer = fakeRuntimePreparer{input: &preparedInput}

	_, err := service.prepareRuntimeForResume(
		context.Background(),
		PersistedSession{
			ID:            "session-1",
			WorkspaceID:   "workspace-1",
			AgentTargetID: agentTargetID,
			Provider:      provider,
			InternalRuntimeContext: legacyEmptyOpenProviderRuntimeContext(
				provider,
				agentTargetID,
				nil,
			),
		},
	)
	if err != nil {
		t.Fatalf("prepareRuntimeForResume() error = %v", err)
	}
	if preparedInput.Provider != provider {
		t.Fatalf("prepared provider = %q, want %q", preparedInput.Provider, provider)
	}
	if preparedInput.ProviderTargetRef["kind"] !=
		agenttargetbiz.LaunchRefTypeAgentExtension {
		t.Fatalf(
			"prepared provider target ref = %#v",
			preparedInput.ProviderTargetRef,
		)
	}
	if got := stringFromAny(preparedInput.ProviderTargetRef["extensionInstallationId"]); got != "installation-1" {
		t.Fatalf("prepared extension installation = %q, want current installation", got)
	}
}

func TestPrepareRuntimeForResumeRecoversLegacyFingerprintWithOpenProvider(
	t *testing.T,
) {
	t.Parallel()

	const (
		provider      = "acp:kimi-code"
		agentTargetID = "extension:kimi-code"
	)
	targets := defaultTestAgentTargets()
	targets[agentTargetID] = agenttargetbiz.Target{
		ID:            agentTargetID,
		Provider:      provider,
		LaunchRefJSON: `{"type":"agent_extension","extensionInstallationId":"installation-1"}`,
		Name:          "Kimi Code",
		Enabled:       true,
		Source:        agenttargetbiz.SourceUser,
	}
	service := &Service{}
	service.AgentTargetStore = fakeAgentTargetStore{targets: targets}
	var preparedInput runtimeprep.PrepareInput
	service.RuntimePreparer = fakeRuntimePreparer{input: &preparedInput}

	_, err := service.prepareRuntimeForResume(
		context.Background(),
		PersistedSession{
			ID:                     "session-1",
			WorkspaceID:            "workspace-1",
			AgentTargetID:          agentTargetID,
			Provider:               provider,
			InternalRuntimeContext: legacyFingerprintOpenProviderRuntimeContext(provider, agentTargetID),
		},
	)
	if err != nil {
		t.Fatalf("prepareRuntimeForResume() error = %v", err)
	}
	if preparedInput.Provider != provider {
		t.Fatalf("prepared provider = %q, want %q", preparedInput.Provider, provider)
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
