package managedruntime

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

func TestConnectorRuntimeResolverUsesConfiguredV2Catalog(t *testing.T) {
	resolver := newV2ConnectorNodeResolver(t)

	resolved, err := resolver.ResolveProfile(context.Background(), ConnectorNodeProfile)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Profile != ConnectorNodeProfile {
		t.Fatalf("resolved profile = %q, want %q", resolved.Profile, ConnectorNodeProfile)
	}
	if resolved.ABI != "node22-"+appRuntimePlatformArch(runtime.GOOS, runtime.GOARCH) {
		t.Fatalf("resolved ABI = %q", resolved.ABI)
	}
	if resolved.Components["node"] != "22.22.3" {
		t.Fatalf("resolved components = %#v", resolved.Components)
	}
	if resolved.Node == nil || !strings.HasPrefix(resolved.Node.Path, resolved.Root) {
		t.Fatalf("resolved Node = %#v", resolved.Node)
	}
	verified, err := resolver.VerifyLaunch(ConnectorNodeProfile, "node")
	if err != nil || verified != *resolved.Node {
		t.Fatalf("VerifyLaunch() = %#v, %v", verified, err)
	}
}

func TestConnectorRuntimeResolverAcceptsPublishedLegacyNodeProfile(t *testing.T) {
	resolver := newV2ConnectorNodeResolver(t)
	resolved, err := resolver.ResolveProfile(context.Background(), ConnectorNodeProfile)
	if err != nil {
		t.Fatalf("ResolveProfile() error = %v", err)
	}
	if resolved.Node == nil {
		t.Fatal("ResolveProfile() did not resolve the legacy node-static profile")
	}
}

func TestConnectorRuntimeResolverRejectsChangedExecutableBeforeLaunch(t *testing.T) {
	resolver := newV2ConnectorNodeResolver(t)
	resolved, err := resolver.ResolveProfile(context.Background(), ConnectorNodeProfile)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(resolved.Node.Path, []byte("tampered"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := resolver.VerifyLaunch(ConnectorNodeProfile, "node"); err == nil || !strings.Contains(err.Error(), "identity changed") {
		t.Fatalf("VerifyLaunch() error = %v, want changed identity", err)
	}
}

func TestConnectorRuntimeResolverRejectsUnsupportedProfile(t *testing.T) {
	resolver := newV2ConnectorNodeResolver(t)
	if _, err := resolver.ResolveProfile(context.Background(), "../connector-node-static"); err == nil || !strings.Contains(err.Error(), "unsupported") {
		t.Fatalf("ResolveProfile() error = %v, want unsupported profile", err)
	}
}

func TestConnectorRuntimeResolverRequiresResolveBeforeLaunchVerification(t *testing.T) {
	resolver := newV2ConnectorNodeResolver(t)
	if _, err := resolver.VerifyLaunch(ConnectorNodeProfile, "node"); err == nil || !strings.Contains(err.Error(), "has not been resolved") {
		t.Fatalf("VerifyLaunch() error = %v, want unresolved profile", err)
	}
}

func newV2ConnectorNodeResolver(t *testing.T) *ConnectorRuntimeResolver {
	t.Helper()
	artifactPath := createManagedRuntimeComponentArchiveForTest(t, "node")
	artifactSHA, artifactSize, err := fileSHA256AndSize(artifactPath)
	if err != nil {
		t.Fatal(err)
	}
	catalogPath := filepath.Join(t.TempDir(), "catalog.json")
	catalog := `{
  "schemaVersion": "tutti.app.runtimes.v2",
  "runtimes": {
    "` + appRuntimePlatformArch(runtime.GOOS, runtime.GOARCH) + `": {
      "version": "2026.07.0",
      "components": {
        "node": {
          "version": "22.22.3",
          "artifactUrl": "` + filepath.ToSlash(artifactPath) + `",
          "artifactSha256": "` + artifactSHA + `",
          "artifactSizeBytes": ` + strconvFormatInt(artifactSize) + `
        }
      },
      "profiles": {
        "baseline": ["node"],
        "node-static": ["node"]
      }
    }
  }
}`
	if err := os.WriteFile(catalogPath, []byte(catalog), 0o600); err != nil {
		t.Fatal(err)
	}
	resolver, err := NewConnectorRuntimeResolver(ConnectorRuntimeResolverConfig{Resolver: DefaultResolver{
		RuntimeRoot: t.TempDir(),
		Environ: func() []string {
			return []string{tuttiAppRuntimeCatalogEnv + "=" + catalogPath, "PATH=/usr/bin:/bin"}
		},
	}})
	if err != nil {
		t.Fatal(err)
	}
	return resolver
}

func strconvFormatInt(value int64) string {
	return strconv.FormatInt(value, 10)
}
