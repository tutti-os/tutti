package agentstatus

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCodexDiscoveryUsesBunConfiguredGlobalBinForStatusAndLaunch(t *testing.T) {
	if bunBinaryName() == "bun.exe" {
		t.Skip("shell fixture is Unix-only")
	}
	home := t.TempDir()
	bunInstall := filepath.Join(home, "custom-bun-install")
	bunBin := filepath.Join(bunInstall, "bin")
	customGlobalBin := filepath.Join(home, "configured-bun-global-bin")
	if err := os.MkdirAll(bunBin, 0o755); err != nil {
		t.Fatalf("mkdir bun bin: %v", err)
	}
	if err := os.MkdirAll(customGlobalBin, 0o755); err != nil {
		t.Fatalf("mkdir custom Bun global bin: %v", err)
	}
	bunProbeLog := filepath.Join(home, "bun-pm-bin.log")
	writeExecutable(t, filepath.Join(bunBin, bunBinaryName()), "#!/bin/sh\n"+
		"if [ \"$1\" = \"pm\" ] && [ \"$2\" = \"bin\" ] && [ \"$3\" = \"-g\" ]; then\n"+
		"  echo call >> \""+bunProbeLog+"\"\n"+
		"  echo \""+customGlobalBin+"\"\n"+
		"  exit 0\n"+
		"fi\n"+
		"exit 1\n")
	codexPath := filepath.Join(customGlobalBin, "codex")
	writeExecutable(t, codexPath, "#!/bin/sh\n"+
		"if [ \"$1\" = \"--version\" ]; then echo 'codex "+MinSupportedCodexVersion+"'; exit 0; fi\n"+
		"exit 1\n")

	service := probeTestService(home)
	service.CodexProtocolProbe = codexProtocolReadyFixture
	service.Environ = func() []string {
		return []string{
			"PATH=/usr/bin:/bin",
			"BUN_INSTALL=" + bunInstall,
		}
	}
	service.BunGlobalBinCache = NewBunGlobalBinCache()
	service.RunAuthStatusCommand = func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
		return AuthInfo{Status: AuthAuthenticated}, true
	}

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"codex"}})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	status := onlyStatus(t, snapshot)
	if status.Availability.Status != AvailabilityReady || status.CLI.BinaryPath != codexPath {
		t.Fatalf("status = %#v, want configured Bun global Codex %q ready", status, codexPath)
	}

	resolution, err := service.ResolveProviderCommand(context.Background(), "codex")
	if err != nil {
		t.Fatalf("ResolveProviderCommand() error = %v", err)
	}
	if len(resolution.Command) == 0 || resolution.Command[0] != codexPath {
		t.Fatalf("command = %#v, want real session to use %q", resolution.Command, codexPath)
	}
	if !pathListContains(envValueForKey(resolution.Env, "PATH"), customGlobalBin) {
		t.Fatalf("launch PATH = %q, want configured Bun global bin", envValueForKey(resolution.Env, "PATH"))
	}

	content, err := os.ReadFile(bunProbeLog)
	if err != nil {
		t.Fatalf("read Bun discovery log: %v", err)
	}
	if calls := len(strings.Fields(string(content))); calls != 1 {
		t.Fatalf("bun pm bin -g calls = %d, want one cached discovery", calls)
	}
}

func pathListContains(value, want string) bool {
	for _, candidate := range filepath.SplitList(value) {
		if filepath.Clean(candidate) == filepath.Clean(want) {
			return true
		}
	}
	return false
}
