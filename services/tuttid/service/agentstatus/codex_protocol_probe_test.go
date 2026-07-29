package agentstatus

import (
	"context"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestProbeCodexAppServerClassifiesMissingOptionalDependencyFromStderr(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture is Unix-only")
	}
	platform, ok := codexNpmPlatformDir(runtime.GOOS, runtime.GOARCH)
	if !ok {
		t.Skip("unsupported Codex platform")
	}
	platformPackage := "@openai/" + platform
	command := filepath.Join(t.TempDir(), "codex")
	writeExecutable(t, command, "#!/bin/sh\n"+
		"echo 'Error: Missing optional dependency "+platformPackage+". Reinstall @openai/codex with optional dependencies enabled.' >&2\n"+
		"exit 1\n")

	service := Service{
		ProbeTimeout:    3 * time.Second,
		ProbeReadyAfter: 100 * time.Millisecond,
	}
	evidence := service.probeCodexAppServer(
		context.Background(),
		[]string{command, "app-server"},
		[]string{"PATH=" + filepath.Dir(command)},
	)

	if evidence.CommandStarted != true || evidence.ProtocolReady {
		t.Fatalf("evidence = %#v, want a started command with failed protocol", evidence)
	}
	if evidence.Category != "platform_package_enoent" || evidence.PlatformPackageName != platformPackage {
		t.Fatalf("evidence = %#v, want missing platform package %q classified from stderr", evidence, platformPackage)
	}
}

func TestProbeCodexAppServerClassifiesUnsupportedSubcommandFromStderr(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture is Unix-only")
	}
	command := filepath.Join(t.TempDir(), "codex")
	writeExecutable(t, command, "#!/bin/sh\n"+
		"echo \"error: unrecognized subcommand 'app-server'\" >&2\n"+
		"exit 2\n")

	service := Service{
		ProbeTimeout:    3 * time.Second,
		ProbeReadyAfter: 100 * time.Millisecond,
	}
	evidence := service.probeCodexAppServer(
		context.Background(),
		[]string{command, "app-server"},
		[]string{"PATH=" + filepath.Dir(command)},
	)

	if evidence.Category != "app_server_unsupported" {
		t.Fatalf("evidence = %#v, want app_server_unsupported classified from stderr", evidence)
	}
}
