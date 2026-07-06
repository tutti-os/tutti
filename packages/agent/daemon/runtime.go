package agentdaemon

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"

	agentruntime "github.com/tutti-os/tutti/packages/agentactivity/daemon/runtime"
)

var ErrHostMetadataRequired = errors.New("agent daemon host metadata is required")
var ErrProcessTransportRequired = errors.New("agent daemon process transport is required")

const (
	defaultLiveSessionReaperIdleAfter     = 30 * time.Minute
	defaultLiveSessionReaperSweepInterval = 5 * time.Minute

	// shutdownCloseAllLiveSessionsTimeout bounds how long Runtime.Close waits
	// for CloseAllLiveSessions to force-terminate every live provider
	// process. Each process close is already internally bounded (SIGTERM,
	// then SIGKILL after a short grace period; see localProcessConnection),
	// so this is a backstop against an unexpectedly large number of live
	// sessions, not the primary timeout mechanism.
	shutdownCloseAllLiveSessionsTimeout = 15 * time.Second
)

type ActivityReporter = agentruntime.ActivityReporter
type Adapter = agentruntime.Adapter
type ClientInfo = agentruntime.ClientInfo
type Controller = agentruntime.Controller
type HostMetadata = agentruntime.HostMetadata
type ProcessTransport = agentruntime.ProcessTransport
type ProviderCommand = agentruntime.ProviderCommand
type ProviderCommandResolver = agentruntime.ProviderCommandResolver

type Config struct {
	Reporter                ActivityReporter
	ProcessTransport        ProcessTransport
	HostMetadata            HostMetadata
	ProviderCommandResolver ProviderCommandResolver
	Adapters                []Adapter
	LiveSessionReaper       LiveSessionReaperConfig
}

type LiveSessionReaperConfig struct {
	Enabled       *bool
	IdleAfter     time.Duration
	SweepInterval time.Duration
}

type Runtime struct {
	controller *Controller
	cancel     context.CancelFunc
	done       chan struct{}
	closeOnce  sync.Once
}

func NewRuntime(config Config) (*Runtime, error) {
	var controller *Controller
	if len(config.Adapters) > 0 {
		controller = agentruntime.NewController(config.Adapters, config.Reporter)
	} else {
		if !hasCompleteHostMetadata(config.HostMetadata) {
			return nil, ErrHostMetadataRequired
		}
		if config.ProcessTransport == nil {
			return nil, ErrProcessTransportRequired
		}
		controller = agentruntime.NewDefaultControllerWithOptions(
			config.Reporter,
			config.ProcessTransport,
			agentruntime.ControllerOptions{
				HostMetadata:            config.HostMetadata,
				ProviderCommandResolver: config.ProviderCommandResolver,
			},
		)
	}
	runtime := &Runtime{controller: controller}
	runtime.startLiveSessionReaper(config.LiveSessionReaper)
	return runtime, nil
}

func NewLocalProcessTransport() ProcessTransport {
	return agentruntime.NewLocalProcessTransport()
}

func MustRuntime(config Config) *Runtime {
	runtime, err := NewRuntime(config)
	if err != nil {
		panic(err)
	}
	return runtime
}

func (r *Runtime) Controller() *Controller {
	if r == nil {
		return nil
	}
	return r.controller
}

func (r *Runtime) Close() {
	if r == nil {
		return
	}
	r.closeOnce.Do(func() {
		r.closeAllLiveSessions()
		if r.cancel != nil {
			r.cancel()
		}
		if r.done != nil {
			<-r.done
		}
	})
}

// closeAllLiveSessions force-terminates every live provider process (Codex
// app-server, Claude Code SDK sidecar, other ACP subprocess adapters) before
// the daemon process exits. A spawned subprocess is not killed automatically
// just because tuttid exits — it is reparented to init and keeps running —
// so without this step, every daemon shutdown (or a desktop-parent-monitor
// triggered shutdown after the host app disappears) would orphan any
// in-flight provider processes, leaving them running unmanaged against the
// session's working directory indefinitely.
func (r *Runtime) closeAllLiveSessions() {
	if r == nil || r.controller == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), shutdownCloseAllLiveSessionsTimeout)
	defer cancel()
	result := r.controller.CloseAllLiveSessions(ctx)
	if result.Scanned == 0 {
		return
	}
	slog.Info("agent live session shutdown close completed",
		"event", "agent_session.shutdown_close.completed",
		"scanned", result.Scanned,
		"closed", result.Closed,
		"failed", result.Failed,
	)
}

func (r *Runtime) startLiveSessionReaper(config LiveSessionReaperConfig) {
	if r == nil || r.controller == nil || !liveSessionReaperEnabled(config) {
		return
	}
	idleAfter := config.IdleAfter
	if idleAfter <= 0 {
		idleAfter = defaultLiveSessionReaperIdleAfter
	}
	sweepInterval := config.SweepInterval
	if sweepInterval <= 0 {
		sweepInterval = defaultLiveSessionReaperSweepInterval
	}
	ctx, cancel := context.WithCancel(context.Background())
	r.cancel = cancel
	r.done = make(chan struct{})
	go func() {
		defer close(r.done)
		ticker := time.NewTicker(sweepInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				result := r.controller.ReleaseIdleLiveSessions(ctx, agentruntime.ReleaseIdleLiveSessionsInput{
					IdleAfter: idleAfter,
					Now:       time.Now(),
				})
				if result.Scanned == 0 {
					continue
				}
				slog.Info("agent live session reaper sweep completed",
					"event", "agent_session.live_reaper.sweep_completed",
					"scanned", result.Scanned,
					"released", result.Released,
					"skipped_fresh", result.SkippedFresh,
					"skipped_active_turn", result.SkippedActiveTurn,
					"skipped_unsupported", result.SkippedUnsupported,
					"skipped_not_live", result.SkippedNotLive,
					"skipped_busy", result.SkippedBusy,
					"failed", result.Failed,
				)
			}
		}
	}()
}

func liveSessionReaperEnabled(config LiveSessionReaperConfig) bool {
	if config.Enabled == nil {
		return true
	}
	return *config.Enabled
}

func hasCompleteHostMetadata(host HostMetadata) bool {
	return strings.TrimSpace(host.ClientInfo.Name) != "" &&
		strings.TrimSpace(host.ClientInfo.Title) != "" &&
		strings.TrimSpace(host.ClientInfo.Version) != "" &&
		strings.TrimSpace(host.WorkspaceEnvName) != "" &&
		strings.TrimSpace(host.OpenClawSessionKeyPrefix) != ""
}
