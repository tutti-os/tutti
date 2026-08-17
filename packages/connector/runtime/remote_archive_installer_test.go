package runtime

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	market "github.com/tutti-os/tutti/packages/connector/host"
	marketartifact "github.com/tutti-os/tutti/packages/connector/runtime/artifact"
)

func TestRemoteArchiveInstallerInstallsAndDetectsTreeDrift(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("remote archive v1 intentionally fails closed on Windows")
	}
	archive, release := remoteArchiveFixture(t)
	requests := 0
	installer, err := NewRemoteArchiveInstaller(RemoteArchiveInstallerConfig{
		RootDir:                              t.TempDir(),
		UnsafeAllowUnpinnedTransportForTests: true,
		HTTPClient: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			requests++
			return &http.Response{StatusCode: http.StatusOK, ContentLength: int64(len(archive)), Body: io.NopCloser(bytes.NewReader(archive)), Header: make(http.Header), Request: request}, nil
		})},
		LookupIP: func(context.Context, string) ([]net.IPAddr, error) {
			return []net.IPAddr{{IP: net.ParseIP("8.8.8.8")}}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = installer.RemoveConnector(context.Background(), market.RemoveConnectorInstallationRequest{ConnectorKey: release.ConnectorKey})
	})
	receipt, err := installer.InstallCLI(t.Context(), market.InstallCLIRequest{OperationID: "install-1", Release: release})
	if err != nil {
		t.Fatal(err)
	}
	if requests != 1 || receipt.SchemaVersion != remoteArchiveReceiptSchema || receipt.InventorySHA256 != release.Manifest.Implementation.ManagedStdio.CLI.Install.RemoteArchive.Extraction.InventorySHA256 {
		t.Fatalf("requests=%d receipt=%#v", requests, receipt)
	}
	if _, err := installer.InstallCLI(t.Context(), market.InstallCLIRequest{OperationID: "install-2", Release: release}); err != nil {
		t.Fatal(err)
	}
	if requests != 1 {
		t.Fatalf("archive downloaded %d times, want cache reuse", requests)
	}
	if err := os.Chmod(filepath.Join(receipt.InstallRoot, "README.txt"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(receipt.InstallRoot, "README.txt"), []byte("tampered"), 0o400); err != nil {
		t.Fatal(err)
	}
	if _, err := installer.ResolveCLI(t.Context(), release); !strings.Contains(err.Error(), market.ErrReleaseInstallationInvalid.Error()) {
		t.Fatalf("ResolveCLI() error = %v, want invalid installation", err)
	}
}

func TestRemoteArchiveInstallerRejectsNonPublicResolution(t *testing.T) {
	archive, release := remoteArchiveFixture(t)
	installer, err := NewRemoteArchiveInstaller(RemoteArchiveInstallerConfig{
		RootDir: t.TempDir(), UnsafeAllowUnpinnedTransportForTests: true, HTTPClient: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: http.StatusOK, ContentLength: int64(len(archive)), Body: io.NopCloser(bytes.NewReader(archive)), Header: make(http.Header), Request: request}, nil
		})},
		LookupIP: func(context.Context, string) ([]net.IPAddr, error) {
			return []net.IPAddr{{IP: net.ParseIP("127.0.0.1")}}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := installer.InstallCLI(t.Context(), market.InstallCLIRequest{OperationID: "install-1", Release: release}); err == nil || !strings.Contains(err.Error(), "non-public") {
		t.Fatalf("InstallCLI() error = %v, want non-public host rejection", err)
	}
}

func TestRemoteArchiveInstallerRejectsSymlinkedStaging(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("remote archive v1 intentionally fails closed on Windows")
	}
	archive, release := remoteArchiveFixture(t)
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "staging"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "staging", "install-1")); err != nil {
		t.Fatal(err)
	}
	installer, err := NewRemoteArchiveInstaller(RemoteArchiveInstallerConfig{
		RootDir:                              root,
		UnsafeAllowUnpinnedTransportForTests: true,
		HTTPClient: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: http.StatusOK, ContentLength: int64(len(archive)), Body: io.NopCloser(bytes.NewReader(archive)), Header: make(http.Header), Request: request}, nil
		})},
		LookupIP: func(context.Context, string) ([]net.IPAddr, error) {
			return []net.IPAddr{{IP: net.ParseIP("8.8.8.8")}}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := installer.InstallCLI(t.Context(), market.InstallCLIRequest{OperationID: "install-1", Release: release}); err == nil || !strings.Contains(err.Error(), "symbolic link") {
		t.Fatalf("InstallCLI() error = %v, want symlink rejection", err)
	}
}

func TestRemoteArchivePromoteRestoresQuarantinedTarget(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("remote archive v1 intentionally fails closed on Windows")
	}
	root := t.TempDir()
	installer, err := NewRemoteArchiveInstaller(RemoteArchiveInstallerConfig{RootDir: root})
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "releases", "aws-cli", strings.Repeat("a", 64))
	staging := filepath.Join(root, "staging", "install-1")
	if err := os.MkdirAll(target, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "old"), []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(staging, 0o700); err != nil {
		t.Fatal(err)
	}
	realRename := installer.rename
	failed := false
	installer.rename = func(oldPath, newPath string) error {
		if oldPath == staging && newPath == target && !failed {
			failed = true
			return errors.New("injected activation failure")
		}
		return realRename(oldPath, newPath)
	}
	if err := installer.promote(staging, target, "install-1"); err == nil {
		t.Fatal("promote succeeded after injected activation failure")
	}
	if data, err := os.ReadFile(filepath.Join(target, "old")); err != nil || string(data) != "old" {
		t.Fatalf("old target was not restored: data=%q error=%v", data, err)
	}
}

func TestRemoteArchivePromoteRejectsSymlinkedReleaseParent(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("remote archive v1 intentionally fails closed on Windows")
	}
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "releases")); err != nil {
		t.Fatal(err)
	}
	staging := filepath.Join(root, "staging", "install-1")
	if err := os.MkdirAll(staging, 0o700); err != nil {
		t.Fatal(err)
	}
	installer, err := NewRemoteArchiveInstaller(RemoteArchiveInstallerConfig{RootDir: root})
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "releases", "aws-cli", strings.Repeat("a", 64))
	if err := installer.promote(staging, target, "install-1"); err == nil || !strings.Contains(err.Error(), "symbolic link") {
		t.Fatalf("promote() error = %v, want symlink rejection", err)
	}
	if _, err := os.Stat(filepath.Join(outside, "aws-cli", strings.Repeat("a", 64))); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("promote wrote outside the managed root: %v", err)
	}
	if _, err := os.Stat(filepath.Join(outside, "aws-cli")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("promote created a directory outside the managed root: %v", err)
	}
}

func TestRemoteArchiveRemoveRejectsSymlinkedParentBeforeChmod(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("remote archive v1 intentionally fails closed on Windows")
	}
	root := t.TempDir()
	outside := t.TempDir()
	externalConnector := filepath.Join(outside, "aws-cli")
	if err := os.MkdirAll(externalConnector, 0o700); err != nil {
		t.Fatal(err)
	}
	externalFile := filepath.Join(externalConnector, "keep")
	if err := os.WriteFile(externalFile, []byte("keep"), 0o400); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(externalConnector, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(externalConnector, 0o700) })
	if err := os.Symlink(outside, filepath.Join(root, "releases")); err != nil {
		t.Fatal(err)
	}
	installer, err := NewRemoteArchiveInstaller(RemoteArchiveInstallerConfig{RootDir: root})
	if err != nil {
		t.Fatal(err)
	}
	err = installer.RemoveConnector(t.Context(), market.RemoveConnectorInstallationRequest{ConnectorKey: "aws-cli"})
	if err == nil || !strings.Contains(err.Error(), "symbolic link") {
		t.Fatalf("RemoveConnector() error = %v, want symlink rejection", err)
	}
	info, statErr := os.Stat(externalFile)
	if statErr != nil || info.Mode().Perm() != 0o400 {
		t.Fatalf("external file mode changed before rejection: mode=%v error=%v", info.Mode().Perm(), statErr)
	}
}

func TestRemoteArchiveCacheRejectsMatchingSymlink(t *testing.T) {
	archive, release := remoteArchiveFixture(t)
	source := release.Manifest.Implementation.ManagedStdio.CLI.Install.RemoteArchive.Source
	outside := filepath.Join(t.TempDir(), "archive.zip")
	if err := os.WriteFile(outside, archive, 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "cached.archive")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	if err := verifyRemoteArchiveFile(link, source); err == nil || !strings.Contains(err.Error(), "cache identity") {
		t.Fatalf("verifyRemoteArchiveFile() error = %v, want symlink rejection", err)
	}
}

func TestRemoteArchiveResolveRejectsSymlinkedReleaseParent(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("remote archive v1 intentionally fails closed on Windows")
	}
	archive, release := remoteArchiveFixture(t)
	root := t.TempDir()
	installer, err := NewRemoteArchiveInstaller(RemoteArchiveInstallerConfig{
		RootDir: root, UnsafeAllowUnpinnedTransportForTests: true,
		HTTPClient: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: http.StatusOK, ContentLength: int64(len(archive)), Body: io.NopCloser(bytes.NewReader(archive)), Header: make(http.Header), Request: request}, nil
		})},
		LookupIP: func(context.Context, string) ([]net.IPAddr, error) {
			return []net.IPAddr{{IP: net.ParseIP("8.8.8.8")}}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := installer.InstallCLI(t.Context(), market.InstallCLIRequest{OperationID: "install-1", Release: release}); err != nil {
		t.Fatal(err)
	}
	externalReleases := filepath.Join(t.TempDir(), "releases")
	if err := os.Rename(filepath.Join(root, "releases"), externalReleases); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = makeRemoteArchiveWritable(externalReleases) })
	if err := os.Symlink(externalReleases, filepath.Join(root, "releases")); err != nil {
		t.Fatal(err)
	}
	if _, err := installer.ResolveCLI(t.Context(), release); err == nil || !strings.Contains(err.Error(), market.ErrReleaseInstallationInvalid.Error()) {
		t.Fatalf("ResolveCLI() error = %v, want invalid installation", err)
	}
}

func TestRemoteArchivePromoteRemovesNewTargetWhenSyncRollbackRenameFails(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("remote archive v1 intentionally fails closed on Windows")
	}
	root := t.TempDir()
	installer, err := NewRemoteArchiveInstaller(RemoteArchiveInstallerConfig{RootDir: root})
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "releases", "aws-cli", strings.Repeat("a", 64))
	staging := filepath.Join(root, "staging", "install-1")
	if err := os.MkdirAll(target, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "old"), []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(staging, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(staging, "new"), []byte("new"), 0o600); err != nil {
		t.Fatal(err)
	}
	realRename := installer.rename
	installer.rename = func(oldPath, newPath string) error {
		if oldPath == target && newPath == staging {
			return errors.New("injected rollback rename failure")
		}
		return realRename(oldPath, newPath)
	}
	installer.syncDir = func(string) error { return errors.New("injected sync failure") }
	if err := installer.promote(staging, target, "install-1"); err == nil {
		t.Fatal("promote succeeded after injected sync failure")
	}
	if data, err := os.ReadFile(filepath.Join(target, "old")); err != nil || string(data) != "old" {
		t.Fatalf("old target was not restored after rollback rename failure: data=%q error=%v", data, err)
	}
	if _, err := os.Stat(filepath.Join(target, "new")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("new target remained active after failed promote: %v", err)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func TestRemoteArchiveInstallerRejectsUnpinnedCustomTransport(t *testing.T) {
	_, err := NewRemoteArchiveInstaller(RemoteArchiveInstallerConfig{
		RootDir: t.TempDir(), HTTPClient: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) { return nil, errors.New("unused") })},
	})
	if err == nil || !strings.Contains(err.Error(), "pinned dialing") {
		t.Fatalf("NewRemoteArchiveInstaller() error = %v, want pinned transport rejection", err)
	}
}

func TestRemoteArchiveInstallerDisablesProxyAndRejectsTLSDialOverride(t *testing.T) {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = http.ProxyURL(&url.URL{Scheme: "http", Host: "proxy.invalid"})
	installer, err := NewRemoteArchiveInstaller(RemoteArchiveInstallerConfig{RootDir: t.TempDir(), HTTPClient: &http.Client{Transport: transport}})
	if err != nil {
		t.Fatal(err)
	}
	if installer.httpClient.Transport.(*http.Transport).Proxy != nil {
		t.Fatal("remote archive transport retained a proxy that can bypass DNS pinning")
	}
	transport = http.DefaultTransport.(*http.Transport).Clone()
	transport.DialTLSContext = func(context.Context, string, string) (net.Conn, error) { return nil, errors.New("unused") }
	_, err = NewRemoteArchiveInstaller(RemoteArchiveInstallerConfig{RootDir: t.TempDir(), HTTPClient: &http.Client{Transport: transport}})
	if err == nil || !strings.Contains(err.Error(), "TLS dialing") {
		t.Fatalf("NewRemoteArchiveInstaller() error = %v, want TLS dial override rejection", err)
	}
	transport = http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} //nolint:gosec // The installer must reject this test input.
	_, err = NewRemoteArchiveInstaller(RemoteArchiveInstallerConfig{RootDir: t.TempDir(), HTTPClient: &http.Client{Transport: transport}})
	if err == nil || !strings.Contains(err.Error(), "verify TLS") {
		t.Fatalf("NewRemoteArchiveInstaller() error = %v, want insecure TLS rejection", err)
	}
}

func remoteArchiveFixture(t *testing.T) ([]byte, market.Release) {
	t.Helper()
	root := t.TempDir()
	awsRoot := filepath.Join(root, "aws")
	if err := os.MkdirAll(filepath.Join(awsRoot, "dist"), 0o700); err != nil {
		t.Fatal(err)
	}
	entrypointContent := []byte("aws fixture")
	if err := os.WriteFile(filepath.Join(awsRoot, "dist", "aws"), entrypointContent, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(awsRoot, "README.txt"), []byte("license"), 0o600); err != nil {
		t.Fatal(err)
	}
	identity, err := marketartifact.InspectTree(awsRoot)
	if err != nil {
		t.Fatal(err)
	}
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for _, relative := range []string{"aws/", "aws/dist/", "aws/dist/aws", "aws/README.txt"} {
		header := &zip.FileHeader{Name: relative, Method: zip.Deflate}
		if strings.HasSuffix(relative, "/") {
			header.SetMode(os.ModeDir | 0o700)
		}
		entry, err := writer.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		switch relative {
		case "aws/dist/aws":
			_, err = entry.Write(entrypointContent)
		case "aws/README.txt":
			_, err = entry.Write([]byte("license"))
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	archive := buffer.Bytes()
	archiveDigest := sha256.Sum256(archive)
	entryDigest := sha256.Sum256(entrypointContent)
	release := market.Release{
		SchemaVersion: "1", ReleaseID: "aws-cli@0.2.0", ConnectorKey: "aws-cli", Version: "0.2.0",
		ReleaseDigest: strings.Repeat("1", 64), ManifestDigest: strings.Repeat("2", 64),
		Artifact:    market.Artifact{Key: "aws-cli.tgz", SHA256: strings.Repeat("3", 64), SizeBytes: 1, MediaType: "application/gzip"},
		PublishedAt: time.Unix(1, 0).UTC(), Status: market.ReleaseStatusAvailable,
		Manifest: market.Manifest{SchemaVersion: "1", DisplayName: "AWS CLI", IconURL: "data:image/png;base64,iVBORw0KGgo=", AuthorizationKind: "none", Compatibility: market.CompatibilityRequirements{MinimumHostVersion: "0.2.27"},
			Implementation: market.Implementation{Kind: market.ImplementationKindManagedStdio, ManagedStdio: &market.ManagedStdioImplementation{
				Runtime: market.RuntimeRequirement{Language: "node", Profile: ConnectorNodeProfile, ABI: "node22-" + runtime.GOOS + "-" + runtime.GOARCH, VersionRange: ">=22.0.0 <23.0.0"},
				CLI: &market.ManagedCLIInterface{Entrypoint: "dist/aws", Command: "aws", TimeoutMS: 120_000, Install: &market.CLIInstallation{Kind: "remote_archive", RemoteArchive: &market.RemoteArchiveInstallation{
					Source:     market.RemoteArchiveSource{URL: "https://awscli.amazonaws.com/awscliv2.zip", AllowedHosts: []string{"awscli.amazonaws.com"}, Format: "zip", SHA256: hex.EncodeToString(archiveDigest[:]), SizeBytes: int64(len(archive))},
					Extraction: market.RemoteArchiveExtraction{Root: "aws", FileCount: identity.FileCount, ExpandedSizeBytes: identity.ExpandedSizeBytes, InventoryAlgorithm: identity.Algorithm, InventorySHA256: identity.SHA256},
					Launch:     market.RemoteArchiveLaunch{Kind: "native", Entrypoint: "dist/aws", SHA256: hex.EncodeToString(entryDigest[:]), SizeBytes: int64(len(entrypointContent))},
				}}},
			}},
		},
	}
	return archive, release
}
