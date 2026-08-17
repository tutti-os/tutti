package runtimeprep

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestMutagenAuthProjectorUsesTwoWaySafeAndFlushesBeforeTerminate(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "stable", "auth.json")
	target := filepath.Join(root, "run", "auth.json")
	if err := os.MkdirAll(filepath.Dir(source), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte(`{"token":"stable"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	var calls [][]string
	projector := MutagenAuthFileProjector{
		StateDir:          root,
		Symlink:           func(string, string) error { return os.ErrPermission },
		ResolveExecutable: func(context.Context) (string, error) { return "mutagen-test", nil },
		Run: func(_ context.Context, _ string, args []string, _ []string) ([]byte, error) {
			calls = append(calls, append([]string(nil), args...))
			if len(args) > 1 && args[1] == "list" {
				return []byte(`[{"conflicts":[]}]`), nil
			}
			return nil, nil
		},
	}
	cleanup, err := projector.Project(context.Background(), AuthFileProjection{
		SourcePath: source, TargetPath: target,
		LockSourcePath: filepath.Join(root, "stable", ".refresh.lock"),
		LockTargetPath: filepath.Join(root, "run", ".refresh.lock"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if cleanup == nil {
		t.Fatal("cleanup = nil, want Mutagen cleanup")
	}
	if content, err := os.ReadFile(target); err != nil || string(content) != `{"token":"stable"}` {
		t.Fatalf("seeded auth = %q, %v", content, err)
	}
	create := strings.Join(calls[0], " ")
	if !strings.Contains(create, "--sync-mode=two-way-safe") || strings.Contains(create, "--watch-mode") {
		t.Fatalf("create args = %q, want two-way-safe default watcher", create)
	}
	if err := cleanup(context.Background()); err != nil {
		t.Fatal(err)
	}
	wantOperations := []string{"create", "flush", "flush", "list", "terminate"}
	operations := make([]string, 0, len(calls))
	for _, call := range calls {
		operations = append(operations, call[1])
	}
	if !reflect.DeepEqual(operations, wantOperations) {
		t.Fatalf("operations = %#v, want %#v", operations, wantOperations)
	}
}

func TestMutagenAuthProjectorFallsBackToGuardedCopy(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "stable", "auth.json")
	target := filepath.Join(root, "run", "auth.json")
	if err := os.MkdirAll(filepath.Dir(source), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte(`{"token":"stable"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	projector := MutagenAuthFileProjector{
		StateDir:          root,
		Symlink:           func(string, string) error { return os.ErrPermission },
		ResolveExecutable: func(context.Context) (string, error) { return "", errors.New("missing") },
	}
	cleanup, err := projector.Project(context.Background(), AuthFileProjection{SourcePath: source, TargetPath: target})
	if err != nil {
		t.Fatal(err)
	}
	if cleanup == nil {
		t.Fatal("cleanup = nil, want copy fallback cleanup")
	}
	if content, err := os.ReadFile(target); err != nil || string(content) != `{"token":"stable"}` {
		t.Fatalf("seeded auth = %q, %v", content, err)
	}
	if err := os.WriteFile(target, []byte(`{"token":"refreshed"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := cleanup(context.Background()); err != nil {
		t.Fatal(err)
	}
	if content, err := os.ReadFile(source); err != nil || string(content) != `{"token":"refreshed"}` {
		t.Fatalf("stable auth = %q, %v", content, err)
	}
}

func TestMutagenAuthProjectorIgnoresCanceledRequestContextDuringSetup(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "stable", "auth.json")
	target := filepath.Join(root, "run", "auth.json")
	if err := os.MkdirAll(filepath.Dir(source), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte(`{"token":"stable"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	requestCtx, cancel := context.WithCancel(context.Background())
	cancel()
	projector := MutagenAuthFileProjector{
		StateDir: root,
		Symlink:  func(string, string) error { return os.ErrPermission },
		ResolveExecutable: func(ctx context.Context) (string, error) {
			if err := ctx.Err(); err != nil {
				t.Fatalf("resolver inherited canceled request context: %v", err)
			}
			return "mutagen-test", nil
		},
		Run: func(ctx context.Context, _ string, args []string, _ []string) ([]byte, error) {
			if err := ctx.Err(); err != nil {
				t.Fatalf("Mutagen %v inherited canceled request context: %v", args, err)
			}
			return nil, nil
		},
	}
	cleanup, err := projector.Project(requestCtx, AuthFileProjection{SourcePath: source, TargetPath: target})
	if err != nil {
		t.Fatal(err)
	}
	if cleanup == nil {
		t.Fatal("cleanup = nil, want Mutagen cleanup")
	}
}

func TestMutagenAuthProjectorFallsBackWhenCreateTimesOut(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "stable", "auth.json")
	target := filepath.Join(root, "run", "auth.json")
	if err := os.MkdirAll(filepath.Dir(source), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte(`{"token":"stable"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	projector := MutagenAuthFileProjector{
		StateDir:          root,
		CommandTimeout:    5 * time.Millisecond,
		Symlink:           func(string, string) error { return os.ErrPermission },
		ResolveExecutable: func(context.Context) (string, error) { return "mutagen-test", nil },
		Run: func(ctx context.Context, _ string, args []string, _ []string) ([]byte, error) {
			if len(args) > 1 && args[1] == "create" {
				<-ctx.Done()
				return nil, ctx.Err()
			}
			return nil, nil
		},
	}
	cleanup, err := projector.Project(context.Background(), AuthFileProjection{SourcePath: source, TargetPath: target})
	if err != nil {
		t.Fatal(err)
	}
	if cleanup == nil {
		t.Fatal("cleanup = nil, want guarded-copy fallback")
	}
	content, readErr := os.ReadFile(target)
	if readErr != nil || string(content) != `{"token":"stable"}` {
		t.Fatalf("fallback target = %q, %v", content, readErr)
	}
}

func TestMutagenAuthProjectorDoesNotFallbackWhenFailedSessionCannotBeTerminated(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "stable", "auth.json")
	target := filepath.Join(root, "run", "auth.json")
	if err := os.MkdirAll(filepath.Dir(source), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte(`{"token":"stable"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	projector := MutagenAuthFileProjector{
		StateDir:          root,
		Symlink:           func(string, string) error { return os.ErrPermission },
		ResolveExecutable: func(context.Context) (string, error) { return "mutagen-test", nil },
		Run: func(_ context.Context, _ string, args []string, _ []string) ([]byte, error) {
			if len(args) > 1 && args[1] == "create" {
				return nil, errors.New("create failed")
			}
			if len(args) > 1 && args[1] == "terminate" {
				return nil, errors.New("terminate failed")
			}
			return nil, nil
		},
	}
	cleanup, err := projector.Project(context.Background(), AuthFileProjection{SourcePath: source, TargetPath: target})
	if err == nil || !strings.Contains(err.Error(), "cleanup failed") {
		t.Fatalf("error = %v, want cleanup failure", err)
	}
	if cleanup != nil {
		t.Fatal("cleanup must be nil when Mutagen ownership is uncertain")
	}
}

func TestMutagenAuthProjectorSerializesSetupForSameStableSource(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "stable", "auth.json")
	if err := os.MkdirAll(filepath.Dir(source), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte(`{"token":"stable"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	firstEntered := make(chan struct{})
	releaseFirst := make(chan struct{})
	var createCount atomic.Int32
	projector := MutagenAuthFileProjector{
		StateDir:          root,
		Symlink:           func(string, string) error { return os.ErrPermission },
		ResolveExecutable: func(context.Context) (string, error) { return "mutagen-test", nil },
		Run: func(_ context.Context, _ string, args []string, _ []string) ([]byte, error) {
			if len(args) > 1 && args[1] == "create" && createCount.Add(1) == 1 {
				close(firstEntered)
				<-releaseFirst
			}
			return nil, nil
		},
	}

	var waitGroup sync.WaitGroup
	errorsByProjection := make(chan error, 2)
	project := func(target string) {
		defer waitGroup.Done()
		_, err := projector.Project(context.Background(), AuthFileProjection{SourcePath: source, TargetPath: target})
		errorsByProjection <- err
	}
	waitGroup.Add(1)
	go project(filepath.Join(root, "run-1", "auth.json"))
	<-firstEntered
	waitGroup.Add(1)
	go project(filepath.Join(root, "run-2", "auth.json"))
	time.Sleep(50 * time.Millisecond)
	if count := createCount.Load(); count != 1 {
		t.Fatalf("create calls while first setup is active = %d, want 1", count)
	}
	close(releaseFirst)
	waitGroup.Wait()
	close(errorsByProjection)
	for err := range errorsByProjection {
		if err != nil {
			t.Fatal(err)
		}
	}
	if count := createCount.Load(); count != 2 {
		t.Fatalf("total create calls = %d, want 2", count)
	}
}

func TestMutagenAuthProjectorSerializesFallbackCleanupAndPreservesConflict(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "stable", "auth.json")
	if err := os.MkdirAll(filepath.Dir(source), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte(`{"token":"baseline"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	projector := MutagenAuthFileProjector{
		StateDir:          root,
		Symlink:           func(string, string) error { return os.ErrPermission },
		ResolveExecutable: func(context.Context) (string, error) { return "", errors.New("missing") },
	}
	targetOne := filepath.Join(root, "run-1", "auth.json")
	targetTwo := filepath.Join(root, "run-2", "auth.json")
	cleanupOne, err := projector.Project(context.Background(), AuthFileProjection{SourcePath: source, TargetPath: targetOne})
	if err != nil {
		t.Fatal(err)
	}
	cleanupTwo, err := projector.Project(context.Background(), AuthFileProjection{SourcePath: source, TargetPath: targetTwo})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(targetOne, []byte(`{"token":"runtime-one"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(targetTwo, []byte(`{"token":"runtime-two"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := cleanupOne(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := cleanupTwo(context.Background()); err == nil || !strings.Contains(err.Error(), "both files preserved") {
		t.Fatalf("second cleanup error = %v, want preserved conflict", err)
	}
	if content, _ := os.ReadFile(source); string(content) != `{"token":"runtime-one"}` {
		t.Fatalf("stable auth = %q, want first serialized cleanup", content)
	}
	if content, _ := os.ReadFile(targetTwo); string(content) != `{"token":"runtime-two"}` {
		t.Fatalf("second runtime auth overwritten: %q", content)
	}
}

func TestMutagenAuthProjectorCleanupRespectsCallerDeadline(t *testing.T) {
	projector := MutagenAuthFileProjector{
		StateDir:       t.TempDir(),
		CommandTimeout: time.Minute,
		Run: func(ctx context.Context, _ string, _ []string, _ []string) ([]byte, error) {
			<-ctx.Done()
			return nil, ctx.Err()
		},
	}
	cleanup := projector.cleanupCallback("mutagen-test", "session", filepath.Join(t.TempDir(), mutagenSessionMarker))
	cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	started := time.Now()
	err := cleanup(cleanupCtx)
	if err == nil || time.Since(started) > time.Second {
		t.Fatalf("cleanup error = %v after %s, want caller deadline", err, time.Since(started))
	}
}

func TestMutagenAuthProjectorCopyFallbackPreservesConcurrentChanges(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "stable", "auth.json")
	target := filepath.Join(root, "run", "auth.json")
	if err := os.MkdirAll(filepath.Dir(source), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte(`{"token":"baseline"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	projector := MutagenAuthFileProjector{
		StateDir:          root,
		Symlink:           func(string, string) error { return os.ErrPermission },
		ResolveExecutable: func(context.Context) (string, error) { return "", errors.New("missing") },
	}
	cleanup, err := projector.Project(context.Background(), AuthFileProjection{SourcePath: source, TargetPath: target})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte(`{"token":"new-stable"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte(`{"token":"new-run"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := cleanup(context.Background()); err == nil || !strings.Contains(err.Error(), "both files preserved") {
		t.Fatalf("cleanup error = %v, want preserved conflict", err)
	}
	if content, _ := os.ReadFile(source); string(content) != `{"token":"new-stable"}` {
		t.Fatalf("stable auth overwritten: %q", content)
	}
	if content, _ := os.ReadFile(target); string(content) != `{"token":"new-run"}` {
		t.Fatalf("runtime auth overwritten: %q", content)
	}
}

func TestMutagenAuthProjectorCopyFallbackRejectsInvalidRuntimeJSON(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "stable", "auth.json")
	target := filepath.Join(root, "run", "auth.json")
	if err := os.MkdirAll(filepath.Dir(source), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte(`{"token":"stable"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	projector := MutagenAuthFileProjector{
		StateDir:          root,
		Symlink:           func(string, string) error { return os.ErrPermission },
		ResolveExecutable: func(context.Context) (string, error) { return "", errors.New("missing") },
	}
	cleanup, err := projector.Project(context.Background(), AuthFileProjection{SourcePath: source, TargetPath: target})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("not-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := cleanup(context.Background()); err == nil || !strings.Contains(err.Error(), "invalid auth JSON") {
		t.Fatalf("cleanup error = %v, want invalid JSON", err)
	}
	if content, _ := os.ReadFile(source); string(content) != `{"token":"stable"}` {
		t.Fatalf("stable auth overwritten: %q", content)
	}
}

func TestMutagenAuthProjectorFallsBackFromPersistedMarkerWhenMutagenIsUnavailable(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "stable", "auth.json")
	target := filepath.Join(root, "run", "auth.json")
	if err := os.MkdirAll(filepath.Dir(source), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte(`{"token":"stable"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte(`{"token":"stale-run"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(filepath.Dir(target), mutagenSessionMarker)
	if err := os.WriteFile(marker, []byte("stale-session\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	projector := MutagenAuthFileProjector{
		StateDir:          root,
		Symlink:           func(string, string) error { return os.ErrPermission },
		ResolveExecutable: func(context.Context) (string, error) { return "", errors.New("missing") },
	}
	cleanup, err := projector.Project(context.Background(), AuthFileProjection{SourcePath: source, TargetPath: target})
	if err != nil {
		t.Fatal(err)
	}
	if cleanup == nil {
		t.Fatal("cleanup = nil, want copy fallback cleanup")
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("marker still exists: %v", err)
	}
	if content, err := os.ReadFile(target); err != nil || string(content) != `{"token":"stable"}` {
		t.Fatalf("refreshed runtime auth = %q, %v", content, err)
	}
}

func TestMutagenAuthProjectorPreservesSessionOnConflict(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "stable", "auth.json")
	target := filepath.Join(root, "run", "auth.json")
	if err := os.MkdirAll(filepath.Dir(source), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	terminated := false
	projector := MutagenAuthFileProjector{
		StateDir:          root,
		Symlink:           func(string, string) error { return os.ErrPermission },
		ResolveExecutable: func(context.Context) (string, error) { return "mutagen-test", nil },
		Run: func(_ context.Context, _ string, args []string, _ []string) ([]byte, error) {
			if args[1] == "list" {
				return []byte(`[{"conflicts":[{"path":"auth.json"}]}]`), nil
			}
			if args[1] == "terminate" {
				terminated = true
			}
			return nil, nil
		},
	}
	cleanup, err := projector.Project(context.Background(), AuthFileProjection{SourcePath: source, TargetPath: target})
	if err != nil {
		t.Fatal(err)
	}
	if err := cleanup(context.Background()); err == nil || !strings.Contains(strings.ToLower(err.Error()), "conflict") {
		t.Fatalf("cleanup error = %v, want conflict", err)
	}
	if terminated {
		t.Fatal("conflicted session was terminated")
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatalf("conflicted target was not preserved: %v", err)
	}
}

func TestMutagenAuthProjectorSharesRefreshLockFileObject(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "stable", "auth.json")
	target := filepath.Join(root, "run", "auth.json")
	if err := os.MkdirAll(filepath.Dir(source), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	lockSource := filepath.Join(root, "stable", ".refresh.lock")
	lockTarget := filepath.Join(root, "run", ".refresh.lock")
	projector := MutagenAuthFileProjector{
		StateDir: root,
		Symlink: func(_ string, newname string) error {
			if strings.HasSuffix(newname, "auth.json") {
				return nil
			}
			return os.ErrPermission
		},
	}
	cleanup, err := projector.Project(context.Background(), AuthFileProjection{
		SourcePath: source, TargetPath: target, LockSourcePath: lockSource, LockTargetPath: lockTarget,
	})
	if err != nil {
		t.Fatal(err)
	}
	if cleanup != nil {
		t.Fatal("cleanup != nil for symlink projection")
	}
	if err := os.WriteFile(lockTarget, []byte("held"), 0o600); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(lockSource)
	if err != nil || string(content) != "held" {
		t.Fatalf("stable lock = %q, %v", content, err)
	}
}

func TestMutagenAuthProjectorRealE2E(t *testing.T) {
	executable := strings.TrimSpace(os.Getenv("TUTTI_MUTAGEN_E2E_BIN"))
	if executable == "" {
		t.Skip("set TUTTI_MUTAGEN_E2E_BIN to run the real Mutagen E2E")
	}
	t.Setenv("TUTTI_MUTAGEN_BIN", executable)
	root := t.TempDir()
	source := filepath.Join(root, "stable", "auth.json")
	target := filepath.Join(root, "run", "auth.json")
	if err := os.MkdirAll(filepath.Dir(source), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte(`{"token":"stable"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	projector := MutagenAuthFileProjector{
		StateDir:          root,
		Symlink:           func(string, string) error { return os.ErrPermission },
		ResolveExecutable: func(context.Context) (string, error) { return executable, nil },
	}
	cleanup, err := projector.Project(context.Background(), AuthFileProjection{SourcePath: source, TargetPath: target})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if cleanup != nil {
			_ = cleanup(context.Background())
		}
	})
	if err := os.WriteFile(target, []byte(`{"token":"session"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	waitForFileContent(t, source, `{"token":"session"}`)
	if err := os.WriteFile(source, []byte(`{"token":"stable-new"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	waitForFileContent(t, target, `{"token":"stable-new"}`)
	// Recover from the persisted marker instead of using the in-memory callback
	// to cover daemon/preparer restarts before runtime deletion.
	if err := recoverMutagenAuthSessions(context.Background(), root, root); err != nil {
		t.Fatal(err)
	}
	cleanup = nil
	command := exec.Command(executable, "daemon", "stop")
	command.Env = append(os.Environ(), "MUTAGEN_DATA_DIRECTORY="+filepath.Join(root, "mutagen"))
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("stop Mutagen test daemon: %v: %s", err, output)
	}
}

func TestMutagenInstallerDownloadsVerifiesAndReusesCache(t *testing.T) {
	binary := []byte("fake-mutagen-executable")
	var archive bytes.Buffer
	gzipWriter := gzip.NewWriter(&archive)
	tarWriter := tar.NewWriter(gzipWriter)
	if err := tarWriter.WriteHeader(&tar.Header{Name: "mutagen.exe", Mode: 0o755, Size: int64(len(binary)), Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	if _, err := tarWriter.Write(binary); err != nil {
		t.Fatal(err)
	}
	if err := tarWriter.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(archive.Bytes())
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		requests++
		_, _ = response.Write(archive.Bytes())
	}))
	defer server.Close()
	projector := MutagenAuthFileProjector{
		StateDir:      t.TempDir(),
		DownloadURL:   server.URL,
		ArchiveSHA256: hex.EncodeToString(digest[:]),
	}
	first, err := projector.installWindowsAMD64(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(first)
	if err != nil || !bytes.Equal(content, binary) {
		t.Fatalf("installed binary = %q, %v", content, err)
	}
	second, err := projector.installWindowsAMD64(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if second != first || requests != 1 {
		t.Fatalf("second path = %q, requests = %d; want %q, 1", second, requests, first)
	}
}

func waitForFileContent(t *testing.T, path, want string) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		content, err := os.ReadFile(path)
		if err == nil && string(content) == want {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	content, err := os.ReadFile(path)
	t.Fatalf("%s = %q, %v; want %q", path, content, err, want)
}
