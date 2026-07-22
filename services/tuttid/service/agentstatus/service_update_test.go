package agentstatus

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestProviderStatusUpdateDiscoveryIsExplicitAndCached(t *testing.T) {
	service, _ := updateTestService(t, "1.0.0")
	service.UpdateCache = NewProviderUpdateCache()
	var requests atomic.Int32
	service.HTTPClient = &http.Client{Transport: networkRoundTripFunc(func(*http.Request) (*http.Response, error) {
		requests.Add(1)
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(`{"version":"1.1.0"}`)),
		}, nil
	})}

	localSnapshot, err := service.List(context.Background(), ListInput{Providers: []string{"tutti-agent"}})
	if err != nil {
		t.Fatalf("local List() error = %v", err)
	}
	local := onlyStatus(t, localSnapshot)
	if got := requests.Load(); got != 0 {
		t.Fatalf("ordinary status made %d update requests, want 0", got)
	}
	if local.Update.Capability != UpdateCapabilitySupported || local.Update.Source != UpdateSourceNPM || local.Update.CurrentVersion != "1.0.0" {
		t.Fatalf("local update status = %#v", local.Update)
	}
	if local.Update.LatestVersion != "" || local.Update.UpdateAvailable != nil || local.Update.LastCheckedAt != nil {
		t.Fatalf("local update discovery fields = %#v, want unchecked", local.Update)
	}

	for range 2 {
		snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"tutti-agent"}, IncludeUpdates: true})
		if err != nil {
			t.Fatalf("update List() error = %v", err)
		}
		status := onlyStatus(t, snapshot)
		if status.Update.LatestVersion != "1.1.0" || status.Update.UpdateAvailable == nil || !*status.Update.UpdateAvailable || status.Update.LastCheckedAt == nil {
			t.Fatalf("discovered update = %#v", status.Update)
		}
		if !hasProviderAction(status.Actions, ActionUpdate) {
			t.Fatalf("actions = %#v, want update", status.Actions)
		}
	}
	if got := requests.Load(); got != 1 {
		t.Fatalf("cached discovery requests = %d, want 1", got)
	}
}

func TestTuttiAgentBelowMinimumRequiresManagedInstall(t *testing.T) {
	service, _ := updateTestService(t, "0.0.2")

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"tutti-agent"}})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	status := onlyStatus(t, snapshot)
	if status.Availability.Status != AvailabilityNotInstalled || status.Availability.ReasonCode != "cli_version_unsupported" {
		t.Fatalf("Availability = %#v, want minimum-version repair", status.Availability)
	}
	if status.CLI.Version != "0.0.2" || status.CLI.MinVersion != "0.0.4" {
		t.Fatalf("CLI = %#v, want current 0.0.2 and minimum 0.0.4", status.CLI)
	}
	if !hasProviderAction(status.Actions, ActionInstall) {
		t.Fatalf("Actions = %#v, want install", status.Actions)
	}
	probe, err := service.Probe(context.Background(), ProbeInput{Provider: "tutti-agent"})
	if err != nil {
		t.Fatalf("Probe() error = %v", err)
	}
	if probe.Status != ProbeFailed || probe.ReasonCode != "cli_version_unsupported" {
		t.Fatalf("Probe = %#v, want minimum-version failure", probe)
	}

	specs, err := service.selectProviderSpecs(context.Background(), []string{"tutti-agent"}, false)
	if err != nil || len(specs) != 1 {
		t.Fatalf("selectProviderSpecs() = %#v, %v", specs, err)
	}
	runtime := service.resolveProviderRuntime(context.Background(), specs[0])
	installer, required, target := service.nextMissingInstaller(specs[0], runtime)
	if !required || target != "cli" || installer.Kind != InstallerKindManagedNPMPackage {
		t.Fatalf("nextMissingInstaller() = %#v, %v, %q", installer, required, target)
	}
}

func TestTuttiAgentUnknownVersionFailsClosed(t *testing.T) {
	tests := []struct {
		name   string
		script string
	}{
		{name: "version command exits nonzero", script: "#!/bin/sh\nexit 1\n"},
		{name: "version command prints nothing", script: "#!/bin/sh\nexit 0\n"},
		{name: "version command prints garbage", script: "#!/bin/sh\necho not-a-version\n"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			service, binaryPath := updateTestService(t, "0.0.2")
			writeExecutable(t, binaryPath, test.script)

			snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"tutti-agent"}})
			if err != nil {
				t.Fatalf("List() error = %v", err)
			}
			status := onlyStatus(t, snapshot)
			if status.Availability.Status != AvailabilityNotInstalled || status.Availability.ReasonCode != "cli_version_unsupported" {
				t.Fatalf("Availability = %#v, want unknown-version repair", status.Availability)
			}
			if status.CLI.Version != "" || status.CLI.MinVersion != "0.0.4" || !hasProviderAction(status.Actions, ActionInstall) {
				t.Fatalf("CLI/actions = %#v/%#v, want unknown current version and managed install", status.CLI, status.Actions)
			}

			probe, err := service.Probe(context.Background(), ProbeInput{Provider: "tutti-agent"})
			if err != nil {
				t.Fatalf("Probe() error = %v", err)
			}
			if probe.Status != ProbeFailed || probe.ReasonCode != "cli_version_unsupported" {
				t.Fatalf("Probe = %#v, want unknown-version failure", probe)
			}
		})
	}
}

func TestTuttiAgentVersionFloorPrecedesAdapterFailure(t *testing.T) {
	service, _ := updateTestService(t, "0.0.2")
	specs, err := service.selectProviderSpecs(context.Background(), []string{"tutti-agent"}, false)
	if err != nil || len(specs) != 1 {
		t.Fatalf("selectProviderSpecs() = %#v, %v", specs, err)
	}
	spec := specs[0]
	spec.AdapterBinaryNames = []string{"missing-adapter"}

	status := service.statusForSpec(context.Background(), spec, service.now())
	if status.Availability.ReasonCode != "cli_version_unsupported" {
		t.Fatalf("Availability = %#v, want CLI floor before adapter failure", status.Availability)
	}
	if status.CLI.Version != "0.0.2" || status.CLI.MinVersion != "0.0.4" {
		t.Fatalf("CLI = %#v, want version evidence retained", status.CLI)
	}
}

func TestCompatibleTuttiAgentDoesNotRequireManagedInstall(t *testing.T) {
	for _, version := range []string{"0.0.4", "0.0.5"} {
		t.Run(version, func(t *testing.T) {
			service, _ := updateTestService(t, version)
			snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"tutti-agent"}})
			if err != nil {
				t.Fatalf("List() error = %v", err)
			}
			status := onlyStatus(t, snapshot)
			if status.Availability.Status != AvailabilityReady || hasProviderAction(status.Actions, ActionInstall) {
				t.Fatalf("status = %#v, want compatible runtime without install", status)
			}

			specs, err := service.selectProviderSpecs(context.Background(), []string{"tutti-agent"}, false)
			if err != nil || len(specs) != 1 {
				t.Fatalf("selectProviderSpecs() = %#v, %v", specs, err)
			}
			runtime := service.resolveProviderRuntime(context.Background(), specs[0])
			if installer, required, target := service.nextMissingInstaller(specs[0], runtime); required {
				t.Fatalf("nextMissingInstaller() = %#v, %v, %q; compatible versions must not auto-update", installer, required, target)
			}
		})
	}
}

func TestProviderCLIRequiresInstallSkipsVersionProbeWithoutFloor(t *testing.T) {
	home := t.TempDir()
	marker := filepath.Join(home, "version-probed")
	binary := filepath.Join(home, "provider-cli")
	writeExecutable(t, binary, "#!/bin/sh\ntouch '"+marker+"'\necho 'provider 1.0.0'\n")

	service := Service{}
	if service.providerCLIRequiresInstall(ProviderSpec{}, providerRuntimeResolution{CLIPath: binary}) {
		t.Fatal("providerCLIRequiresInstall() = true without a minimum version")
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("version command ran without a minimum version: %v", err)
	}
}

func TestRunInstallActionUpgradesTuttiAgentBelowMinimumAndReprobes(t *testing.T) {
	service, binaryPath := updateTestService(t, "0.0.2")
	service.ProbeReadyAfter = 20 * time.Millisecond
	service.ProbeTimeout = 200 * time.Millisecond
	var commands atomic.Int32
	service.InstallCommand = func(_ context.Context, input InstallCommandInput) (InstallCommandResult, error) {
		commands.Add(1)
		if !strings.Contains(input.Command, "@tutti-os/tutti-agent") {
			t.Fatalf("install command = %q, want managed Tutti Agent package", input.Command)
		}
		writeUpdateTestCLI(t, binaryPath, "0.0.4")
		return InstallCommandResult{ExitCode: 0, Stdout: "updated"}, nil
	}

	result, err := service.RunAction(context.Background(), RunActionInput{Provider: "tutti-agent", ActionID: ActionInstall})
	if err != nil {
		t.Fatalf("RunAction() error = %v", err)
	}
	if commands.Load() != 1 || result.Status != RunActionCompleted || result.Probe == nil || result.Probe.Status != ProbeReady {
		t.Fatalf("install result = %#v, commands = %d", result, commands.Load())
	}

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"tutti-agent"}, ForceRefresh: true})
	if err != nil {
		t.Fatalf("post-install List() error = %v", err)
	}
	status := onlyStatus(t, snapshot)
	if status.Availability.Status != AvailabilityReady || status.CLI.Version != "0.0.4" {
		t.Fatalf("post-install status = %#v", status)
	}
}

func TestRunInstallActionFailsWhenInstalledVersionRemainsUnknown(t *testing.T) {
	service, binaryPath := updateTestService(t, "0.0.2")
	var commands atomic.Int32
	service.InstallCommand = func(context.Context, InstallCommandInput) (InstallCommandResult, error) {
		commands.Add(1)
		writeExecutable(t, binaryPath, "#!/bin/sh\necho not-a-version\n")
		return InstallCommandResult{ExitCode: 0, Stdout: "installed"}, nil
	}

	result, err := service.RunAction(context.Background(), RunActionInput{Provider: "tutti-agent", ActionID: ActionInstall})
	if err != nil {
		t.Fatalf("RunAction() error = %v", err)
	}
	if commands.Load() != 1 || result.Status != RunActionFailed {
		t.Fatalf("result = %#v, commands = %d; unknown installed version must fail", result, commands.Load())
	}
	if !strings.Contains(result.Message, "still unavailable after install") {
		t.Fatalf("result message = %q, want unavailable-after-install evidence", result.Message)
	}
}

func TestProviderStatusUpdateDiscoveryFailureIsNonFatal(t *testing.T) {
	service, _ := updateTestService(t, "1.0.0")
	service.UpdateCache = NewProviderUpdateCache()
	service.HTTPClient = &http.Client{Transport: networkRoundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("registry unavailable")
	})}

	snapshot, err := service.List(context.Background(), ListInput{
		Providers:      []string{"tutti-agent"},
		IncludeUpdates: true,
	})
	if err != nil {
		t.Fatalf("List() error = %v, want non-fatal discovery", err)
	}
	status := onlyStatus(t, snapshot)
	if status.Availability.Status == "" {
		t.Fatalf("readiness status was lost: %#v", status)
	}
	if status.Update.ReasonCode != "update_check_failed" || status.Update.LastCheckedAt == nil || status.Update.UpdateAvailable != nil {
		t.Fatalf("update failure = %#v", status.Update)
	}
	if hasProviderAction(status.Actions, ActionUpdate) {
		t.Fatalf("actions = %#v, do not offer update after failed discovery", status.Actions)
	}
}

func TestBackgroundUpdateDiscoveryChecksOnlyInstalledManagedNPM(t *testing.T) {
	service, _ := updateTestService(t, "1.0.0")
	service.UpdateCache = NewProviderUpdateCache()
	var requests atomic.Int32
	service.HTTPClient = &http.Client{Transport: networkRoundTripFunc(func(*http.Request) (*http.Response, error) {
		requests.Add(1)
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(`{"version":"1.1.0"}`)),
		}, nil
	})}

	if err := service.DiscoverManagedProviderUpdates(context.Background()); err != nil {
		t.Fatalf("DiscoverManagedProviderUpdates() error = %v", err)
	}
	if got := requests.Load(); got != 1 {
		t.Fatalf("background update requests = %d, want only the owned tutti-agent package", got)
	}
	if _, ok := service.UpdateCache.get("tutti-agent", service.now(), time.Hour); !ok {
		t.Fatal("background discovery did not populate the shared update cache")
	}
}

func TestRefreshUpdatesBypassesOnlyUpdateMetadataCache(t *testing.T) {
	service, _ := updateTestService(t, "1.0.0")
	service.StatusCache = NewProviderStatusCache()
	service.UpdateCache = NewProviderUpdateCache()
	var readinessChecks atomic.Int32
	service.RunAuthStatusCommand = func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
		readinessChecks.Add(1)
		return AuthInfo{Status: AuthAuthenticated}, true
	}
	var updateChecks atomic.Int32
	service.HTTPClient = &http.Client{Transport: networkRoundTripFunc(func(*http.Request) (*http.Response, error) {
		updateChecks.Add(1)
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(`{"version":"1.1.0"}`)),
		}, nil
	})}

	if _, err := service.List(context.Background(), ListInput{Providers: []string{"tutti-agent"}, IncludeUpdates: true}); err != nil {
		t.Fatalf("initial List() error = %v", err)
	}
	if readinessChecks.Load() != 1 || updateChecks.Load() != 1 {
		t.Fatalf("initial checks readiness=%d update=%d, want 1/1", readinessChecks.Load(), updateChecks.Load())
	}
	if _, err := service.List(context.Background(), ListInput{
		Providers:      []string{"tutti-agent"},
		RefreshUpdates: true,
	}); err != nil {
		t.Fatalf("update-cache-only flag List() error = %v", err)
	}
	if readinessChecks.Load() != 1 || updateChecks.Load() != 1 {
		t.Fatalf("refreshUpdates without opt-in checks readiness=%d update=%d, want unchanged 1/1", readinessChecks.Load(), updateChecks.Load())
	}
	if _, err := service.List(context.Background(), ListInput{
		Providers:      []string{"tutti-agent"},
		IncludeUpdates: true,
		RefreshUpdates: true,
	}); err != nil {
		t.Fatalf("update refresh List() error = %v", err)
	}
	if readinessChecks.Load() != 1 {
		t.Fatalf("update refresh readiness checks = %d, want cached 1", readinessChecks.Load())
	}
	if updateChecks.Load() != 2 {
		t.Fatalf("update refresh metadata checks = %d, want 2", updateChecks.Load())
	}
	if _, err := service.List(context.Background(), ListInput{
		Providers:    []string{"tutti-agent"},
		ForceRefresh: true,
	}); err != nil {
		t.Fatalf("readiness refresh List() error = %v", err)
	}
	if readinessChecks.Load() != 2 {
		t.Fatalf("readiness refresh checks = %d, want 2", readinessChecks.Load())
	}
	if updateChecks.Load() != 2 {
		t.Fatalf("readiness refresh update checks = %d, want unchanged 2", updateChecks.Load())
	}
}

func TestProviderStatusUnsupportedUpdateDoesNotTouchNetwork(t *testing.T) {
	service := testService(func(string) (string, error) { return "/usr/bin/true", nil }, map[string]bool{})
	var requests atomic.Int32
	service.HTTPClient = &http.Client{Transport: networkRoundTripFunc(func(*http.Request) (*http.Response, error) {
		requests.Add(1)
		return nil, errors.New("unexpected request")
	})}

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"opencode"}, IncludeUpdates: true})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	status := onlyStatus(t, snapshot)
	if requests.Load() != 0 {
		t.Fatalf("unsupported update made %d requests", requests.Load())
	}
	if status.Update.Capability != UpdateCapabilityUnsupported || status.Update.UnsupportedReason != "official_script_update_unsupported" {
		t.Fatalf("unsupported update = %#v", status.Update)
	}
}

func TestProviderStatusUnknownInstallSourceIsUnsupported(t *testing.T) {
	unknownHome := t.TempDir()
	unknownBinary := filepath.Join(unknownHome, "bin", "tutti-agent")
	if err := os.MkdirAll(filepath.Dir(unknownBinary), 0o755); err != nil {
		t.Fatalf("mkdir unknown bin: %v", err)
	}
	writeUpdateTestCLI(t, unknownBinary, "1.0.0")
	service := testService(func(name string) (string, error) {
		if name == "tutti-agent" {
			return unknownBinary, nil
		}
		return "/usr/bin/true", nil
	}, map[string]bool{})
	service.HomeDir = func() (string, error) { return unknownHome, nil }
	service.Environ = func() []string { return []string{"PATH=" + filepath.Dir(unknownBinary)} }
	service.IsExecutableFile = func(path string) bool { return path == unknownBinary }
	service.RunAuthStatusCommand = func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
		return AuthInfo{Status: AuthAuthenticated}, true
	}
	specs, err := service.selectProviderSpecs(context.Background(), []string{"tutti-agent"}, false)
	if err != nil || len(specs) != 1 {
		t.Fatalf("select provider specs = %#v, %v", specs, err)
	}
	runtimeResolution := service.resolveProviderRuntime(context.Background(), specs[0])
	if runtimeResolution.CLIPath != unknownBinary {
		t.Fatalf("CLI path = %q, want %q", runtimeResolution.CLIPath, unknownBinary)
	}
	if providerRuntimeUsesManagedNPM(unknownBinary, "@tutti-os/tutti-agent") {
		t.Fatalf("unknown binary %q was classified as managed npm", unknownBinary)
	}
	var requests atomic.Int32
	service.HTTPClient = &http.Client{Transport: networkRoundTripFunc(func(*http.Request) (*http.Response, error) {
		requests.Add(1)
		return nil, errors.New("unexpected request")
	})}

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"tutti-agent"}, IncludeUpdates: true})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	status := onlyStatus(t, snapshot)
	if requests.Load() != 0 {
		t.Fatalf("unknown install source made %d requests", requests.Load())
	}
	if status.Update.Capability != UpdateCapabilityUnsupported || status.Update.UnsupportedReason != "unmanaged_install_source" || status.Update.Source != "" {
		t.Fatalf("update status = %#v", status.Update)
	}
}

func TestRunUpdateActionUsesManagedNPMAndReprobes(t *testing.T) {
	service, binaryPath := updateTestService(t, "1.0.0")
	service.UpdateCache = NewProviderUpdateCache()
	service.ProbeReadyAfter = 20 * time.Millisecond
	service.ProbeTimeout = 200 * time.Millisecond
	service.HTTPClient = &http.Client{Transport: networkRoundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(`{"version":"1.1.0"}`)),
		}, nil
	})}
	var commands atomic.Int32
	service.InstallCommand = func(_ context.Context, input InstallCommandInput) (InstallCommandResult, error) {
		commands.Add(1)
		if !strings.Contains(input.Command, "@tutti-os/tutti-agent@1.1.0") {
			t.Fatalf("update command = %q, want exact discovered version", input.Command)
		}
		writeUpdateTestCLI(t, binaryPath, "1.1.0")
		return InstallCommandResult{ExitCode: 0, Stdout: "updated"}, nil
	}

	result, err := service.RunAction(context.Background(), RunActionInput{Provider: "tutti-agent", ActionID: ActionUpdate})
	if err != nil {
		t.Fatalf("RunAction() error = %v", err)
	}
	if commands.Load() != 1 {
		t.Fatalf("update commands = %d, want 1", commands.Load())
	}
	if result.Status != RunActionCompleted || result.ActionID != ActionUpdate {
		t.Fatalf("result = %#v", result)
	}
	if result.Probe == nil || result.Probe.Status != ProbeReady {
		t.Fatalf("post-update probe = %#v, want ready", result.Probe)
	}
}

func TestRunUpdateActionRejectsOfficialScriptSource(t *testing.T) {
	service := testService(func(string) (string, error) { return "/usr/bin/true", nil }, map[string]bool{})
	var commands atomic.Int32
	service.InstallCommand = func(context.Context, InstallCommandInput) (InstallCommandResult, error) {
		commands.Add(1)
		return InstallCommandResult{}, nil
	}
	result, err := service.RunAction(context.Background(), RunActionInput{Provider: "opencode", ActionID: ActionUpdate})
	if err != nil {
		t.Fatalf("RunAction() error = %v", err)
	}
	if commands.Load() != 0 {
		t.Fatalf("unsupported update ran %d commands", commands.Load())
	}
	if result.Status != RunActionFailed || result.ReasonCode != "official_script_update_unsupported" {
		t.Fatalf("result = %#v", result)
	}
}

func updateTestService(t *testing.T, version string) (Service, string) {
	t.Helper()
	home := t.TempDir()
	prefixDir := filepath.Join(home, ".local")
	binDir := filepath.Join(prefixDir, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir bin: %v", err)
	}
	packageDir := filepath.Join(prefixDir, "lib", "node_modules", "@tutti-os", "tutti-agent")
	packageBinDir := filepath.Join(packageDir, "bin")
	if err := os.MkdirAll(packageBinDir, 0o755); err != nil {
		t.Fatalf("mkdir package bin: %v", err)
	}
	packageJSON := `{"name":"@tutti-os/tutti-agent","version":"` + version + `"}`
	if err := os.WriteFile(filepath.Join(packageDir, "package.json"), []byte(packageJSON), 0o644); err != nil {
		t.Fatalf("write package.json: %v", err)
	}
	packageBinaryPath := filepath.Join(packageBinDir, "tutti-agent")
	writeUpdateTestCLI(t, packageBinaryPath, version)
	binaryPath := filepath.Join(binDir, "tutti-agent")
	if err := os.Symlink(packageBinaryPath, binaryPath); err != nil {
		t.Fatalf("symlink test CLI: %v", err)
	}
	service := testService(func(name string) (string, error) {
		switch name {
		case "tutti-agent":
			return binaryPath, nil
		case "npm", "node":
			return "/usr/bin/true", nil
		default:
			return "", errors.New("not found")
		}
	}, map[string]bool{})
	service.HomeDir = func() (string, error) { return home, nil }
	service.Environ = func() []string {
		return []string{
			"PATH=" + binDir + ":/usr/bin:/bin",
			agentNPMRegistryEnv + "=https://registry.example.test",
		}
	}
	service.IsExecutableFile = func(path string) bool { return path == binaryPath }
	service.RunAuthStatusCommand = func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
		return AuthInfo{Status: AuthAuthenticated}, true
	}
	return service, binaryPath
}

func writeUpdateTestCLI(t *testing.T, path string, version string) {
	t.Helper()
	content := "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"tutti-agent " + version + "\"; exit 0; fi\nsleep 1\n"
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatalf("write test CLI: %v", err)
	}
}

func hasProviderAction(actions []Action, actionID ActionID) bool {
	for _, action := range actions {
		if action.ID == actionID {
			return true
		}
	}
	return false
}
