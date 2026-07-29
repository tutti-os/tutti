package agentstatus

import (
	"context"
	"errors"
	"testing"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

func TestCursorStatusReusesAboutCLIVersion(t *testing.T) {
	binaryPath := "/test/cursor-agent"
	service := testService(func(name string) (string, error) {
		if name == "cursor-agent" || name == "agent" {
			return binaryPath, nil
		}
		return "", errors.New("not found")
	}, map[string]bool{})
	aboutCalls := 0
	service.runCursorAuthStatusCommand = func(context.Context, string, []string) (AuthInfo, string, bool) {
		aboutCalls++
		return AuthInfo{
			Status:       AuthAuthenticated,
			AccountLabel: "Cursor Pro · user@example.com",
			AuthMethod:   "cursor_login",
		}, "2026.07.22-test", true
	}

	snapshot, err := service.List(t.Context(), ListInput{Providers: []string{"cursor"}, ForceRefresh: true})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	status := onlyStatus(t, snapshot)
	if status.CLI.Version != "2026.07.22-test" {
		t.Fatalf("CLI.Version = %q, want about cliVersion", status.CLI.Version)
	}
	if aboutCalls != 1 {
		t.Fatalf("Cursor about calls = %d, want 1", aboutCalls)
	}
}

func TestCursorAuthCommandUsesSingleOuterAttempt(t *testing.T) {
	spec := ProviderSpec{
		Provider:              providerregistry.CursorProviderID,
		AuthCommandRunnerKind: providerregistry.AuthCommandRunnerKindCursor,
	}
	calls := 0
	service := Service{
		RunAuthStatusCommand: func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
			calls++
			return AuthInfo{}, false
		},
	}
	if _, ok := service.resolveAuthFromCommand(context.Background(), spec, "/cursor-agent"); ok {
		t.Fatal("resolveAuthFromCommand() ok = true, want false")
	}
	if calls != 1 {
		t.Fatalf("Cursor auth command calls = %d, want 1", calls)
	}
}
