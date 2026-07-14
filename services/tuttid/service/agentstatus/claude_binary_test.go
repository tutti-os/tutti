package agentstatus

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"

	"github.com/klauspost/compress/zstd"
)

const testClaudeVersion = "2.1.201"
const testClaudeNPMVersion = "0.3.201"

func testClaudeBinaryName() string {
	if runtime.GOOS == "windows" {
		return "claude.exe"
	}
	return "claude"
}

type claudeBinaryFixture struct {
	service   Service
	stateRoot string
	payload   []byte
}

func newClaudeBinaryFixture(t *testing.T, extraEnv ...string) claudeBinaryFixture {
	t.Helper()
	payload := []byte("fake-claude-binary payload for " + t.Name())
	sum := sha256.Sum256(payload)

	bundleDir := filepath.Join(t.TempDir(), "claude-sdk-sidecar")
	entry := filepath.Join(bundleDir, "src", "main.ts")
	if err := os.MkdirAll(filepath.Dir(entry), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(entry, []byte("// sidecar entry\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	sdkDir := filepath.Join(bundleDir, "node_modules", claudeSDKPackageScopeDir, claudeSDKPackageName)
	if err := os.MkdirAll(sdkDir, 0o755); err != nil {
		t.Fatal(err)
	}
	packageJSON := fmt.Sprintf(`{"name":"@anthropic-ai/claude-agent-sdk","version":%q}`, testClaudeNPMVersion)
	if err := os.WriteFile(filepath.Join(sdkDir, "package.json"), []byte(packageJSON), 0o644); err != nil {
		t.Fatal(err)
	}
	manifest := claudeSDKManifest{
		Version: testClaudeVersion,
		Platforms: map[string]claudeSDKManifestPlatform{
			claudeCodePlatformKey(runtime.GOOS, runtime.GOARCH): {
				Binary:   testClaudeBinaryName(),
				Checksum: hex.EncodeToString(sum[:]),
				Size:     int64(len(payload)),
			},
		},
	}
	manifestContent, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sdkDir, "manifest.json"), manifestContent, 0o644); err != nil {
		t.Fatal(err)
	}

	stateDir := t.TempDir()
	env := append([]string{
		claudeSDKSidecarEntryPathEnv + "=" + entry,
	}, extraEnv...)
	service := Service{
		Environ:            func() []string { return env },
		ClaudeCodeStateDir: stateDir,
	}
	return claudeBinaryFixture{
		service:   service,
		stateRoot: filepath.Join(stateDir, filepath.FromSlash(claudeCodeStateRelDir)),
		payload:   payload,
	}
}

func zstdCompress(t *testing.T, payload []byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer, err := zstd.NewWriter(&buffer)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write(payload); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func npmTarballWithBinary(t *testing.T, binaryName string, payload []byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	gzipWriter := gzip.NewWriter(&buffer)
	tarWriter := tar.NewWriter(gzipWriter)
	if err := tarWriter.WriteHeader(&tar.Header{
		Name: "package/package.json",
		Mode: 0o644,
		Size: int64(len("{}")),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := tarWriter.Write([]byte("{}")); err != nil {
		t.Fatal(err)
	}
	if err := tarWriter.WriteHeader(&tar.Header{
		Name: "package/" + binaryName,
		Mode: 0o755,
		Size: int64(len(payload)),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := tarWriter.Write(payload); err != nil {
		t.Fatal(err)
	}
	if err := tarWriter.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func (f claudeBinaryFixture) installedBinaryPath() string {
	return filepath.Join(f.stateRoot, "versions", testClaudeVersion, testClaudeBinaryName())
}

func TestEnsureClaudeCodeBinaryDownloadsFromCDN(t *testing.T) {
	var requests atomic.Int64
	var fixture claudeBinaryFixture
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		want := "/claude-code/" + testClaudeVersion + "/claude-" + claudeCodePlatformKey(runtime.GOOS, runtime.GOARCH) + ".zst"
		if r.URL.Path != want {
			t.Errorf("unexpected CDN path %q, want %q", r.URL.Path, want)
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(zstdCompress(t, fixture.payload))
	}))
	defer server.Close()
	fixture = newClaudeBinaryFixture(t, claudeCodeBinaryBaseURLEnv+"="+server.URL+"/claude-code")

	status, err := fixture.service.EnsureClaudeCodeBinary(context.Background())
	if err != nil {
		t.Fatalf("EnsureClaudeCodeBinary: %v", err)
	}
	if status.Source != "cdn" {
		t.Fatalf("source = %q, want cdn", status.Source)
	}
	if status.Version != testClaudeVersion {
		t.Fatalf("version = %q, want %q", status.Version, testClaudeVersion)
	}
	installed, err := os.ReadFile(fixture.installedBinaryPath())
	if err != nil {
		t.Fatalf("read installed binary: %v", err)
	}
	if !bytes.Equal(installed, fixture.payload) {
		t.Fatal("installed binary content mismatch")
	}
	info, err := os.Stat(fixture.installedBinaryPath())
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0 {
		t.Fatal("installed binary is not executable")
	}
	pointer, err := readClaudeCodePointer(fixture.stateRoot)
	if err != nil {
		t.Fatalf("read pointer: %v", err)
	}
	if pointer.Version != testClaudeVersion || pointer.Executable != fixture.installedBinaryPath() {
		t.Fatalf("pointer = %+v", pointer)
	}

	// A second ensure resolves from disk without re-downloading.
	downloaded := requests.Load()
	status, err = fixture.service.EnsureClaudeCodeBinary(context.Background())
	if err != nil {
		t.Fatalf("EnsureClaudeCodeBinary (second): %v", err)
	}
	if status.Source != "installed" {
		t.Fatalf("second source = %q, want installed", status.Source)
	}
	if requests.Load() != downloaded {
		t.Fatal("second ensure re-downloaded the binary")
	}
}

func TestEnsureClaudeCodeBinaryFallsBackToNPM(t *testing.T) {
	var fixture claudeBinaryFixture
	tarballPath := "/@anthropic-ai/claude-agent-sdk-" + claudeCodePlatformKey(runtime.GOOS, runtime.GOARCH) +
		"/-/claude-agent-sdk-" + claudeCodePlatformKey(runtime.GOOS, runtime.GOARCH) + "-" + testClaudeNPMVersion + ".tgz"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == tarballPath {
			_, _ = w.Write(npmTarballWithBinary(t, testClaudeBinaryName(), fixture.payload))
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()
	fixture = newClaudeBinaryFixture(t,
		claudeCodeBinaryBaseURLEnv+"="+server.URL+"/missing-cdn",
		agentNPMRegistryEnv+"="+server.URL,
	)

	status, err := fixture.service.EnsureClaudeCodeBinary(context.Background())
	if err != nil {
		t.Fatalf("EnsureClaudeCodeBinary: %v", err)
	}
	if status.Source != "npm" {
		t.Fatalf("source = %q, want npm", status.Source)
	}
	installed, err := os.ReadFile(fixture.installedBinaryPath())
	if err != nil {
		t.Fatalf("read installed binary: %v", err)
	}
	if !bytes.Equal(installed, fixture.payload) {
		t.Fatal("installed binary content mismatch")
	}
}

func TestEnsureClaudeCodeBinaryRejectsChecksumMismatch(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		payload := []byte("tampered payload of matching length!!!!!!")
		_, _ = w.Write(zstdCompress(t, payload))
	}))
	defer server.Close()
	fixture := newClaudeBinaryFixture(t,
		claudeCodeBinaryBaseURLEnv+"="+server.URL,
		agentNPMRegistryEnv+"="+server.URL+"/missing-registry",
	)
	// Match the manifest size so only the checksum gate can reject it.
	tampered := make([]byte, len(fixture.payload))
	copy(tampered, "tampered payload")
	server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(zstdCompress(t, tampered))
	})

	if _, err := fixture.service.EnsureClaudeCodeBinary(context.Background()); err == nil {
		t.Fatal("expected checksum mismatch error")
	}
	if _, err := os.Stat(fixture.installedBinaryPath()); !os.IsNotExist(err) {
		t.Fatalf("tampered binary must not stay installed: %v", err)
	}
	if _, err := readClaudeCodePointer(fixture.stateRoot); !os.IsNotExist(err) {
		t.Fatalf("pointer must not be written on failure: %v", err)
	}
}

func TestEnsureClaudeCodeBinarySkipsWhenNativePackagePresent(t *testing.T) {
	fixture := newClaudeBinaryFixture(t)
	entry := ""
	for _, kv := range fixture.service.Environ() {
		if len(kv) > len(claudeSDKSidecarEntryPathEnv)+1 && kv[:len(claudeSDKSidecarEntryPathEnv)] == claudeSDKSidecarEntryPathEnv {
			entry = kv[len(claudeSDKSidecarEntryPathEnv)+1:]
		}
	}
	bundleDir := filepath.Dir(filepath.Dir(entry))
	nativeDir := filepath.Join(bundleDir, "node_modules", claudeSDKPackageScopeDir,
		claudeSDKPackageName+"-"+claudeCodePlatformKey(runtime.GOOS, runtime.GOARCH))
	if err := os.MkdirAll(nativeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(nativeDir, testClaudeBinaryName()), fixture.payload, 0o755); err != nil {
		t.Fatal(err)
	}

	status, err := fixture.service.EnsureClaudeCodeBinary(context.Background())
	if err != nil {
		t.Fatalf("EnsureClaudeCodeBinary: %v", err)
	}
	if status.Source != "native_package_present" {
		t.Fatalf("source = %q, want native_package_present", status.Source)
	}
	if status.Path != "" {
		t.Fatalf("path = %q, want empty", status.Path)
	}
}

func TestClaudeCodePlatformKey(t *testing.T) {
	cases := []struct {
		goos, goarch, want string
	}{
		{"darwin", "arm64", "darwin-arm64"},
		{"darwin", "amd64", "darwin-x64"},
		{"linux", "amd64", "linux-x64"},
		{"linux", "arm64", "linux-arm64"},
		{"windows", "amd64", "win32-x64"},
		{"windows", "arm64", "win32-arm64"},
		{"plan9", "amd64", ""},
		{"linux", "riscv64", ""},
	}
	for _, tc := range cases {
		if got := claudeCodePlatformKey(tc.goos, tc.goarch); got != tc.want {
			t.Errorf("claudeCodePlatformKey(%s,%s) = %q, want %q", tc.goos, tc.goarch, got, tc.want)
		}
	}
}

func TestClaudeBinaryLockIsRecognized(t *testing.T) {
	if !requiresInstallCommandLock(claudeCodeBinaryLockCommand) {
		t.Fatal("claude binary provisioning must acquire an install lock")
	}
	lockPath := installCommandLockPath(claudeCodeBinaryLockCommand)
	if filepath.Base(lockPath) != "claude-code-runtime-binary.lock" {
		t.Fatalf("lock path = %q, want dedicated claude lock file", lockPath)
	}
	if lockPath == installCommandLockPath("npm install -g something") {
		t.Fatal("claude lock must not share the npm global install lock")
	}
}

func TestPromoteClaudeBinaryRejectsMismatchedStaging(t *testing.T) {
	dir := t.TempDir()
	staging := filepath.Join(dir, ".claude.staging")
	final := filepath.Join(dir, "claude")
	if err := os.WriteFile(staging, []byte("not the pinned bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	descriptor := claudeSDKRuntimeDescriptor{
		PlatformKey: "darwin-arm64",
		SHA256:      "0000000000000000000000000000000000000000000000000000000000000000",
	}
	if err := promoteClaudeBinary(staging, final, descriptor); err == nil {
		t.Fatal("expected sha256 mismatch error")
	}
	if _, err := os.Stat(final); !os.IsNotExist(err) {
		t.Fatalf("final path must never receive unverified bytes: %v", err)
	}
	if _, err := os.Stat(staging); !os.IsNotExist(err) {
		t.Fatalf("rejected staging file must be removed: %v", err)
	}
}

func TestExtractClaudeBinaryFromTarballBoundsSize(t *testing.T) {
	dir := t.TempDir()
	oversized := bytes.Repeat([]byte("A"), 4096)
	archive := filepath.Join(dir, "package.tgz")
	if err := os.WriteFile(archive, npmTarballWithBinary(t, "claude", oversized), 0o644); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(dir, ".claude.staging")
	err := extractClaudeBinaryFromTarball(archive, "claude", destination, 128)
	if err == nil {
		t.Fatal("expected size mismatch error for oversized member")
	}
	if _, statErr := os.Stat(destination); !os.IsNotExist(statErr) {
		t.Fatalf("oversized extraction must not leave a file: %v", statErr)
	}
}

func TestNPMPackageTarballURL(t *testing.T) {
	got := npmPackageTarballURL("https://registry.npmjs.org/", "@anthropic-ai/claude-agent-sdk-darwin-arm64", "0.3.201")
	want := "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-darwin-arm64/-/claude-agent-sdk-darwin-arm64-0.3.201.tgz"
	if got != want {
		t.Fatalf("npmPackageTarballURL = %q, want %q", got, want)
	}
	if npmPackageTarballURL("", "pkg", "1.0.0") != "" {
		t.Fatal("empty registry must produce empty URL")
	}
}
