package agentextension

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
)

const (
	accountUsageReconcileInterval   = 5 * time.Minute
	accountUsageReconcileMinBackoff = time.Second
	accountUsageReconcileMaxBackoff = time.Minute
)

// StartAccountUsageCompanionReconciler starts the optional companion lifecycle.
// It is independent from setup actions: failures retry with bounded backoff and
// never alter the ACP runtime's ready state.
func (s *SetupService) StartAccountUsageCompanionReconciler() error {
	if s == nil || s.Plans.Manager == nil || s.Plans.Manager.Store == nil {
		return errors.New("account usage companion reconciler is not configured")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireOpenLocked(); err != nil {
		return err
	}
	if s.accountUsageReconcilerActive {
		return nil
	}
	s.accountUsageReconcilerActive = true
	s.accountUsageReconcileWake = make(chan struct{}, 1)
	s.workers.Add(1)
	go s.runAccountUsageCompanionReconciler(s.workerCtx)
	return nil
}

// WakeAccountUsageCompanionReconciler requests an immediate pass after an
// extension or ACP runtime activation without performing network I/O inline.
func (s *SetupService) WakeAccountUsageCompanionReconciler() {
	if s == nil {
		return
	}
	s.mu.Lock()
	wake := s.accountUsageReconcileWake
	active := s.accountUsageReconcilerActive && !s.closed
	s.mu.Unlock()
	if !active || wake == nil {
		return
	}
	select {
	case wake <- struct{}{}:
	default:
	}
}

func (s *SetupService) runAccountUsageCompanionReconciler(ctx context.Context) {
	defer s.workers.Done()
	delay := time.Duration(0)
	backoff := accountUsageReconcileMinBackoff
	for {
		if !waitForAccountUsageReconcile(ctx, s.accountUsageReconcileWake, delay) {
			return
		}
		errs := s.ReconcileAccountUsageCompanions(ctx)
		if ctx.Err() != nil {
			return
		}
		if len(errs) == 0 {
			delay = accountUsageReconcileInterval
			backoff = accountUsageReconcileMinBackoff
			continue
		}
		delay = backoff
		backoff = min(backoff*2, accountUsageReconcileMaxBackoff)
	}
}

func waitForAccountUsageReconcile(ctx context.Context, wake <-chan struct{}, delay time.Duration) bool {
	if delay <= 0 {
		return ctx.Err() == nil
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

// ReconcileAccountUsageCompanions ensures every enabled extension target with
// a compatible ACP runtime has its independently activated helper runtime.
func (s *SetupService) ReconcileAccountUsageCompanions(ctx context.Context) []error {
	if s == nil || s.Plans.Manager == nil || s.Plans.Manager.Store == nil {
		return []error{errors.New("account usage companion reconciler is not configured")}
	}
	s.accountUsageReconcileMu.Lock()
	defer s.accountUsageReconcileMu.Unlock()

	discoveryRoot, err := s.ensureDiscoveryRoot(ctx)
	if err != nil {
		return []error{fmt.Errorf("prepare account usage discovery root: %w", err)}
	}
	targets, err := s.Plans.Manager.Store.ListAgentTargets(ctx)
	if err != nil {
		return []error{fmt.Errorf("list account usage targets: %w", err)}
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
		if loadErr != nil || installation.Provider != target.Provider {
			continue
		}
		profile, profileErr := loadAccountUsageProfile(installation)
		if profileErr != nil {
			errs = append(errs, fmt.Errorf("load account usage profile for %s: %w", target.ID, profileErr))
			continue
		}
		if profile == nil {
			continue
		}
		if localExecutable := s.Plans.Manager.localAccountUsageExecutable(installation); localExecutable != "" {
			if _, bindingErr := s.Plans.Manager.resolvedLocalAccountUsageRuntimeBinding(localExecutable, profile); bindingErr != nil {
				errs = append(errs, fmt.Errorf("resolve local account usage helper for %s: %w", target.ID, bindingErr))
			}
			continue
		}
		if _, runtimeErr := s.Plans.Manager.ResolveRuntimeForCWD(ctx, installation.ID, discoveryRoot); runtimeErr != nil {
			// The main runtime is not ready yet. Its setup completion will wake an
			// immediate pass, so this is not a companion install failure.
			continue
		}
		companion, planErr := buildAccountUsageInstall(
			s.Plans.Manager.RuntimeInstallDir,
			installation,
			profile,
			runtimePlatform(),
		)
		if planErr != nil {
			errs = append(errs, fmt.Errorf("plan account usage helper for %s: %w", target.ID, planErr))
			continue
		}
		if installErr := s.installAccountUsageCompanion(ctx, installation, InstallPlan{AccountUsage: companion}); installErr != nil {
			errs = append(errs, fmt.Errorf("install account usage helper for %s: %w", target.ID, installErr))
			continue
		}
		s.Plans.Manager.clearAccountUsageProbeResults()
	}
	return errs
}
