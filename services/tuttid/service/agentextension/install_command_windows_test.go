//go:build windows

package agentextension

import (
	"context"
	"reflect"
	"testing"
)

func TestAgentExtensionInstallCommandUsesCmdForNPMShim(t *testing.T) {
	t.Setenv("ComSpec", `C:\Windows\System32\cmd.exe`)
	command := newAgentExtensionInstallCommand(
		context.Background(),
		`C:\Program Files\nodejs\npm.cmd`,
		"install", "--prefix", `C:\runtime root`, "@example/probe@1.0.0",
	)
	want := []string{
		`C:\Windows\System32\cmd.exe`, "/D", "/S", "/C", "call",
		`C:\Program Files\nodejs\npm.cmd`, "install", "--prefix", `C:\runtime root`, "@example/probe@1.0.0",
	}
	if command.Path != want[0] || !reflect.DeepEqual(command.Args, want) {
		t.Fatalf("Windows npm command = path %q args %#v, want %#v", command.Path, command.Args, want)
	}
}
