package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"
)

// codexAppServerSession keeps one provider app-server alive across model/list
// requests. The session is deliberately owned by the model catalog, not by a
// request, so concurrent composer callers share both the process and the
// initialized protocol connection.
type codexAppServerSession struct {
	mu          sync.Mutex
	base        CodexCLIModelLister
	process     *codexAppServerProcess
	cancel      context.CancelFunc
	scanner     *bufio.Scanner
	nextID      int
	initialized bool
	idleTimer   *time.Timer
}

func newCodexAppServerSession(base CodexCLIModelLister) *codexAppServerSession {
	base.Session = nil
	return &codexAppServerSession{base: base, nextID: 1}
}

func (s *codexAppServerSession) ListModels(ctx context.Context, lister CodexCLIModelLister) (AgentModelListResult, error) {
	if s == nil {
		return lister.listModelsOnce(ctx)
	}
	timeout := lister.Timeout
	if timeout <= 0 {
		timeout = codexAppServerModelListTimeout
	}
	requestCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.process == nil || s.process.exited() {
		if err := s.startLocked(requestCtx, lister); err != nil {
			return AgentModelListResult{}, err
		}
	}
	models, err := s.runWithContextLocked(requestCtx, func() ([]AgentModelOption, error) {
		return s.requestModelsLocked(lister.clientName())
	})
	if err == nil {
		s.armIdleTimerLocked()
		return AgentModelListResult{Models: models}, nil
	}
	if requestCtx.Err() != nil {
		return AgentModelListResult{}, fmt.Errorf("codex app-server model/list timed out: %w", requestCtx.Err())
	}
	process := s.process
	_ = s.closeLocked()
	if process != nil {
		if stderr := strings.TrimSpace(process.stderr.String()); stderr != "" {
			err = fmt.Errorf("%w: %s", err, stderr)
		}
	}
	return AgentModelListResult{}, err
}

func (s *codexAppServerSession) startLocked(ctx context.Context, lister CodexCLIModelLister) error {
	command, args, env, err := lister.resolveLaunch(ctx)
	if err != nil {
		return err
	}
	processContext, cancel := context.WithCancel(context.WithoutCancel(ctx))
	slog.Info("agent model catalog process launch",
		"event", "agent.model_catalog.process_start",
		"provider", lister.Provider,
		"command", command,
		"args", args,
		"provider_command_resolver", lister.ProviderCommands != nil,
		"persistent", true,
	)
	process, err := startCodexAppServerProcess(processContext, command, args, env)
	if err != nil {
		cancel()
		return err
	}
	s.process = process
	s.cancel = cancel
	s.scanner = bufio.NewScanner(process.stdout)
	s.scanner.Buffer(make([]byte, 0, 64*1024), codexModelListMaxLineBytes)
	s.nextID = 1
	s.initialized = false
	return nil
}

func (s *codexAppServerSession) requestModelsLocked(clientName string) ([]AgentModelOption, error) {
	if s.process == nil || s.scanner == nil {
		return nil, fmt.Errorf("codex app-server session is not running")
	}
	encoder := json.NewEncoder(s.process.stdin)
	if !s.initialized {
		initializeID := s.nextRequestIDLocked()
		if err := writeCodexInitializeRequest(encoder, initializeID, clientName); err != nil {
			return nil, err
		}
		initializeStartedAt := time.Now()
		if err := readCodexInitializeResponseForID(s.scanner, initializeID); err != nil {
			return nil, err
		}
		slog.Info("agent model catalog request stage settled",
			"event", "agent.model_catalog.stage_settled",
			"provider", s.base.Provider,
			"stage", "initialize",
			"durationMs", time.Since(initializeStartedAt).Milliseconds(),
			"persistent", true,
		)
		if err := writeCodexInitializedNotification(encoder); err != nil {
			return nil, err
		}
		s.initialized = true
	}
	modelListID := s.nextRequestIDLocked()
	if err := writeCodexModelListRequest(encoder, modelListID); err != nil {
		return nil, err
	}
	modelListStartedAt := time.Now()
	models, err := readCodexModelListResponseForID(s.scanner, modelListID)
	slog.Info("agent model catalog request stage settled",
		"event", "agent.model_catalog.stage_settled",
		"provider", s.base.Provider,
		"stage", "model_list",
		"durationMs", time.Since(modelListStartedAt).Milliseconds(),
		"persistent", true,
		"error", err,
	)
	return models, err
}

func (s *codexAppServerSession) nextRequestIDLocked() string {
	id := fmt.Sprintf("%d", s.nextID)
	s.nextID++
	return id
}

func (s *codexAppServerSession) runWithContextLocked(
	ctx context.Context,
	request func() ([]AgentModelOption, error),
) ([]AgentModelOption, error) {
	resultCh := make(chan struct {
		models []AgentModelOption
		err    error
	}, 1)
	go func() {
		models, err := request()
		resultCh <- struct {
			models []AgentModelOption
			err    error
		}{models: models, err: err}
	}()
	select {
	case result := <-resultCh:
		return result.models, result.err
	case <-ctx.Done():
		_ = s.closeLocked()
		return nil, ctx.Err()
	}
}

func (s *codexAppServerSession) closeLocked() error {
	if s.idleTimer != nil {
		s.idleTimer.Stop()
		s.idleTimer = nil
	}
	if s.process == nil {
		return nil
	}
	process := s.process
	cancel := s.cancel
	s.process = nil
	s.cancel = nil
	s.scanner = nil
	s.initialized = false
	if cancel == nil {
		cancel = func() {}
	}
	return process.stop(cancel)
}

func (s *codexAppServerSession) armIdleTimerLocked() {
	if s.idleTimer != nil {
		s.idleTimer.Stop()
	}
	process := s.process
	s.idleTimer = time.AfterFunc(codexAppServerIdleTTL, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.process != process {
			return
		}
		slog.Info("agent model catalog idle process closed",
			"event", "agent.model_catalog.process_idle_close",
			"provider", s.base.Provider,
		)
		_ = s.closeLocked()
	})
}

func (s *codexAppServerSession) Close() error {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closeLocked()
}

func (p *codexAppServerProcess) exited() bool {
	if p == nil {
		return true
	}
	select {
	case <-p.waitDone:
		return true
	default:
		return false
	}
}
