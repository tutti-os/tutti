package daemon

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"sync"
	"time"
)

const (
	defaultStartupTimeout     = 3 * time.Second
	defaultForegroundTimeout  = 10 * time.Second
	defaultForegroundInterval = 30 * time.Minute
)

type Config struct {
	Identity           Identity
	ChecksEnabled      bool
	Checker            Checker
	FeatureCache       FeatureCache
	Logger             *slog.Logger
	StartupTimeout     time.Duration
	ForegroundTimeout  time.Duration
	ForegroundInterval time.Duration
	Now                func() time.Time
}

type Service struct {
	config      Config
	mu          sync.Mutex
	snapshot    Snapshot
	started     bool
	initialDone chan struct{}
	initialOnce sync.Once
	active      chan struct{}
	lifecycle   context.Context
	cancel      context.CancelFunc
	closed      bool
}

func New(config Config) (*Service, error) {
	if err := validateIdentity(config.Identity, config.ChecksEnabled); err != nil {
		return nil, err
	}
	if config.ChecksEnabled && config.Checker == nil {
		return nil, errors.New("desktop update admission checker is required when checks are enabled")
	}
	if config.Logger == nil {
		config.Logger = slog.Default()
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	if config.StartupTimeout <= 0 {
		config.StartupTimeout = defaultStartupTimeout
	}
	if config.ForegroundTimeout <= 0 {
		config.ForegroundTimeout = defaultForegroundTimeout
	}
	if config.ForegroundInterval <= 0 {
		config.ForegroundInterval = defaultForegroundInterval
	}

	feature := FeatureAvailabilitySnapshot{
		Keys:   []string{},
		Source: "empty",
	}
	if config.FeatureCache != nil {
		cached, err := config.FeatureCache.Load(config.Identity)
		if err == nil {
			feature = cached
			log(config.Logger, slog.LevelInfo, "feature-cache-read", map[string]any{
				"count":  len(cached.Keys),
				"result": "success",
			})
		} else if !errors.Is(err, os.ErrNotExist) {
			log(config.Logger, slog.LevelError, "feature-cache-read", map[string]any{
				"error":  err.Error(),
				"result": "failure",
			})
		}
	}

	return &Service{
		config:      config,
		initialDone: make(chan struct{}),
		snapshot: Snapshot{
			Identity:            config.Identity,
			Policy:              PolicySnapshot{Status: "checking"},
			FeatureAvailability: feature,
		},
	}, nil
}

func (service *Service) Start(parent context.Context) {
	service.mu.Lock()
	if service.started || service.closed {
		service.mu.Unlock()
		return
	}
	service.started = true
	ctx, cancel := context.WithCancel(parent)
	service.lifecycle = ctx
	service.cancel = cancel
	service.mu.Unlock()

	if !service.config.ChecksEnabled {
		service.mu.Lock()
		service.snapshot.Policy = PolicySnapshot{
			Status: "skipped",
			Reason: "checksDisabled",
		}
		service.mu.Unlock()
		service.markInitialDone()
		return
	}
	go func() {
		_, _ = service.refresh(ctx, "startup")
		service.markInitialDone()
	}()
}

func (service *Service) WaitInitial(ctx context.Context) (Snapshot, error) {
	service.mu.Lock()
	started := service.started
	initialDone := service.initialDone
	service.mu.Unlock()
	if !started {
		return Snapshot{}, errors.New("desktop update admission service has not started")
	}
	select {
	case <-ctx.Done():
		return Snapshot{}, ctx.Err()
	case <-initialDone:
		return service.Snapshot(), nil
	}
}

func (service *Service) Snapshot() Snapshot {
	service.mu.Lock()
	defer service.mu.Unlock()
	return cloneSnapshot(service.snapshot)
}

func (service *Service) Refresh(ctx context.Context, trigger RefreshTrigger) (RefreshResult, error) {
	if trigger != RefreshTriggerForeground && trigger != RefreshTriggerRetry {
		return RefreshResult{}, errors.New("desktop update admission refresh trigger is invalid")
	}
	service.mu.Lock()
	if !service.started {
		service.mu.Unlock()
		return RefreshResult{}, errors.New("desktop update admission service has not started")
	}
	if service.closed {
		service.mu.Unlock()
		return RefreshResult{}, errors.New("desktop update admission service is closed")
	}
	if !service.config.ChecksEnabled {
		snapshot := cloneSnapshot(service.snapshot)
		service.mu.Unlock()
		return RefreshResult{SkipReason: "checksDisabled", Snapshot: snapshot}, nil
	}
	lifecycle := service.lifecycle
	service.mu.Unlock()

	refreshCtx, cancel := context.WithCancel(ctx)
	stopLifecycleCancellation := context.AfterFunc(lifecycle, cancel)
	defer func() {
		stopLifecycleCancellation()
		cancel()
	}()
	return service.refresh(refreshCtx, string(trigger))
}

func (service *Service) Close() {
	service.mu.Lock()
	if service.closed {
		service.mu.Unlock()
		return
	}
	service.closed = true
	cancel := service.cancel
	service.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (service *Service) refresh(ctx context.Context, trigger string) (RefreshResult, error) {
	service.mu.Lock()
	if trigger == string(RefreshTriggerForeground) &&
		policyUsesForegroundThrottle(service.snapshot.Policy) &&
		service.snapshot.LastAttemptAt != nil {
		next := service.snapshot.LastAttemptAt.Add(service.config.ForegroundInterval)
		if service.config.Now().Before(next) {
			snapshot := cloneSnapshot(service.snapshot)
			service.mu.Unlock()
			return RefreshResult{
				SkipReason: "throttled",
				Snapshot:   snapshot,
			}, nil
		}
	}
	if active := service.active; active != nil {
		service.mu.Unlock()
		select {
		case <-ctx.Done():
			return RefreshResult{}, ctx.Err()
		case <-active:
			return RefreshResult{
				SkipReason: "requestInFlight",
				Snapshot:   service.Snapshot(),
			}, nil
		}
	}
	active := make(chan struct{})
	service.active = active
	service.mu.Unlock()

	defer func() {
		service.mu.Lock()
		if service.active == active {
			service.active = nil
			close(active)
		}
		service.mu.Unlock()
	}()

	timeout := service.config.ForegroundTimeout
	if trigger == "startup" {
		timeout = service.config.StartupTimeout
	}
	checkCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	startedAt := service.config.Now().UTC()
	raw, err := service.config.Checker.Check(checkCtx, service.config.Identity)
	completedAt := service.config.Now().UTC()

	service.mu.Lock()
	service.snapshot.LastAttemptAt = pointerTime(completedAt)
	if err != nil {
		service.snapshot.NextForegroundCheckAt = nil
		failureKind := "transport"
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(checkCtx.Err(), context.DeadlineExceeded) {
			failureKind = "timeout"
		}
		service.snapshot.Policy = PolicySnapshot{
			Status:  "failedOpen",
			Failure: &PolicyFailure{Kind: failureKind},
		}
		snapshot := cloneSnapshot(service.snapshot)
		service.mu.Unlock()
		log(service.config.Logger, slog.LevelError, "policy-check", map[string]any{
			"elapsedMs": completedAt.Sub(startedAt).Milliseconds(),
			"error":     err.Error(),
			"result":    "failure",
			"stage":     trigger,
		})
		return RefreshResult{Performed: true, Snapshot: snapshot}, nil
	}

	parsed, parseErr := ParseRemoteResponse(raw)
	if parseErr != nil {
		nextForeground := completedAt.Add(service.config.ForegroundInterval)
		service.snapshot.NextForegroundCheckAt = pointerTime(nextForeground)
		service.snapshot.Policy = PolicySnapshot{
			Status:  "failedOpen",
			Failure: &PolicyFailure{Kind: "invalidResponse"},
		}
		snapshot := cloneSnapshot(service.snapshot)
		service.mu.Unlock()
		log(service.config.Logger, slog.LevelError, "policy-check", map[string]any{
			"elapsedMs": completedAt.Sub(startedAt).Milliseconds(),
			"error":     parseErr.Error(),
			"result":    "failure",
			"stage":     trigger,
		})
		return RefreshResult{Performed: true, Snapshot: snapshot}, nil
	}

	policy := parsed.Policy
	nextForeground := completedAt.Add(service.config.ForegroundInterval)
	service.snapshot.NextForegroundCheckAt = pointerTime(nextForeground)
	service.snapshot.Policy = PolicySnapshot{
		Status:   "resolved",
		Response: &policy,
	}
	var cacheSnapshot *FeatureAvailabilitySnapshot
	if parsed.FeatureValid {
		revision := parsed.Policy.PolicyRevision
		fetchedAt := completedAt
		service.snapshot.FeatureAvailability = FeatureAvailabilitySnapshot{
			Keys:           cloneFeatureKeys(parsed.Feature),
			Source:         "remote",
			PolicyRevision: &revision,
			FetchedAt:      &fetchedAt,
		}
		copied := cloneFeatureSnapshot(service.snapshot.FeatureAvailability)
		cacheSnapshot = &copied
	}
	snapshot := cloneSnapshot(service.snapshot)
	service.mu.Unlock()

	if parsed.FeaturePresent && !parsed.FeatureValid {
		log(service.config.Logger, slog.LevelError, "feature-response", map[string]any{
			"error":  parsed.FeatureParseError.Error(),
			"result": "retained",
			"stage":  trigger,
		})
	}
	if cacheSnapshot != nil && service.config.FeatureCache != nil {
		if err := service.config.FeatureCache.Save(service.config.Identity, *cacheSnapshot); err != nil {
			log(service.config.Logger, slog.LevelError, "feature-cache-write", map[string]any{
				"error":  err.Error(),
				"result": "failure",
			})
		}
	}
	log(service.config.Logger, slog.LevelInfo, "policy-check", map[string]any{
		"currentVersion": service.config.Identity.CurrentVersion,
		"decision":       parsed.Policy.Decision,
		"elapsedMs":      completedAt.Sub(startedAt).Milliseconds(),
		"minimumVersion": parsed.Policy.MinimumVersion,
		"policyRevision": parsed.Policy.PolicyRevision,
		"reason":         parsed.Policy.Reason,
		"result":         "success",
		"stage":          trigger,
	})
	return RefreshResult{Performed: true, Snapshot: snapshot}, nil
}

func policyUsesForegroundThrottle(policy PolicySnapshot) bool {
	return policy.Status == "resolved" ||
		(policy.Status == "failedOpen" &&
			policy.Failure != nil &&
			policy.Failure.Kind == "invalidResponse")
}

func (service *Service) markInitialDone() {
	service.initialOnce.Do(func() {
		close(service.initialDone)
	})
}

func cloneSnapshot(snapshot Snapshot) Snapshot {
	clone := snapshot
	if snapshot.Policy.Response != nil {
		response := *snapshot.Policy.Response
		clone.Policy.Response = &response
	}
	if snapshot.Policy.Failure != nil {
		failure := *snapshot.Policy.Failure
		clone.Policy.Failure = &failure
	}
	clone.FeatureAvailability = cloneFeatureSnapshot(snapshot.FeatureAvailability)
	if snapshot.LastAttemptAt != nil {
		clone.LastAttemptAt = pointerTime(*snapshot.LastAttemptAt)
	}
	if snapshot.NextForegroundCheckAt != nil {
		clone.NextForegroundCheckAt = pointerTime(*snapshot.NextForegroundCheckAt)
	}
	return clone
}

func cloneFeatureSnapshot(snapshot FeatureAvailabilitySnapshot) FeatureAvailabilitySnapshot {
	clone := snapshot
	clone.Keys = cloneFeatureKeys(snapshot.Keys)
	if snapshot.PolicyRevision != nil {
		revision := *snapshot.PolicyRevision
		clone.PolicyRevision = &revision
	}
	if snapshot.FetchedAt != nil {
		clone.FetchedAt = pointerTime(*snapshot.FetchedAt)
	}
	return clone
}

// cloneFeatureKeys preserves the wire contract that an empty key set is an
// empty JSON array, never null. append([]string(nil), values...) would turn an
// empty slice into nil and break strict feature-availability consumers.
func cloneFeatureKeys(keys []string) []string {
	clone := make([]string, len(keys))
	copy(clone, keys)
	return clone
}

func pointerTime(value time.Time) *time.Time {
	copied := value
	return &copied
}

func log(logger *slog.Logger, level slog.Level, stage string, details map[string]any) {
	attributes := make([]any, 0, len(details)*2+4)
	attributes = append(attributes, "event", "desktop.update_admission."+stage, "stage", stage)
	for key, value := range details {
		attributes = append(attributes, key, value)
	}
	logger.Log(context.Background(), level, "[minimum-version-check]", attributes...)
}
