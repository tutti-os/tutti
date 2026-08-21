package agent

import (
	"context"
	"fmt"
	"strings"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

// modelPlanRebindInput resolves the latest immutable revision of the exact
// Model Plan already bound to a Session. Provider-native and Agent Extension
// sessions never enter this path.
func (s *Service) modelPlanRebindInput(
	ctx context.Context,
	workspaceID string,
	session storesqlite.Session,
) (agenthost.ReprepareRuntimeSessionInput, bool, error) {
	snapshot, exists, err := sessionRuntimeSnapshotFromContext(session.InternalRuntimeContext, session.Provider)
	if err != nil || !exists {
		return agenthost.ReprepareRuntimeSessionInput{}, false, err
	}
	if snapshot.ModelConfigurationSource != modelConfigurationSourceModelPlan {
		return agenthost.ReprepareRuntimeSessionInput{}, false, nil
	}
	runtime := s.modelPlanRuntime()
	if runtime.Plans == nil {
		return agenthost.ReprepareRuntimeSessionInput{}, false, fmt.Errorf("%w: model plan resolver is unavailable", ErrSessionRuntimeSnapshotUnavailable)
	}
	plan, err := runtime.Plans.GetModelPlan(ctx, strings.TrimSpace(workspaceID), snapshot.ModelPlanID)
	if err != nil {
		return agenthost.ReprepareRuntimeSessionInput{}, false, fmt.Errorf("%w: current model plan no longer exists", ErrSessionRuntimeAccessRevoked)
	}
	if plan.Revision == snapshot.ModelPlanRevision {
		return agenthost.ReprepareRuntimeSessionInput{}, false, nil
	}
	resolution, err := resolveProvidedModelPlan(
		snapshot.Provider,
		snapshot.AgentTargetID,
		plan,
		snapshot.ModelDefaultModel,
		snapshot.Model,
	)
	if err != nil {
		return agenthost.ReprepareRuntimeSessionInput{}, false, err
	}
	replacement := clonePayload(session.InternalRuntimeContext)
	rawSnapshot, ok := replacement[sessionRuntimeSnapshotContextKey].(map[string]any)
	if !ok {
		return agenthost.ReprepareRuntimeSessionInput{}, false, ErrSessionRuntimeSnapshotUnavailable
	}
	configuration := resolution.ModelConfiguration.runtimeContext()
	delete(configuration, "agentTargetId")
	rawSnapshot["modelConfiguration"] = configuration
	if resolution.Endpoint != nil && strings.TrimSpace(resolution.Endpoint.Model) != "" {
		rawSnapshot["model"] = strings.TrimSpace(resolution.Endpoint.Model)
	}
	return agenthost.ReprepareRuntimeSessionInput{
		WorkspaceID:               strings.TrimSpace(workspaceID),
		AgentSessionID:            strings.TrimSpace(session.ID),
		ExpectedRuntimeContext:    clonePayload(session.InternalRuntimeContext),
		ReplacementRuntimeContext: replacement,
	}, true, nil
}
