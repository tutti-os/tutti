package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"

	"github.com/tutti-os/tutti/packages/agentactivity/daemon/httpx"
)

const defaultAppHealthcheckTimeout = 30 * time.Second

type AppRunner struct {
	HealthcheckTimeout time.Duration
	HTTPClient         *http.Client
	OnStateChanged     AppRunnerStateChanged
	RuntimeResolver    AppRuntimeResolver

	mu        sync.Mutex
	processes map[string]*appProcess
	states    map[string]workspacebiz.AppRuntimeState
	starts    map[string]*appStart
	queue     chan struct{}
}

type AppRunnerStateChanged func(workspaceID string, appID string, state workspacebiz.AppRuntimeState)

type AppStartInput struct {
	WorkspaceID     string
	WorkspaceName   string
	WorkspaceRoot   string
	AppID           string
	PackageDir      string
	Bootstrap       string
	HealthcheckPath string
	RuntimeProfile  string
	RuntimeDir      string
	DataDir         string
	LogDir          string
	Restart         bool
}

type appProcess struct {
	command       *exec.Cmd
	done          chan error
	stopRequested bool
	logFile       *os.File
}

type appStart struct {
	cancel context.CancelFunc
}

func (r *AppRunner) State(workspaceID string, appID string) workspacebiz.AppRuntimeState {
	r.ensure()

	r.mu.Lock()
	defer r.mu.Unlock()

	state, ok := r.states[appRuntimeKey(workspaceID, appID)]
	if !ok {
		return workspacebiz.AppRuntimeState{
			Status: workspacebiz.AppRuntimeStatusIdle,
		}
	}
	return state
}

func (r *AppRunner) Start(ctx context.Context, input AppStartInput) (workspacebiz.AppRuntimeState, error) {
	r.ensure()

	key := appRuntimeKey(input.WorkspaceID, input.AppID)
	r.mu.Lock()
	existing, running := r.processes[key]
	existingState := r.states[key]
	if running && existing != nil && existingState.Status == workspacebiz.AppRuntimeStatusRunning && !input.Restart {
		r.mu.Unlock()
		return existingState, nil
	}
	if r.starts[key] != nil &&
		!input.Restart &&
		(existingState.Status == workspacebiz.AppRuntimeStatusPreparing || existingState.Status == workspacebiz.AppRuntimeStatusStarting) {
		r.mu.Unlock()
		return existingState, nil
	}
	if start := r.starts[key]; start != nil {
		start.cancel()
		delete(r.starts, key)
	}
	r.mu.Unlock()
	if running {
		_, _ = r.Stop(ctx, input.WorkspaceID, input.AppID)
	}
	startCtx, cancel := context.WithCancel(context.Background())
	start := &appStart{cancel: cancel}
	r.mu.Lock()
	r.starts[key] = start
	r.mu.Unlock()

	state := r.setState(key, workspacebiz.AppRuntimeState{
		Status:     workspacebiz.AppRuntimeStatusPreparing,
		PackageDir: input.PackageDir,
	})
	go r.startQueued(startCtx, key, input, start)
	return state, nil
}

func (r *AppRunner) PreloadRuntime(ctx context.Context) error {
	r.ensure()
	_, err := r.runtimeResolver().Resolve(ctx)
	return err
}

func (r *AppRunner) PreloadRuntimeForProfile(ctx context.Context, profile string) error {
	r.ensure()
	if appRuntimeProfileIsStandalone(profile) {
		return nil
	}
	resolver := r.runtimeResolver()
	if preloader, ok := resolver.(AppRuntimeProfilePreloader); ok {
		return preloader.PreloadProfile(ctx, profile)
	}
	_, err := resolver.Resolve(ctx)
	return err
}

func (r *AppRunner) startQueued(ctx context.Context, key string, input AppStartInput, start *appStart) {
	select {
	case r.queue <- struct{}{}:
		defer func() { <-r.queue }()
	case <-ctx.Done():
		r.finishStart(key, ctx, start)
		return
	}
	if err := ctx.Err(); err != nil {
		r.finishStart(key, ctx, start)
		return
	}
	r.startProcess(ctx, key, input)
	r.finishStart(key, ctx, start)
}

func (r *AppRunner) startProcess(ctx context.Context, key string, input AppStartInput) {
	port, err := allocateLoopbackPort()
	if err != nil {
		logAppRuntimeControl("workspace_app_runtime_start_failed", input, 0, "startup", fmt.Errorf("allocate app port: %w", err))
		r.setFailed(key, "startup", fmt.Errorf("allocate app port: %w", err))
		return
	}

	if err := os.MkdirAll(input.RuntimeDir, 0o755); err != nil {
		logAppRuntimeControl("workspace_app_runtime_start_failed", input, port, "startup", fmt.Errorf("create app runtime dir: %w", err))
		r.setFailed(key, "startup", fmt.Errorf("create app runtime dir: %w", err))
		return
	}
	if err := os.MkdirAll(input.DataDir, 0o755); err != nil {
		logAppRuntimeControl("workspace_app_runtime_start_failed", input, port, "startup", fmt.Errorf("create app data dir: %w", err))
		r.setFailed(key, "startup", fmt.Errorf("create app data dir: %w", err))
		return
	}
	if err := os.MkdirAll(input.LogDir, 0o755); err != nil {
		logAppRuntimeControl("workspace_app_runtime_start_failed", input, port, "startup", fmt.Errorf("create app log dir: %w", err))
		r.setFailed(key, "startup", fmt.Errorf("create app log dir: %w", err))
		return
	}
	appRuntime, err := r.resolveRuntime(ctx, input.RuntimeProfile)
	if err != nil {
		logAppRuntimeControl("workspace_app_runtime_start_failed", input, port, "runtime_unavailable", err)
		r.setFailed(key, "runtime_unavailable", err)
		return
	}

	logFile, err := os.OpenFile(filepath.Join(input.LogDir, "runtime.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		logAppRuntimeControl("workspace_app_runtime_start_failed", input, port, "startup", fmt.Errorf("open app runtime log: %w", err))
		r.setFailed(key, "startup", fmt.Errorf("open app runtime log: %w", err))
		return
	}

	bootstrap := input.Bootstrap
	if bootstrap == "" {
		bootstrap = "bootstrap.sh"
	}
	bootstrapPath := filepath.Join(input.PackageDir, filepath.Clean(bootstrap))
	command := exec.Command(bootstrapPath)
	prepareAppProcessCommand(command)
	command.Dir = input.RuntimeDir
	command.Stdout = logFile
	command.Stderr = logFile
	tuttiCLIShim := tuttiCLIShimPath()
	tuttiAPIBaseURL := tuttiAPIBaseURLFromEnv()
	appToolchainRoot := tuttiAppToolchainRoot()
	envOverrides := []string{
		"TUTTI_APP_ID=" + input.AppID,
		"TUTTI_WORKSPACE_ID=" + input.WorkspaceID,
		"TUTTI_WORKSPACE_NAME=" + input.WorkspaceName,
		"TUTTI_WORKSPACE_ROOT=" + input.WorkspaceRoot,
		"TUTTI_APP_HOST=127.0.0.1",
		"TUTTI_APP_PACKAGE_DIR=" + input.PackageDir,
		"TUTTI_APP_RUNTIME_DIR=" + input.RuntimeDir,
		"TUTTI_APP_DATA_DIR=" + input.DataDir,
		"TUTTI_APP_LOG_DIR=" + input.LogDir,
		"TUTTI_APP_TOOLCHAIN_ROOT=" + appToolchainRoot,
		"TUTTI_APP_PORT=" + strconv.Itoa(port),
		"TUTTI_APP_BASE_URL=http://127.0.0.1:" + strconv.Itoa(port),
		"TUTTI_API_BASE_URL=" + tuttiAPIBaseURL,
		"TUTTI_APP_INSTALLATION_ID=" + input.WorkspaceID + ":" + input.AppID,
		"TUTTI_APP_SERVER_TOKEN=" + appServerToken(input.WorkspaceID, input.AppID),
		"TUTTI_CLI=" + tuttiCLIShim,
	}
	envOverrides = append(envOverrides, appRuntime.EnvOverrides...)
	envOverrides = append(envOverrides, appRuntimePathWithCLIShim(appRuntime, tuttiCLIShim))
	command.Env = workspaceAppProcessEnv(envOverrides...)
	writeAppStartupDiagnostic(logFile, input, bootstrapPath, port, appRuntime, command.Env)

	launchURL := "http://127.0.0.1:" + strconv.Itoa(port)
	startedAt := unixMsNow()
	process := &appProcess{
		command: command,
		done:    make(chan error, 1),
		logFile: logFile,
	}
	r.setState(key, workspacebiz.AppRuntimeState{
		Status:          workspacebiz.AppRuntimeStatusStarting,
		LaunchURL:       &launchURL,
		Port:            &port,
		StartedAtUnixMs: &startedAt,
		PackageDir:      input.PackageDir,
	})

	if err := ctx.Err(); err != nil {
		_ = logFile.Close()
		return
	}
	if err := command.Start(); err != nil {
		_ = logFile.Close()
		logAppRuntimeControl("workspace_app_runtime_start_failed", input, port, "startup", fmt.Errorf("start app process: %w", err))
		r.setFailed(key, "startup", fmt.Errorf("start app process: %w", err))
		return
	}

	r.mu.Lock()
	r.processes[key] = process
	r.mu.Unlock()

	go r.waitForProcess(key, process)

	healthErr := r.waitForHealth(ctx, launchURL, input.HealthcheckPath)
	if healthErr != nil {
		if errors.Is(healthErr, context.Canceled) {
			_, _ = r.stopProcess(context.Background(), key, process)
			return
		}
		_, _ = r.stopProcess(context.Background(), key, process)
		logAppRuntimeControl("workspace_app_runtime_healthcheck_failed", input, port, "healthcheck", healthErr)
		r.setFailed(key, "healthcheck", healthErr)
		return
	}

	logAppRuntimeControl("workspace_app_runtime_running", input, port, "", nil)
	r.setState(key, workspacebiz.AppRuntimeState{
		Status:          workspacebiz.AppRuntimeStatusRunning,
		LaunchURL:       &launchURL,
		Port:            &port,
		StartedAtUnixMs: &startedAt,
		PackageDir:      input.PackageDir,
	})
}

func tuttiAPIBaseURLFromEnv() string {
	if addr := tuttiBoundAddrFromListenerInfo(); addr != "" {
		return "http://" + addr
	}
	addr := strings.TrimSpace(os.Getenv("TUTTID_ADDR"))
	if addr == "" {
		return "http://127.0.0.1:28100"
	}
	if strings.HasPrefix(addr, "http://") || strings.HasPrefix(addr, "https://") {
		return addr
	}
	return "http://" + addr
}

func tuttiBoundAddrFromListenerInfo() string {
	path := strings.TrimSpace(os.Getenv("TUTTID_LISTENER_INFO_PATH"))
	if path == "" {
		path = tuttitypes.TuttidListenerInfoPath()
	}
	body, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var info struct {
		Addr string `json:"addr"`
	}
	if err := json.Unmarshal(body, &info); err != nil {
		return ""
	}
	return strings.TrimSpace(info.Addr)
}

func appServerToken(workspaceID string, appID string) string {
	token := strings.TrimSpace(os.Getenv("TUTTID_ACCESS_TOKEN"))
	return workspacebiz.AppServerToken(token, workspaceID, appID)
}

func (r *AppRunner) Stop(ctx context.Context, workspaceID string, appID string) (workspacebiz.AppRuntimeState, error) {
	r.ensure()

	key := appRuntimeKey(workspaceID, appID)
	r.mu.Lock()
	if start := r.starts[key]; start != nil {
		start.cancel()
		delete(r.starts, key)
	}
	process := r.processes[key]
	existingState, hasExistingState := r.states[key]
	r.mu.Unlock()
	if process == nil {
		if !hasExistingState || existingState.Status == workspacebiz.AppRuntimeStatusIdle {
			return workspacebiz.AppRuntimeState{
				Status: workspacebiz.AppRuntimeStatusIdle,
			}, nil
		}
		return r.setState(key, workspacebiz.AppRuntimeState{
			Status: workspacebiz.AppRuntimeStatusIdle,
		}), nil
	}

	return r.stopProcess(ctx, key, process)
}

func (r *AppRunner) StopWorkspace(ctx context.Context, workspaceID string) {
	r.ensure()

	r.mu.Lock()
	var keys []string
	for key := range r.processes {
		if appRuntimeWorkspaceIDFromKey(key) == workspaceID {
			keys = append(keys, key)
		}
	}
	for key := range r.starts {
		if appRuntimeWorkspaceIDFromKey(key) == workspaceID {
			keys = append(keys, key)
		}
	}
	for key := range r.states {
		if appRuntimeWorkspaceIDFromKey(key) == workspaceID {
			keys = append(keys, key)
		}
	}
	r.mu.Unlock()

	for _, key := range uniqueRuntimeKeys(keys) {
		appID := appRuntimeAppIDFromKey(key)
		_, _ = r.Stop(ctx, workspaceID, appID)
	}
}

func (r *AppRunner) StopApp(ctx context.Context, appID string) {
	r.ensure()

	appID = strings.TrimSpace(appID)
	if appID == "" {
		return
	}

	r.mu.Lock()
	var keys []string
	for key := range r.processes {
		if appRuntimeAppIDFromKey(key) == appID {
			keys = append(keys, key)
		}
	}
	for key := range r.starts {
		if appRuntimeAppIDFromKey(key) == appID {
			keys = append(keys, key)
		}
	}
	for key := range r.states {
		if appRuntimeAppIDFromKey(key) == appID {
			keys = append(keys, key)
		}
	}
	r.mu.Unlock()

	for _, key := range uniqueRuntimeKeys(keys) {
		_, _ = r.Stop(ctx, appRuntimeWorkspaceIDFromKey(key), appID)
	}
}

func (r *AppRunner) StopAll(ctx context.Context) {
	r.ensure()

	r.mu.Lock()
	keys := make([]string, 0, len(r.processes))
	for key := range r.processes {
		keys = append(keys, key)
	}
	for key := range r.starts {
		keys = append(keys, key)
	}
	for key := range r.states {
		keys = append(keys, key)
	}
	r.mu.Unlock()

	for _, key := range uniqueRuntimeKeys(keys) {
		_, _ = r.Stop(ctx, appRuntimeWorkspaceIDFromKey(key), appRuntimeAppIDFromKey(key))
	}
}

func (r *AppRunner) stopProcess(ctx context.Context, key string, process *appProcess) (workspacebiz.AppRuntimeState, error) {
	r.mu.Lock()
	currentProcess := r.processes[key]
	current := r.states[key]
	if currentProcess != nil && currentProcess != process {
		r.mu.Unlock()
		return currentRuntimeStateOrIdle(current), nil
	}
	if currentProcess == nil {
		r.mu.Unlock()
		return currentRuntimeStateOrIdle(current), nil
	}
	if process.stopRequested {
		r.mu.Unlock()
		return currentRuntimeStateOrIdle(current), nil
	}
	process.stopRequested = true
	stoppingState := withRuntimeUpdated(workspacebiz.AppRuntimeState{
		Status:          workspacebiz.AppRuntimeStatusStopping,
		LaunchURL:       current.LaunchURL,
		Port:            current.Port,
		FailureReason:   current.FailureReason,
		LastError:       current.LastError,
		StartedAtUnixMs: current.StartedAtUnixMs,
		PackageDir:      current.PackageDir,
	})
	r.states[key] = stoppingState
	r.mu.Unlock()
	r.notifyStateChanged(key, stoppingState)

	if err := interruptAppProcess(process.command); err != nil {
		_ = killAppProcess(process.command)
	}

	select {
	case <-process.done:
	case <-ctx.Done():
		_ = killAppProcess(process.command)
		select {
		case <-process.done:
		case <-time.After(500 * time.Millisecond):
		}
		return r.setStoppedProcessFailed(key, process, "stop", ctx.Err()), ctx.Err()
	case <-time.After(2 * time.Second):
		_ = killAppProcess(process.command)
		select {
		case <-process.done:
			return r.setStoppedProcessIdle(key, process), nil
		case <-time.After(500 * time.Millisecond):
		}
		return r.setStoppedProcessFailed(key, process, "stop", errors.New("timed out stopping app process")), nil
	}

	return r.setStoppedProcessIdle(key, process), nil
}

func (r *AppRunner) setStoppedProcessIdle(key string, process *appProcess) workspacebiz.AppRuntimeState {
	return r.setStoppedProcessTerminalState(key, process, workspacebiz.AppRuntimeState{
		Status: workspacebiz.AppRuntimeStatusIdle,
	})
}

func (r *AppRunner) setStoppedProcessFailed(key string, process *appProcess, failureReason string, err error) workspacebiz.AppRuntimeState {
	message := err.Error()
	return r.setStoppedProcessTerminalState(key, process, workspacebiz.AppRuntimeState{
		Status:        workspacebiz.AppRuntimeStatusFailed,
		FailureReason: &failureReason,
		LastError:     &message,
	})
}

func (r *AppRunner) setStoppedProcessTerminalState(key string, process *appProcess, next workspacebiz.AppRuntimeState) workspacebiz.AppRuntimeState {
	r.mu.Lock()
	currentProcess := r.processes[key]
	current := r.states[key]
	if currentProcess != nil && currentProcess != process {
		r.mu.Unlock()
		return currentRuntimeStateOrIdle(current)
	}
	if currentProcess == nil && current.Status != workspacebiz.AppRuntimeStatusStopping {
		r.mu.Unlock()
		return currentRuntimeStateOrIdle(current)
	}
	state := withRuntimeUpdated(next)
	r.states[key] = state
	r.mu.Unlock()
	r.notifyStateChanged(key, state)
	return state
}

func currentRuntimeStateOrIdle(state workspacebiz.AppRuntimeState) workspacebiz.AppRuntimeState {
	if state.Status == "" {
		return workspacebiz.AppRuntimeState{Status: workspacebiz.AppRuntimeStatusIdle}
	}
	return state
}

func writeAppStartupDiagnostic(logFile *os.File, input AppStartInput, bootstrapPath string, port int, appRuntime ResolvedAppRuntime, env []string) {
	if logFile == nil {
		return
	}
	_, _ = fmt.Fprintf(logFile, "tutti workspace app startup\n")
	_, _ = fmt.Fprintf(logFile, "  appId=%s\n", input.AppID)
	_, _ = fmt.Fprintf(logFile, "  workspaceId=%s\n", input.WorkspaceID)
	_, _ = fmt.Fprintf(logFile, "  workspaceName=%s\n", input.WorkspaceName)
	_, _ = fmt.Fprintf(logFile, "  workspaceRoot=%s\n", input.WorkspaceRoot)
	_, _ = fmt.Fprintf(logFile, "  bootstrap=%s\n", bootstrapPath)
	_, _ = fmt.Fprintf(logFile, "  runtimeRoot=%s\n", appRuntime.Root)
	_, _ = fmt.Fprintf(logFile, "  python=%s\n", appRuntime.Python)
	_, _ = fmt.Fprintf(logFile, "  node=%s\n", appRuntime.Node)
	_, _ = fmt.Fprintf(logFile, "  npm=%s\n", appRuntime.NPM)
	_, _ = fmt.Fprintf(logFile, "  cwd=%s\n", input.RuntimeDir)
	_, _ = fmt.Fprintf(logFile, "  packageDir=%s\n", input.PackageDir)
	_, _ = fmt.Fprintf(logFile, "  dataDir=%s\n", input.DataDir)
	_, _ = fmt.Fprintf(logFile, "  logDir=%s\n", input.LogDir)
	_, _ = fmt.Fprintf(logFile, "  toolchainRoot=%s\n", appRuntimeEnvValue(env, "TUTTI_APP_TOOLCHAIN_ROOT"))
	_, _ = fmt.Fprintf(logFile, "  host=127.0.0.1\n")
	_, _ = fmt.Fprintf(logFile, "  port=%d\n", port)
	_, _ = fmt.Fprintf(logFile, "  path=%s\n", appRuntimeEnvValue(env, "PATH"))
}

func (r *AppRunner) waitForProcess(key string, process *appProcess) {
	err := process.command.Wait()
	_ = process.logFile.Close()

	r.mu.Lock()
	if current := r.processes[key]; current != process {
		r.mu.Unlock()
		process.done <- err
		return
	}
	delete(r.processes, key)
	var nextState workspacebiz.AppRuntimeState
	if process.stopRequested || err == nil {
		nextState = withRuntimeUpdated(workspacebiz.AppRuntimeState{Status: workspacebiz.AppRuntimeStatusIdle})
	} else {
		message := err.Error()
		nextState = withRuntimeUpdated(workspacebiz.AppRuntimeState{
			Status:        workspacebiz.AppRuntimeStatusFailed,
			FailureReason: stringPtr("process_exit"),
			LastError:     &message,
		})
	}
	if !process.stopRequested && err != nil {
		slog.Warn(
			"workspace_app_runtime_process_failed",
			"workspaceId", appRuntimeWorkspaceIDFromKey(key),
			"appId", appRuntimeAppIDFromKey(key),
			"failureReason", "process_exit",
			"lastError", err.Error(),
			"error", err,
		)
	}
	r.states[key] = nextState
	r.mu.Unlock()
	r.notifyStateChanged(key, nextState)
	process.done <- err
}

func logAppRuntimeControl(event string, input AppStartInput, port int, failureReason string, err error) {
	fields := []any{
		"workspaceId", input.WorkspaceID,
		"appId", input.AppID,
		"packageDir", input.PackageDir,
		"bootstrap", input.Bootstrap,
		"healthcheckPath", input.HealthcheckPath,
	}
	if strings.TrimSpace(input.RuntimeProfile) != "" {
		fields = append(fields, "runtimeProfile", strings.TrimSpace(input.RuntimeProfile))
	}
	if port != 0 {
		fields = append(fields, "port", port)
	}
	if failureReason != "" {
		fields = append(fields, "failureReason", failureReason)
	}
	if err != nil {
		fields = append(fields, "lastError", err.Error(), "error", err)
		slog.Warn(event, fields...)
		return
	}
	slog.Info(event, fields...)
}

func (r *AppRunner) finishStart(key string, ctx context.Context, start *appStart) {
	r.mu.Lock()
	defer r.mu.Unlock()
	currentStart := r.starts[key]
	if currentStart == nil || currentStart != start {
		return
	}
	delete(r.starts, key)
	var nextState *workspacebiz.AppRuntimeState
	if ctx.Err() != nil && r.processes[key] == nil {
		current := r.states[key]
		if current.Status == workspacebiz.AppRuntimeStatusPreparing || current.Status == workspacebiz.AppRuntimeStatusStarting {
			state := withRuntimeUpdated(workspacebiz.AppRuntimeState{
				Status: workspacebiz.AppRuntimeStatusIdle,
			})
			r.states[key] = state
			nextState = &state
		}
	}
	if nextState != nil {
		go r.notifyStateChanged(key, *nextState)
	}
}

func (r *AppRunner) waitForHealth(ctx context.Context, launchURL string, healthcheckPath string) error {
	timeout := r.HealthcheckTimeout
	if timeout <= 0 {
		timeout = defaultAppHealthcheckTimeout
	}
	deadline := time.Now().Add(timeout)
	healthcheckPath = path.Clean("/" + strings.TrimPrefix(healthcheckPath, "/"))

	for {
		if time.Now().After(deadline) {
			return errors.New("app healthcheck timed out")
		}
		if err := ctx.Err(); err != nil {
			return err
		}

		request, err := http.NewRequestWithContext(ctx, http.MethodGet, launchURL+healthcheckPath, nil)
		if err != nil {
			return fmt.Errorf("create app healthcheck request: %w", err)
		}
		response, err := r.httpClient().Do(request)
		if err == nil {
			_ = response.Body.Close()
			if response.StatusCode >= 200 && response.StatusCode < 300 {
				return nil
			}
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func (r *AppRunner) httpClient() *http.Client {
	if r.HTTPClient != nil {
		return r.HTTPClient
	}
	return httpx.NewClient(1 * time.Second)
}

func (r *AppRunner) runtimeResolver() AppRuntimeResolver {
	if r.RuntimeResolver != nil {
		return r.RuntimeResolver
	}
	return DefaultManagedAppRuntimeResolver{}
}

func (r *AppRunner) resolveRuntime(ctx context.Context, profile string) (ResolvedAppRuntime, error) {
	profile = strings.TrimSpace(profile)
	if appRuntimeProfileIsStandalone(profile) {
		return ResolvedAppRuntime{}, nil
	}
	resolver := r.runtimeResolver()
	if profile != "" {
		if profileResolver, ok := resolver.(AppRuntimeProfileResolver); ok {
			return profileResolver.ResolveProfile(ctx, profile)
		}
	}
	return resolver.Resolve(ctx)
}

func (r *AppRunner) setFailed(key string, reason string, err error) workspacebiz.AppRuntimeState {
	message := ""
	if err != nil {
		message = err.Error()
	}
	return r.setState(key, workspacebiz.AppRuntimeState{
		Status:        workspacebiz.AppRuntimeStatusFailed,
		FailureReason: &reason,
		LastError:     &message,
	})
}

func (r *AppRunner) setState(key string, state workspacebiz.AppRuntimeState) workspacebiz.AppRuntimeState {
	r.ensure()
	r.mu.Lock()
	updated := withRuntimeUpdated(state)
	r.states[key] = updated
	r.mu.Unlock()
	r.notifyStateChanged(key, updated)
	return updated
}

func (r *AppRunner) notifyStateChanged(key string, state workspacebiz.AppRuntimeState) {
	if r.OnStateChanged == nil {
		return
	}
	r.OnStateChanged(appRuntimeWorkspaceIDFromKey(key), appRuntimeAppIDFromKey(key), state)
}

func (r *AppRunner) ensure() {
	if r.processes == nil {
		r.processes = make(map[string]*appProcess)
	}
	if r.states == nil {
		r.states = make(map[string]workspacebiz.AppRuntimeState)
	}
	if r.starts == nil {
		r.starts = make(map[string]*appStart)
	}
	if r.queue == nil {
		r.queue = make(chan struct{}, 2)
	}
}

func uniqueRuntimeKeys(keys []string) []string {
	if len(keys) < 2 {
		return keys
	}
	seen := make(map[string]struct{}, len(keys))
	result := keys[:0]
	for _, key := range keys {
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, key)
	}
	return result
}

func allocateLoopbackPort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer listener.Close()

	tcpAddr, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		return 0, fmt.Errorf("unexpected listener address %q", listener.Addr().String())
	}
	return tcpAddr.Port, nil
}

func tuttiCLIShimPath() string {
	return tuttiCLIShimPathForPlatform(runtime.GOOS)
}

func tuttiAppToolchainRoot() string {
	return filepath.Join(tuttitypes.DefaultStateDir(), "app-toolchains")
}

func appRuntimePathWithCLIShim(appRuntime ResolvedAppRuntime, cliShimPath string) string {
	pathKey := pathEnvKey(appRuntime.EnvOverrides)
	pathValue := envValue(appRuntime.EnvOverrides, pathKey)
	if strings.TrimSpace(pathValue) == "" {
		pathValue = os.Getenv(pathKey)
	}
	pathDirs := filepath.SplitList(pathValue)
	pathDirs = mergeAppPathDirs(append([]string{filepath.Dir(cliShimPath)}, pathDirs...))
	return pathKey + "=" + strings.Join(pathDirs, string(os.PathListSeparator))
}

func tuttiCLIShimPathForPlatform(platform string) string {
	commandName := "tutti"
	if tuttitypes.IsDevelopmentEnv() {
		commandName = "tutti-dev"
	}
	if platform == "windows" {
		commandName += ".cmd"
	}
	return filepath.Join(tuttitypes.DefaultStateDir(), "bin", commandName)
}

func withRuntimeUpdated(state workspacebiz.AppRuntimeState) workspacebiz.AppRuntimeState {
	now := unixMsNow()
	state.UpdatedAtUnixMs = &now
	return state
}

func unixMsNow() int64 {
	return time.Now().UTC().UnixNano() / int64(time.Millisecond)
}

func stringPtr(value string) *string {
	return &value
}

func appRuntimeKey(workspaceID string, appID string) string {
	return workspaceID + "\x00" + appID
}

func appRuntimeWorkspaceIDFromKey(key string) string {
	for index, value := range key {
		if value == 0 {
			return key[:index]
		}
	}
	return key
}

func appRuntimeAppIDFromKey(key string) string {
	for index, value := range key {
		if value == 0 {
			return key[index+1:]
		}
	}
	return ""
}
