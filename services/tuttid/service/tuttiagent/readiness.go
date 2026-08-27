package tuttiagent

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"

	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	agentstatusservice "github.com/tutti-os/tutti/services/tuttid/service/agentstatus"
)

const tuttiAgentProvider = "tutti-agent"

type RuntimeService interface {
	List(context.Context, agentstatusservice.ListInput) (agentstatusservice.Snapshot, error)
	RunAction(context.Context, agentstatusservice.RunActionInput) (agentstatusservice.RunActionResult, error)
}

type TargetService interface {
	List(context.Context) ([]agenttargetbiz.Target, error)
}

// ReadinessCoordinator owns the Tutti Agent managed-runtime lifecycle. Runtime
// installation is independent of the Agent Target switch: Tutti installs the
// managed binary by default, while the switch only gates auth and Agent usage.
type ReadinessCoordinator struct {
	Runtime       RuntimeService
	Targets       TargetService
	BootstrapAuth func(context.Context)

	mu sync.Mutex
}

func NewReadinessCoordinator(
	runtime RuntimeService,
	targets TargetService,
	bootstrapAuth func(context.Context),
) *ReadinessCoordinator {
	return &ReadinessCoordinator{
		Runtime:       runtime,
		Targets:       targets,
		BootstrapAuth: bootstrapAuth,
	}
}

// Trigger schedules a best-effort reconciliation without tying its lifetime to
// an HTTP request or account callback context.
func (c *ReadinessCoordinator) Trigger(reason string) {
	if c == nil {
		return
	}
	go func() {
		if err := c.Reconcile(context.Background()); err != nil {
			slog.Warn("tutti-agent readiness reconcile failed",
				"event", "tutti_agent.readiness.failed",
				"trigger", reason,
				"error", err,
			)
		}
	}()
}

// ProviderActionCompleted resumes readiness after a successful managed Tutti
// Agent install or update. Provider routing stays owned by this package rather
// than leaking a provider-specific branch into the generic daemon API.
func (c *ReadinessCoordinator) ProviderActionCompleted(result agentstatusservice.RunActionResult) {
	if result.Provider != tuttiAgentProvider || result.Status != agentstatusservice.RunActionCompleted {
		return
	}
	c.Trigger("provider_action_completed")
}

// Reconcile first guarantees the managed binary, even when the target is
// disabled. Auth is reconciled only after the runtime is ready and the user has
// enabled the Tutti Agent target.
func (c *ReadinessCoordinator) Reconcile(ctx context.Context) error {
	if c == nil || c.Runtime == nil {
		return errors.New("tutti-agent runtime service is unavailable")
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	snapshot, err := c.Runtime.List(ctx, agentstatusservice.ListInput{
		Providers:    []string{tuttiAgentProvider},
		ForceRefresh: true,
	})
	if err != nil {
		return fmt.Errorf("inspect managed runtime: %w", err)
	}
	status, ok := tuttiAgentProviderStatus(snapshot)
	if !ok {
		return errors.New("tutti-agent provider status is missing")
	}
	if !tuttiAgentRuntimeReady(status.Availability.Status) {
		if status.ActiveAction != nil &&
			status.ActiveAction.ID == agentstatusservice.ActionInstall &&
			status.ActiveAction.Status == "running" {
			// The existing renderer bootstrap may have won the race. Its
			// completed daemon action triggers another reconciliation.
			return nil
		}
		if !hasTuttiAgentInstallAction(status.Actions) {
			return fmt.Errorf("managed runtime is %s (%s) and has no install action",
				status.Availability.Status,
				status.Availability.ReasonCode,
			)
		}
		result, runErr := c.Runtime.RunAction(ctx, agentstatusservice.RunActionInput{
			Provider: tuttiAgentProvider,
			ActionID: agentstatusservice.ActionInstall,
		})
		if runErr != nil {
			return fmt.Errorf("install managed runtime: %w", runErr)
		}
		if result.Status != agentstatusservice.RunActionCompleted ||
			result.Probe == nil ||
			result.Probe.Status != agentstatusservice.ProbeReady {
			return fmt.Errorf("managed runtime install did not become ready: status=%s reason=%s message=%s",
				result.Status,
				result.ReasonCode,
				result.Message,
			)
		}
	}

	enabled, err := c.targetEnabled(ctx)
	if err != nil {
		return fmt.Errorf("read tutti-agent target: %w", err)
	}
	if !enabled || c.BootstrapAuth == nil {
		return nil
	}
	c.BootstrapAuth(ctx)
	return nil
}

func tuttiAgentRuntimeReady(status agentstatusservice.AvailabilityStatus) bool {
	return status == agentstatusservice.AvailabilityReady ||
		status == agentstatusservice.AvailabilityAuthRequired
}

func (c *ReadinessCoordinator) targetEnabled(ctx context.Context) (bool, error) {
	if c.Targets == nil {
		return false, errors.New("agent target service is unavailable")
	}
	targets, err := c.Targets.List(ctx)
	if err != nil {
		return false, err
	}
	for _, target := range targets {
		if target.ID == agenttargetbiz.IDLocalTuttiAgent {
			return target.Enabled, nil
		}
	}
	return false, errors.New("tutti-agent target is missing")
}

func tuttiAgentProviderStatus(snapshot agentstatusservice.Snapshot) (agentstatusservice.ProviderStatus, bool) {
	for _, status := range snapshot.Providers {
		if status.Provider == tuttiAgentProvider {
			return status, true
		}
	}
	return agentstatusservice.ProviderStatus{}, false
}

func hasTuttiAgentInstallAction(actions []agentstatusservice.Action) bool {
	for _, action := range actions {
		if action.ID == agentstatusservice.ActionInstall {
			return true
		}
	}
	return false
}
