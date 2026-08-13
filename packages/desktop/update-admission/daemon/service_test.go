package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

type checkerFunc func(context.Context, Identity) ([]byte, error)

func (fn checkerFunc) Check(ctx context.Context, identity Identity) ([]byte, error) {
	return fn(ctx, identity)
}

func testIdentity() Identity {
	return Identity{
		Product:        ProductTuttiDesktop,
		Platform:       PlatformMacOS,
		Architecture:   ArchitectureARM64,
		CurrentVersion: "1.0.0",
	}
}

func TestServiceStartsCheckBeforeLocalRead(t *testing.T) {
	called := make(chan struct{}, 1)
	service, err := New(Config{
		Identity:      testIdentity(),
		ChecksEnabled: true,
		Checker: checkerFunc(func(_ context.Context, got Identity) ([]byte, error) {
			if got != testIdentity() {
				t.Fatalf("identity = %#v", got)
			}
			called <- struct{}{}
			return []byte(`{"channel":"stable","decision":"allowed","reason":"minimumNotConfigured","policyRevision":"v1","featureAvailability":{"keys":[]}}`), nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	service.Start(context.Background())
	select {
	case <-called:
	case <-time.After(time.Second):
		t.Fatal("daemon did not start the policy request")
	}
	snapshot, err := service.WaitInitial(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Policy.Status != "resolved" || snapshot.Policy.Response.Decision != "allowed" {
		t.Fatalf("snapshot = %#v", snapshot)
	}
	assertEmptyFeatureKeysEncodeAsArray(t, snapshot)
	assertEmptyFeatureKeysEncodeAsArray(t, service.Snapshot())
}

func TestServiceInitialSnapshotEncodesEmptyFeatureKeysAsArray(t *testing.T) {
	service, err := New(Config{
		Identity:      testIdentity(),
		ChecksEnabled: false,
	})
	if err != nil {
		t.Fatal(err)
	}
	assertEmptyFeatureKeysEncodeAsArray(t, service.Snapshot())
}

func TestFeatureCacheEncodesEmptyFeatureKeysAsArray(t *testing.T) {
	cachePath := filepath.Join(t.TempDir(), "feature-cache.json")
	cache := FileFeatureCache{Path: cachePath}
	now := time.Date(2026, 8, 3, 1, 2, 3, 0, time.UTC)
	revision := "v1"
	if err := cache.Save(testIdentity(), FeatureAvailabilitySnapshot{
		Keys:           nil,
		Source:         "remote",
		PolicyRevision: &revision,
		FetchedAt:      &now,
	}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(cachePath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(raw, []byte(`"keys":[]`)) {
		t.Fatalf("cache keys must encode as an array: %s", raw)
	}
}

func TestServicePersistsOnlyFeatureAvailabilityAndRestoresOnFailure(t *testing.T) {
	cachePath := filepath.Join(t.TempDir(), "feature-cache.json")
	cache := FileFeatureCache{Path: cachePath}
	service, err := New(Config{
		Identity:      testIdentity(),
		ChecksEnabled: true,
		FeatureCache:  cache,
		Checker: checkerFunc(func(context.Context, Identity) ([]byte, error) {
			return []byte(`{"channel":"stable","minimumVersion":"1.1.0","decision":"upgradeRequired","reason":"belowMinimum","policyRevision":"v2","featureAvailability":{"keys":["workspace.example"]}}`), nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	service.Start(context.Background())
	if _, err := service.WaitInitial(context.Background()); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(cachePath)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"minimumVersion", "upgradeRequired", "belowMinimum"} {
		if stringContains(string(raw), forbidden) {
			t.Fatalf("cache contains policy field %q: %s", forbidden, raw)
		}
	}

	restored, err := New(Config{
		Identity:      testIdentity(),
		ChecksEnabled: true,
		FeatureCache:  cache,
		Checker: checkerFunc(func(context.Context, Identity) ([]byte, error) {
			return nil, errors.New("offline")
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	restored.Start(context.Background())
	snapshot, err := restored.WaitInitial(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Policy.Status != "failedOpen" {
		t.Fatalf("policy = %#v", snapshot.Policy)
	}
	if snapshot.FeatureAvailability.Source != "cache" ||
		len(snapshot.FeatureAvailability.Keys) != 1 ||
		snapshot.FeatureAvailability.Keys[0] != "workspace.example" {
		t.Fatalf("featureAvailability = %#v", snapshot.FeatureAvailability)
	}
}

func TestInvalidFeatureRetainsCacheWithoutInvalidatingPolicy(t *testing.T) {
	cachePath := filepath.Join(t.TempDir(), "feature-cache.json")
	cache := FileFeatureCache{Path: cachePath}
	now := time.Date(2026, 8, 2, 1, 2, 3, 0, time.UTC)
	revision := "v1"
	if err := cache.Save(testIdentity(), FeatureAvailabilitySnapshot{
		Keys:           []string{"cached.feature"},
		Source:         "remote",
		PolicyRevision: &revision,
		FetchedAt:      &now,
	}); err != nil {
		t.Fatal(err)
	}
	service, err := New(Config{
		Identity:      testIdentity(),
		ChecksEnabled: true,
		FeatureCache:  cache,
		Checker: checkerFunc(func(context.Context, Identity) ([]byte, error) {
			return []byte(`{"channel":"stable","decision":"allowed","reason":"minimumNotConfigured","policyRevision":"v2","featureAvailability":{"keys":[7]}}`), nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	service.Start(context.Background())
	snapshot, err := service.WaitInitial(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Policy.Status != "resolved" {
		t.Fatalf("policy = %#v", snapshot.Policy)
	}
	if snapshot.FeatureAvailability.Source != "cache" ||
		snapshot.FeatureAvailability.Keys[0] != "cached.feature" {
		t.Fatalf("featureAvailability = %#v", snapshot.FeatureAvailability)
	}
}

func TestForegroundRefreshIsThrottledAndRetryBypassesThrottle(t *testing.T) {
	var mu sync.Mutex
	calls := 0
	now := time.Date(2026, 8, 2, 1, 0, 0, 0, time.UTC)
	service, err := New(Config{
		Identity:           testIdentity(),
		ChecksEnabled:      true,
		ForegroundInterval: 30 * time.Minute,
		Now:                func() time.Time { return now },
		Checker: checkerFunc(func(context.Context, Identity) ([]byte, error) {
			mu.Lock()
			calls++
			mu.Unlock()
			return []byte(`{"channel":"stable","decision":"allowed","reason":"minimumNotConfigured","policyRevision":"v1"}`), nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	service.Start(context.Background())
	if _, err := service.WaitInitial(context.Background()); err != nil {
		t.Fatal(err)
	}
	foreground, err := service.Refresh(context.Background(), RefreshTriggerForeground)
	if err != nil {
		t.Fatal(err)
	}
	if foreground.Performed || foreground.SkipReason != "throttled" {
		t.Fatalf("foreground = %#v", foreground)
	}
	retry, err := service.Refresh(context.Background(), RefreshTriggerRetry)
	if err != nil {
		t.Fatal(err)
	}
	if !retry.Performed {
		t.Fatalf("retry = %#v", retry)
	}
	mu.Lock()
	defer mu.Unlock()
	if calls != 2 {
		t.Fatalf("calls = %d, want 2", calls)
	}
}

func TestFailedOpenDoesNotThrottleForegroundRecovery(t *testing.T) {
	var mu sync.Mutex
	calls := 0
	now := time.Date(2026, 8, 13, 1, 0, 0, 0, time.UTC)
	service, err := New(Config{
		Identity:           testIdentity(),
		ChecksEnabled:      true,
		ForegroundInterval: 30 * time.Minute,
		Now:                func() time.Time { return now },
		Checker: checkerFunc(func(context.Context, Identity) ([]byte, error) {
			mu.Lock()
			defer mu.Unlock()
			calls++
			if calls == 1 {
				return nil, errors.New("network unavailable after system resume")
			}
			return []byte(`{"channel":"stable","minimumVersion":"1.1.0","decision":"upgradeRequired","reason":"belowMinimum","policyRevision":"v2"}`), nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	service.Start(context.Background())
	initial, err := service.WaitInitial(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if initial.Policy.Status != "failedOpen" || initial.NextForegroundCheckAt != nil {
		t.Fatalf("initial snapshot = %#v", initial)
	}

	foreground, err := service.Refresh(context.Background(), RefreshTriggerForeground)
	if err != nil {
		t.Fatal(err)
	}
	if !foreground.Performed || foreground.SkipReason != "" {
		t.Fatalf("foreground = %#v", foreground)
	}
	if foreground.Snapshot.Policy.Status != "resolved" ||
		foreground.Snapshot.Policy.Response == nil ||
		foreground.Snapshot.Policy.Response.Decision != "upgradeRequired" ||
		foreground.Snapshot.NextForegroundCheckAt == nil {
		t.Fatalf("recovered snapshot = %#v", foreground.Snapshot)
	}
	mu.Lock()
	defer mu.Unlock()
	if calls != 2 {
		t.Fatalf("calls = %d, want startup failure plus foreground recovery", calls)
	}
}

func TestInvalidResponseRetainsForegroundThrottle(t *testing.T) {
	calls := 0
	now := time.Date(2026, 8, 13, 1, 0, 0, 0, time.UTC)
	service, err := New(Config{
		Identity:           testIdentity(),
		ChecksEnabled:      true,
		ForegroundInterval: 30 * time.Minute,
		Now:                func() time.Time { return now },
		Checker: checkerFunc(func(context.Context, Identity) ([]byte, error) {
			calls++
			return []byte(`{"decision":"unexpected"}`), nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	service.Start(context.Background())
	initial, err := service.WaitInitial(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if initial.Policy.Status != "failedOpen" ||
		initial.Policy.Failure == nil ||
		initial.Policy.Failure.Kind != "invalidResponse" ||
		initial.NextForegroundCheckAt == nil {
		t.Fatalf("initial snapshot = %#v", initial)
	}

	foreground, err := service.Refresh(context.Background(), RefreshTriggerForeground)
	if err != nil {
		t.Fatal(err)
	}
	if foreground.Performed || foreground.SkipReason != "throttled" {
		t.Fatalf("foreground = %#v", foreground)
	}
	if calls != 1 {
		t.Fatalf("calls = %d, want one invalid request", calls)
	}
}

func TestStartupTimeoutFailsOpenWithoutCachingPolicy(t *testing.T) {
	service, err := New(Config{
		Identity:       testIdentity(),
		ChecksEnabled:  true,
		StartupTimeout: 10 * time.Millisecond,
		Checker: checkerFunc(func(ctx context.Context, _ Identity) ([]byte, error) {
			<-ctx.Done()
			return nil, ctx.Err()
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	service.Start(context.Background())
	snapshot, err := service.WaitInitial(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Policy.Status != "failedOpen" ||
		snapshot.Policy.Failure == nil ||
		snapshot.Policy.Failure.Kind != "timeout" ||
		snapshot.Policy.Response != nil {
		t.Fatalf("policy = %#v", snapshot.Policy)
	}
}

func TestDisabledChecksCompleteStartupWithoutChecker(t *testing.T) {
	service, err := New(Config{
		Identity:      testIdentity(),
		ChecksEnabled: false,
	})
	if err != nil {
		t.Fatal(err)
	}
	service.Start(context.Background())
	snapshot, err := service.WaitInitial(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Policy.Status != "skipped" ||
		snapshot.Policy.Reason != "checksDisabled" {
		t.Fatalf("policy = %#v", snapshot.Policy)
	}
}

func TestConcurrentRefreshSharesOneActiveRequest(t *testing.T) {
	release := make(chan struct{})
	started := make(chan struct{}, 2)
	var mu sync.Mutex
	calls := 0
	service, err := New(Config{
		Identity:      testIdentity(),
		ChecksEnabled: true,
		Checker: checkerFunc(func(context.Context, Identity) ([]byte, error) {
			mu.Lock()
			calls++
			call := calls
			mu.Unlock()
			if call > 1 {
				started <- struct{}{}
				<-release
			}
			return []byte(`{"channel":"stable","decision":"allowed","reason":"minimumNotConfigured","policyRevision":"v1"}`), nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	service.Start(context.Background())
	if _, err := service.WaitInitial(context.Background()); err != nil {
		t.Fatal(err)
	}

	firstDone := make(chan RefreshResult, 1)
	go func() {
		result, _ := service.Refresh(context.Background(), RefreshTriggerRetry)
		firstDone <- result
	}()
	<-started
	secondDone := make(chan RefreshResult, 1)
	go func() {
		result, _ := service.Refresh(context.Background(), RefreshTriggerRetry)
		secondDone <- result
	}()
	time.Sleep(10 * time.Millisecond)
	close(release)
	first := <-firstDone
	second := <-secondDone
	if !first.Performed || second.Performed || second.SkipReason != "requestInFlight" {
		t.Fatalf("results = %#v and %#v", first, second)
	}
	mu.Lock()
	defer mu.Unlock()
	if calls != 2 {
		t.Fatalf("calls = %d, want startup plus one refresh", calls)
	}
}

func TestCloseCancelsActiveRefresh(t *testing.T) {
	started := make(chan struct{}, 1)
	var mu sync.Mutex
	calls := 0
	service, err := New(Config{
		Identity:      testIdentity(),
		ChecksEnabled: true,
		Checker: checkerFunc(func(ctx context.Context, _ Identity) ([]byte, error) {
			mu.Lock()
			calls++
			call := calls
			mu.Unlock()
			if call == 1 {
				return []byte(`{"channel":"stable","decision":"allowed","reason":"minimumNotConfigured","policyRevision":"v1"}`), nil
			}
			select {
			case started <- struct{}{}:
			default:
			}
			<-ctx.Done()
			return nil, ctx.Err()
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	service.Start(context.Background())
	if _, err := service.WaitInitial(context.Background()); err != nil {
		t.Fatal(err)
	}
	refreshDone := make(chan RefreshResult, 1)
	go func() {
		result, _ := service.Refresh(context.Background(), RefreshTriggerRetry)
		refreshDone <- result
	}()
	<-started
	service.Close()

	select {
	case result := <-refreshDone:
		if result.Snapshot.Policy.Status != "failedOpen" ||
			result.Snapshot.Policy.Failure == nil ||
			result.Snapshot.Policy.Failure.Kind != "transport" {
			t.Fatalf("policy = %#v", result.Snapshot.Policy)
		}
	case <-time.After(time.Second):
		t.Fatal("active refresh was not canceled when the service closed")
	}
}

func assertEmptyFeatureKeysEncodeAsArray(t *testing.T, snapshot Snapshot) {
	t.Helper()
	if snapshot.FeatureAvailability.Keys == nil {
		t.Fatal("feature availability keys must be a non-nil empty slice")
	}
	raw, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(raw, []byte(`"keys":[]`)) {
		t.Fatalf("snapshot keys must encode as an array: %s", raw)
	}
}

func stringContains(value string, target string) bool {
	for index := 0; index+len(target) <= len(value); index++ {
		if value[index:index+len(target)] == target {
			return true
		}
	}
	return false
}
