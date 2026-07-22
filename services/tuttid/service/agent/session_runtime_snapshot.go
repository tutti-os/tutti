package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"

	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
)

const (
	sessionRuntimeSnapshotContextKey = "sessionRuntimeSnapshot"
	sessionRuntimeSnapshotVersion    = 1
)

var (
	ErrSessionRuntimeSnapshotUnavailable = errors.New("session runtime snapshot is unavailable")
	ErrSessionRuntimeAccessRevoked       = errors.New("session runtime access was revoked")
)

type sessionRuntimeSnapshot struct {
	Version                  int
	AgentTargetID            string
	WorkspaceAgentRevision   int64
	HarnessAgentTargetID     string
	Provider                 string
	Model                    string
	ModelConfigurationSource string
	ModelPlanID              string
	ModelPlanRevision        uint64
	ModelFingerprint         string
	ModelDefaultModel        string
	Name                     string
	Description              string
	Instructions             string
	CallConditions           []string
	CapabilitiesExplicit     bool
	Skills                   []string
	Tools                    []string
	EffectiveConfig          map[string]any
}

func runtimeContextWithSessionRuntimeSnapshot(
	runtimeContext map[string]any,
	input CreateSessionInput,
	provider string,
	resolution modelPlanResolution,
) map[string]any {
	result := clonePayload(runtimeContext)
	if result == nil {
		result = map[string]any{}
	}
	harnessAgentTargetID := strings.TrimSpace(input.HarnessAgentTargetID)
	if harnessAgentTargetID == "" {
		harnessAgentTargetID = strings.TrimSpace(input.AgentTargetID)
	}
	configuration := resolution.ModelConfiguration
	snapshot := map[string]any{
		"version":              sessionRuntimeSnapshotVersion,
		"agentTargetId":        strings.TrimSpace(input.AgentTargetID),
		"harnessAgentTargetId": harnessAgentTargetID,
		"provider":             agentprovider.Normalize(provider),
		"model":                strings.TrimSpace(value(input.Model)),
		"modelConfiguration": map[string]any{
			"source":       configuration.Source,
			"fingerprint":  configuration.Fingerprint,
			"defaultModel": strings.TrimSpace(configuration.DefaultModel),
		},
		"effectiveConfig": sessionRuntimeEffectiveConfig(input),
	}
	if input.WorkspaceAgentRevision > 0 {
		snapshot["workspaceAgentId"] = strings.TrimSpace(input.AgentTargetID)
		snapshot["workspaceAgentRevision"] = input.WorkspaceAgentRevision
	}
	modelConfiguration := snapshot["modelConfiguration"].(map[string]any)
	if strings.TrimSpace(configuration.ModelPlanID) != "" {
		modelConfiguration["modelPlanId"] = strings.TrimSpace(configuration.ModelPlanID)
		modelConfiguration["modelPlanRevision"] = configuration.ModelPlanRevision
	}
	agentDefinition := map[string]any{}
	if name := strings.TrimSpace(input.AgentName); name != "" {
		agentDefinition["name"] = name
	}
	if description := strings.TrimSpace(input.AgentDescription); description != "" {
		agentDefinition["description"] = description
	}
	if instructions := strings.TrimSpace(input.AgentInstructions); instructions != "" {
		agentDefinition["instructions"] = instructions
	}
	if callConditions := normalizedSnapshotStrings(input.AgentCallConditions); len(callConditions) > 0 {
		agentDefinition["callConditions"] = callConditions
	}
	if input.WorkspaceAgentRevision > 0 {
		agentDefinition["capabilitiesExplicit"] = input.AgentCapabilitiesExplicit
	}
	if skills := normalizedSnapshotStrings(input.AgentSkills); len(skills) > 0 {
		agentDefinition["skills"] = skills
	}
	if tools := normalizedSnapshotStrings(input.AgentTools); len(tools) > 0 {
		agentDefinition["tools"] = tools
	}
	if len(agentDefinition) > 0 {
		snapshot["agentDefinition"] = agentDefinition
	}
	result[sessionRuntimeSnapshotContextKey] = snapshot
	return result
}

func sessionRuntimeEffectiveConfig(input CreateSessionInput) map[string]any {
	result := map[string]any{}
	if value := strings.TrimSpace(value(input.PermissionModeID)); value != "" {
		result["permissionModeId"] = value
	}
	if input.PlanMode != nil {
		result["planMode"] = *input.PlanMode
	}
	if input.BrowserUse != nil {
		result["browserUse"] = *input.BrowserUse
	}
	if input.ComputerUse != nil {
		result["computerUse"] = *input.ComputerUse
	}
	if value := strings.TrimSpace(value(input.ReasoningEffort)); value != "" {
		result["reasoningEffort"] = value
	}
	if value := strings.TrimSpace(value(input.Speed)); value != "" {
		result["speed"] = value
	}
	if value := strings.TrimSpace(input.ConversationDetailMode); value != "" {
		result["conversationDetailMode"] = value
	}
	return result
}

func sessionRuntimeSnapshotFromContext(runtimeContext map[string]any) (sessionRuntimeSnapshot, bool, error) {
	raw, exists := runtimeContext[sessionRuntimeSnapshotContextKey]
	if !exists {
		return sessionRuntimeSnapshot{}, false, nil
	}
	payload, ok := raw.(map[string]any)
	if !ok {
		return sessionRuntimeSnapshot{}, true, fmt.Errorf("%w: snapshot payload is invalid", ErrSessionRuntimeSnapshotUnavailable)
	}
	version, ok := snapshotInt64(payload["version"])
	if !ok || version != sessionRuntimeSnapshotVersion {
		return sessionRuntimeSnapshot{}, true, fmt.Errorf("%w: unsupported snapshot version", ErrSessionRuntimeSnapshotUnavailable)
	}
	configuration, ok := payload["modelConfiguration"].(map[string]any)
	if !ok {
		return sessionRuntimeSnapshot{}, true, fmt.Errorf("%w: model configuration is missing", ErrSessionRuntimeSnapshotUnavailable)
	}
	snapshot := sessionRuntimeSnapshot{
		Version:                  int(version),
		AgentTargetID:            snapshotString(payload["agentTargetId"]),
		HarnessAgentTargetID:     snapshotString(payload["harnessAgentTargetId"]),
		Provider:                 agentprovider.Normalize(snapshotString(payload["provider"])),
		Model:                    snapshotString(payload["model"]),
		ModelConfigurationSource: snapshotString(configuration["source"]),
		ModelPlanID:              snapshotString(configuration["modelPlanId"]),
		ModelFingerprint:         snapshotString(configuration["fingerprint"]),
		ModelDefaultModel:        snapshotString(configuration["defaultModel"]),
		Name:                     snapshotNestedString(payload, "agentDefinition", "name"),
		Description:              snapshotAgentDefinitionDescription(payload),
		Instructions:             snapshotNestedString(payload, "agentDefinition", "instructions"),
		CallConditions:           snapshotNestedStrings(payload, "agentDefinition", "callConditions"),
		CapabilitiesExplicit:     snapshotNestedBool(payload, "agentDefinition", "capabilitiesExplicit"),
		Skills:                   snapshotNestedStrings(payload, "agentDefinition", "skills"),
		Tools:                    snapshotNestedStrings(payload, "agentDefinition", "tools"),
		EffectiveConfig:          snapshotMap(payload["effectiveConfig"]),
	}
	if revision, ok := snapshotInt64(payload["workspaceAgentRevision"]); ok {
		snapshot.WorkspaceAgentRevision = revision
	}
	if revision, ok := snapshotUint64(configuration["modelPlanRevision"]); ok {
		snapshot.ModelPlanRevision = revision
	}
	if snapshot.AgentTargetID == "" || snapshot.HarnessAgentTargetID == "" || snapshot.Provider == "" || snapshot.ModelFingerprint == "" {
		return sessionRuntimeSnapshot{}, true, fmt.Errorf("%w: launch identity is incomplete", ErrSessionRuntimeSnapshotUnavailable)
	}
	switch snapshot.ModelConfigurationSource {
	case modelConfigurationSourceProviderNative:
		if snapshot.ModelPlanID != "" || snapshot.ModelPlanRevision != 0 {
			return sessionRuntimeSnapshot{}, true, fmt.Errorf("%w: provider-native snapshot references a plan", ErrSessionRuntimeSnapshotUnavailable)
		}
	case modelConfigurationSourceModelPlan:
		if snapshot.ModelPlanID == "" || snapshot.ModelPlanRevision == 0 || snapshot.ModelFingerprint == "" {
			return sessionRuntimeSnapshot{}, true, fmt.Errorf("%w: model plan revision is incomplete", ErrSessionRuntimeSnapshotUnavailable)
		}
	default:
		return sessionRuntimeSnapshot{}, true, fmt.Errorf("%w: model configuration source is invalid", ErrSessionRuntimeSnapshotUnavailable)
	}
	return snapshot, true, nil
}

// snapshotAgentDefinitionDescription reads the retained description text.
// Snapshots written before the Wave 4-2 contract cleanup stored it under the
// retired purpose key; durable session records keep resuming through the
// fallback read.
func snapshotAgentDefinitionDescription(payload map[string]any) string {
	if description := snapshotNestedString(payload, "agentDefinition", "description"); description != "" {
		return description
	}
	return snapshotNestedString(payload, "agentDefinition", "purpose")
}

func snapshotNestedBool(payload map[string]any, parent string, key string) bool {
	nested, _ := payload[parent].(map[string]any)
	value, _ := nested[key].(bool)
	return value
}

func (s *Service) modelEndpointFromSessionRuntimeSnapshot(
	ctx context.Context,
	workspaceID string,
	snapshot sessionRuntimeSnapshot,
	effectiveModel string,
) (*runtimeprep.ModelEndpointConfig, error) {
	if snapshot.ModelConfigurationSource == modelConfigurationSourceProviderNative {
		expected := newProviderNativeModelConfiguration(snapshot.Provider, snapshot.AgentTargetID)
		if expected.Fingerprint != snapshot.ModelFingerprint {
			return nil, fmt.Errorf("%w: provider-native fingerprint does not match", ErrSessionRuntimeSnapshotUnavailable)
		}
		return nil, nil
	}
	runtime := s.modelPlanRuntime()
	if runtime.Plans == nil {
		return nil, fmt.Errorf("%w: model plan reader is unavailable", ErrSessionRuntimeSnapshotUnavailable)
	}
	current, err := runtime.Plans.GetModelPlan(ctx, strings.TrimSpace(workspaceID), snapshot.ModelPlanID)
	if err != nil {
		return nil, fmt.Errorf("%w: current model plan no longer exists", ErrSessionRuntimeAccessRevoked)
	}
	if !current.Enabled {
		return nil, fmt.Errorf("%w: current model plan is disabled", ErrSessionRuntimeAccessRevoked)
	}
	revisions, ok := runtime.Plans.(AgentModelPlanRevisionSource)
	if !ok || revisions == nil {
		return nil, fmt.Errorf("%w: model plan revision reader is unavailable", ErrSessionRuntimeSnapshotUnavailable)
	}
	plan, err := revisions.GetModelPlanRevision(ctx, strings.TrimSpace(workspaceID), snapshot.ModelPlanID, snapshot.ModelPlanRevision)
	if err != nil {
		return nil, fmt.Errorf("%w: resolve model plan %s revision %d: %v", ErrSessionRuntimeSnapshotUnavailable, snapshot.ModelPlanID, snapshot.ModelPlanRevision, err)
	}
	if strings.TrimSpace(plan.ID) != snapshot.ModelPlanID || plan.Revision != snapshot.ModelPlanRevision {
		return nil, fmt.Errorf("%w: model plan revision identity does not match", ErrSessionRuntimeSnapshotUnavailable)
	}
	if !modelPlanFingerprintMatchesSnapshot(snapshot, plan) {
		return nil, fmt.Errorf("%w: model plan revision fingerprint does not match", ErrSessionRuntimeSnapshotUnavailable)
	}
	requiredProtocol, supported := modelPlanProtocolForProvider(snapshot.Provider)
	if !supported || plan.Protocol != requiredProtocol {
		return nil, fmt.Errorf("%w: snapshotted model plan protocol does not match provider", ErrSessionRuntimeSnapshotUnavailable)
	}
	if !plan.Enabled {
		return nil, fmt.Errorf("%w: snapshotted model plan revision was disabled", ErrSessionRuntimeSnapshotUnavailable)
	}
	effectiveModel = strings.TrimSpace(effectiveModel)
	if effectiveModel == "" {
		effectiveModel = snapshot.Model
	}
	if err := validateModelAgainstPlan(snapshot.Provider, effectiveModel, plan.Models); err != nil {
		return nil, err
	}
	return &runtimeprep.ModelEndpointConfig{
		PlanID:              plan.ID,
		PlanName:            plan.Name,
		Protocol:            string(plan.Protocol),
		BaseURL:             plan.BaseURL,
		APIKey:              plan.APIKey,
		Model:               planModelComposerValue(snapshot.Provider, planModelIDFromComposerValue(snapshot.Provider, effectiveModel)),
		Models:              modelEndpointModels(plan.Models),
		PlanUpdatedAtUnixMS: plan.UpdatedAt.UnixMilli(),
	}, nil
}

func modelPlanFingerprintMatchesSnapshot(snapshot sessionRuntimeSnapshot, plan modelplanbiz.Plan) bool {
	modelIDs := make([]string, 0, len(plan.Models))
	for _, model := range plan.Models {
		modelIDs = append(modelIDs, strings.TrimSpace(model.ID))
	}
	base := modelConfigurationFingerprintPayload{
		Provider:          snapshot.Provider,
		AgentTargetID:     snapshot.AgentTargetID,
		Source:            modelConfigurationSourceModelPlan,
		ModelPlanID:       strings.TrimSpace(plan.ID),
		ModelPlanRevision: plan.Revision,
		Protocol:          string(plan.Protocol),
		PlanDefaultModel:  strings.TrimSpace(plan.DefaultModel),
		ModelIDs:          modelIDs,
	}
	// Runtime snapshots intentionally retain only the effective default, not
	// the legacy binding record. A valid configured default is either empty or
	// equal to the effective default, so both canonical fingerprints preserve
	// compatibility while still detecting plan/revision drift.
	for _, bindingDefault := range []string{"", strings.TrimSpace(snapshot.ModelDefaultModel)} {
		base.BindingDefaultModel = bindingDefault
		if fingerprintModelConfiguration(base) == snapshot.ModelFingerprint {
			return true
		}
	}
	return false
}

func (s *Service) validateSessionModelAgainstRuntimeSnapshot(
	ctx context.Context,
	workspaceID string,
	runtimeContext map[string]any,
	model string,
) error {
	snapshot, exists, err := sessionRuntimeSnapshotFromContext(runtimeContext)
	if err != nil || !exists {
		return err
	}
	_, err = s.modelEndpointFromSessionRuntimeSnapshot(ctx, workspaceID, snapshot, model)
	return err
}

func (s *Service) applyHarnessFromSessionRuntimeSnapshot(
	ctx context.Context,
	snapshot sessionRuntimeSnapshot,
	input *CreateSessionInput,
) error {
	if s.AgentTargetStore == nil {
		return fmt.Errorf("%w: harness target store is unavailable", ErrSessionRuntimeSnapshotUnavailable)
	}
	target, err := s.AgentTargetStore.GetAgentTarget(ctx, snapshot.HarnessAgentTargetID)
	if err != nil {
		return fmt.Errorf("%w: harness target no longer exists", ErrSessionRuntimeAccessRevoked)
	}
	target, err = agenttargetbiz.NormalizeTarget(target)
	if err != nil {
		return fmt.Errorf("%w: harness target is invalid", ErrSessionRuntimeSnapshotUnavailable)
	}
	if !target.Enabled {
		return fmt.Errorf("%w: harness target is disabled", ErrSessionRuntimeAccessRevoked)
	}
	providerTargetRef, err := agenttargetbiz.RuntimeProviderTargetRef(target)
	if err != nil {
		return fmt.Errorf("%w: harness launch reference is invalid", ErrSessionRuntimeSnapshotUnavailable)
	}
	provider, _ := providerTargetRef["provider"].(string)
	if agentprovider.Normalize(provider) != snapshot.Provider {
		return fmt.Errorf("%w: harness provider does not match", ErrSessionRuntimeSnapshotUnavailable)
	}
	input.HarnessAgentTargetID = snapshot.HarnessAgentTargetID
	input.ProviderTargetRef = providerTargetRef
	return nil
}

func normalizedSnapshotStrings(values []string) []string {
	result := make([]string, 0, len(values))
	seen := map[string]struct{}{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

func snapshotNestedString(payload map[string]any, objectKey string, fieldKey string) string {
	object, _ := payload[objectKey].(map[string]any)
	return snapshotString(object[fieldKey])
}

func snapshotNestedStrings(payload map[string]any, objectKey string, fieldKey string) []string {
	object, _ := payload[objectKey].(map[string]any)
	values, _ := object[fieldKey].([]any)
	result := make([]string, 0, len(values))
	for _, value := range values {
		if normalized := snapshotString(value); normalized != "" {
			result = append(result, normalized)
		}
	}
	if typed, ok := object[fieldKey].([]string); ok {
		return normalizedSnapshotStrings(typed)
	}
	return normalizedSnapshotStrings(result)
}

func snapshotMap(value any) map[string]any {
	payload, _ := value.(map[string]any)
	return clonePayload(payload)
}

func snapshotString(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}

func snapshotInt64(value any) (int64, bool) {
	switch typed := value.(type) {
	case int:
		return int64(typed), true
	case int64:
		return typed, true
	case uint64:
		if typed > math.MaxInt64 {
			return 0, false
		}
		return int64(typed), true
	case float64:
		if typed != math.Trunc(typed) || typed > math.MaxInt64 || typed < math.MinInt64 {
			return 0, false
		}
		return int64(typed), true
	case json.Number:
		value, err := typed.Int64()
		return value, err == nil
	default:
		return 0, false
	}
}

func snapshotUint64(value any) (uint64, bool) {
	integer, ok := snapshotInt64(value)
	return uint64(integer), ok && integer > 0
}
