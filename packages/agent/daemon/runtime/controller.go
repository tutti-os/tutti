package agentruntime

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	replay "github.com/tutti-os/tutti/packages/agent/session-replay"
)

var (
	ErrSessionNotFound                  = errors.New("agent session not found")
	ErrSessionSettingsRequireNewSession = errors.New("agent session settings update requires a new session to preserve context")
	ErrSessionActiveTurn                = errors.New("agent session already has an active turn")
	ErrSessionForkUnsupported           = errors.New("agent session fork is unsupported")
)

const defaultStreamingReportCoalesceWindow = 50 * time.Millisecond

type execMetadataContextKey struct{}

type Controller struct {
	mu                           sync.Mutex
	streamObserverMu             sync.RWMutex
	providerObservationMu        sync.RWMutex
	goalControlObserverMu        sync.RWMutex
	sessions                     map[string]Session
	liveConnectionGenerations    map[string]uint64
	nextLiveConnectionGeneration uint64
	sessionAvailabilityWaiters   map[string]*sessionAvailabilityWaiter
	adapters                     map[string]Adapter
	adapterResolver              AdapterResolver
	turns                        map[string]activeTurn
	commands                     map[string]AgentSessionCommandSnapshot
	pendingCommandSnapshots      map[string]AgentSessionCommandSnapshot
	configOptionsUpdates         map[string]AgentSessionConfigOptionsUpdate
	pendingConfigOptionsUpdates  map[string][]AgentSessionConfigOptionsUpdate
	provisionalSessions          map[string]bool
	sessionInitializations       map[string]*controllerSessionInitialization
	goalGenerationFences         map[string]*controllerGoalGenerationFenceRegistry
	startupLocks                 map[startupLockKey]*controllerLifecycleLock
	lifecycleLocks               map[string]*controllerLifecycleLock
	hub                          *EventHub
	reporter                     DurableActivityReporter
	reportQueue                  *reportRequestQueue
	providerGoalAdoptionSink     ProviderGoalAdoptionSink
	terminalInteractions         terminalInteractiveDispositionStore
	streamObserver               RuntimeStreamEventObserver
	providerObservationObserver  ProviderObservationObserver
	goalControlObserver          GoalControlLifecycleObserver
}

// RuntimeStreamEventObserver receives the ordered precommit stream projection
// synchronously with the per-session EventHub fan-out. Implementations must
// remain lightweight: the ordering guarantee prevents a durable terminal
// confirmation from overtaking its preceding optimistic deltas.
type RuntimeStreamEventObserver interface {
	ObserveRuntimeStreamEvents(
		context.Context,
		string,
		string,
		[]StreamEvent,
	) error
}

// RuntimeStreamEventFilter can be implemented by an observer that validates
// event identity before the same stream is delivered to daemon-local
// subscribers. Observation and filtering are separate so an external
// projection can still emit a reconcile signal while the invalid event is
// withheld from the local session fan-out.
type RuntimeStreamEventFilter interface {
	FilterRuntimeStreamEvents(string, string, []StreamEvent) []StreamEvent
}

// ProviderObservationObserver receives capture-only provider observations
// synchronously before their durable activity report is queued.
type ProviderObservationObserver interface {
	ObserveProviderObservations(
		context.Context,
		string,
		string,
		[]replay.ProviderObservationBatch,
	) error
}

// GoalControlAppliedObservation is exact provider evidence that one durable
// Goal operation was consumed by the runtime. The Host validates every fence
// before completing the operation.
type GoalControlAppliedObservation struct {
	WorkspaceID      string
	AgentSessionID   string
	OperationID      string
	Revision         int64
	RepairEpoch      int64
	Action           string
	ProviderTurnID   string
	Observed         map[string]any
	OccurredAtUnixMS int64
	ExecutionPending bool
}

type GoalControlLifecycleObserver interface {
	ObserveGoalControlApplied(context.Context, GoalControlAppliedObservation) error
}

type controllerLifecycleLock struct {
	gate              chan struct{}
	refs              int
	startupOperations map[chan struct{}]struct{}
}

// controllerSessionInitialization retains every provider observation emitted
// between Runtime start and Host's canonical initialization commit. The map
// entry itself is the publication barrier; it remains present while Publish
// drains events and side-channel snapshots so later observations cannot
// overtake the initial Session report.
type controllerSessionInitialization struct {
	events                  []activityshared.Event
	initialEventsPublished  bool
	commandSnapshotResolved bool
}

// startupLockKey uses agentSessionID for normal Host calls. Provider is set
// only for the legacy path that asks Controller.Start to allocate the ID.
type startupLockKey struct {
	roomID         string
	agentSessionID string
	provider       string
}

type sessionAvailabilityWaiter struct {
	changed chan struct{}
	refs    int
}

type activeTurn struct {
	turnID                string
	cancel                context.CancelFunc
	tuttiModeSnapshot     *TuttiModeTurnSnapshot
	openCallIDs           map[string]struct{}
	pendingTerminalEvents []activityshared.Event
}

type reportRequest struct {
	ctx              context.Context
	report           agentsessionstore.ReportActivityInput
	submitProvenance bool
	barrier          bool
	done             chan error
}

type ReleaseIdleLiveSessionsInput struct {
	IdleAfter time.Duration
	Now       time.Time
	Limit     int
}

type ReleaseIdleLiveSessionsResult struct {
	Scanned                  int
	Released                 int
	SkippedFresh             int
	SkippedActiveTurn        int
	SkippedUnsupported       int
	SkippedNotLive           int
	SkippedBusy              int
	SkippedCleanupBudget     int
	Failed                   int
	ResourceCleanupAttempted int
	ResourceCleanupCleaned   int
	ResourceCleanupFailed    int
}

// CloseAllLiveSessionsResult reports the outcome of CloseAllLiveSessions.
type CloseAllLiveSessionsResult struct {
	// Scanned counts sessions whose adapter reported a live provider process.
	Scanned                  int
	Closed                   int
	SkippedCleanupBudget     int
	Failed                   int
	ResourceCleanupAttempted int
	ResourceCleanupCleaned   int
	ResourceCleanupFailed    int
}

// DisconnectRuntimeSessionResult reports whether a live provider connection
// was released. The Controller session record and provider session id remain.
type DisconnectRuntimeSessionResult struct {
	Disconnected bool
}

// RuntimeDisconnectTarget identifies one exact live-connection incarnation.
// A stale target must never disconnect a later Resume for the same Session.
type RuntimeDisconnectTarget struct {
	RoomID               string
	AgentSessionID       string
	ConnectionGeneration uint64
}

type asyncActivityReporter interface {
	DurableActivityReporter
	AsyncActivityReporter()
}

func NewController(adapters []Adapter, reporter DurableActivityReporter) *Controller {
	return NewControllerWithAdapterResolver(adapters, reporter, nil)
}

func NewControllerWithAdapterResolver(adapters []Adapter, reporter DurableActivityReporter, resolver AdapterResolver) *Controller {
	byProvider := make(map[string]Adapter, len(adapters))
	for _, adapter := range adapters {
		if adapter == nil {
			continue
		}
		provider := strings.TrimSpace(adapter.Provider())
		if provider != "" {
			byProvider[provider] = adapter
		}
	}
	controller := &Controller{
		sessions:                    make(map[string]Session),
		liveConnectionGenerations:   make(map[string]uint64),
		sessionAvailabilityWaiters:  make(map[string]*sessionAvailabilityWaiter),
		adapters:                    byProvider,
		adapterResolver:             resolver,
		turns:                       make(map[string]activeTurn),
		commands:                    make(map[string]AgentSessionCommandSnapshot),
		pendingCommandSnapshots:     make(map[string]AgentSessionCommandSnapshot),
		configOptionsUpdates:        make(map[string]AgentSessionConfigOptionsUpdate),
		pendingConfigOptionsUpdates: make(map[string][]AgentSessionConfigOptionsUpdate),
		provisionalSessions:         make(map[string]bool),
		sessionInitializations:      make(map[string]*controllerSessionInitialization),
		goalGenerationFences:        make(map[string]*controllerGoalGenerationFenceRegistry),
		startupLocks:                make(map[startupLockKey]*controllerLifecycleLock),
		lifecycleLocks:              make(map[string]*controllerLifecycleLock),
		hub:                         NewEventHub(),
		reporter:                    reporter,
	}
	if reporter != nil {
		if _, ok := reporter.(asyncActivityReporter); !ok {
			controller.reportQueue = newReportRequestQueue()
			go controller.runReportWorker()
		}
	}
	for _, adapter := range byProvider {
		controller.configureAdapter(adapter)
	}
	return controller
}

func (c *Controller) sessionPublicationPendingLocked(key string) bool {
	if c == nil {
		return false
	}
	if c.provisionalSessions[key] {
		return true
	}
	_, pending := c.sessionInitializations[key]
	return pending
}

func (c *Controller) configureAdapter(adapter Adapter) {
	if adapter == nil {
		return
	}
	if sinkAdapter, ok := adapter.(CommandSnapshotSinkAdapter); ok {
		sinkAdapter.SetCommandSnapshotSink(c.applyCommandSnapshotByAgentSessionID)
	}
	if sinkAdapter, ok := adapter.(SessionEventSinkAdapter); ok {
		sinkAdapter.SetSessionEventSink(c.applySessionEventsByAgentSessionID)
	}
	if sinkAdapter, ok := adapter.(GoalReconcileDurableSinkAdapter); ok {
		sinkAdapter.SetGoalReconcileDurableSink(c.reportGoalReconcileDurable)
	}
	if sinkAdapter, ok := adapter.(GoalProvenanceDurableSinkAdapter); ok {
		// Always install the controller boundary. If the configured reporter
		// cannot durably bind/lookup provenance, the controller returns an
		// explicit error and Codex fails closed instead of silently falling back
		// to a restart-unsafe process-local cache.
		sinkAdapter.SetGoalProvenanceDurableSink(c)
	}
	if sinkAdapter, ok := adapter.(ProviderGoalAdoptionSinkAdapter); ok {
		sinkAdapter.SetProviderGoalAdoptionSink(c.adoptProviderGoal)
	}
	if sinkAdapter, ok := adapter.(ConfigOptionsUpdateSinkAdapter); ok {
		sinkAdapter.SetConfigOptionsUpdateSink(c.applyConfigOptionsUpdateByAgentSessionID)
	}
	if sinkAdapter, ok := adapter.(InteractiveDispositionSinkAdapter); ok {
		sinkAdapter.SetInteractiveDispositionSink(c.recordTerminalInteractiveDisposition)
	}
}

func NewDefaultController(reporter DurableActivityReporter) *Controller {
	return NewDefaultControllerWithProcessTransport(reporter, nil)
}

func NewDefaultControllerWithProcessTransport(
	reporter DurableActivityReporter,
	transport ProcessTransport,
) *Controller {
	return NewDefaultControllerWithOptions(reporter, transport, ControllerOptions{
		HostMetadata: LegacyHostMetadata(),
	})
}

func NewDefaultControllerWithOptions(
	reporter DurableActivityReporter,
	transport ProcessTransport,
	options ControllerOptions,
) *Controller {
	host := options.HostMetadata
	adapters := newMigratedProviderAdapters(
		transport,
		host,
		options.ProviderCommandResolver,
		options.CommandNetworkAccessPolicy,
	)
	setProviderLaunchPreparer(adapters, options.ProviderLaunchPreparer)
	return NewControllerWithAdapterResolver(adapters, reporter, options.AdapterResolver)
}
