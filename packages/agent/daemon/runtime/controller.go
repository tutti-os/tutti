package agentruntime

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

var (
	ErrSessionNotFound                  = errors.New("agent session not found")
	ErrSessionSettingsRequireNewSession = errors.New("agent session settings update requires a new session to preserve context")
	ErrSessionActiveTurn                = errors.New("agent session already has an active turn")
)

const defaultStreamingReportCoalesceWindow = 50 * time.Millisecond
const interactiveDenyFollowUpStartTimeout = 30 * time.Second
const interactiveDenyFollowUpPollInterval = 25 * time.Millisecond

type execMetadataContextKey struct{}

type Controller struct {
	startMu                     sync.Mutex
	mu                          sync.Mutex
	sessions                    map[string]Session
	adapters                    map[string]Adapter
	turns                       map[string]activeTurn
	commands                    map[string]AgentSessionCommandSnapshot
	pendingCommandSnapshots     map[string]AgentSessionCommandSnapshot
	configOptionsUpdates        map[string]AgentSessionConfigOptionsUpdate
	pendingConfigOptionsUpdates map[string][]AgentSessionConfigOptionsUpdate
	provisionalSessions         map[string]bool
	lifecycleLocks              map[string]*sessionLifecycleLock
	hub                         *EventHub
	reporter                    ActivityReporter
	reportCh                    chan reportRequest
}

type sessionLifecycleLock struct {
	mu   sync.Mutex
	refs int
}

type activeTurn struct {
	turnID                string
	cancel                context.CancelFunc
	openCallIDs           map[string]struct{}
	pendingTerminalEvents []activityshared.Event
}

type reportRequest struct {
	ctx    context.Context
	report agentsessionstore.ReportActivityInput
}

type ReleaseIdleLiveSessionsInput struct {
	IdleAfter time.Duration
	Now       time.Time
	Limit     int
}

type ReleaseIdleLiveSessionsResult struct {
	Scanned            int
	Released           int
	SkippedFresh       int
	SkippedActiveTurn  int
	SkippedUnsupported int
	SkippedNotLive     int
	SkippedBusy        int
	Failed             int
}

// CloseAllLiveSessionsResult reports the outcome of CloseAllLiveSessions.
type CloseAllLiveSessionsResult struct {
	// Scanned counts sessions whose adapter reported a live provider process.
	Scanned int
	Closed  int
	Failed  int
}

type asyncActivityReporter interface {
	ActivityReporter
	AsyncActivityReporter()
}

func NewController(adapters []Adapter, reporter ActivityReporter) *Controller {
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
		adapters:                    byProvider,
		turns:                       make(map[string]activeTurn),
		commands:                    make(map[string]AgentSessionCommandSnapshot),
		pendingCommandSnapshots:     make(map[string]AgentSessionCommandSnapshot),
		configOptionsUpdates:        make(map[string]AgentSessionConfigOptionsUpdate),
		pendingConfigOptionsUpdates: make(map[string][]AgentSessionConfigOptionsUpdate),
		provisionalSessions:         make(map[string]bool),
		lifecycleLocks:              make(map[string]*sessionLifecycleLock),
		hub:                         NewEventHub(),
		reporter:                    reporter,
	}
	if reporter != nil {
		if _, ok := reporter.(asyncActivityReporter); !ok {
			controller.reportCh = make(chan reportRequest, 1024)
			go controller.runReportWorker()
		}
	}
	for _, adapter := range byProvider {
		if sinkAdapter, ok := adapter.(CommandSnapshotSinkAdapter); ok {
			sinkAdapter.SetCommandSnapshotSink(controller.applyCommandSnapshotByAgentSessionID)
		}
		if sinkAdapter, ok := adapter.(SessionEventSinkAdapter); ok {
			sinkAdapter.SetSessionEventSink(controller.applySessionEventsByAgentSessionID)
		}
		if sinkAdapter, ok := adapter.(ConfigOptionsUpdateSinkAdapter); ok {
			sinkAdapter.SetConfigOptionsUpdateSink(controller.applyConfigOptionsUpdateByAgentSessionID)
		}
	}
	return controller
}

func NewDefaultController(reporter ActivityReporter) *Controller {
	return NewDefaultControllerWithProcessTransport(reporter, nil)
}

func NewDefaultControllerWithProcessTransport(
	reporter ActivityReporter,
	transport ProcessTransport,
) *Controller {
	return NewDefaultControllerWithOptions(reporter, transport, ControllerOptions{
		HostMetadata: LegacyHostMetadata(),
	})
}

func NewDefaultControllerWithOptions(
	reporter ActivityReporter,
	transport ProcessTransport,
	options ControllerOptions,
) *Controller {
	host := options.HostMetadata
	adapters := newMigratedProviderAdapters(transport, host, options.ProviderCommandResolver)
	setProviderLaunchPreparer(adapters, options.ProviderLaunchPreparer)
	return NewController(adapters, reporter)
}
