package agentextension

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	"github.com/tutti-os/tutti/packages/agent/daemon/runtimecmd"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	agentextensiondata "github.com/tutti-os/tutti/services/tuttid/data/agentextension"
)

type fakeACPVersionTransport struct {
	mu      sync.Mutex
	specs   []agentruntime.ProcessSpec
	version string
}

func (t *fakeACPVersionTransport) Start(_ context.Context, spec agentruntime.ProcessSpec) (agentruntime.ProcessConnection, error) {
	t.mu.Lock()
	t.specs = append(t.specs, spec)
	version := t.version
	t.mu.Unlock()
	return &fakeACPVersionConn{
		version: version,
		frames:  make(chan agentruntime.ProcessFrame, 4),
		done:    make(chan struct{}),
	}, nil
}

type fakeACPVersionConn struct {
	version   string
	frames    chan agentruntime.ProcessFrame
	done      chan struct{}
	closeOnce sync.Once
}

func (c *fakeACPVersionConn) Send(payload []byte) error {
	var msg struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
	}
	if err := json.Unmarshal(payload, &msg); err != nil {
		return err
	}
	switch msg.Method {
	case "initialize":
		reply := `{"jsonrpc":"2.0","id":` + string(msg.ID) + `,"result":{"protocolVersion":1,"agentInfo":{"name":"pi-acp","version":"` + c.version + `"}}}` + "\n"
		c.frames <- agentruntime.ProcessFrame{Stdout: []byte(reply)}
	case "session/new":
		reply := `{"jsonrpc":"2.0","id":` + string(msg.ID) + `,"result":{"sessionId":"probe-session-1"}}` + "\n"
		c.frames <- agentruntime.ProcessFrame{Stdout: []byte(reply)}
	}
	return nil
}

func (c *fakeACPVersionConn) Recv() (agentruntime.ProcessFrame, error) {
	return c.RecvContext(context.Background())
}

func (c *fakeACPVersionConn) RecvContext(ctx context.Context) (agentruntime.ProcessFrame, error) {
	select {
	case frame := <-c.frames:
		return frame, nil
	case <-c.done:
		code := 0
		return agentruntime.ProcessFrame{ExitCode: &code}, nil
	case <-ctx.Done():
		return agentruntime.ProcessFrame{}, ctx.Err()
	}
}

func (c *fakeACPVersionConn) Close() error {
	c.closeOnce.Do(func() { close(c.done) })
	return nil
}

func TestValidateDiscoveryProfileSupportsEmptyLaunchArgsAndACPInitializeVersionSource(t *testing.T) {
	validPayload := `{
		"schemaVersion": "tutti.agent.discovery.v1",
		"candidates": [{
			"binaryNames": ["pi-acp"],
			"version": {
				"source": "acp-initialize",
				"constraint": ">=0.0.35 <1.0.0"
			},
			"launchArgs": [],
			"probe": {
				"kind": "acp-initialize",
				"timeoutMs": 5000
			}
		}]
	}`
	var valid DiscoveryProfile
	if err := json.NewDecoder(strings.NewReader(validPayload)).Decode(&valid); err != nil {
		t.Fatal(err)
	}
	if err := validateDiscoveryProfile(valid); err != nil {
		t.Fatalf("validateDiscoveryProfile(acp-initialize version source, empty launchArgs) error = %v", err)
	}

	invalidCases := map[string]string{
		"acp-initialize with version args": `{"schemaVersion":"tutti.agent.discovery.v1","candidates":[{"binaryNames":["pi-acp"],"version":{"source":"acp-initialize","args":["--version"],"constraint":">=0.0.35 <1.0.0"},"launchArgs":[],"probe":{"kind":"acp-initialize","timeoutMs":5000}}]}`,
		"unknown version source":           `{"schemaVersion":"tutti.agent.discovery.v1","candidates":[{"binaryNames":["pi-acp"],"version":{"source":"package-json","constraint":">=0.0.35 <1.0.0"},"launchArgs":[],"probe":{"kind":"acp-initialize","timeoutMs":5000}}]}`,
		"command source missing args":      `{"schemaVersion":"tutti.agent.discovery.v1","candidates":[{"binaryNames":["pi-acp"],"version":{"source":"command","constraint":">=0.0.35 <1.0.0"},"launchArgs":[],"probe":{"kind":"acp-initialize","timeoutMs":5000}}]}`,
		"acp-initialize with placeholder":  `{"schemaVersion":"tutti.agent.discovery.v1","candidates":[{"binaryNames":["pi-acp"],"version":{"source":"acp-initialize","constraint":">=0.0.35 <1.0.0"},"launchArgs":["${permissionMode}"],"probe":{"kind":"acp-initialize","timeoutMs":5000}}]}`,
	}
	for name, payload := range invalidCases {
		t.Run(name, func(t *testing.T) {
			var profile DiscoveryProfile
			if err := json.NewDecoder(strings.NewReader(payload)).Decode(&profile); err != nil {
				t.Fatal(err)
			}
			if err := validateDiscoveryProfile(profile); err == nil {
				t.Fatal("validateDiscoveryProfile() error = nil, want rejection")
			}
		})
	}
}

func TestValidateRuntimeContractAndInstallPlanAcceptUnscopedExactNPMPackage(t *testing.T) {
	manifest := testManifest()
	manifest.AgentKey = "pi"
	manifest.Name = "Pi"
	manifest.Runtime.Install.Runner = "npm"
	manifest.Runtime.Install.Args = []string{"install", "--prefix", "${installRoot}", "pi-acp@0.0.35"}
	manifest.Runtime.Launch.Executable = "${installRoot}/node_modules/.bin/pi-acp"
	manifest.Runtime.Launch.Args = []string{}

	if err := validateRuntimeContract(manifest); err != nil {
		t.Fatalf("validateRuntimeContract(unscoped exact npm package) error = %v", err)
	}

	packageDir := t.TempDir()
	discoveryPath := filepath.Join(packageDir, filepath.FromSlash(manifest.Profiles.Discovery))
	if err := os.MkdirAll(filepath.Dir(discoveryPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(discoveryPath, []byte(`{"schemaVersion":"tutti.agent.discovery.v1","candidates":[{"binaryNames":["pi-acp"],"version":{"source":"acp-initialize","constraint":">=0.0.35 <1.0.0"},"launchArgs":[],"probe":{"kind":"acp-initialize","timeoutMs":5000}}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	installation := Installation{
		ID:         "pi@0.1.0",
		AgentKey:   "pi",
		Version:    "0.1.0",
		PackageDir: packageDir,
		Manifest:   manifest,
	}
	plan, err := buildInstallPlan("extension:pi", testResolvedTempDir(t), installation)
	if err != nil {
		t.Fatalf("buildInstallPlan(unscoped npm package) error = %v", err)
	}
	if plan.PackageName != "pi-acp" || plan.PackageVersion != "0.0.35" {
		t.Fatalf("plan package = (%q, %q), want (pi-acp, 0.0.35)", plan.PackageName, plan.PackageVersion)
	}
	if len(plan.LaunchArgs) != 0 {
		t.Fatalf("plan.LaunchArgs = %#v, want empty slice", plan.LaunchArgs)
	}

	invalidArgs := map[string][]string{
		"unversioned unscoped": {"install", "--prefix", "${installRoot}", "pi-acp"},
		"tag version":          {"install", "--prefix", "${installRoot}", "pi-acp@latest"},
		"range version":        {"install", "--prefix", "${installRoot}", "pi-acp@^0.0.35"},
		"multiple packages":    {"install", "--prefix", "${installRoot}", "pi-acp@0.0.35", "@scope/other@1.0.0"},
	}
	for name, args := range invalidArgs {
		t.Run(name, func(t *testing.T) {
			invalid := manifest
			invalid.Runtime.Install.Args = args
			if err := validateRuntimeContract(invalid); err == nil {
				t.Fatalf("validateRuntimeContract(%v) error = nil, want rejection", args)
			}
		})
	}
}

func TestManagerResolvesLocalRuntimeUsingACPInitializeVersionAndCachesResult(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX fake executable test; Windows launcher resolution is covered separately")
	}
	stateDir := t.TempDir()
	binDir := t.TempDir()
	fakeBinary := filepath.Join(binDir, "pi-acp")
	if err := os.WriteFile(fakeBinary, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	packageSrc := t.TempDir()
	for rel, content := range map[string]string{
		"tutti.agent.json": `{
			"schemaVersion": "tutti.agent.manifest.v2",
			"agentKey": "pi",
			"version": "0.1.0",
			"name": "Pi",
			"description": "Pi coding agent over ACP",
			"icon": {"type": "asset", "src": "assets/icon.svg"},
			"runtime": {
				"kind": "standard-acp",
				"install": {
					"runner": "npm",
					"args": ["install", "--prefix", "${installRoot}", "pi-acp@0.0.35"]
				},
				"launch": {
					"executable": "${installRoot}/node_modules/.bin/pi-acp",
					"args": []
				}
			},
			"profiles": {
				"discovery": "profiles/discovery.json"
			},
			"localizationInfo": {
				"defaultLocale": "en",
				"defaultFile": "locales/en.json"
			}
		}`,
		"assets/icon.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"></svg>`,
		"locales/en.json": `{"agent.name":"Pi","runtime.authRequired":"Authenticate Pi"}`,
		"profiles/discovery.json": `{
			"schemaVersion": "tutti.agent.discovery.v1",
			"candidates": [{
				"binaryNames": ["pi-acp"],
				"version": {
					"source": "acp-initialize",
					"constraint": ">=0.0.35 <1.0.0"
				},
				"launchArgs": [],
				"probe": {
					"kind": "acp-initialize",
					"timeoutMs": 5000
				}
			}]
		}`,
	} {
		target := filepath.Join(packageSrc, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	transport := &fakeACPVersionTransport{version: "0.0.35"}
	manager := &Manager{
		Installations: agentextensiondata.NewFileInstallationStore(stateDir),
		Discovery:     agentextensiondata.NewFileSetupDiscoveryDirectory(stateDir),
		Transport:     transport,
		Host:          agentruntime.LegacyHostMetadata(),
		RuntimeResolver: runtimecmd.Resolver{
			Environ: func() []string { return []string{"PATH=" + binDir} },
			HomeDir: func() (string, error) { return t.TempDir(), nil },
			LookPath: func(string) (string, error) {
				return "", errors.New("not found")
			},
		},
	}

	installation, err := manager.installLocalPackage("pi", packageSrc)
	if err != nil {
		t.Fatalf("installLocalPackage() error = %v", err)
	}

	first, err := manager.ResolveRuntime(context.Background(), installation.ID)
	if err != nil {
		t.Fatalf("first ResolveRuntime() error = %v", err)
	}
	if first.Version != "0.0.35" || first.Source != "local" {
		t.Fatalf("first binding = (%q, %q), want (0.0.35, local)", first.Version, first.Source)
	}
	if len(first.Command) != 1 || first.Command[0] != fakeBinary {
		t.Fatalf("first binding command = %#v, want [%q]", first.Command, fakeBinary)
	}

	second, err := manager.ResolveRuntime(context.Background(), installation.ID)
	if err != nil {
		t.Fatalf("second ResolveRuntime() error = %v", err)
	}
	if second.Version != "0.0.35" {
		t.Fatalf("second binding version = %q, want 0.0.35", second.Version)
	}
	transport.mu.Lock()
	probeCount := len(transport.specs)
	transport.mu.Unlock()
	if probeCount != 1 {
		t.Fatalf("ACP initialize version probe count = %d, want 1 (cached)", probeCount)
	}

	// Verify incompatible version is rejected.
	incompatibleTransport := &fakeACPVersionTransport{version: "0.0.10"}
	manager2 := &Manager{
		Installations:   manager.Installations,
		Discovery:       manager.Discovery,
		Transport:       incompatibleTransport,
		Host:            agentruntime.LegacyHostMetadata(),
		RuntimeResolver: manager.RuntimeResolver,
	}
	if _, err := manager2.ResolveRuntime(context.Background(), installation.ID); err == nil {
		t.Fatal("ResolveRuntime(incompatible ACP version 0.0.10) error = nil, want rejection")
	}
}

func TestAgentTargetSetupInstallsUnscopedNPMRuntimeWithACPInitializeVersion(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	stateDir := testResolvedTempDir(t)
	runtimeDir := testResolvedTempDir(t)
	binDir := testResolvedTempDir(t)
	store := &targetStoreStub{targets: map[string]agenttargetbiz.Target{}}
	transport := &fakeACPVersionTransport{version: "0.0.35"}
	manager := &Manager{
		RuntimeInstallDir: runtimeDir,
		RuntimeBinDir:     binDir,
		Store:             store,
		Installations:     agentextensiondata.NewFileInstallationStore(stateDir),
		Discovery:         agentextensiondata.NewFileSetupDiscoveryDirectory(stateDir),
		Transport:         transport,
		Host:              agentruntime.LegacyHostMetadata(),
		RuntimeResolver: runtimecmd.Resolver{
			Environ:  func() []string { return []string{"PATH=" + t.TempDir()} },
			HomeDir:  func() (string, error) { return t.TempDir(), nil },
			LookPath: func(string) (string, error) { return "", errors.New("not found") },
		},
	}
	manifest := testManifest()
	manifest.AgentKey = "pi"
	manifest.Version = "0.1.0"
	manifest.Name = "Pi"
	manifest.Runtime.Install.Runner = "npm"
	manifest.Runtime.Install.Args = []string{"install", "--prefix", "${installRoot}", "pi-acp@0.0.35"}
	manifest.Runtime.Launch.Executable = "${installRoot}/node_modules/.bin/pi-acp"
	manifest.Runtime.Launch.Args = []string{}
	discovery := `{"schemaVersion":"tutti.agent.discovery.v1","candidates":[{"binaryNames":["pi-acp"],"version":{"source":"acp-initialize","constraint":">=0.0.35 <1.0.0"},"launchArgs":[],"probe":{"kind":"acp-initialize","timeoutMs":5000}}]}`
	installation, err := installTestPackage(t, manager, Release{AgentKey: "pi", Version: "0.1.0"}, testPackageZIPFor(t, manifest, discovery))
	if err != nil {
		t.Fatal(err)
	}
	launchRef, err := agenttargetbiz.CanonicalLaunchRefJSON(installation.Provider, agenttargetbiz.LaunchRef{
		Type: agenttargetbiz.LaunchRefTypeAgentExtension, ExtensionInstallationID: installation.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	store.targets["extension:pi"] = agenttargetbiz.Target{
		ID: "extension:pi", Provider: installation.Provider, Name: "Pi",
		LaunchRefJSON: launchRef, Enabled: true, Source: agenttargetbiz.SourceSystem,
	}
	service := NewSetupService(context.Background())
	t.Cleanup(func() { _ = service.Close() })
	service.Plans = InstallPlanService{
		Manager:    manager,
		Workspaces: workspaceLookupStub{workspace: workspacebiz.Summary{ID: "workspace-1"}},
		Targets:    store,
	}
	service.Transport = transport
	service.Host = agentruntime.LegacyHostMetadata()
	service.Actions = agentextensiondata.NewFileSetupActionStore(stateDir)
	service.Discovery = agentextensiondata.NewFileSetupDiscoveryDirectory(stateDir)
	service.Runner = &fixtureInstallRunner{binary: "pi-acp", packageName: "pi-acp", version: "0.0.35"}

	initial, err := service.GetSetup(context.Background(), InstallPlanInput{WorkspaceID: "workspace-1", AgentTargetID: "extension:pi"})
	if err != nil {
		t.Fatal(err)
	}
	if initial.Status != SetupNotInstalled || initial.Plan == nil || initial.Plan.PackageName != "pi-acp" || initial.Plan.PackageVersion != "0.0.35" {
		t.Fatalf("initial setup = %#v", initial)
	}
	if _, err := service.Install(context.Background(), InstallInput{
		WorkspaceID: "workspace-1", AgentTargetID: "extension:pi",
		PlanDigest: initial.Plan.PlanDigest, ClientActionID: "pi-install-1",
	}); err != nil {
		t.Fatalf("Install() error = %v", err)
	}
	ready := waitForSetupStatus(t, service, "extension:pi", SetupReady)
	if ready.RuntimeSource != "managed" || ready.RuntimeVersion != "0.0.35" || ready.Plan != nil {
		t.Fatalf("ready setup = %#v", ready)
	}
}
