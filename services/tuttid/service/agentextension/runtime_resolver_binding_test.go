package agentextension

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	"github.com/tutti-os/tutti/packages/agent/daemon/runtimecmd"
	agentextensiondata "github.com/tutti-os/tutti/services/tuttid/data/agentextension"
)

func TestRuntimeResolverAllowsWorkspaceAgentsToShareTrustedHarness(t *testing.T) {
	binDir := t.TempDir()
	commandName := "example"
	if runtime.GOOS == "windows" {
		commandName += ".cmd"
	}
	executable := filepath.Join(binDir, commandName)
	if err := os.WriteFile(executable, []byte("test executable"), 0o700); err != nil {
		t.Fatal(err)
	}

	manifest := testManifest()
	manifest.AgentKey = "example"
	manifest.Name = "Example"
	const versionConstraint = ">=1.0.0 <2.0.0"
	discovery := fmt.Sprintf(
		`{"schemaVersion":"tutti.agent.discovery.v1","candidates":[{"binaryNames":[%q],"version":{"args":["--version"],"constraint":%q},"launchArgs":["--acp"],"probe":{"kind":"acp-initialize","timeoutMs":5000}}]}`,
		commandName,
		versionConstraint,
	)
	homeDir := t.TempDir()
	manager := Manager{
		Installations: agentextensiondata.NewFileInstallationStore(t.TempDir()),
		RuntimeResolver: runtimecmd.Resolver{
			Environ: func() []string { return []string{"PATH=" + binDir} },
			HomeDir: func() (string, error) { return homeDir, nil },
		},
	}
	installation, err := installTestPackage(
		t,
		&manager,
		Release{AgentKey: manifest.AgentKey, Version: manifest.Version},
		testPackageZIPFor(t, manifest, discovery),
	)
	if err != nil {
		t.Fatal(err)
	}
	fingerprint, ok := readRuntimeVersionExecutableFingerprint(executable)
	if !ok {
		t.Fatalf("read executable fingerprint for %q", executable)
	}
	manager.runtimeVersionCache().set(
		runtimeVersionCacheKey(executable, []string{"--version"}, versionConstraint),
		fingerprint,
		"1.0.0",
	)

	projectRoot := t.TempDir()
	providerTargetID := "extension:example-alias"
	resolver := RuntimeResolver{
		Manager:   &manager,
		Transport: &probeTransport{},
		Host:      agentruntime.LegacyHostMetadata(),
	}
	adapter, err := resolver.ResolveAdapter(context.Background(), agentruntime.AdapterResolveInput{
		Provider:      installation.Provider,
		AgentTargetID: "workspace-agent:writer",
		CWD:           projectRoot,
		ProviderTargetRef: map[string]any{
			"kind":                    "agent_extension",
			"provider":                installation.Provider,
			"targetId":                providerTargetID,
			"extensionInstallationId": installation.ID,
		},
	})
	if err != nil {
		t.Fatalf("ResolveAdapter: %v", err)
	}
	bound, ok := adapter.(agentruntime.ResolveInputBoundAdapter)
	if !ok {
		t.Fatal("runtime adapter does not expose its trusted resolve binding")
	}

	sharedHarness := agentruntime.AdapterResolveInput{
		Provider:      installation.Provider,
		AgentTargetID: "workspace-agent:reviewer",
		CWD:           projectRoot,
		ProviderTargetRef: map[string]any{
			"kind":                    "agent_extension",
			"provider":                installation.Provider,
			"targetId":                providerTargetID,
			"extensionInstallationId": installation.ID,
		},
	}
	if !bound.MatchesAdapterResolveInput(sharedHarness) {
		t.Fatal("workspace Agents using the same trusted Harness binding cannot share the runtime adapter")
	}
}
