package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func TestAppRunnerStartsHealthyAppWithWorkspaceScopedCwdAndInjectedDirs(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bootstrap.sh runner test is POSIX-only")
	}
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 is required for runner happy path test")
	}

	root := t.TempDir()
	stateRoot := filepath.Join(root, "state")
	packageDir := filepath.Join(root, "package")
	runtimeDir := filepath.Join(root, "runtime")
	dataDir := filepath.Join(root, "data")
	databaseDir := filepath.Join(root, "database")
	logDir := filepath.Join(root, "logs")
	if err := os.MkdirAll(packageDir, 0o755); err != nil {
		t.Fatalf("MkdirAll(packageDir) error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(packageDir, "bootstrap.sh"), []byte(`#!/bin/sh
set -eu
echo runner-started
exec "$TUTTI_APP_PYTHON" "$TUTTI_APP_PACKAGE_DIR/server.py"
`), 0o755); err != nil {
		t.Fatalf("WriteFile(bootstrap.sh) error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(packageDir, "server.py"), []byte(pythonAppReadyServerScript("/ready", true)), 0o644); err != nil {
		t.Fatalf("WriteFile(server.py) error = %v", err)
	}

	t.Setenv(tuttiAppRuntimeRootEnv, createManagedAppRuntimeFixture(t, root))
	t.Setenv("TUTTI_ENV", "production")
	t.Setenv("TUTTI_STATE_DIR", stateRoot)
	t.Setenv("TUTTI_WORKSPACE_ROOT", "/inherited/workspace")
	t.Setenv(removedWorkspaceRootCompatibilityEnvKey, "/inherited/workspace")
	runner := &AppRunner{HealthcheckTimeout: 10 * time.Second}
	state, err := runner.Start(context.Background(), AppStartInput{
		WorkspaceID:     "ws-runner",
		WorkspaceName:   "Runner Workspace",
		AppID:           "hello",
		PackageDir:      packageDir,
		Bootstrap:       "bootstrap.sh",
		HealthcheckPath: "/ready",
		RuntimeDir:      runtimeDir,
		DataDir:         dataDir,
		DatabaseDir:     databaseDir,
		LogDir:          logDir,
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	t.Cleanup(func() {
		_, _ = runner.Stop(context.Background(), "ws-runner", "hello")
	})
	if state.Status != workspacebiz.AppRuntimeStatusPreparing {
		t.Fatalf("Start() status = %q, want preparing, lastError=%v", state.Status, state.LastError)
	}
	state = waitForRunnerStatus(t, runner, "ws-runner", "hello", workspacebiz.AppRuntimeStatusRunning)
	if state.LaunchURL == nil || !strings.HasPrefix(*state.LaunchURL, "http://127.0.0.1:") {
		t.Fatalf("LaunchURL = %v", state.LaunchURL)
	}
	if state.Port == nil || *state.Port <= 0 {
		t.Fatalf("Port = %v", state.Port)
	}
	if info, err := os.Stat(databaseDir); err != nil || !info.IsDir() {
		t.Fatalf("database directory stat = (%v, %v), want directory", info, err)
	}

	probePath := filepath.Join(dataDir, "probe.json")
	probe, err := os.ReadFile(probePath)
	if err != nil {
		t.Fatalf("ReadFile(%s) error = %v", probePath, err)
	}
	var probeValues map[string]string
	if err := json.Unmarshal(probe, &probeValues); err != nil {
		t.Fatalf("Unmarshal(probe) error = %v", err)
	}
	if samePath(t, probeValues["cwd"], runtimeDir) == false {
		t.Fatalf("probe cwd = %q, want %q", probeValues["cwd"], runtimeDir)
	}
	for key, want := range map[string]string{
		"packageDir":    packageDir,
		"runtimeDir":    runtimeDir,
		"dataDir":       dataDir,
		"databaseDir":   databaseDir,
		"logDir":        logDir,
		"toolchainRoot": filepath.Join(stateRoot, "app-toolchains"),
	} {
		if probeValues[key] != want {
			t.Fatalf("probe[%s] = %q, want %q", key, probeValues[key], want)
		}
	}
	for _, key := range []string{"tuttiWorkspaceRoot", "legacyWorkspaceRoot"} {
		if probeValues[key] != "" {
			t.Fatalf("probe[%s] = %q, want absent root contract", key, probeValues[key])
		}
	}
	for key, want := range map[string]string{
		"appId":         "hello",
		"workspaceId":   "ws-runner",
		"workspaceName": "Runner Workspace",
		"appHost":       "127.0.0.1",
		"appBaseUrl":    *state.LaunchURL,
	} {
		if probeValues[key] != want {
			t.Fatalf("probe[%s] = %q, want %q", key, probeValues[key], want)
		}
	}
	wantCLIPath := filepath.Join(stateRoot, "bin", "tutti")
	if probeValues["tuttiCli"] != wantCLIPath {
		t.Fatalf("probe[tuttiCli] = %q, want %q", probeValues["tuttiCli"], wantCLIPath)
	}
	pathDirs := filepath.SplitList(probeValues["path"])
	if len(pathDirs) == 0 || pathDirs[0] != filepath.Dir(wantCLIPath) {
		t.Fatalf("probe[path] = %q, want tutti CLI shim dir first", probeValues["path"])
	}

	logData, err := os.ReadFile(filepath.Join(logDir, "runtime.log"))
	if err != nil {
		t.Fatalf("ReadFile(runtime.log) error = %v", err)
	}
	if !strings.Contains(string(logData), "runner-started") {
		t.Fatalf("runtime.log = %q, want runner output", string(logData))
	}
	if !strings.Contains(string(logData), "tutti workspace app startup") || strings.Contains(string(logData), "workspaceRoot=") {
		t.Fatalf("runtime.log = %q, want startup diagnostic", string(logData))
	}
	if !strings.Contains(string(logData), "python=") || !strings.Contains(string(logData), "node=") {
		t.Fatalf("runtime.log = %q, want managed runtime diagnostic", string(logData))
	}

	stopped, err := runner.Stop(context.Background(), "ws-runner", "hello")
	if err != nil {
		t.Fatalf("Stop() error = %v", err)
	}
	if stopped.Status != workspacebiz.AppRuntimeStatusIdle {
		t.Fatalf("Stop() status = %q, want idle", stopped.Status)
	}
}

func TestAppRunnerStartsStandaloneAppWithoutResolvingManagedRuntime(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bootstrap.sh runner test is POSIX-only")
	}
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 is required for runner standalone test")
	}

	root := t.TempDir()
	packageDir := filepath.Join(root, "package")
	runtimeDir := filepath.Join(root, "runtime")
	dataDir := filepath.Join(root, "data")
	logDir := filepath.Join(root, "logs")
	if err := os.MkdirAll(packageDir, 0o755); err != nil {
		t.Fatalf("MkdirAll(packageDir) error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(packageDir, "bootstrap.sh"), []byte(`#!/bin/sh
set -eu
exec python3 "$TUTTI_APP_PACKAGE_DIR/server.py"
`), 0o755); err != nil {
		t.Fatalf("WriteFile(bootstrap.sh) error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(packageDir, "server.py"), []byte(pythonAppReadyServerScript("/healthz", false)), 0o644); err != nil {
		t.Fatalf("WriteFile(server.py) error = %v", err)
	}

	resolver := &appRuntimeResolverStub{called: make(chan struct{})}
	runner := &AppRunner{
		HealthcheckTimeout: 10 * time.Second,
		RuntimeResolver:    resolver,
	}
	state, err := runner.Start(context.Background(), AppStartInput{
		WorkspaceID:     "ws-runner",
		WorkspaceName:   "Runner Workspace",
		AppID:           "standalone",
		PackageDir:      packageDir,
		Bootstrap:       "bootstrap.sh",
		HealthcheckPath: "/healthz",
		RuntimeProfile:  workspaceAppStandaloneRuntimeProfile,
		RuntimeDir:      runtimeDir,
		DataDir:         dataDir,
		DatabaseDir:     filepath.Join(root, "database"),
		LogDir:          logDir,
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	t.Cleanup(func() {
		_, _ = runner.Stop(context.Background(), "ws-runner", "standalone")
	})
	if state.Status != workspacebiz.AppRuntimeStatusPreparing {
		t.Fatalf("Start() status = %q, want preparing, lastError=%v", state.Status, state.LastError)
	}
	state = waitForRunnerStatus(t, runner, "ws-runner", "standalone", workspacebiz.AppRuntimeStatusRunning)
	if state.LaunchURL == nil || !strings.HasPrefix(*state.LaunchURL, "http://127.0.0.1:") {
		t.Fatalf("LaunchURL = %v", state.LaunchURL)
	}

	select {
	case <-resolver.called:
		t.Fatal("standalone app resolved managed runtime")
	default:
	}
}

func TestAppRunnerRestartStartsFreshProcessAndWritesStartupDiagnostic(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bootstrap.sh runner test is POSIX-only")
	}
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 is required for runner restart test")
	}

	root := t.TempDir()
	packageDir := filepath.Join(root, "package")
	runtimeDir := filepath.Join(root, "runtime")
	dataDir := filepath.Join(root, "data")
	logDir := filepath.Join(root, "logs")
	if err := os.MkdirAll(packageDir, 0o755); err != nil {
		t.Fatalf("MkdirAll(packageDir) error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(packageDir, "bootstrap.sh"), []byte(`#!/bin/sh
set -eu
echo runner-started
exec "$TUTTI_APP_PYTHON" "$TUTTI_APP_PACKAGE_DIR/server.py"
`), 0o755); err != nil {
		t.Fatalf("WriteFile(bootstrap.sh) error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(packageDir, "server.py"), []byte(pythonAppReadyServerScript("/ready", false)), 0o644); err != nil {
		t.Fatalf("WriteFile(server.py) error = %v", err)
	}

	t.Setenv(tuttiAppRuntimeRootEnv, createManagedAppRuntimeFixture(t, root))
	runner := &AppRunner{HealthcheckTimeout: 10 * time.Second}
	input := AppStartInput{
		WorkspaceID:     "ws-runner",
		WorkspaceName:   "Runner Workspace",
		AppID:           "hello",
		PackageDir:      packageDir,
		Bootstrap:       "bootstrap.sh",
		HealthcheckPath: "/ready",
		RuntimeDir:      runtimeDir,
		DataDir:         dataDir,
		DatabaseDir:     filepath.Join(root, "database"),
		LogDir:          logDir,
	}
	if _, err := runner.Start(context.Background(), input); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	t.Cleanup(func() {
		_, _ = runner.Stop(context.Background(), "ws-runner", "hello")
	})
	first := waitForRunnerStatus(t, runner, "ws-runner", "hello", workspacebiz.AppRuntimeStatusRunning)
	if first.Port == nil {
		t.Fatalf("first Port = nil")
	}

	state, err := runner.Start(context.Background(), input)
	if err != nil {
		t.Fatalf("Start(no restart) error = %v", err)
	}
	if state.Status != workspacebiz.AppRuntimeStatusRunning {
		t.Fatalf("Start(no restart) status = %q, want running", state.Status)
	}
	if state.Port == nil || *state.Port != *first.Port {
		t.Fatalf("Start(no restart) port = %v, want %d", state.Port, *first.Port)
	}

	input.Restart = true
	state, err = runner.Start(context.Background(), input)
	if err != nil {
		t.Fatalf("Start(Restart) error = %v", err)
	}
	if state.Status != workspacebiz.AppRuntimeStatusPreparing {
		t.Fatalf("Start(Restart) status = %q, want preparing", state.Status)
	}
	second := waitForRunnerStatus(t, runner, "ws-runner", "hello", workspacebiz.AppRuntimeStatusRunning)
	if second.Port == nil {
		t.Fatalf("second Port = nil")
	}

	logData, err := os.ReadFile(filepath.Join(logDir, "runtime.log"))
	if err != nil {
		t.Fatalf("ReadFile(runtime.log) error = %v", err)
	}
	if got := strings.Count(string(logData), "tutti workspace app startup"); got != 2 {
		t.Fatalf("startup diagnostics = %d, want 2; runtime.log=%q", got, string(logData))
	}
}

func TestAppRunnerStopProcessDoesNotOverwriteReplacementRuntime(t *testing.T) {
	runner := &AppRunner{}
	runner.ensure()
	key := appRuntimeKey("ws-runner", "hello")
	oldURL := "http://127.0.0.1:41001"
	newURL := "http://127.0.0.1:41002"
	oldPort := 41001
	newPort := 41002
	oldProcess := &appProcess{done: make(chan error, 1)}
	newProcess := &appProcess{done: make(chan error, 1)}

	runner.mu.Lock()
	runner.processes[key] = oldProcess
	runner.states[key] = workspacebiz.AppRuntimeState{
		Status:    workspacebiz.AppRuntimeStatusRunning,
		LaunchURL: &oldURL,
		Port:      &oldPort,
	}
	runner.mu.Unlock()

	type stopResult struct {
		state workspacebiz.AppRuntimeState
		err   error
	}
	stopped := make(chan stopResult, 1)
	go func() {
		state, err := runner.stopProcess(context.Background(), key, oldProcess)
		stopped <- stopResult{state: state, err: err}
	}()

	waitForRunnerStatus(t, runner, "ws-runner", "hello", workspacebiz.AppRuntimeStatusStopping)

	runner.mu.Lock()
	runner.processes[key] = newProcess
	runner.states[key] = workspacebiz.AppRuntimeState{
		Status:    workspacebiz.AppRuntimeStatusRunning,
		LaunchURL: &newURL,
		Port:      &newPort,
	}
	runner.mu.Unlock()

	oldProcess.done <- nil

	select {
	case result := <-stopped:
		if result.err != nil {
			t.Fatalf("stopProcess() error = %v", result.err)
		}
		if result.state.Status != workspacebiz.AppRuntimeStatusRunning {
			t.Fatalf("stopProcess() status = %q, want running", result.state.Status)
		}
		if result.state.LaunchURL == nil || *result.state.LaunchURL != newURL {
			t.Fatalf("stopProcess() launchURL = %v, want %q", result.state.LaunchURL, newURL)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for stopProcess")
	}

	state := runner.State("ws-runner", "hello")
	if state.Status != workspacebiz.AppRuntimeStatusRunning {
		t.Fatalf("runner state = %q, want running", state.Status)
	}
	if state.LaunchURL == nil || *state.LaunchURL != newURL {
		t.Fatalf("runner launchURL = %v, want %q", state.LaunchURL, newURL)
	}
}

func TestAppRunnerStopProcessWaitsForProcessDoneWhenContextIsCanceled(t *testing.T) {
	runner := &AppRunner{}
	runner.ensure()
	key := appRuntimeKey("ws-runner", "hello")
	process := &appProcess{done: make(chan error)}
	runner.mu.Lock()
	runner.processes[key] = process
	runner.states[key] = workspacebiz.AppRuntimeState{
		Status: workspacebiz.AppRuntimeStatusRunning,
	}
	runner.mu.Unlock()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	type stopResult struct {
		state workspacebiz.AppRuntimeState
		err   error
	}
	stopped := make(chan stopResult, 1)
	go func() {
		state, err := runner.stopProcess(ctx, key, process)
		stopped <- stopResult{state: state, err: err}
	}()

	select {
	case result := <-stopped:
		t.Fatalf("stopProcess() returned before process done: %#v", result)
	case <-time.After(50 * time.Millisecond):
	}
	process.done <- nil
	select {
	case result := <-stopped:
		if !errors.Is(result.err, context.Canceled) {
			t.Fatalf("stopProcess() error = %v, want context.Canceled", result.err)
		}
		if result.state.Status != workspacebiz.AppRuntimeStatusFailed {
			t.Fatalf("stopProcess() status = %q, want failed", result.state.Status)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for stopProcess")
	}
}

func TestAppRunnerStopAllClearsStateOnlyRuntime(t *testing.T) {
	runner := &AppRunner{}
	runner.setState(appRuntimeKey("ws-runner", "orphaned"), workspacebiz.AppRuntimeState{
		Status:    workspacebiz.AppRuntimeStatusRunning,
		LaunchURL: stringPtr("http://127.0.0.1:43210"),
		Port:      intPtr(43210),
	})

	runner.StopAll(context.Background())

	assertRunnerStatus(t, runner, "ws-runner", "orphaned", workspacebiz.AppRuntimeStatusIdle)
}

func TestAppRunnerStopWorkspaceClearsMatchingStateOnlyRuntime(t *testing.T) {
	runner := &AppRunner{}
	runner.setState(appRuntimeKey("ws-runner", "orphaned"), workspacebiz.AppRuntimeState{
		Status:    workspacebiz.AppRuntimeStatusRunning,
		LaunchURL: stringPtr("http://127.0.0.1:43210"),
		Port:      intPtr(43210),
	})
	runner.setState(appRuntimeKey("ws-other", "orphaned"), workspacebiz.AppRuntimeState{
		Status:    workspacebiz.AppRuntimeStatusRunning,
		LaunchURL: stringPtr("http://127.0.0.1:43211"),
		Port:      intPtr(43211),
	})

	runner.StopWorkspace(context.Background(), "ws-runner")

	assertRunnerStatus(t, runner, "ws-runner", "orphaned", workspacebiz.AppRuntimeStatusIdle)
	assertRunnerStatus(t, runner, "ws-other", "orphaned", workspacebiz.AppRuntimeStatusRunning)
}

func TestAppRunnerStopAppClearsMatchingStateOnlyRuntime(t *testing.T) {
	runner := &AppRunner{}
	runner.setState(appRuntimeKey("ws-runner", "orphaned"), workspacebiz.AppRuntimeState{
		Status:    workspacebiz.AppRuntimeStatusRunning,
		LaunchURL: stringPtr("http://127.0.0.1:43210"),
		Port:      intPtr(43210),
	})
	runner.setState(appRuntimeKey("ws-runner", "other"), workspacebiz.AppRuntimeState{
		Status:    workspacebiz.AppRuntimeStatusRunning,
		LaunchURL: stringPtr("http://127.0.0.1:43211"),
		Port:      intPtr(43211),
	})

	runner.StopApp(context.Background(), "orphaned")

	assertRunnerStatus(t, runner, "ws-runner", "orphaned", workspacebiz.AppRuntimeStatusIdle)
	assertRunnerStatus(t, runner, "ws-runner", "other", workspacebiz.AppRuntimeStatusRunning)
}

func TestAppRunnerStartWithoutRestartReusesQueuedStart(t *testing.T) {
	root := t.TempDir()
	packageDir := filepath.Join(root, "package")
	if err := os.MkdirAll(packageDir, 0o755); err != nil {
		t.Fatalf("MkdirAll(packageDir) error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(packageDir, "bootstrap.sh"), []byte("#!/bin/sh\nsleep 30\n"), 0o755); err != nil {
		t.Fatalf("WriteFile(bootstrap.sh) error = %v", err)
	}

	var eventsMu sync.Mutex
	var events []workspacebiz.AppRuntimeState
	runner := &AppRunner{
		RuntimeResolver: &appRuntimeResolverStub{called: make(chan struct{}), err: errors.New("skip runtime")},
		OnStateChanged: func(_ string, _ string, state workspacebiz.AppRuntimeState) {
			eventsMu.Lock()
			events = append(events, state)
			eventsMu.Unlock()
		},
		queue: make(chan struct{}, 1),
	}
	runner.queue <- struct{}{}
	input := AppStartInput{
		WorkspaceID:     "ws-runner",
		AppID:           "queued",
		PackageDir:      packageDir,
		Bootstrap:       "bootstrap.sh",
		HealthcheckPath: "/ready",
		RuntimeDir:      filepath.Join(root, "runtime"),
		DataDir:         filepath.Join(root, "data"),
		DatabaseDir:     filepath.Join(root, "database"),
		LogDir:          filepath.Join(root, "logs"),
	}
	state, err := runner.Start(context.Background(), input)
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if state.Status != workspacebiz.AppRuntimeStatusPreparing {
		t.Fatalf("Start() status = %q, want preparing", state.Status)
	}

	state, err = runner.Start(context.Background(), input)
	if err != nil {
		t.Fatalf("Start(no restart) error = %v", err)
	}
	if state.Status != workspacebiz.AppRuntimeStatusPreparing {
		t.Fatalf("Start(no restart) status = %q, want preparing", state.Status)
	}
	eventsMu.Lock()
	eventCount := len(events)
	eventsMu.Unlock()
	if eventCount != 1 {
		t.Fatalf("state change events = %d, want 1", eventCount)
	}

	<-runner.queue
	waitForRunnerStatus(t, runner, "ws-runner", "queued", workspacebiz.AppRuntimeStatusFailed)
}

func TestAppRunnerFinishStartIgnoresReplacedStart(t *testing.T) {
	runner := &AppRunner{}
	runner.ensure()
	key := appRuntimeKey("ws-runner", "queued")
	oldStart := &appStart{cancel: func() {}}
	newStart := &appStart{cancel: func() {}}
	cancelledCtx, cancel := context.WithCancel(context.Background())
	cancel()

	runner.mu.Lock()
	runner.starts[key] = newStart
	runner.states[key] = workspacebiz.AppRuntimeState{Status: workspacebiz.AppRuntimeStatusPreparing}
	runner.mu.Unlock()

	runner.finishStart(key, cancelledCtx, oldStart)

	runner.mu.Lock()
	defer runner.mu.Unlock()
	if runner.starts[key] != newStart {
		t.Fatalf("finishStart() replaced start = %v, want still active", runner.starts[key])
	}
	if state := runner.states[key]; state.Status != workspacebiz.AppRuntimeStatusPreparing {
		t.Fatalf("finishStart() status = %q, want preparing", state.Status)
	}
}

func TestAppRunnerStartWithoutRestartReusesStartingProcess(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bootstrap.sh runner test is POSIX-only")
	}

	root := t.TempDir()
	packageDir := filepath.Join(root, "package")
	if err := os.MkdirAll(packageDir, 0o755); err != nil {
		t.Fatalf("MkdirAll(packageDir) error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(packageDir, "bootstrap.sh"), []byte("#!/bin/sh\nsleep 30\n"), 0o755); err != nil {
		t.Fatalf("WriteFile(bootstrap.sh) error = %v", err)
	}

	t.Setenv(tuttiAppRuntimeRootEnv, createManagedAppRuntimeFixture(t, root))
	runner := &AppRunner{HealthcheckTimeout: 3 * time.Second}
	input := AppStartInput{
		WorkspaceID:     "ws-runner",
		AppID:           "starting",
		PackageDir:      packageDir,
		Bootstrap:       "bootstrap.sh",
		HealthcheckPath: "/ready",
		RuntimeDir:      filepath.Join(root, "runtime"),
		DataDir:         filepath.Join(root, "data"),
		DatabaseDir:     filepath.Join(root, "database"),
		LogDir:          filepath.Join(root, "logs"),
	}
	if _, err := runner.Start(context.Background(), input); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	t.Cleanup(func() {
		_, _ = runner.Stop(context.Background(), "ws-runner", "starting")
	})
	starting := waitForRunnerStatus(t, runner, "ws-runner", "starting", workspacebiz.AppRuntimeStatusStarting)
	if starting.Port == nil {
		t.Fatalf("starting Port = nil")
	}

	state, err := runner.Start(context.Background(), input)
	if err != nil {
		t.Fatalf("Start(no restart) error = %v", err)
	}
	if state.Status != workspacebiz.AppRuntimeStatusStarting {
		t.Fatalf("Start(no restart) status = %q, want starting", state.Status)
	}
	if state.Port == nil || *state.Port != *starting.Port {
		t.Fatalf("Start(no restart) port = %v, want %d", state.Port, *starting.Port)
	}
}

func TestAppRunnerStartsAppWithManagedNodeRuntimeEnv(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bootstrap.sh runner test is POSIX-only")
	}
	root := t.TempDir()
	packageDir := filepath.Join(root, "package")
	runtimeDir := filepath.Join(root, "runtime")
	dataDir := filepath.Join(root, "data")
	logDir := filepath.Join(root, "logs")
	for _, dir := range []string{packageDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("MkdirAll(%s) error = %v", dir, err)
		}
	}
	if err := os.WriteFile(filepath.Join(packageDir, "bootstrap.sh"), []byte(`#!/bin/sh
set -eu
exec "$TUTTI_APP_NODE" "$TUTTI_APP_PACKAGE_DIR/server.js"
`), 0o755); err != nil {
		t.Fatalf("WriteFile(bootstrap.sh) error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(packageDir, "server.py"), []byte(pythonAppReadyServerScript("/healthz", false)), 0o644); err != nil {
		t.Fatalf("WriteFile(server.py) error = %v", err)
	}

	runtimeRoot := createManagedAppRuntimeFixture(t, root)
	t.Setenv(tuttiAppRuntimeRootEnv, runtimeRoot)
	runner := &AppRunner{HealthcheckTimeout: 10 * time.Second}
	state, err := runner.Start(context.Background(), AppStartInput{
		WorkspaceID:     "ws-fnm",
		WorkspaceName:   "Fnm Workspace",
		AppID:           "fnm-node",
		PackageDir:      packageDir,
		Bootstrap:       "bootstrap.sh",
		HealthcheckPath: "/healthz",
		RuntimeDir:      runtimeDir,
		DataDir:         dataDir,
		DatabaseDir:     filepath.Join(root, "database"),
		LogDir:          logDir,
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	t.Cleanup(func() {
		_, _ = runner.Stop(context.Background(), "ws-fnm", "fnm-node")
	})
	if state.Status != workspacebiz.AppRuntimeStatusPreparing {
		t.Fatalf("Start() status = %q, want preparing, lastError=%v", state.Status, state.LastError)
	}
	waitForRunnerStatus(t, runner, "ws-fnm", "fnm-node", workspacebiz.AppRuntimeStatusRunning)
	logData, err := os.ReadFile(filepath.Join(logDir, "runtime.log"))
	if err != nil {
		t.Fatalf("ReadFile(runtime.log) error = %v", err)
	}
	if !strings.Contains(string(logData), filepath.Join(runtimeRoot, "node", "bin")) {
		t.Fatalf("runtime log PATH does not include managed node bin: %s", string(logData))
	}
}

func TestAppRunnerHealthcheckFailureIsBackgroundState(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bootstrap.sh runner test is POSIX-only")
	}

	root := t.TempDir()
	packageDir := filepath.Join(root, "package")
	if err := os.MkdirAll(packageDir, 0o755); err != nil {
		t.Fatalf("MkdirAll(packageDir) error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(packageDir, "bootstrap.sh"), []byte(`#!/bin/sh
set -eu
sleep 30
`), 0o755); err != nil {
		t.Fatalf("WriteFile(bootstrap.sh) error = %v", err)
	}

	t.Setenv(tuttiAppRuntimeRootEnv, createManagedAppRuntimeFixture(t, root))
	runner := &AppRunner{HealthcheckTimeout: 100 * time.Millisecond}
	state, err := runner.Start(context.Background(), AppStartInput{
		WorkspaceID:     "ws-runner",
		AppID:           "slow",
		PackageDir:      packageDir,
		Bootstrap:       "bootstrap.sh",
		HealthcheckPath: "/ready",
		RuntimeDir:      filepath.Join(root, "runtime"),
		DataDir:         filepath.Join(root, "data"),
		DatabaseDir:     filepath.Join(root, "database"),
		LogDir:          filepath.Join(root, "logs"),
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	t.Cleanup(func() {
		_, _ = runner.Stop(context.Background(), "ws-runner", "slow")
	})
	if state.Status != workspacebiz.AppRuntimeStatusPreparing {
		t.Fatalf("Start() status = %q, want preparing", state.Status)
	}

	state = waitForRunnerStatus(t, runner, "ws-runner", "slow", workspacebiz.AppRuntimeStatusFailed)
	if state.FailureReason == nil || *state.FailureReason != "healthcheck" {
		t.Fatalf("FailureReason = %v, want healthcheck", state.FailureReason)
	}
}

func TestAppRunnerStopDuringHealthcheckLeavesAppIdle(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bootstrap.sh runner test is POSIX-only")
	}

	root := t.TempDir()
	packageDir := filepath.Join(root, "package")
	if err := os.MkdirAll(packageDir, 0o755); err != nil {
		t.Fatalf("MkdirAll(packageDir) error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(packageDir, "bootstrap.sh"), []byte(`#!/bin/sh
set -eu
sleep 30
`), 0o755); err != nil {
		t.Fatalf("WriteFile(bootstrap.sh) error = %v", err)
	}

	t.Setenv(tuttiAppRuntimeRootEnv, createManagedAppRuntimeFixture(t, root))
	healthcheckStarted := make(chan struct{})
	var healthcheckStartedOnce sync.Once
	var eventsMu sync.Mutex
	var events []workspacebiz.AppRuntimeState
	runner := &AppRunner{
		HealthcheckTimeout: 3 * time.Second,
		HTTPClient: &http.Client{Transport: roundTripperFunc(func(request *http.Request) (*http.Response, error) {
			healthcheckStartedOnce.Do(func() {
				close(healthcheckStarted)
			})
			<-request.Context().Done()
			return nil, request.Context().Err()
		})},
		OnStateChanged: func(_ string, _ string, state workspacebiz.AppRuntimeState) {
			eventsMu.Lock()
			events = append(events, state)
			eventsMu.Unlock()
		},
	}
	state, err := runner.Start(context.Background(), AppStartInput{
		WorkspaceID:     "ws-runner",
		AppID:           "slow",
		PackageDir:      packageDir,
		Bootstrap:       "bootstrap.sh",
		HealthcheckPath: "/ready",
		RuntimeDir:      filepath.Join(root, "runtime"),
		DataDir:         filepath.Join(root, "data"),
		DatabaseDir:     filepath.Join(root, "database"),
		LogDir:          filepath.Join(root, "logs"),
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	t.Cleanup(func() {
		_, _ = runner.Stop(context.Background(), "ws-runner", "slow")
	})
	if state.Status != workspacebiz.AppRuntimeStatusPreparing {
		t.Fatalf("Start() status = %q, want preparing", state.Status)
	}

	select {
	case <-healthcheckStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for healthcheck request")
	}
	stopped, err := runner.Stop(context.Background(), "ws-runner", "slow")
	if err != nil {
		t.Fatalf("Stop() error = %v", err)
	}
	if stopped.Status != workspacebiz.AppRuntimeStatusIdle {
		t.Fatalf("Stop() status = %q, want idle", stopped.Status)
	}

	state = waitForRunnerStatus(t, runner, "ws-runner", "slow", workspacebiz.AppRuntimeStatusIdle)
	if state.FailureReason != nil || state.LastError != nil {
		t.Fatalf("runner state after stop = %#v, want idle without failure", state)
	}

	eventsMu.Lock()
	defer eventsMu.Unlock()
	for _, event := range events {
		if event.Status != workspacebiz.AppRuntimeStatusFailed {
			continue
		}
		reason := ""
		if event.FailureReason != nil {
			reason = *event.FailureReason
		}
		lastError := ""
		if event.LastError != nil {
			lastError = *event.LastError
		}
		if reason == "healthcheck" && strings.Contains(lastError, context.Canceled.Error()) {
			t.Fatalf("recorded canceled healthcheck failure: %#v", event)
		}
	}
}

func TestTuttiCLIShimPathUsesProductionCommand(t *testing.T) {
	stateDir := t.TempDir()
	t.Setenv("TUTTI_STATE_DIR", stateDir)
	t.Setenv("TUTTI_ENV", "production")

	want := filepath.Join(stateDir, "bin", "tutti")
	if got := tuttiCLIShimPathForPlatform("darwin"); got != want {
		t.Fatalf("tuttiCLIShimPathForPlatform() = %q, want %q", got, want)
	}
}

func TestTuttiCLIShimPathUsesDevelopmentCommand(t *testing.T) {
	stateDir := t.TempDir()
	t.Setenv("TUTTI_STATE_DIR", stateDir)
	t.Setenv("TUTTI_ENV", "development")

	want := filepath.Join(stateDir, "bin", "tutti-dev")
	if got := tuttiCLIShimPathForPlatform("darwin"); got != want {
		t.Fatalf("tuttiCLIShimPathForPlatform() = %q, want %q", got, want)
	}
}

func TestTuttiCLIShimPathUsesWindowsCommandExtension(t *testing.T) {
	stateDir := t.TempDir()
	t.Setenv("TUTTI_STATE_DIR", stateDir)
	t.Setenv("TUTTI_ENV", "production")

	want := filepath.Join(stateDir, "bin", "tutti.cmd")
	if got := tuttiCLIShimPathForPlatform("windows"); got != want {
		t.Fatalf("tuttiCLIShimPathForPlatform() = %q, want %q", got, want)
	}
}

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (f roundTripperFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func samePath(t *testing.T, actual string, expected string) bool {
	t.Helper()

	actualResolved, err := filepath.EvalSymlinks(actual)
	if err != nil {
		actualResolved = actual
	}
	expectedResolved, err := filepath.EvalSymlinks(expected)
	if err != nil {
		expectedResolved = expected
	}
	return actualResolved == expectedResolved
}

func createManagedAppRuntimeFixture(t *testing.T, root string) string {
	t.Helper()

	pythonPath, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 is required for managed app runtime fixture")
	}

	runtimeRoot := filepath.Join(root, "managed-runtime")
	pythonBinDir := filepath.Join(runtimeRoot, "python", "bin")
	nodeBinDir := filepath.Join(runtimeRoot, "node", "bin")
	for _, dir := range []string{pythonBinDir, nodeBinDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("MkdirAll(%s) error = %v", dir, err)
		}
	}
	if err := os.WriteFile(filepath.Join(pythonBinDir, "python3"), []byte(`#!/bin/sh
exec "`+pythonPath+`" "$@"
`), 0o755); err != nil {
		t.Fatalf("WriteFile(managed python) error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(nodeBinDir, "node"), []byte(`#!/bin/sh
exec "`+pythonPath+`" "$TUTTI_APP_PACKAGE_DIR/server.py"
`), 0o755); err != nil {
		t.Fatalf("WriteFile(managed node) error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(nodeBinDir, "npm"), []byte(`#!/bin/sh
exit 0
`), 0o755); err != nil {
		t.Fatalf("WriteFile(managed npm) error = %v", err)
	}
	return runtimeRoot
}

func TestAppRunnerWaitForHealthVerifiesInstanceToken(t *testing.T) {
	const token = "instance-token-abc"

	newServer := func(status int, echo string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			if echo != "" {
				w.Header().Set(appInstanceHeader, echo)
			}
			w.WriteHeader(status)
		}))
	}

	t.Run("verified when app echoes the token", func(t *testing.T) {
		server := newServer(http.StatusOK, token)
		defer server.Close()
		runner := &AppRunner{HealthcheckTimeout: 2 * time.Second}
		verified, err := runner.waitForHealth(context.Background(), server.URL, "/healthz", token)
		if err != nil {
			t.Fatalf("waitForHealth error = %v", err)
		}
		if !verified {
			t.Fatal("verified = false, want true when the app echoes the token")
		}
	})

	t.Run("accepts legacy app without token but reports unverified", func(t *testing.T) {
		server := newServer(http.StatusNoContent, "")
		defer server.Close()
		runner := &AppRunner{HealthcheckTimeout: 2 * time.Second}
		verified, err := runner.waitForHealth(context.Background(), server.URL, "/healthz", token)
		if err != nil {
			t.Fatalf("waitForHealth error = %v", err)
		}
		if verified {
			t.Fatal("verified = true, want false for a legacy app that omits the token")
		}
	})

	t.Run("times out when responder returns a wrong token", func(t *testing.T) {
		server := newServer(http.StatusOK, "not-the-token")
		defer server.Close()
		runner := &AppRunner{HealthcheckTimeout: 300 * time.Millisecond}
		verified, err := runner.waitForHealth(context.Background(), server.URL, "/healthz", token)
		if err == nil {
			t.Fatal("waitForHealth error = nil, want a timeout for a mismatched token")
		}
		if verified {
			t.Fatal("verified = true, want false for a mismatched token")
		}
	})

	t.Run("strict mode rejects a legacy app without token", func(t *testing.T) {
		server := newServer(http.StatusOK, "")
		defer server.Close()
		runner := &AppRunner{HealthcheckTimeout: 300 * time.Millisecond, RequireInstanceIdentity: true}
		verified, err := runner.waitForHealth(context.Background(), server.URL, "/healthz", token)
		if err == nil {
			t.Fatal("waitForHealth error = nil, want a timeout in strict mode")
		}
		if verified {
			t.Fatal("verified = true, want false in strict mode")
		}
	})
}

func pythonAppReadyServerScript(healthcheckPath string, writeProbe bool) string {
	probeImport := ""
	probeWrite := ""
	if writeProbe {
		probeImport = "import json\n"
		probeWrite = `        with open(os.path.join(os.environ["TUTTI_APP_DATA_DIR"], "probe.json"), "w") as f:
            json.dump({
                "cwd": os.getcwd(),
                "appId": os.environ["TUTTI_APP_ID"],
                "workspaceId": os.environ["TUTTI_WORKSPACE_ID"],
                "workspaceName": os.environ["TUTTI_WORKSPACE_NAME"],
                "tuttiWorkspaceRoot": os.environ.get("TUTTI_WORKSPACE_ROOT", ""),
                "legacyWorkspaceRoot": os.environ.get("NEX" + "TOP_WORKSPACE_ROOT", ""),
                "appHost": os.environ["TUTTI_APP_HOST"],
                "appBaseUrl": os.environ["TUTTI_APP_BASE_URL"],
                "packageDir": os.environ["TUTTI_APP_PACKAGE_DIR"],
                "runtimeDir": os.environ["TUTTI_APP_RUNTIME_DIR"],
                "dataDir": os.environ["TUTTI_APP_DATA_DIR"],
                "databaseDir": os.environ["TUTTI_APP_DATABASE_DIR"],
                "logDir": os.environ["TUTTI_APP_LOG_DIR"],
                "toolchainRoot": os.environ["TUTTI_APP_TOOLCHAIN_ROOT"],
                "tuttiCli": os.environ["TUTTI_CLI"],
                "path": os.environ["PATH"],
            }, f)
`
	}

	script := `import os
__PROBE_IMPORT__import socket

HEALTHCHECK_PATH = "__HEALTHCHECK_PATH__"

server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("127.0.0.1", int(os.environ["TUTTI_APP_PORT"])))
server.listen(16)

while True:
    connection, _ = server.accept()
    with connection:
        request = b""
        while b"\r\n\r\n" not in request:
            chunk = connection.recv(4096)
            if not chunk:
                break
            request += chunk
        request_line = request.split(b"\r\n", 1)[0].decode("ascii", "ignore")
        parts = request_line.split(" ")
        path = parts[1] if len(parts) > 1 else "/"
        if path != HEALTHCHECK_PATH:
            connection.sendall(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            continue
__PROBE_WRITE__        connection.sendall(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
`
	script = strings.ReplaceAll(script, "__PROBE_IMPORT__", probeImport)
	script = strings.ReplaceAll(script, "__PROBE_WRITE__", probeWrite)
	script = strings.ReplaceAll(script, "__HEALTHCHECK_PATH__", healthcheckPath)
	return script
}

func waitForRunnerStatus(t *testing.T, runner *AppRunner, workspaceID string, appID string, want workspacebiz.AppRuntimeStatus) workspacebiz.AppRuntimeState {
	t.Helper()

	return waitForRunnerState(t, runner, workspaceID, appID, func(state workspacebiz.AppRuntimeState) bool {
		return state.Status == want
	})
}

func assertRunnerStatus(t *testing.T, runner *AppRunner, workspaceID string, appID string, want workspacebiz.AppRuntimeStatus) {
	t.Helper()

	state := runner.State(workspaceID, appID)
	if state.Status != want {
		t.Fatalf("State(%q, %q) status = %q, want %q", workspaceID, appID, state.Status, want)
	}
}

func waitForRunnerState(t *testing.T, runner *AppRunner, workspaceID string, appID string, matches func(workspacebiz.AppRuntimeState) bool) workspacebiz.AppRuntimeState {
	t.Helper()

	deadline := time.Now().Add(runnerStatusWaitTimeout(runner))
	var state workspacebiz.AppRuntimeState
	for time.Now().Before(deadline) {
		state = runner.State(workspaceID, appID)
		if matches(state) {
			return state
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("runner state did not match before timeout: status=%q failureReason=%q lastError=%q launchURL=%v port=%v", state.Status, stringValue(state.FailureReason), stringValue(state.LastError), state.LaunchURL, state.Port)
	return state
}

func runnerStatusWaitTimeout(runner *AppRunner) time.Duration {
	timeout := 5 * time.Second
	if runner != nil && runner.HealthcheckTimeout > timeout {
		timeout = runner.HealthcheckTimeout + 2*time.Second
	}
	return timeout
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
