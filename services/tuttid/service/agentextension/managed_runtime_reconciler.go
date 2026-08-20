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
	managedRuntimeReconcileMaxBackoff = time.Minute
)

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
	backoff := managedRuntimeReconcileMinBackoff
	for {
		if !waitForManagedRuntimeReconcile(ctx, s.managedRuntimeReconcileWake, delay) {
			return
		}
		errs := s.ReconcileManagedRuntimes(ctx)
		if ctx.Err() != nil {
			return
		}
		if len(errs) == 0 {
			// Pinned releases cannot change while this client is running. Sleep
			// until startup refresh or a source activation explicitly wakes us.
			delay = -1
			backoff = managedRuntimeReconcileMinBackoff
			continue
		}
		for _, err := range errs {
			slog.Warn("agent extension managed runtime reconcile failed",
				"event", "tutti.agent_extension.managed_runtime_reconcile_failed",
				"error", err,
			)
		}
		delay = backoff
		backoff = min(backoff*2, managedRuntimeReconcileMaxBackoff)
	}
}

func waitForManagedRuntimeReconcile(ctx context.Context, wake <-chan struct{}, delay time.Duration) bool {
	if delay == 0 {
		return ctx.Err() == nil
	}
	if delay < 0 {
		select {
		case <-ctx.Done():
			return false
		case <-wake:
			return true
		}
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-wake:
		return true
	case <-timer.C:
		return true
	}
}

// ReconcileManagedRuntimes installs the exact Runtime declared by every
// enabled, client-pinned remote Extension Target. User-owned local CLIs are not
// modified; the managed Runtime lives in Tutti's private runtime root.
func (s *SetupService) ReconcileManagedRuntimes(ctx context.Context) []error {
	if s == nil || s.Plans.Manager == nil || s.Plans.Manager.Store == nil || s.Discovery == nil || s.Transport == nil {
		return []error{errors.New("managed runtime reconciler is not configured")}
	}
	s.managedRuntimeReconcileMu.Lock()
	defer s.managedRuntimeReconcileMu.Unlock()

	discoveryRoot, err := s.ensureDiscoveryRoot(ctx)
	if err != nil {
		return []error{fmt.Errorf("prepare managed runtime discovery root: %w", err)}
	}
	targets, err := s.Plans.Manager.Store.ListAgentTargets(ctx)
	if err != nil {
		return []error{fmt.Errorf("list managed runtime targets: %w", err)}
	}
	var errs []error
	for _, rawTarget := range targets {
		if ctx.Err() != nil {
			return append(errs, ctx.Err())
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
		installation, loadErr := s.Plans.Manager.loadInstallationByID(strings.TrimSpace(installationID))
		if loadErr != nil {
			errs = append(errs, fmt.Errorf("load managed runtime Extension for %s: %w", target.ID, loadErr))
			continue
		}
		if installation.Provider != target.Provider {
			errs = append(errs, fmt.Errorf("load managed runtime Extension for %s: provider does not match Target", target.ID))
			continue
		}
		if installation.HasLocalPackageProvenance() {
			continue
		}
		var profile DiscoveryProfile
		if profileErr := readJSON(
			filepath.Join(installation.PackageDir, filepath.FromSlash(installation.Manifest.Profiles.Discovery)),
			&profile,
		); profileErr != nil {
			errs = append(errs, fmt.Errorf("load managed runtime profile for %s: %w", target.ID, profileErr))
			continue
		}
		if _, runtimeErr := s.Plans.Manager.resolveInstalledManagedRuntime(
			ctx,
			installation,
			profile,
			discoveryRoot,
		); runtimeErr == nil {
			continue
		}
		plan, planErr := buildInstallPlan(target.ID, s.Plans.Manager.RuntimeInstallDir, installation)
		if planErr != nil {
			errs = append(errs, fmt.Errorf("plan managed runtime for %s: %w", target.ID, planErr))
			continue
		}
		if installErr := s.executeInstall(ctx, plan, discoveryRoot, func(SetupActionPhase) error { return nil }); installErr != nil {
			errs = append(errs, fmt.Errorf("install managed runtime for %s: %w", target.ID, installErr))
		}
	}
	return errs
}
