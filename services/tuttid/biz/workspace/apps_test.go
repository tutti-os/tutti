package workspace

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAppPackageIconDataURLAllowsUploadedIconLimit(t *testing.T) {
	t.Parallel()

	packageDir := t.TempDir()
	iconData := append([]byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}, bytes.Repeat([]byte{0}, 300*1024)...)
	if err := os.WriteFile(filepath.Join(packageDir, "icon.png"), iconData, 0o644); err != nil {
		t.Fatalf("write icon: %v", err)
	}

	appPackage := AppPackage{
		PackageDir: packageDir,
		Manifest: AppManifest{
			Icon: AppManifestIcon{
				Type: "asset",
				Src:  "icon.png",
			},
		},
	}

	iconURL := appPackage.IconDataURL()
	if iconURL == nil || !strings.HasPrefix(*iconURL, "data:image/png;base64,") {
		t.Fatalf("IconDataURL() = %v, want png data URL", iconURL)
	}
}

func TestAppPackageLocalizationsReadsManifestLocaleFiles(t *testing.T) {
	t.Parallel()

	packageDir := t.TempDir()
	localeDir := filepath.Join(packageDir, "locales", "zh-CN")
	if err := os.MkdirAll(localeDir, 0o755); err != nil {
		t.Fatalf("create locale dir: %v", err)
	}
	if err := os.WriteFile(
		filepath.Join(localeDir, "manifest.json"),
		[]byte(`{"name":"自动化","description":"管理工作区自动化任务。","tags":["自动化","工作区"]}`),
		0o644,
	); err != nil {
		t.Fatalf("write locale file: %v", err)
	}

	appPackage := AppPackage{
		PackageDir: packageDir,
		Manifest: AppManifest{
			LocalizationInfo: &AppManifestLocalizationInfo{
				DefaultLocale: "en",
				AdditionalLocales: []AppManifestLocalizationFile{
					{
						Locale: "zh-CN",
						File:   "locales/zh-CN/manifest.json",
					},
				},
			},
		},
	}

	localizations := appPackage.Localizations()
	if len(localizations) != 1 {
		t.Fatalf("Localizations() length = %d, want 1", len(localizations))
	}
	if localizations[0].Locale != "zh-CN" || localizations[0].Name != "自动化" || len(localizations[0].Tags) != 2 {
		t.Fatalf("Localizations()[0] = %#v", localizations[0])
	}
}

func TestValidateAppManifestRejectsInvalidLocalizationInfo(t *testing.T) {
	t.Parallel()

	manifest := validTestAppManifest()
	manifest.LocalizationInfo = &AppManifestLocalizationInfo{
		DefaultLocale: "en",
		AdditionalLocales: []AppManifestLocalizationFile{
			{
				Locale: "zh-CN",
				File:   "../manifest.json",
			},
		},
	}

	if err := ValidateAppManifest(manifest); err == nil {
		t.Fatal("ValidateAppManifest() error = nil, want invalid localizationInfo error")
	}
}

func TestAppPackageMinimizeBehaviorDefaultsToKeepMounted(t *testing.T) {
	t.Parallel()

	appPackage := AppPackage{
		Manifest: AppManifest{},
	}

	if got := appPackage.MinimizeBehavior(); got != "keep-mounted" {
		t.Fatalf("MinimizeBehavior() = %q, want keep-mounted", got)
	}
}

func TestAppPackageWindowMinimumSize(t *testing.T) {
	t.Parallel()

	minWidth := 720
	minHeight := 520
	appPackage := AppPackage{
		Manifest: AppManifest{
			Window: &AppManifestWindow{
				MinWidth:  &minWidth,
				MinHeight: &minHeight,
			},
		},
	}

	if got := appPackage.WindowMinWidth(); got == nil || *got != minWidth {
		t.Fatalf("WindowMinWidth() = %v, want %d", got, minWidth)
	}
	if got := appPackage.WindowMinHeight(); got == nil || *got != minHeight {
		t.Fatalf("WindowMinHeight() = %v, want %d", got, minHeight)
	}
}

func TestAppPackageReferenceListSupported(t *testing.T) {
	t.Parallel()

	appPackage := AppPackage{
		Manifest: AppManifest{
			References: &AppManifestReferences{
				ListEndpoint: "/references/list",
			},
		},
	}

	if !appPackage.ReferenceListSupported() {
		t.Fatal("ReferenceListSupported() = false, want true")
	}
}

func TestValidateAppManifestRejectsInvalidWindowMinimizeBehavior(t *testing.T) {
	t.Parallel()

	manifest := validTestAppManifest()
	manifest.Window = &AppManifestWindow{
		MinimizeBehavior: "destroy",
	}

	if err := ValidateAppManifest(manifest); err == nil {
		t.Fatal("ValidateAppManifest() error = nil, want invalid window minimizeBehavior error")
	}
}

func TestValidateAppManifestRejectsInvalidWindowMinimumSize(t *testing.T) {
	t.Parallel()

	minWidth := MinAppWindowWidth - 1
	manifest := validTestAppManifest()
	manifest.Window = &AppManifestWindow{
		MinWidth: &minWidth,
	}

	if err := ValidateAppManifest(manifest); err == nil {
		t.Fatal("ValidateAppManifest() error = nil, want invalid window minWidth error")
	}
}

func TestValidateAppManifestRejectsInvalidReferencesListEndpoint(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name         string
		listEndpoint string
	}{
		{
			name:         "empty",
			listEndpoint: "",
		},
		{
			name:         "absolute",
			listEndpoint: "https://example.com/references/list",
		},
		{
			name:         "query",
			listEndpoint: "/references/list?query=main",
		},
		{
			name:         "fragment",
			listEndpoint: "/references/list#results",
		},
		{
			name:         "network path",
			listEndpoint: "//example.com/references/list",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			manifest := validTestAppManifest()
			manifest.References = &AppManifestReferences{ListEndpoint: tt.listEndpoint}

			if err := ValidateAppManifest(manifest); err == nil {
				t.Fatal("ValidateAppManifest() error = nil, want invalid references.listEndpoint error")
			}
		})
	}
}

func TestParseAppManifestJSONRejectsUnsupportedReferencesFields(t *testing.T) {
	t.Parallel()

	if _, _, err := ParseAppManifestJSON([]byte(
		`{"schemaVersion":"tutti.app.manifest.v1","appId":"test-app","version":"0.1.0","name":"Test App","description":"Test app","icon":{"type":"asset","src":"icon.png"},"runtime":{"bootstrap":"bootstrap.sh","healthcheckPath":"/healthz"},"references":null}`,
	)); err == nil {
		t.Fatal("ParseAppManifestJSON() error = nil, want invalid references error")
	}

	if _, _, err := ParseAppManifestJSON([]byte(
		`{"schemaVersion":"tutti.app.manifest.v1","appId":"test-app","version":"0.1.0","name":"Test App","description":"Test app","icon":{"type":"asset","src":"icon.png"},"runtime":{"bootstrap":"bootstrap.sh","healthcheckPath":"/healthz"},"references":{"listEndpoint":"/references/list","customEndpoint":"/references/custom"}}`,
	)); err == nil {
		t.Fatal("ParseAppManifestJSON() error = nil, want unsupported references field error")
	}
}

func TestParseAppManifestJSONAcceptsLegacyReferencesSearchEndpoint(t *testing.T) {
	t.Parallel()

	manifest, normalized, err := ParseAppManifestJSON([]byte(
		`{"schemaVersion":"tutti.app.manifest.v1","appId":"test-app","version":"0.1.0","name":"Test App","description":"Test app","icon":{"type":"asset","src":"icon.png"},"runtime":{"bootstrap":"bootstrap.sh","healthcheckPath":"/healthz"},"references":{"searchEndpoint":"/references/search"}}`,
	))
	if err != nil {
		t.Fatalf("ParseAppManifestJSON() error = %v, want legacy searchEndpoint alias accepted", err)
	}
	if manifest.References == nil || manifest.References.ListEndpoint != "/references/search" {
		t.Fatalf("manifest.References = %#v, want listEndpoint /references/search", manifest.References)
	}
	if strings.Contains(normalized, "searchEndpoint") {
		t.Fatalf("normalized manifest = %q, want searchEndpoint removed", normalized)
	}
}

func validTestAppManifest() AppManifest {
	return AppManifest{
		SchemaVersion: AppManifestSchemaVersionV1,
		AppID:         "test-app",
		Version:       "0.1.0",
		Name:          "Test App",
		Description:   "Test app",
		Icon: AppManifestIcon{
			Type: "asset",
			Src:  "icon.png",
		},
		Runtime: AppManifestRuntime{
			Bootstrap:       "bootstrap.sh",
			HealthcheckPath: "/healthz",
		},
	}
}
