package agentstatus

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestProviderStatusCacheReusesProviderAcrossRequestShapes(t *testing.T) {
	var authCalls atomic.Int32
	service := testService(func(string) (string, error) {
		return "/usr/bin/true", nil
	}, map[string]bool{"/home/test/.cursor/cli-config.json": true})
	service.StatusCache = NewProviderStatusCache()
	service.Now = time.Now
	service.RunAuthStatusCommand = func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
		authCalls.Add(1)
		return AuthInfo{Status: AuthAuthenticated}, true
	}

	if _, err := service.List(context.Background(), ListInput{Providers: []string{"cursor", "codex"}}); err != nil {
		t.Fatalf("first List() error = %v", err)
	}
	probesAfterFirst := authCalls.Load()
	if probesAfterFirst != 2 {
		t.Fatalf("first List() auth probes = %d, want 2", probesAfterFirst)
	}
	if _, err := service.List(context.Background(), ListInput{Providers: []string{"cursor"}}); err != nil {
		t.Fatalf("second List() error = %v", err)
	}
	if got := authCalls.Load(); got != probesAfterFirst {
		t.Fatalf("auth probes = %d, want cached %d", got, probesAfterFirst)
	}
	if _, err := service.List(context.Background(), ListInput{Providers: []string{"cursor"}, ForceRefresh: true}); err != nil {
		t.Fatalf("forced List() error = %v", err)
	}
	if got := authCalls.Load(); got <= probesAfterFirst {
		t.Fatalf("auth probes after force refresh = %d, want > %d", got, probesAfterFirst)
	}
}

func TestForcedProviderStatusRefreshRechecksAuthButReusesStableCLIVersion(t *testing.T) {
	tempDir := t.TempDir()
	binaryPath := filepath.Join(tempDir, "cursor-agent")
	versionCallsPath := filepath.Join(tempDir, "version-calls")
	script := "#!/bin/sh\n" +
		"if [ \"$1\" = \"--version\" ]; then\n" +
		"  echo call >> " + versionCallsPath + "\n" +
		"  echo 'cursor-agent 1.2.3'\n" +
		"fi\n"
	if err := os.WriteFile(binaryPath, []byte(script), 0o700); err != nil {
		t.Fatalf("write cursor test CLI: %v", err)
	}

	var authCalls atomic.Int32
	service := testService(func(string) (string, error) {
		return binaryPath, nil
	}, map[string]bool{})
	service.StatusCache = NewProviderStatusCache()
	service.CLIVersionCache = NewCLIVersionCache()
	service.RunAuthStatusCommand = func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
		authCalls.Add(1)
		return AuthInfo{Status: AuthAuthenticated}, true
	}

	for range 2 {
		if _, err := service.List(context.Background(), ListInput{
			Providers:    []string{"cursor"},
			ForceRefresh: true,
		}); err != nil {
			t.Fatalf("forced List() error = %v", err)
		}
	}
	if got := authCalls.Load(); got != 2 {
		t.Fatalf("auth checks = %d, want every forced refresh", got)
	}
	versionCalls, err := os.ReadFile(versionCallsPath)
	if err != nil {
		t.Fatalf("read version calls: %v", err)
	}
	if got := len(strings.Fields(string(versionCalls))); got != 1 {
		t.Fatalf("version checks = %d, want stable binary checked once", got)
	}
}

func TestProviderStatusCacheCollapsesConcurrentProviderProbes(t *testing.T) {
	var authCalls atomic.Int32
	service := testService(func(string) (string, error) {
		return "/usr/bin/true", nil
	}, map[string]bool{"/home/test/.cursor/cli-config.json": true})
	service.StatusCache = NewProviderStatusCache()
	service.Now = time.Now
	service.RunAuthStatusCommand = func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
		authCalls.Add(1)
		time.Sleep(30 * time.Millisecond)
		return AuthInfo{Status: AuthAuthenticated}, true
	}

	start := make(chan struct{})
	var wait sync.WaitGroup
	for range 2 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			if _, err := service.List(context.Background(), ListInput{Providers: []string{"cursor"}}); err != nil {
				t.Errorf("List() error = %v", err)
			}
		}()
	}
	close(start)
	wait.Wait()
	if got := authCalls.Load(); got != 1 {
		t.Fatalf("auth probe calls = %d, want 1", got)
	}
}

func TestProviderStatusCacheUsesProbeCompletionTime(t *testing.T) {
	times := []time.Time{
		time.Unix(100, 0).UTC(),
		time.Unix(101, 0).UTC(),
		time.Unix(102, 0).UTC(),
		time.Unix(103, 0).UTC(),
		time.Unix(104, 0).UTC(),
	}
	var index atomic.Int32
	service := testService(func(string) (string, error) {
		return "", errors.New("not found")
	}, map[string]bool{})
	service.StatusCache = NewProviderStatusCache()
	service.Now = func() time.Time {
		i := int(index.Add(1) - 1)
		if i >= len(times) {
			return times[len(times)-1]
		}
		return times[i]
	}

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"cursor"}})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	checkedAt := onlyStatus(t, snapshot).Availability.CheckedAt
	if checkedAt == nil || !checkedAt.After(times[0]) {
		t.Fatalf("checkedAt = %v, want after probe start %v", checkedAt, times[0])
	}
}

func TestProviderStatusCacheInvalidatesWhenCredentialsChange(t *testing.T) {
	var authCalls atomic.Int32
	credentialModifiedAt := time.Unix(100, 0).UTC()
	service := testService(func(string) (string, error) {
		return "/usr/bin/true", nil
	}, map[string]bool{"/home/test/.cursor/cli-config.json": true})
	service.StatusCache = NewProviderStatusCache()
	service.Now = time.Now
	service.FileModTime = func(path string) (time.Time, bool) {
		if path == "/home/test/.cursor/cli-config.json" {
			return credentialModifiedAt, true
		}
		return time.Time{}, false
	}
	service.RunAuthStatusCommand = func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
		authCalls.Add(1)
		return AuthInfo{Status: AuthAuthenticated}, true
	}

	for range 2 {
		if _, err := service.List(context.Background(), ListInput{Providers: []string{"cursor"}}); err != nil {
			t.Fatalf("List() error = %v", err)
		}
	}
	if got := authCalls.Load(); got != 1 {
		t.Fatalf("auth probes before credential change = %d, want 1", got)
	}
	credentialModifiedAt = credentialModifiedAt.Add(time.Second)
	if _, err := service.List(context.Background(), ListInput{Providers: []string{"cursor"}}); err != nil {
		t.Fatalf("List() after credential change error = %v", err)
	}
	if got := authCalls.Load(); got != 2 {
		t.Fatalf("auth probes after credential change = %d, want 2", got)
	}
}
