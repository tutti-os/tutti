package agent

import (
	"context"
	"errors"
	"strings"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

// committedSessionForkReader is deliberately read-only. A lineage row is
// created atomically with a committed Session Fork, so runtime preparation can
// verify the provider binding directly without invoking Host reconciliation or
// bypassing a lifecycle write boundary.
type committedSessionForkReader interface {
	GetSessionForkLineage(context.Context, string, string) (storesqlite.SessionForkLineage, bool, error)
	GetSessionForkOperation(context.Context, string, string) (storesqlite.SessionForkOperation, bool, error)
}

type serviceHostRuntimePreparationSupport interface {
	clampPersistedSessionReasoningEffortForResume(context.Context, PersistedSession) PersistedSession
	prepareRuntimeForResume(context.Context, PersistedSession) (preparedRuntime, error)
	resolveProviderTargetRefForResume(context.Context, PersistedSession) (map[string]any, error)
	cleanupSessionResources(context.Context, string, string) error
	releaseSessionResourcesForRecoverableDeletion(context.Context, string, string) error
	deleteTuttiModeActivationSessionState(context.Context, string, string) error
}

// serviceRuntimePreparation is the narrow component shared by production
// Service and Host. It owns only provider preparation, resume resolution, and
// cleanup dependencies; it has no Host or Service reference.
type serviceRuntimePreparation struct {
	runtimePreparer              runtimeprep.Preparer
	connectorRuntime             ConnectorRuntime
	connectorCapabilities        ConnectorCapabilityResolver
	modelGateway                 ModelGatewayRegistry
	modelCatalog                 AgentModelCatalog
	agentTargetStore             AgentTargetStore
	workspaceAgentResolver       WorkspaceAgentResolver
	extensionComposerProfiles    ExtensionComposerProfileResolver
	browserUseAvailable          func() bool
	computerUseAvailable         func() bool
	modelPlanBinding             modelPlanBindingRuntime
	agentSessionResourceReleaser AgentSessionResourceReleaser
	sessionReader                SessionReader
	tuttiModeActivations         TuttiModeActivationPort
}

func newServiceRuntimePreparation(config ServiceConfig) *serviceRuntimePreparation {
	return &serviceRuntimePreparation{
		runtimePreparer:           config.Runtime.Preparer,
		connectorRuntime:          config.Runtime.Connector,
		connectorCapabilities:     config.Runtime.ConnectorCapabilities,
		modelGateway:              config.Runtime.ModelGateway,
		modelCatalog:              config.Composer.ModelCatalog,
		agentTargetStore:          config.Composer.AgentTargetStore,
		workspaceAgentResolver:    config.Composer.WorkspaceAgentResolver,
		extensionComposerProfiles: config.Composer.ExtensionComposerProfiles,
		browserUseAvailable:       config.Runtime.BrowserUseAvailable,
		computerUseAvailable:      config.Runtime.ComputerUseAvailable,
		modelPlanBinding: modelPlanBindingRuntime{
			Bindings: config.Runtime.ModelBindings,
			Plans:    config.Runtime.ModelPlans,
		},
		agentSessionResourceReleaser: config.Resources.AgentSessionResourceReleaser,
		sessionReader:                config.Sessions.Reader,
		tuttiModeActivations:         config.Observers.TuttiModeActivations,
	}
}

func (p *serviceRuntimePreparation) facade() *Service {
	if p == nil {
		return &Service{}
	}
	return &Service{
		RuntimePreparer:              p.runtimePreparer,
		ConnectorRuntime:             p.connectorRuntime,
		ConnectorCapabilities:        p.connectorCapabilities,
		ModelGateway:                 p.modelGateway,
		ModelCatalog:                 p.modelCatalog,
		AgentTargetStore:             p.agentTargetStore,
		WorkspaceAgentResolver:       p.workspaceAgentResolver,
		ExtensionComposerProfiles:    p.extensionComposerProfiles,
		BrowserUseAvailable:          p.browserUseAvailable,
		ComputerUseAvailable:         p.computerUseAvailable,
		AgentSessionResourceReleaser: p.agentSessionResourceReleaser,
		SessionReader:                p.sessionReader,
		TuttiModeActivations:         p.tuttiModeActivations,
		modelPlanBinding:             p.modelPlanBinding,
	}
}

func (p *serviceRuntimePreparation) clampPersistedSessionReasoningEffortForResume(
	ctx context.Context,
	session PersistedSession,
) PersistedSession {
	return p.facade().clampPersistedSessionReasoningEffortForResume(ctx, session)
}

func (p *serviceRuntimePreparation) prepareRuntimeForResume(
	ctx context.Context,
	session PersistedSession,
) (preparedRuntime, error) {
	return p.facade().prepareRuntimeForResume(ctx, session)
}

func (p *serviceRuntimePreparation) resolveProviderTargetRefForResume(
	ctx context.Context,
	session PersistedSession,
) (map[string]any, error) {
	return p.facade().resolveProviderTargetRefForResume(ctx, session)
}

func (p *serviceRuntimePreparation) cleanupSessionResources(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
) error {
	return p.facade().cleanupSessionResources(ctx, workspaceID, agentSessionID)
}

func (p *serviceRuntimePreparation) releaseSessionResourcesForRecoverableDeletion(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
) error {
	return p.facade().releaseSessionResourcesForRecoverableDeletion(ctx, workspaceID, agentSessionID)
}

func (p *serviceRuntimePreparation) deleteTuttiModeActivationSessionState(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
) error {
	return p.facade().deleteTuttiModeActivationSessionState(ctx, workspaceID, agentSessionID)
}

type serviceHostPreparation struct {
	support         serviceHostRuntimePreparationSupport
	runtimePreparer runtimeprep.Preparer
	sessionForks    committedSessionForkReader
}

type servicePreparedRuntimeContext struct {
	support  serviceHostRuntimePreparationSupport
	prepared preparedRuntime
}

type servicePreparedRuntimeContextKey struct{}

func withServicePreparedRuntime(ctx context.Context, service *Service, prepared preparedRuntime) context.Context {
	support := serviceHostRuntimePreparationSupport(service)
	if service != nil && service.hostRuntimePreparation != nil {
		support = service.hostRuntimePreparation
	}
	return context.WithValue(ctx, servicePreparedRuntimeContextKey{}, servicePreparedRuntimeContext{support: support, prepared: prepared})
}

func (a serviceHostPreparation) Prepare(ctx context.Context, input agenthost.RuntimePreparationInput) (agenthost.PreparedRuntime, error) {
	if override, ok := ctx.Value(servicePreparedRuntimeContextKey{}).(servicePreparedRuntimeContext); ok && override.support == a.support {
		return agenthost.PreparedRuntime{Cwd: override.prepared.Cwd, Env: append([]string(nil), override.prepared.Env...),
			MCPServers: hostMCPServerBindings(override.prepared.MCPServers)}, nil
	}
	settings := input.Settings
	persisted := PersistedSession{
		ID: input.AgentSessionID, WorkspaceID: input.WorkspaceID, Origin: input.SessionOrigin,
		AgentTargetID: input.AgentTargetID, Provider: input.Provider, ProviderSessionID: input.ProviderSessionID,
		Cwd: input.Cwd, Title: input.Title, Settings: settings,
		InternalRuntimeContext: clonePayload(input.RuntimeContext), CreatedAtUnixMS: input.CreatedAtUnixMS,
		UpdatedAtUnixMS: input.UpdatedAtUnixMS, Metadata: input.SessionMetadata,
	}
	persisted = a.support.clampPersistedSessionReasoningEffortForResume(ctx, persisted)
	prepared, err := a.support.prepareRuntimeForResume(ctx, persisted)
	if err != nil {
		return agenthost.PreparedRuntime{}, err
	}
	cleanupPreparationFailure := func(cause error) error {
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		return errors.Join(cause, a.support.cleanupSessionResources(
			cleanupCtx,
			input.WorkspaceID,
			input.AgentSessionID,
		))
	}
	if err := a.bindCommittedSessionForkProviderState(ctx, input); err != nil {
		return agenthost.PreparedRuntime{}, cleanupPreparationFailure(err)
	}
	var targetRef map[string]any
	if strings.TrimSpace(input.AgentTargetID) != "" {
		resolvedRef, err := a.support.resolveProviderTargetRefForResume(ctx, persisted)
		if err != nil {
			return agenthost.PreparedRuntime{}, cleanupPreparationFailure(err)
		}
		targetRef = resolvedRef
	}
	settings = persisted.Settings
	return agenthost.PreparedRuntime{
		Cwd: prepared.Cwd, Env: append([]string(nil), prepared.Env...), MCPServers: hostMCPServerBindings(prepared.MCPServers),
		ProviderTargetRef: clonePayload(targetRef), Settings: &settings,
		RuntimeContext: persistedSessionRuntimeContext(persisted),
	}, nil
}

func hostMCPServerBindings(input []runtimeprep.MCPServerBinding) []agenthost.MCPServerBinding {
	if len(input) == 0 {
		return nil
	}
	result := make([]agenthost.MCPServerBinding, 0, len(input))
	for _, binding := range input {
		headers := make(map[string]string, len(binding.Headers))
		for key, value := range binding.Headers {
			headers[key] = value
		}
		result = append(result, agenthost.MCPServerBinding{Name: binding.Name, Type: binding.Type, URL: binding.URL, Headers: headers})
	}
	return result
}

func (a serviceHostPreparation) bindCommittedSessionForkProviderState(
	ctx context.Context,
	input agenthost.RuntimePreparationInput,
) error {
	if a.runtimePreparer == nil || a.sessionForks == nil {
		return nil
	}
	binder, ok := a.runtimePreparer.(runtimeprep.SessionForkProviderStateBinder)
	if !ok || !binder.SupportsSessionForkProviderStateBinding(input.Provider) {
		return nil
	}
	lineage, found, err := a.sessionForks.GetSessionForkLineage(
		ctx,
		input.WorkspaceID,
		input.AgentSessionID,
	)
	if err != nil || !found {
		return err
	}
	operation, operationFound, err := a.sessionForks.GetSessionForkOperation(
		ctx,
		input.WorkspaceID,
		lineage.OperationID,
	)
	if err != nil {
		return err
	}
	if !operationFound ||
		operation.Status != storesqlite.SessionForkStatusCommitted ||
		operation.TargetAgentSessionID != input.AgentSessionID ||
		operation.TargetProviderSessionID != input.ProviderSessionID {
		return errors.New("committed Codex session fork identity could not be verified")
	}
	return binder.BindSessionForkProviderState(
		ctx,
		runtimeprep.SessionForkProviderStateBindingInput{
			WorkspaceID:             input.WorkspaceID,
			Provider:                input.Provider,
			SourceAgentSessionID:    operation.SourceAgentSessionID,
			TargetAgentSessionID:    operation.TargetAgentSessionID,
			SourceProviderSessionID: operation.SourceProviderSessionID,
			TargetProviderSessionID: operation.TargetProviderSessionID,
		},
	)
}

func (a serviceHostPreparation) Cleanup(ctx context.Context, input agenthost.RuntimeCleanupInput) error {
	var activationErr error
	if input.OrphanActivationCleanup {
		activationErr = a.support.deleteTuttiModeActivationSessionState(ctx, input.WorkspaceID, input.AgentSessionID)
	}
	var resourceErr error
	if input.PreserveRecoverableState {
		resourceErr = a.support.releaseSessionResourcesForRecoverableDeletion(
			ctx,
			input.WorkspaceID,
			input.AgentSessionID,
		)
	} else {
		resourceErr = a.support.cleanupSessionResources(ctx, input.WorkspaceID, input.AgentSessionID)
	}
	return errors.Join(resourceErr, activationErr)
}
