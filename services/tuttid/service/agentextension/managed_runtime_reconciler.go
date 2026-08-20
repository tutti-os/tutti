package agentextension

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"strings"
	"time"

	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
)

const (
	managedRuntimeReconcileMinBackoff = time.Second
	managedRuntimeReconcileMaxBackoff = 30 * time.Minute
)

const managedRuntimeGlobalRetryKey = "managed-runtime:global"

type managedRuntimeReconcileTrigger uint8

const (
	managedRuntimeReconcileInitial managedRuntimeReconcileTrigger = iota
	managedRuntimeReconcileWake
	managedRuntimeReconcileTimer
	managedRuntimeReconcileStopped
)

type managedRuntimeReconcileResult struct {
	key       string
	targetID  string
	err       error
	retryable bool
}

type managedRuntimeReconcileOutcome struct {
	seen    map[string]struct{}
	results []managedRuntimeReconcileResult
}

type managedRuntimeRetryState struct {
	settled      bool
	permanent    bool
	failureCount int
	nextAttempt  time.Time
}

// StartManagedRuntimeReconciler starts client-owned Runtime convergence. A
// client-pinned remote Extension always receives its declared Tutti-managed
// Runtime without waiting for a user setup action.
func (s *SetupService) StartManagedRuntimeReconciler() error {
	if s == nil || s.Plans.Manager == nil || s.Plans.Manager.Store == nil || s.Discovery == nil || s.Transport == nil {
		return errors.New("managed runtime reconciler is not configured")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireOpenLocked(); err != nil {
		return err
	}
	if s.managedRuntimeReconcilerActive {
		return nil
	}
	s.managedRuntimeReconcilerActive = true
	s.managedRuntimeReconcileWake = make(chan struct{}, 1)
	s.workers.Add(1)
	go s.runManagedRuntimeReconciler(s.workerCtx)
	return nil
}

// WakeManagedRuntimeReconciler requests a pass after Extension activation or
// source preference changes without installing a Runtime inline.
func (s *SetupService) WakeManagedRuntimeReconciler() {
	if s == nil {
		return
	}
	s.mu.Lock()
	wake := s.managedRuntimeReconcileWake
	active := s.managedRuntimeReconcilerActive && !s.closed
	s.mu.Unlock()
	if !active || wake == nil {
		return
	}
	select {
	case wake <- struct{}{}:
	default:
	}
}

func (s *SetupService) runManagedRuntimeReconciler(ctx context.Context) {
	defer s.workers.Done()
	delay := time.Duration(0)
	retryStates := map[string]managedRuntimeRetryState{}
	for {
		trigger := waitForManagedRuntimeReconcile(ctx, s.managedRuntimeReconcileWake, delay)
		if trigger == managedRuntimeReconcileStopped {
			return
		}
		if trigger == managedRuntimeReconcileWake {
			clear(retryStates)
		}
		now := time.Now()
		outcome := s.reconcileManagedRuntimes(ctx, func(key string) bool {
			return shouldAttemptManagedRuntime(retryStates, key, now)
		})
		if ctx.Err() != nil {
			return
		}
		for _, result := range outcome.results {
			if result.err == nil {
				continue
			}
			slog.Warn("agent extension managed runtime reconcile failed",
				"event", "tutti.agent_extension.managed_runtime_reconcile_failed",
				"agentTargetId", result.targetID,
				"retryable", result.retryable,
				"error", result.err,
			)
		}
		delay = applyManagedRuntimeReconcileOutcome(retryStates, outcome, now)
	}
}

func waitForManagedRuntimeReconcile(
	ctx context.Context,
	wake <-chan struct{},
	delay time.Duration,
) managedRuntimeReconcileTrigger {
	if delay == 0 {
		if ctx.Err() != nil {
			return managedRuntimeReconcileStopped
		}
		return managedRuntimeReconcileInitial
	}
	if delay < 0 {
		select {
		case <-ctx.Done():
			return managedRuntimeReconcileStopped
		case <-wake:
			return managedRuntimeReconcileWake
		}
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return managedRuntimeReconcileStopped
	case <-wake:
		return managedRuntimeReconcileWake
	case <-timer.C:
		return managedRuntimeReconcileTimer
	}
}

func shouldAttemptManagedRuntime(
	retryStates map[string]managedRuntimeRetryState,
	key string,
	now time.Time,
) bool {
	state, ok := retryStates[key]
	if !ok {
		return true
	}
	if state.settled || state.permanent {
		return false
	}
	return !now.Before(state.nextAttempt)
}

func applyManagedRuntimeReconcileOutcome(
	retryStates map[string]managedRuntimeRetryState,
	outcome managedRuntimeReconcileOutcome,
	now time.Time,
) time.Duration {
	for key := range retryStates {
		if _, ok := outcome.seen[key]; !ok {
			delete(retryStates, key)
		}
	}
	for _, result := range outcome.results {
		if result.err == nil {
			retryStates[result.key] = managedRuntimeRetryState{settled: true}
			continue
		}
		if !result.retryable {
			retryStates[result.key] = managedRuntimeRetryState{permanent: true}
			continue
		}
		failureCount := retryStates[result.key].failureCount + 1
		backoff := managedRuntimeReconcileMinBackoff
		for range failureCount - 1 {
			backoff = min(backoff*2, managedRuntimeReconcileMaxBackoff)
		}
		retryStates[result.key] = managedRuntimeRetryState{
			failureCount: failureCount,
			nextAttempt:  now.Add(backoff),
		}
	}

	delay := time.Duration(-1)
	for _, state := range retryStates {
		if state.settled || state.permanent {
			continue
		}
		remaining := state.nextAttempt.Sub(now)
		if remaining < 0 {
			remaining = 0
		}
		if delay < 0 || remaining < delay {
			delay = remaining
		}
	}
	return delay
}

// ReconcileManagedRuntimes installs the exact Runtime declared by every
// enabled, client-pinned remote Extension Target. User-owned local CLIs are not
// modified; the managed Runtime lives in Tutti's private runtime root.
func (s *SetupService) ReconcileManagedRuntimes(ctx context.Context) []error {
	outcome := s.reconcileManagedRuntimes(ctx, nil)
	errs := make([]error, 0, len(outcome.results))
	for _, result := range outcome.results {
		if result.err != nil {
			errs = append(errs, result.err)
		}
	}
	return errs
}

func (s *SetupService) reconcileManagedRuntimes(
	ctx context.Context,
	shouldAttempt func(string) bool,
) managedRuntimeReconcileOutcome {
	outcome := managedRuntimeReconcileOutcome{seen: map[string]struct{}{}}
	addResult := func(result managedRuntimeReconcileResult) {
		outcome.seen[result.key] = struct{}{}
		outcome.results = append(outcome.results, result)
	}
	if s == nil || s.Plans.Manager == nil || s.Plans.Manager.Store == nil || s.Discovery == nil || s.Transport == nil {
		addResult(managedRuntimeReconcileResult{
			key: managedRuntimeGlobalRetryKey, err: errors.New("managed runtime reconciler is not configured"),
		})
		return outcome
	}
	s.managedRuntimeReconcileMu.Lock()
	defer s.managedRuntimeReconcileMu.Unlock()

	discoveryRoot, err := s.ensureDiscoveryRoot(ctx)
	if err != nil {
		addResult(managedRuntimeReconcileResult{
			key: managedRuntimeGlobalRetryKey, err: fmt.Errorf("prepare managed runtime discovery root: %w", err), retryable: true,
		})
		return outcome
	}
	targets, err := s.Plans.Manager.Store.ListAgentTargets(ctx)
	if err != nil {
		addResult(managedRuntimeReconcileResult{
			key: managedRuntimeGlobalRetryKey, err: fmt.Errorf("list managed runtime targets: %w", err), retryable: true,
		})
		return outcome
	}
	for _, rawTarget := range targets {
		if ctx.Err() != nil {
			addResult(managedRuntimeReconcileResult{
				key: managedRuntimeGlobalRetryKey, err: ctx.Err(), retryable: true,
			})
			return outcome
		}
		target, normalizeErr := agenttargetbiz.NormalizeTarget(rawTarget)
		if normalizeErr != nil || !target.Enabled {
			continue
		}
		launchRef, launchErr := agenttargetbiz.RuntimeProviderTargetRef(target)
		if launchErr != nil || launchRef["kind"] != agenttargetbiz.LaunchRefTypeAgentExtension {
			continue
		}
		installationID, _ := launchRef["extensionInstallationId"].(string)
		installationID = strings.TrimSpace(installationID)
		key := target.ID + "\x00" + installationID
		outcome.seen[key] = struct{}{}
		if shouldAttempt != nil && !shouldAttempt(key) {
			continue
		}
		installation, loadErr := s.Plans.Manager.loadInstallationByID(strings.TrimSpace(installationID))
		if loadErr != nil {
			addResult(managedRuntimeReconcileResult{
				key: key, targetID: target.ID,
				err: fmt.Errorf("load managed runtime Extension for %s: %w", target.ID, loadErr),
			})
			continue
		}
		if installation.Provider != target.Provider {
			addResult(managedRuntimeReconcileResult{
				key: key, targetID: target.ID,
				err: fmt.Errorf("load managed runtime Extension for %s: provider does not match Target", target.ID),
			})
			continue
		}
		if !s.Plans.Manager.isCurrentClientPinnedRemoteInstallation(installation) {
			addResult(managedRuntimeReconcileResult{key: key, targetID: target.ID})
			continue
		}
		var profile DiscoveryProfile
		if profileErr := readJSON(
			filepath.Join(installation.PackageDir, filepath.FromSlash(installation.Manifest.Profiles.Discovery)),
			&profile,
		); profileErr != nil {
			addResult(managedRuntimeReconcileResult{
				key: key, targetID: target.ID,
				err: fmt.Errorf("load managed runtime profile for %s: %w", target.ID, profileErr),
			})
			continue
		}
		if _, runtimeErr := s.Plans.Manager.resolveInstalledManagedRuntime(
			ctx,
			installation,
			profile,
			discoveryRoot,
		); runtimeErr == nil {
			addResult(managedRuntimeReconcileResult{key: key, targetID: target.ID})
			continue
		}
		plan, planErr := buildInstallPlan(target.ID, s.Plans.Manager.RuntimeInstallDir, installation)
		if planErr != nil {
			addResult(managedRuntimeReconcileResult{
				key: key, targetID: target.ID,
				err: fmt.Errorf("plan managed runtime for %s: %w", target.ID, planErr),
			})
			continue
		}
		if publicationErr := validatePlannedManagedRuntimePublication(s.Plans.Manager, installation, plan); publicationErr != nil {
			addResult(managedRuntimeReconcileResult{
				key: key, targetID: target.ID,
				err: fmt.Errorf("publish managed runtime command for %s: %w", target.ID, publicationErr),
			})
			continue
		}
		if installErr := s.executeInstall(ctx, plan, discoveryRoot, func(SetupActionPhase) error { return nil }); installErr != nil {
			addResult(managedRuntimeReconcileResult{
				key: key, targetID: target.ID, retryable: managedRuntimeInstallFailureRetryable(installErr),
				err: fmt.Errorf("install managed runtime for %s: %w", target.ID, installErr),
			})
			continue
		}
		addResult(managedRuntimeReconcileResult{key: key, targetID: target.ID})
	}
	return outcome
}

func managedRuntimeInstallFailureRetryable(err error) bool {
	return errors.Is(err, ErrRuntimeInstallFailed) || errors.Is(err, ErrRuntimeProbeFailed)
}

func validatePlannedManagedRuntimePublication(
	manager *Manager,
	installation Installation,
	plan InstallPlan,
) error {
	if !plan.PublishUserCommand {
		return nil
	}
	relativeExecutable, err := filepath.Rel(plan.InstallRoot, plan.Executable)
	if err != nil || relativeExecutable == "." || strings.HasPrefix(relativeExecutable, ".."+string(filepath.Separator)) {
		return errors.New("managed runtime executable path is invalid")
	}
	entry, err := manager.managedRuntimeEntry(
		installation,
		plan.InstallRoot,
		installation.Manifest.Runtime.Launch.Executable,
		filepath.ToSlash(relativeExecutable),
	)
	if err != nil {
		return err
	}
	return validateManagedRuntimeEntry(entry)
}
