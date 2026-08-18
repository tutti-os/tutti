package agentextension

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	agentextensionbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentextension"
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
	if s == nil || s.Plans.Manager == nil || s.Plans.Manager.Store == nil || s.AccountUsageFailures == nil {
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
		outcome := s.reconcileAccountUsageCompanions(ctx)
		if ctx.Err() != nil {
			return
		}
		if outcome.retryAfter > 0 {
			delay = min(outcome.retryAfter, accountUsageReconcileInterval)
			backoff = accountUsageReconcileMinBackoff
			continue
		}
		if len(outcome.errs) == 0 {
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
	return s.reconcileAccountUsageCompanions(ctx).errs
}

type accountUsageReconcileOutcome struct {
	errs       []error
	retryAfter time.Duration
}

func (outcome *accountUsageReconcileOutcome) addRetryAfter(delay time.Duration) {
	if delay <= 0 {
		return
	}
	if outcome.retryAfter <= 0 || delay < outcome.retryAfter {
		outcome.retryAfter = delay
	}
}

func (s *SetupService) reconcileAccountUsageCompanions(ctx context.Context) accountUsageReconcileOutcome {
	if s == nil || s.Plans.Manager == nil || s.Plans.Manager.Store == nil || s.AccountUsageFailures == nil {
		return accountUsageReconcileOutcome{errs: []error{errors.New("account usage companion reconciler is not configured")}}
	}
	s.accountUsageReconcileMu.Lock()
	defer s.accountUsageReconcileMu.Unlock()

	discoveryRoot, err := s.ensureDiscoveryRoot(ctx)
	if err != nil {
		return accountUsageReconcileOutcome{errs: []error{fmt.Errorf("prepare account usage discovery root: %w", err)}}
	}
	targets, err := s.Plans.Manager.Store.ListAgentTargets(ctx)
	if err != nil {
		return accountUsageReconcileOutcome{errs: []error{fmt.Errorf("list account usage targets: %w", err)}}
	}
	now := s.accountUsageReconcileTime()
	outcome := accountUsageReconcileOutcome{}
	for _, rawTarget := range targets {
		if ctx.Err() != nil {
			outcome.errs = append(outcome.errs, ctx.Err())
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
		installation, loadErr := s.Plans.Manager.loadInstallationByID(strings.TrimSpace(installationID))
		if loadErr != nil || installation.Provider != target.Provider {
			continue
		}
		profile, profileErr := loadAccountUsageProfile(installation)
		if profileErr != nil {
			outcome.errs = append(outcome.errs, fmt.Errorf("load account usage profile for %s: %w", target.ID, profileErr))
			continue
		}
		failureScope := accountUsageCompanionFailureScope(target.ID, installation.ID)
		if profile == nil {
			if clearErr := s.AccountUsageFailures.Delete(ctx, failureScope); clearErr != nil {
				outcome.errs = append(outcome.errs, fmt.Errorf("clear obsolete account usage helper failure for %s: %w", target.ID, clearErr))
			}
			continue
		}
		if localExecutable := s.Plans.Manager.localAccountUsageExecutable(installation); localExecutable != "" {
			if _, bindingErr := s.Plans.Manager.resolvedLocalAccountUsageRuntimeBindingContext(ctx, localExecutable, profile); bindingErr != nil {
				outcome.errs = append(outcome.errs, fmt.Errorf("resolve local account usage helper for %s: %w", target.ID, bindingErr))
			} else if clearErr := s.AccountUsageFailures.Delete(ctx, failureScope); clearErr != nil {
				outcome.errs = append(outcome.errs, fmt.Errorf("clear recovered account usage helper failure for %s: %w", target.ID, clearErr))
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
			outcome.errs = append(outcome.errs, fmt.Errorf("plan account usage helper for %s: %w", target.ID, planErr))
			continue
		}
		failure, readErr := s.AccountUsageFailures.Read(ctx, failureScope)
		if readErr != nil {
			outcome.errs = append(outcome.errs, fmt.Errorf("read account usage helper failure for %s: %w", target.ID, readErr))
			continue
		}
		if failure != nil && failure.RuntimeIdentity != companion.RuntimeIdentity {
			if clearErr := s.AccountUsageFailures.Delete(ctx, failureScope); clearErr != nil {
				outcome.errs = append(outcome.errs, fmt.Errorf("clear stale account usage helper failure for %s: %w", target.ID, clearErr))
				continue
			}
			failure = nil
		}
		if failure != nil {
			retryAfter := time.UnixMilli(failure.NextAttemptAtUnixMS).Sub(now)
			if retryAfter > 0 {
				outcome.addRetryAfter(retryAfter)
				continue
			}
		}
		if installErr := s.installAccountUsageCompanion(ctx, installation, InstallPlan{AccountUsage: companion}); installErr != nil {
			if ctx.Err() != nil {
				outcome.errs = append(outcome.errs, ctx.Err())
				return outcome
			}
			failureCount := 1
			if failure != nil {
				failureCount = failure.ConsecutiveFailures + 1
			}
			attemptedAt := s.accountUsageReconcileTime()
			retryAfter := accountUsageCompanionRetryBackoff(failureCount)
			record := agentextensionbiz.AccountUsageCompanionFailure{
				SchemaVersion: agentextensionbiz.AccountUsageCompanionFailureSchemaVersion,
				AgentTargetID: target.ID, ExtensionInstallationID: installation.ID,
				RuntimeIdentity: companion.RuntimeIdentity, ErrorCode: "install_failed",
				ConsecutiveFailures: failureCount, LastAttemptAtUnixMS: attemptedAt.UnixMilli(),
				NextAttemptAtUnixMS: attemptedAt.Add(retryAfter).UnixMilli(),
			}
			if persistErr := s.AccountUsageFailures.Put(ctx, failureScope, record); persistErr != nil {
				outcome.errs = append(outcome.errs, fmt.Errorf("persist account usage helper failure for %s: %w", target.ID, persistErr))
			} else {
				outcome.addRetryAfter(retryAfter)
			}
			outcome.errs = append(outcome.errs, fmt.Errorf("install account usage helper for %s: %w", target.ID, installErr))
			continue
		}
		if clearErr := s.AccountUsageFailures.Delete(ctx, failureScope); clearErr != nil {
			outcome.errs = append(outcome.errs, fmt.Errorf("clear recovered account usage helper failure for %s: %w", target.ID, clearErr))
			continue
		}
		s.Plans.Manager.clearAccountUsageProbeResults()
	}
	return outcome
}

func accountUsageCompanionRetryBackoff(consecutiveFailures int) time.Duration {
	delay := accountUsageReconcileMinBackoff
	for attempt := 1; attempt < consecutiveFailures && delay < accountUsageReconcileMaxBackoff; attempt++ {
		delay = min(delay*2, accountUsageReconcileMaxBackoff)
	}
	return delay
}

func (s *SetupService) accountUsageReconcileTime() time.Time {
	if s.accountUsageNow != nil {
		return s.accountUsageNow().UTC()
	}
	return time.Now().UTC()
}
