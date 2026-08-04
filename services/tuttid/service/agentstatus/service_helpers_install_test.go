package agentstatus

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
)

func TestInstallCommandArgvHelper(_ *testing.T) {
	if os.Getenv("TUTTI_TEST_INSTALL_COMMAND_ARGV_HELPER") != "1" {
		return
	}
	separator := -1
	for index, value := range os.Args {
		if value == "--" {
			separator = index
			break
		}
	}
	if separator < 0 {
		os.Exit(2)
	}
	_, _ = fmt.Fprint(os.Stdout, strings.Join(os.Args[separator+1:], "\x00"))
	os.Exit(0)
}

func TestRunDefaultInstallCommandPreservesStructuredArguments(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	result, err := runDefaultInstallCommand(context.Background(), InstallCommandInput{
		Command: "must-not-be-evaluated && exit 99",
		Args: []string{
			executable,
			"-test.run=TestInstallCommandArgvHelper",
			"--",
			"value with spaces",
			"shell&metacharacters",
		},
		Env: append(os.Environ(), "TUTTI_TEST_INSTALL_COMMAND_ARGV_HELPER=1"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.ExitCode != 0 {
		t.Fatalf("exit code = %d, stderr = %q", result.ExitCode, result.Stderr)
	}
	if got, want := result.Stdout, "value with spaces\x00shell&metacharacters"; got != want {
		t.Fatalf("stdout = %q, want %q", got, want)
	}
}
