package agent

import (
	"context"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
	reporterservice "github.com/tutti-os/tutti/services/tuttid/service/reporter"
)

// ServiceConfig groups the tuttid adapter dependencies by their owning
// responsibility. Production passes one complete value to NewService; public
// Service fields remain temporarily available for isolated tests and internal
// compatibility callers.
type ServiceConfig struct {
	Host           ServiceHostConfig
	Runtime        ServiceRuntimeConfig
	Sessions       ServiceSessionConfig
	Composer       ServiceComposerConfig
	ExternalImport ServiceExternalImportConfig
	Resources      ServiceResourceConfig
	Observers      ServiceObserverConfig
}

type ServiceHostConfig struct {
	ApplicationHost *agenthost.Host
	Components      *ServiceComponents
}

type ServiceRuntimeConfig struct {
	Preparer                      runtimeprep.Preparer
	Connector                     ConnectorRuntime
	ConnectorCapabilities         ConnectorCapabilityResolver
	ModelGateway                  ModelGatewayRegistry
	BrowserUseAvailable           func() bool
	ComputerUseAvailable          func() bool
	RuntimeOperationStore         RuntimeOperationStore
	RuntimeOperationOwner         string
	RuntimeOperationClock         func() time.Time
	StaleTurnSettler              agenthost.StaleTurnSettler
	GoalStateStore                GoalStateStore
	GoalGenerationFenceStore      agenthost.GoalGenerationFenceStore
	GoalReconcileInboxStore       GoalReconcileInboxStore
	GoalOperationOwner            string
	GoalOperationClock            func() time.Time
	GoalOperationAttemptTimeout   time.Duration
	GoalOperationRecoveryBudget   time.Duration
	GoalOperationMaxAttempts      int
	GoalOperationDispatchDeadline time.Duration
	ModelBindings                 AgentModelBindingSource
	ModelPlans                    AgentModelPlanSource
}

type ServiceSessionConfig struct {
	Initializer       SessionInitializer
	Reader            SessionReader
	DeletedSessions   agenthost.DeletedSessionStore
	PurgeStore        agenthost.SessionPurgeStore
	DeletionGuard     agenthost.SessionDeletionGuard
	UserProjectReader UserProjectReader
	MessageReader     MessageReader
	TurnStore         TurnStore
	TurnSummaryReader agentactivitybiz.SessionTurnSummaryReader
	SubmitClaimStore  SubmitClaimStore
}

type ServiceComposerConfig struct {
	AvailabilityChecker ProviderAvailabilityChecker
	ModelCatalog        AgentModelCatalog
	// ReplayMode makes cassette-provided model catalogs authoritative. It is
	// set only for the isolated Replay daemon; normal sessions keep live
	// catalog and discovery behavior.
	ReplayMode                    bool
	ModelCapabilities             ModelCapabilitiesResolver
	AgentTargetStore              AgentTargetStore
	WorkspaceAgentResolver        WorkspaceAgentResolver
	AgentComposerDefaultsReader   AgentComposerDefaultsReader
	DesktopPreferencesReader      DesktopPreferencesReader
	CapabilityLister              ComposerCapabilityLister
	ConnectorMarketSnapshots      market.SnapshotReader
	ExtensionComposerProfiles     ExtensionComposerProfileResolver
	ProviderAvailabilityCacheTTL  time.Duration
	CapabilityCatalogCacheTTL     time.Duration
	LiveModelCacheTTL             time.Duration
	GeneratedFilesClock           func() time.Time
	LiveModelDiscoveryDeleteDelay time.Duration
}

type ServiceExternalImportConfig struct {
	Store agentactivitybiz.Repository
}

type ServiceResourceConfig struct {
	AgentSessionResourceReleaser AgentSessionResourceReleaser
	SessionDirectoryAllocator    SessionDirectoryAllocator
	WorktreeStateDir             string
	WorkspaceIDs                 func(context.Context) ([]string, error)
	PromptAttachmentStore        PromptAttachmentStore
}

type ServiceObserverConfig struct {
	AnalyticsReporter              reporterservice.Reporter
	CommitObserver                 agenthost.CommitObserver
	RuntimeOperationEventPublisher RuntimeOperationEventPublisher
	TuttiModeActivations           TuttiModeActivationPort
	TuttiModeSourceActivity        TuttiModeSourceActivityObserver
	TurnCancelObserver             TurnCancelObserver
}

func (s *Service) applyConfig(config ServiceConfig) {
	s.AnalyticsReporter = config.Observers.AnalyticsReporter
	s.AvailabilityChecker = config.Composer.AvailabilityChecker
	s.ModelCatalog = config.Composer.ModelCatalog
	s.ReplayMode = config.Composer.ReplayMode
	s.ModelCapabilities = config.Composer.ModelCapabilities
	s.AgentTargetStore = config.Composer.AgentTargetStore
	s.SessionInitializer = config.Sessions.Initializer
	s.WorkspaceAgentResolver = config.Composer.WorkspaceAgentResolver
	s.SessionReader = config.Sessions.Reader
	s.SessionPurgeStore = config.Sessions.PurgeStore
	s.SessionDeletionGuard = config.Sessions.DeletionGuard
	s.AgentSessionResourceReleaser = config.Resources.AgentSessionResourceReleaser
	s.UserProjectReader = config.Sessions.UserProjectReader
	s.MessageReader = config.Sessions.MessageReader
	s.ExternalImportStore = config.ExternalImport.Store
	s.TurnStore = config.Sessions.TurnStore
	s.TurnSummaryReader = config.Sessions.TurnSummaryReader
	s.RuntimeOperationStore = config.Runtime.RuntimeOperationStore
	s.GoalStateStore = config.Runtime.GoalStateStore
	s.GoalGenerationFenceStore = config.Runtime.GoalGenerationFenceStore
	s.CommitObserver = config.Observers.CommitObserver
	s.GoalReconcileInboxStore = config.Runtime.GoalReconcileInboxStore
	s.SubmitClaimStore = config.Sessions.SubmitClaimStore
	s.RuntimeOperationEventPublisher = config.Observers.RuntimeOperationEventPublisher
	s.TuttiModeActivations = config.Observers.TuttiModeActivations
	s.TuttiModeSourceActivity = config.Observers.TuttiModeSourceActivity
	s.TurnCancelObserver = config.Observers.TurnCancelObserver
	s.RuntimeOperationClock = config.Runtime.RuntimeOperationClock
	s.RuntimeOperationOwner = config.Runtime.RuntimeOperationOwner
	s.StaleTurnSettler = config.Runtime.StaleTurnSettler
	s.GoalOperationOwner = config.Runtime.GoalOperationOwner
	s.GoalOperationClock = config.Runtime.GoalOperationClock
	s.GoalOperationAttemptTimeout = config.Runtime.GoalOperationAttemptTimeout
	s.GoalOperationRecoveryBudget = config.Runtime.GoalOperationRecoveryBudget
	s.GoalOperationMaxAttempts = config.Runtime.GoalOperationMaxAttempts
	s.GoalOperationDispatchDeadline = config.Runtime.GoalOperationDispatchDeadline
	s.SessionDirectoryAllocator = config.Resources.SessionDirectoryAllocator
	s.WorktreeStateDir = config.Resources.WorktreeStateDir
	s.WorkspaceIDs = config.Resources.WorkspaceIDs
	s.PromptAttachmentStore = config.Resources.PromptAttachmentStore
	s.RuntimePreparer = config.Runtime.Preparer
	s.ConnectorRuntime = config.Runtime.Connector
	s.ConnectorCapabilities = config.Runtime.ConnectorCapabilities
	s.ModelGateway = config.Runtime.ModelGateway
	s.BrowserUseAvailable = config.Runtime.BrowserUseAvailable
	s.ComputerUseAvailable = config.Runtime.ComputerUseAvailable
	s.CapabilityLister = config.Composer.CapabilityLister
	s.ConnectorMarketSnapshots = config.Composer.ConnectorMarketSnapshots
	s.ExtensionComposerProfiles = config.Composer.ExtensionComposerProfiles
	s.AgentComposerDefaultsReader = config.Composer.AgentComposerDefaultsReader
	s.DesktopPreferencesReader = config.Composer.DesktopPreferencesReader
	s.ProviderAvailabilityCacheTTL = config.Composer.ProviderAvailabilityCacheTTL
	s.CapabilityCatalogCacheTTL = config.Composer.CapabilityCatalogCacheTTL
	s.LiveModelCacheTTL = config.Composer.LiveModelCacheTTL
	s.GeneratedFilesClock = config.Composer.GeneratedFilesClock
	s.LiveModelDiscoveryDeleteDelay = config.Composer.LiveModelDiscoveryDeleteDelay
	s.modelPlanBinding = modelPlanBindingRuntime{
		Bindings: config.Runtime.ModelBindings,
		Plans:    config.Runtime.ModelPlans,
	}
}
