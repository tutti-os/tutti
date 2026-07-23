package agentextension

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

func TestResolveManagedUVToolchainDownloadsVerifiesAndCaches(t *testing.T) {
	uvBytes := []byte("#!/bin/sh\necho fake-uv\n")
	archive := buildUVToolchainTarGz(t, "uv-bundle/uv", uvBytes)
	var hits atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		_, _ = w.Write(archive)
	}))
	defer server.Close()
	root := testResolvedTempDir(t)
	artifact := testUVToolArtifact(server.URL+"/uv.tar.gz", archive, "tar.gz", "uv-bundle/uv")

	toolDir, err := ensureManagedUVToolchain(context.Background(), server.Client(), root, artifact)
	if err != nil {
		t.Fatal(err)
	}
	wantDir := filepath.Join(root, "_tools", "uv", runtimePlatform(), artifact.Version)
	if toolDir != wantDir {
		t.Fatalf("tool dir = %q, want %q", toolDir, wantDir)
	}
	uvPath := filepath.Join(toolDir, uvExecutableName())
	contents, err := os.ReadFile(uvPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(contents, uvBytes) {
		t.Fatalf("extracted uv bytes = %q, want %q", contents, uvBytes)
	}
	info, err := os.Lstat(uvPath)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&0o111 == 0 {
		t.Fatalf("uv mode = %v, error = %v", info, err)
	}
	if _, err := os.Lstat(filepath.Join(toolDir, uvToolchainVerifiedName)); err != nil {
		t.Fatalf("verified marker missing: %v", err)
	}

	cachedDir, err := ensureManagedUVToolchain(context.Background(), server.Client(), root, artifact)
	if err != nil {
		t.Fatal(err)
	}
	if cachedDir != toolDir {
		t.Fatalf("cached dir = %q, want %q", cachedDir, toolDir)
	}
	if got := hits.Load(); got != 1 {
		t.Fatalf("server hits = %d, want 1 (cache hit on second resolve)", got)
	}
}

func TestResolveManagedUVToolchainSupportsZipArchives(t *testing.T) {
	uvBytes := []byte("MZ fake uv exe")
	archive := buildUVToolchainZip(t, "uv.exe", uvBytes)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(archive)
	}))
	defer server.Close()
	artifact := testUVToolArtifact(server.URL+"/uv.zip", archive, "zip", "uv.exe")

	toolDir, err := ensureManagedUVToolchain(context.Background(), server.Client(), testResolvedTempDir(t), artifact)
	if err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(filepath.Join(toolDir, uvExecutableName()))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(contents, uvBytes) {
		t.Fatalf("extracted uv bytes = %q, want %q", contents, uvBytes)
	}
}

func TestResolveManagedUVToolchainRejectsChecksumMismatch(t *testing.T) {
	archive := buildUVToolchainTarGz(t, "uv-bundle/uv", []byte("fake"))
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(archive)
	}))
	defer server.Close()
	root := testResolvedTempDir(t)
	artifact := testUVToolArtifact(server.URL+"/uv.tar.gz", archive, "tar.gz", "uv-bundle/uv")
	artifact.SHA256 = strings.Repeat("0", 64)

	_, err := ensureManagedUVToolchain(context.Background(), server.Client(), root, artifact)
	if err == nil || !strings.Contains(err.Error(), "SHA-256") {
		t.Fatalf("checksum mismatch error = %v", err)
	}
	assertUVToolchainAbsent(t, root, artifact)
}

func TestResolveManagedUVToolchainRejectsSizeMismatch(t *testing.T) {
	archive := buildUVToolchainTarGz(t, "uv-bundle/uv", []byte("fake"))
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(archive)
	}))
	defer server.Close()
	root := testResolvedTempDir(t)
	artifact := testUVToolArtifact(server.URL+"/uv.tar.gz", archive, "tar.gz", "uv-bundle/uv")
	artifact.SizeBytes++

	_, err := ensureManagedUVToolchain(context.Background(), server.Client(), root, artifact)
	if err == nil {
		t.Fatal("size mismatch unexpectedly succeeded")
	}
	assertUVToolchainAbsent(t, root, artifact)
}

func TestResolveManagedUVToolchainRejectsUnsafeArchiveMembers(t *testing.T) {
	for _, test := range []struct {
		name       string
		memberName string
		symlink    bool
	}{
		{name: "path-traversal", memberName: "../evil"},
		{name: "absolute", memberName: "/evil"},
		{name: "symlink", memberName: "uv-bundle/uv", symlink: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			var archive []byte
			if test.symlink {
				archive = buildUVToolchainTarGzSymlink(t, test.memberName, "target")
			} else {
				archive = buildUVToolchainTarGz(t, test.memberName, []byte("x"))
			}
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write(archive)
			}))
			defer server.Close()
			root := testResolvedTempDir(t)
			artifact := testUVToolArtifact(server.URL+"/uv.tar.gz", archive, "tar.gz", "uv-bundle/uv")

			_, err := ensureManagedUVToolchain(context.Background(), server.Client(), root, artifact)
			if err == nil {
				t.Fatal("unsafe archive unexpectedly succeeded")
			}
			assertUVToolchainAbsent(t, root, artifact)
		})
	}
}

func TestResolveManagedUVToolchainRejectsHTTPSDowngradeRedirect(t *testing.T) {
	insecure := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("untrusted"))
	}))
	defer insecure.Close()
	secure := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		http.Redirect(w, request, insecure.URL+"/uv.tar.gz", http.StatusFound)
	}))
	defer secure.Close()
	root := testResolvedTempDir(t)
	payload := []byte("untrusted")
	artifact := testUVToolArtifact(secure.URL, payload, "tar.gz", "uv-bundle/uv")

	_, err := ensureManagedUVToolchain(context.Background(), secure.Client(), root, artifact)
	if err == nil || !strings.Contains(err.Error(), "redirected away from HTTPS") {
		t.Fatalf("HTTPS downgrade error = %v", err)
	}
	assertUVToolchainAbsent(t, root, artifact)
}

func TestResolveManagedUVToolchainReplacesUnverifiedCache(t *testing.T) {
	uvBytes := []byte("fresh-uv")
	archive := buildUVToolchainTarGz(t, "uv-bundle/uv", uvBytes)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(archive)
	}))
	defer server.Close()
	root := testResolvedTempDir(t)
	artifact := testUVToolArtifact(server.URL+"/uv.tar.gz", archive, "tar.gz", "uv-bundle/uv")
	// Plant an unverified executable: no marker, so the cache must not be trusted.
	toolDir, uvPath := uvToolchainDirs(root, artifact)
	if err := os.MkdirAll(toolDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(uvPath, []byte("stale"), 0o700); err != nil {
		t.Fatal(err)
	}

	if _, err := ensureManagedUVToolchain(context.Background(), server.Client(), root, artifact); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(uvPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(contents, uvBytes) {
		t.Fatalf("uv bytes = %q, want re-downloaded %q", contents, uvBytes)
	}
}

func testUVToolArtifact(rawURL string, payload []byte, archiveKind, executable string) tuttitypes.UVToolArtifact {
	return tuttitypes.UVToolArtifact{
		Version:           "0.11.31",
		Platform:          runtimePlatform(),
		URL:               rawURL,
		SHA256:            sha256Bytes(payload),
		SizeBytes:         int64(len(payload)),
		Archive:           archiveKind,
		ArchiveExecutable: executable,
	}
}

func assertUVToolchainAbsent(t *testing.T, root string, artifact tuttitypes.UVToolArtifact) {
	t.Helper()
	_, uvPath := uvToolchainDirs(root, artifact)
	assertPathDoesNotExist(t, uvPath)
}

func buildUVToolchainTarGz(t *testing.T, name string, contents []byte) []byte {
	t.Helper()
	buffer := &bytes.Buffer{}
	gzipWriter := gzip.NewWriter(buffer)
	tarWriter := tar.NewWriter(gzipWriter)
	if err := tarWriter.WriteHeader(&tar.Header{
		Name: name, Mode: 0o755, Size: int64(len(contents)), Typeflag: tar.TypeReg,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := tarWriter.Write(contents); err != nil {
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

func buildUVToolchainTarGzSymlink(t *testing.T, name, target string) []byte {
	t.Helper()
	buffer := &bytes.Buffer{}
	gzipWriter := gzip.NewWriter(buffer)
	tarWriter := tar.NewWriter(gzipWriter)
	if err := tarWriter.WriteHeader(&tar.Header{
		Name: name, Mode: 0o777, Typeflag: tar.TypeSymlink, Linkname: target,
	}); err != nil {
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

func buildUVToolchainZip(t *testing.T, name string, contents []byte) []byte {
	t.Helper()
	buffer := &bytes.Buffer{}
	writer := zip.NewWriter(buffer)
	member, err := writer.Create(name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := member.Write(contents); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}
