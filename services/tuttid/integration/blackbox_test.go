package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
)

const (
	daemonStartTimeout = 15 * time.Second
	requestTimeout     = 5 * time.Second
	healthPollInterval = 25 * time.Millisecond
)

var (
	buildBinaryOnce sync.Once
	builtBinaryPath string
	buildBinaryErr  error
)

type testDaemon struct {
	accessToken string
	baseURL     string
	cmd         *exec.Cmd
	logPath     string
	stateDir    string
	stderr      bytes.Buffer
	stdout      bytes.Buffer
}

func TestTuttidBlackBoxHealthAndEmptyCatalog(t *testing.T) {
	daemon := startTestDaemon(t)

	health := mustRequestJSON[tuttigenerated.HealthStatusResponse](t, daemon, http.MethodGet, "/v1/health", nil, http.StatusOK)
	if health.Service != "tuttid" {
		t.Fatalf("health.service = %q, want %q", health.Service, "tuttid")
	}
	if health.Status != tuttigenerated.Ok {
		t.Fatalf("health.status = %q, want %q", health.Status, tuttigenerated.Ok)
	}

	workspaces := mustRequestJSON[tuttigenerated.ListWorkspacesResponse](t, daemon, http.MethodGet, "/v1/workspaces", nil, http.StatusOK)
	if workspaces.TotalCount != 0 {
		t.Fatalf("workspaces.totalCount = %d, want 0", workspaces.TotalCount)
	}
	if len(workspaces.Workspaces) != 0 {
		t.Fatalf("workspaces len = %d, want 0", len(workspaces.Workspaces))
	}

	startup := mustRequestJSON[tuttigenerated.StartupWorkspaceResponse](t, daemon, http.MethodGet, "/v1/workspaces/startup", nil, http.StatusOK)
	if startup.Workspace == nil {
		t.Fatal("startup.workspace = nil, want workspace")
	}
	if startup.Workspace.Name != "default" {
		t.Fatalf("startup.workspace.name = %q, want %q", startup.Workspace.Name, "default")
	}
	if startup.Workspace.LastOpenedAt == nil {
		t.Fatalf("startup.workspace.lastOpenedAt = %#v, want timestamp", startup.Workspace.LastOpenedAt)
	}

	workspacesAfterStartup := mustRequestJSON[tuttigenerated.ListWorkspacesResponse](t, daemon, http.MethodGet, "/v1/workspaces", nil, http.StatusOK)
	if workspacesAfterStartup.TotalCount != 1 {
		t.Fatalf("workspacesAfterStartup.totalCount = %d, want 1", workspacesAfterStartup.TotalCount)
	}

	dbPath := filepath.Join(daemon.stateDir, "tuttid.db")
	if _, err := os.Stat(dbPath); err != nil {
		t.Fatalf("expected database under temp state dir: %v", err)
	}

	if !strings.HasPrefix(dbPath, daemon.stateDir) {
		t.Fatalf("db path = %q, want under %q", dbPath, daemon.stateDir)
	}
}

func TestTuttidBlackBoxWorkspaceLifecycle(t *testing.T) {
	daemon := startTestDaemon(t)

	created := mustRequestJSON[tuttigenerated.WorkspaceResponse](t, daemon, http.MethodPost, "/v1/workspaces", tuttigenerated.CreateWorkspaceRequest{
		Name: "Workspace One",
	}, http.StatusCreated)

	if created.Workspace.Id == "" {
		t.Fatalf("created workspace id is empty")
	}
	if created.Workspace.Name != "Workspace One" {
		t.Fatalf("created workspace name = %q, want %q", created.Workspace.Name, "Workspace One")
	}
	if created.Workspace.LastOpenedAt != nil {
		t.Fatalf("created workspace lastOpenedAt = %#v, want nil", created.Workspace.LastOpenedAt)
	}

	listed := mustRequestJSON[tuttigenerated.ListWorkspacesResponse](t, daemon, http.MethodGet, "/v1/workspaces", nil, http.StatusOK)
	if listed.TotalCount != 1 {
		t.Fatalf("listed.totalCount = %d, want 1", listed.TotalCount)
	}
	if len(listed.Workspaces) != 1 {
		t.Fatalf("listed workspaces len = %d, want 1", len(listed.Workspaces))
	}
	if listed.Workspaces[0].Id != created.Workspace.Id {
		t.Fatalf("listed workspace id = %q, want %q", listed.Workspaces[0].Id, created.Workspace.Id)
	}

	updated := mustRequestJSON[tuttigenerated.WorkspaceResponse](t, daemon, http.MethodPatch, "/v1/workspaces/"+created.Workspace.Id, tuttigenerated.UpdateWorkspaceRequest{
		Name: "Workspace Renamed",
	}, http.StatusOK)
	if updated.Workspace.Name != "Workspace Renamed" {
		t.Fatalf("updated workspace name = %q, want %q", updated.Workspace.Name, "Workspace Renamed")
	}
	fetched := mustRequestJSON[tuttigenerated.WorkspaceResponse](t, daemon, http.MethodGet, "/v1/workspaces/"+created.Workspace.Id, nil, http.StatusOK)
	if fetched.Workspace.Id != created.Workspace.Id {
		t.Fatalf("fetched workspace id = %q, want %q", fetched.Workspace.Id, created.Workspace.Id)
	}
	if fetched.Workspace.Name != "Workspace Renamed" {
		t.Fatalf("fetched workspace name = %q, want %q", fetched.Workspace.Name, "Workspace Renamed")
	}

	startupBeforeOpen := mustRequestJSON[tuttigenerated.StartupWorkspaceResponse](t, daemon, http.MethodGet, "/v1/workspaces/startup", nil, http.StatusOK)
	if startupBeforeOpen.Workspace == nil {
		t.Fatalf("startup before open = nil, want workspace")
	}
	if startupBeforeOpen.Workspace.Id != created.Workspace.Id {
		t.Fatalf("startup before open id = %q, want %q", startupBeforeOpen.Workspace.Id, created.Workspace.Id)
	}
	if startupBeforeOpen.Workspace.LastOpenedAt == nil {
		t.Fatalf("startup before open lastOpenedAt = nil, want timestamp")
	}

	opened := mustRequestJSON[tuttigenerated.WorkspaceResponse](t, daemon, http.MethodPost, "/v1/workspaces/"+created.Workspace.Id+"/open", nil, http.StatusOK)
	if opened.Workspace.Id != created.Workspace.Id {
		t.Fatalf("opened workspace id = %q, want %q", opened.Workspace.Id, created.Workspace.Id)
	}
	if opened.Workspace.LastOpenedAt == nil {
		t.Fatalf("opened workspace lastOpenedAt = nil, want timestamp")
	}

	startupAfterOpen := mustRequestJSON[tuttigenerated.StartupWorkspaceResponse](t, daemon, http.MethodGet, "/v1/workspaces/startup", nil, http.StatusOK)
	if startupAfterOpen.Workspace == nil {
		t.Fatalf("startup after open = nil, want workspace")
	}
	if startupAfterOpen.Workspace.Id != created.Workspace.Id {
		t.Fatalf("startup workspace id = %q, want %q", startupAfterOpen.Workspace.Id, created.Workspace.Id)
	}
	if startupAfterOpen.Workspace.LastOpenedAt == nil {
		t.Fatalf("startup workspace lastOpenedAt = nil, want timestamp")
	}
}

func startTestDaemon(t *testing.T) *testDaemon {
	t.Helper()

	stateDir := t.TempDir()
	binaryPath := mustBuildDaemonBinary(t)
	accessToken := "test-access-token"
	logPath := filepath.Join(stateDir, "logs", "tuttid.log")

	cmd := exec.Command(binaryPath)
	cmd.Dir = serviceRoot(t)
	cmd.Env = append(os.Environ(),
		"TUTTI_ENV=development",
		"TUTTI_STATE_DIR="+stateDir,
		"TUTTID_ACCESS_TOKEN="+accessToken,
		"TUTTID_ADDR=127.0.0.1:0",
		"TUTTID_LOG_OUTPUT=tee",
		"TUTTI_AGENT_EXTENSION_HERMES_PACKAGE_DIR="+testAgentExtensionPackageDir(t, "hermes"),
		"TUTTI_AGENT_EXTENSION_KIMI_CODE_PACKAGE_DIR="+testAgentExtensionPackageDir(t, "kimi-code"),
	)

	daemon := &testDaemon{
		accessToken: accessToken,
		cmd:         cmd,
		logPath:     logPath,
		stateDir:    stateDir,
	}
	cmd.Stdout = &daemon.stdout
	cmd.Stderr = &daemon.stderr

	if err := cmd.Start(); err != nil {
		t.Fatalf("start tuttid: %v", err)
	}

	t.Cleanup(func() {
		stopTestDaemon(t, daemon)
	})

	daemon.baseURL = "http://" + waitForListenerInfo(t, daemon)
	waitForHealth(t, daemon)
	return daemon
}

func testAgentExtensionPackageDir(t *testing.T, key string) string {
	t.Helper()

	return filepath.Join(serviceRoot(t), "integration", "testdata", "agent-extensions", key)
}

func mustBuildDaemonBinary(t *testing.T) string {
	t.Helper()

	buildBinaryOnce.Do(func() {
		tempDir, err := os.MkdirTemp("", "tuttid-blackbox-bin-")
		if err != nil {
			buildBinaryErr = fmt.Errorf("create temp build dir: %w", err)
			return
		}

		binaryName := "tuttid"
		if runtime.GOOS == "windows" {
			binaryName += ".exe"
		}

		builtBinaryPath = filepath.Join(tempDir, binaryName)
		cmd := exec.Command("go", "build", "-o", builtBinaryPath, ".")
		cmd.Dir = serviceRoot(t)
		output, err := cmd.CombinedOutput()
		if err != nil {
			buildBinaryErr = fmt.Errorf("build tuttid binary: %w\n%s", err, strings.TrimSpace(string(output)))
		}
	})

	if buildBinaryErr != nil {
		t.Fatalf("build tuttid binary: %v", buildBinaryErr)
	}

	return builtBinaryPath
}

func waitForHealth(t *testing.T, daemon *testDaemon) {
	t.Helper()

	deadline := time.Now().Add(daemonStartTimeout)
	var lastErr error

	for time.Now().Before(deadline) {
		if daemon.cmd.ProcessState != nil && daemon.cmd.ProcessState.Exited() {
			t.Fatalf("tuttid exited before becoming healthy: %v\nstdout:\n%s\nstderr:\n%s", lastErr, daemon.stdout.String(), daemon.stderr.String())
		}

		health, err := requestJSON[tuttigenerated.HealthStatusResponse](daemon, http.MethodGet, "/v1/health", nil)
		if err == nil && health.Status == tuttigenerated.Ok {
			return
		}
		lastErr = err
		time.Sleep(healthPollInterval)
	}

	t.Fatalf("timed out waiting for tuttid health: %v\nstdout:\n%s\nstderr:\n%s", lastErr, daemon.stdout.String(), daemon.stderr.String())
}

func waitForListenerInfo(t *testing.T, daemon *testDaemon) string {
	t.Helper()

	deadline := time.Now().Add(daemonStartTimeout)
	listenerInfoPath := filepath.Join(daemon.stateDir, "run", "tuttid.listener.json")
	var lastErr error

	for time.Now().Before(deadline) {
		if daemon.cmd.ProcessState != nil && daemon.cmd.ProcessState.Exited() {
			t.Fatalf("tuttid exited before publishing listener info: %v\nstdout:\n%s\nstderr:\n%s", lastErr, daemon.stdout.String(), daemon.stderr.String())
		}

		content, err := os.ReadFile(listenerInfoPath)
		if err == nil {
			var payload struct {
				Addr string `json:"addr"`
			}
			if decodeErr := json.Unmarshal(content, &payload); decodeErr == nil && strings.TrimSpace(payload.Addr) != "" {
				return strings.TrimSpace(payload.Addr)
			} else if decodeErr != nil {
				lastErr = decodeErr
			} else {
				lastErr = errors.New("listener info file is invalid")
			}
		} else {
			lastErr = err
		}

		time.Sleep(healthPollInterval)
	}

	t.Fatalf("timed out waiting for tuttid listener info: %v\nstdout:\n%s\nstderr:\n%s", lastErr, daemon.stdout.String(), daemon.stderr.String())
	return ""
}

func mustRequestJSON[T any](t *testing.T, daemon *testDaemon, method string, path string, body any, wantStatus int) T {
	t.Helper()

	result, statusCode, err := requestJSONWithStatus[T](daemon, method, path, body)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	if statusCode != wantStatus {
		t.Fatalf("%s %s status = %d, want %d", method, path, statusCode, wantStatus)
	}

	return result
}

func requestJSON[T any](daemon *testDaemon, method string, path string, body any) (T, error) {
	result, _, err := requestJSONWithStatus[T](daemon, method, path, body)
	return result, err
}

func requestJSONWithStatus[T any](daemon *testDaemon, method string, path string, body any) (T, int, error) {
	var zero T

	var requestBody *bytes.Reader
	if body == nil {
		requestBody = bytes.NewReader(nil)
	} else {
		encoded, err := json.Marshal(body)
		if err != nil {
			return zero, 0, fmt.Errorf("encode request body: %w", err)
		}
		requestBody = bytes.NewReader(encoded)
	}

	ctx, cancel := context.WithTimeout(context.Background(), requestTimeout)
	defer cancel()

	request, err := http.NewRequestWithContext(ctx, method, daemon.baseURL+path, requestBody)
	if err != nil {
		return zero, 0, fmt.Errorf("build request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+daemon.accessToken)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}

	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return zero, 0, fmt.Errorf("perform request: %w", err)
	}
	defer func() {
		_ = response.Body.Close()
	}()

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var failure tuttigenerated.ApiErrorResponse
		if decodeErr := json.NewDecoder(response.Body).Decode(&failure); decodeErr != nil {
			return zero, response.StatusCode, fmt.Errorf("%s %s failed with status %d", method, path, response.StatusCode)
		}
		developerMessage := "<missing developerMessage>"
		if failure.Error.DeveloperMessage != nil {
			developerMessage = *failure.Error.DeveloperMessage
		}
		return zero, response.StatusCode, fmt.Errorf("%s %s failed with status %d: %s", method, path, response.StatusCode, developerMessage)
	}

	var result T
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		return zero, response.StatusCode, fmt.Errorf("decode response: %w", err)
	}

	return result, response.StatusCode, nil
}

func stopTestDaemon(t *testing.T, daemon *testDaemon) {
	t.Helper()

	if daemon == nil || daemon.cmd == nil || daemon.cmd.Process == nil {
		return
	}

	if daemon.cmd.ProcessState != nil && daemon.cmd.ProcessState.Exited() {
		return
	}

	var signalErr error
	if runtime.GOOS == "windows" {
		signalErr = daemon.cmd.Process.Kill()
	} else {
		signalErr = daemon.cmd.Process.Signal(syscall.SIGINT)
	}
	if signalErr != nil && !errors.Is(signalErr, os.ErrProcessDone) {
		t.Fatalf("signal tuttid shutdown: %v", signalErr)
	}

	done := make(chan error, 1)
	go func() {
		done <- daemon.cmd.Wait()
	}()

	select {
	case err := <-done:
		if err != nil && runtime.GOOS != "windows" {
			t.Fatalf("wait for tuttid shutdown: %v\nstdout:\n%s\nstderr:\n%s", err, daemon.stdout.String(), daemon.stderr.String())
		}
	case <-time.After(5 * time.Second):
		_ = daemon.cmd.Process.Kill()
		<-done
		t.Fatalf("timed out waiting for tuttid shutdown\nstdout:\n%s\nstderr:\n%s", daemon.stdout.String(), daemon.stderr.String())
	}
}

func serviceRoot(t *testing.T) string {
	t.Helper()

	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatalf("resolve test file location")
	}

	return filepath.Dir(filepath.Dir(filename))
}
