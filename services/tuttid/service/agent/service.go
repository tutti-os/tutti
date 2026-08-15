package agent

import (
	"errors"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	claudecodeservice "github.com/tutti-os/tutti/services/tuttid/service/claudecode"
)

var (
	ErrInvalidArgument                  = agenthost.ErrInvalidArgument
	ErrActiveTurnGuidanceUnsupported    = errors.New("agent provider does not support active-turn guidance")
	ErrActiveTurnTargetRequired         = agenthost.ErrActiveTurnTargetRequired
	ErrActiveTurnTargetMismatch         = agenthost.ErrActiveTurnTargetMismatch
	ErrPromptImageUnsupported           = errors.New("agent prompt image input is unsupported")
	ErrSessionNoActiveTurn              = errors.New("agent session has no active turn")
	ErrSessionNotFound                  = agenthost.ErrSessionNotFound
	ErrRuntimeSessionDisconnected       = agenthost.ErrRuntimeSessionDisconnected
	ErrRuntimeOperationIdentityMismatch = agenthost.ErrRuntimeOperationIdentityMismatch
	ErrInteractiveRequestNotLive        = errors.New("interactive request is no longer live")
	ErrInteractiveAlreadyAnswered       = errors.New("interactive request has already been answered")
	ErrInteractionRequestNotFound       = agenthost.ErrInteractionNotFound
	ErrInteractionSemanticNotFound      = errors.New("agent interaction semantic was not found")
	ErrInteractionSemanticAmbiguous     = errors.New("agent interaction semantic is ambiguous")
	ErrSkillBundleUnavailable           = errors.New("agent skill bundle renderer is unavailable")
	ErrSessionSettingsRequireNewSession = errors.New("agent session settings update requires a new session to preserve context")
	ErrSubmitDeliveryUnknown            = agenthost.ErrSubmitDeliveryUnknown
)

func NewService(runtime RuntimeController, configs ...ServiceConfig) *Service {
	if runtime == nil {
		panic("agent service requires a runtime")
	}
	if len(configs) > 1 {
		panic("agent service accepts at most one config")
	}
	service := &Service{
		Runtime:                   runtime,
		skillOptionsCache:         newComposerSkillOptionsCache(),
		providerAvailabilityCache: newProviderAvailabilityCache(),
		capabilityCatalogCache:    newComposerCapabilityCatalogCache(),
		liveModelCache:            newComposerLiveModelCache(),
		claudeStartupLock:         claudecodeservice.DefaultStartupGate,
	}
	if len(configs) == 0 {
		return service
	}
	config := configs[0]
	service.applyConfig(config)
	if config.Host.ApplicationHost == nil || config.Host.Components == nil {
		panic("configured agent service requires a complete Host composition")
	}
	service.hostRuntimePreparation = config.Host.Components.runtimePreparation
	service.sessionSettingsState = config.Host.Components.sessionSettings
	service.worktreeIsolationLock = config.Host.Components.worktreeIsolationLock
	host := config.Host.ApplicationHost
	service.applicationHost = config.Host.ApplicationHost
	service.applicationHostProvider = func() *agenthost.Host { return host }
	return service
}
