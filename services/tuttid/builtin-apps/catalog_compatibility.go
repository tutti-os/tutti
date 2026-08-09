package builtinapps

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
	"golang.org/x/mod/semver"
)

type remoteCatalogDocument struct {
	SchemaVersion string                      `json:"schemaVersion"`
	Apps          []remoteCatalogApp          `json:"apps"`
	Compatibility *remoteCatalogCompatibility `json:"compatibility,omitempty"`
}

type remoteCatalogCompatibility struct {
	Apps           map[string][]remoteCatalogCompatibilityEntry `json:"apps"`
	CapabilityApps map[string][]remoteCatalogCapabilityEntry    `json:"capabilityApps,omitempty"`
}

type remoteCatalogCompatibilityEntry struct {
	MinTuttiVersion string           `json:"minTuttiVersion"`
	App             remoteCatalogApp `json:"app"`
}

type remoteCatalogCapabilityEntry struct {
	RequiredTuttiCapabilities []string         `json:"requiredTuttiCapabilities"`
	App                       remoteCatalogApp `json:"app"`
}

// CatalogHost is the local host contract used to select a remote app release.
// Capability strings come from the host binary, never from the app process.
type CatalogHost struct {
	TuttiVersion string
	Capabilities []string
}

type remoteCatalogApp struct {
	Localizations []workspacebiz.AppManifestLocalization `json:"localizations,omitempty"`
	Manifest      workspacebiz.AppManifest               `json:"manifest"`
	Distribution  remoteDistribution                     `json:"distribution"`
}

type remoteDistribution struct {
	Kind           string `json:"kind"`
	ArtifactURL    string `json:"artifactUrl"`
	ArtifactSHA256 string `json:"artifactSha256"`
	IconURL        string `json:"iconUrl"`
}

func parseRemoteCatalog(data []byte) ([]App, error) {
	return parseRemoteCatalogForHost(data, CatalogHost{})
}

func parseRemoteCatalogForTuttiVersion(data []byte, tuttiVersion string) ([]App, error) {
	return parseRemoteCatalogForHost(data, CatalogHost{TuttiVersion: tuttiVersion})
}

func parseRemoteCatalogForHost(data []byte, host CatalogHost) ([]App, error) {
	var document remoteCatalogDocument
	if err := json.Unmarshal(data, &document); err != nil {
		return nil, fmt.Errorf("parse app catalog json: %w", err)
	}
	if !isSupportedRemoteCatalogSchemaVersion(strings.TrimSpace(document.SchemaVersion)) {
		return nil, fmt.Errorf("unsupported app catalog schema version %q", document.SchemaVersion)
	}

	appsByID := make(map[string]App, len(document.Apps))
	for _, entry := range document.Apps {
		app, err := parseRemoteCatalogApp(entry)
		if err != nil {
			return nil, err
		}
		appID := strings.TrimSpace(app.Manifest.AppID)
		if _, ok := appsByID[appID]; ok {
			return nil, fmt.Errorf("duplicate app catalog appId %q", appID)
		}
		appsByID[appID] = app
	}

	hostVersion, hostVersionValid := tuttitypes.NormalizeSemver(host.TuttiVersion)
	if document.Compatibility != nil {
		if document.Compatibility.Apps == nil {
			return nil, errors.New("app catalog compatibility.apps is required")
		}
		for appID, entries := range document.Compatibility.Apps {
			appID = strings.TrimSpace(appID)
			if appID == "" || len(entries) == 0 {
				return nil, errors.New("app catalog compatibility app entries are required")
			}
			seenVersions := make(map[string]struct{}, len(entries))
			seenMinimums := make(map[string]struct{}, len(entries))
			selected, hasSelected := appsByID[appID]
			selectedMinimum := ""
			hasCompatibleSelection := false
			for _, entry := range entries {
				minimum, ok := tuttitypes.NormalizeSemver(entry.MinTuttiVersion)
				if !ok {
					return nil, fmt.Errorf("app catalog compatibility app %q has invalid minTuttiVersion %q", appID, entry.MinTuttiVersion)
				}
				if _, ok := seenMinimums[minimum]; ok {
					return nil, fmt.Errorf("app catalog compatibility app %q has duplicate minTuttiVersion %q", appID, entry.MinTuttiVersion)
				}
				seenMinimums[minimum] = struct{}{}
				if !hostVersionValid || semver.Compare(minimum, hostVersion) > 0 {
					continue
				}
				app, err := parseRemoteCatalogApp(entry.App)
				if err != nil {
					return nil, err
				}
				if strings.TrimSpace(app.Manifest.AppID) != appID {
					return nil, fmt.Errorf("app catalog compatibility app %q manifest appId mismatch", appID)
				}
				version, ok := tuttitypes.NormalizeSemver(app.Manifest.Version)
				if !ok {
					return nil, fmt.Errorf("app catalog compatibility app %q has invalid version %q", appID, app.Manifest.Version)
				}
				if _, ok := seenVersions[version]; ok {
					return nil, fmt.Errorf("app catalog compatibility app %q has duplicate version %q", appID, app.Manifest.Version)
				}
				seenVersions[version] = struct{}{}
				if !hasCompatibleSelection || semver.Compare(minimum, selectedMinimum) > 0 {
					selected = app
					hasSelected = true
					selectedMinimum = minimum
					hasCompatibleSelection = true
				}
			}
			if hasSelected {
				appsByID[appID] = selected
			}
		}
		if err := applyCapabilityCompatibleApps(
			appsByID,
			document.Compatibility.CapabilityApps,
			host.Capabilities,
		); err != nil {
			return nil, err
		}
	}

	apps := make([]App, 0, len(appsByID))
	for _, app := range appsByID {
		apps = append(apps, app)
	}
	sort.Slice(apps, func(left, right int) bool {
		return apps[left].Manifest.AppID < apps[right].Manifest.AppID
	})
	return apps, nil
}

func applyCapabilityCompatibleApps(appsByID map[string]App, entriesByAppID map[string][]remoteCatalogCapabilityEntry, capabilities []string) error {
	hostCapabilities := make(map[string]struct{}, len(capabilities))
	for _, capability := range capabilities {
		if isCanonicalCatalogCapability(capability) {
			hostCapabilities[capability] = struct{}{}
		}
	}
	for rawAppID, entries := range entriesByAppID {
		appID := strings.TrimSpace(rawAppID)
		if appID == "" || len(entries) == 0 {
			continue
		}
		seenCapabilitySets := make(map[string]struct{}, len(entries))
		seenVersions := make(map[string]struct{}, len(entries))
		selected, hasSelected := appsByID[appID]
		for _, entry := range entries {
			capabilityKey, eligible := eligibleCatalogCapabilityEntry(entry.RequiredTuttiCapabilities, hostCapabilities)
			if !eligible {
				continue
			}
			if _, ok := seenCapabilitySets[capabilityKey]; ok {
				return fmt.Errorf("app catalog capability compatibility app %q has duplicate requiredTuttiCapabilities", appID)
			}
			seenCapabilitySets[capabilityKey] = struct{}{}
			app, err := parseRemoteCatalogApp(entry.App)
			if err != nil {
				return err
			}
			if strings.TrimSpace(app.Manifest.AppID) != appID {
				return fmt.Errorf("app catalog capability compatibility app %q manifest appId mismatch", appID)
			}
			version, ok := tuttitypes.NormalizeSemver(app.Manifest.Version)
			if !ok {
				return fmt.Errorf("app catalog capability compatibility app %q has invalid version %q", appID, app.Manifest.Version)
			}
			if _, ok := seenVersions[version]; ok {
				return fmt.Errorf("app catalog capability compatibility app %q has duplicate version %q", appID, app.Manifest.Version)
			}
			seenVersions[version] = struct{}{}
			if !hasSelected || compareCatalogAppVersions(app, selected) > 0 {
				selected = app
				hasSelected = true
			}
		}
		if hasSelected {
			appsByID[appID] = selected
		}
	}
	return nil
}

func eligibleCatalogCapabilityEntry(required []string, hostCapabilities map[string]struct{}) (string, bool) {
	if len(required) == 0 {
		return "", false
	}
	seen := make(map[string]struct{}, len(required))
	for _, capability := range required {
		if !isCanonicalCatalogCapability(capability) {
			return "", false
		}
		if _, ok := seen[capability]; ok {
			return "", false
		}
		seen[capability] = struct{}{}
		if _, ok := hostCapabilities[capability]; !ok {
			return "", false
		}
	}
	normalized := make([]string, 0, len(seen))
	for capability := range seen {
		normalized = append(normalized, capability)
	}
	sort.Strings(normalized)
	return strings.Join(normalized, "\x00"), true
}

func isCanonicalCatalogCapability(value string) bool {
	if len(value) == 0 || len(value) > 64 || value[0] < 'a' || value[0] > 'z' {
		return false
	}
	for _, character := range value[1:] {
		if (character < 'a' || character > 'z') &&
			(character < '0' || character > '9') &&
			character != '-' {
			return false
		}
	}
	return true
}

func parseRemoteCatalogApp(entry remoteCatalogApp) (App, error) {
	entry.Manifest = workspacebiz.NormalizeAppManifestRuntimeProfile(entry.Manifest)
	if err := workspacebiz.ValidateAppManifest(entry.Manifest); err != nil {
		return App{}, fmt.Errorf("validate app catalog manifest: %w", err)
	}
	appID := strings.TrimSpace(entry.Manifest.AppID)
	distribution, err := parseRemoteDistribution(appID, entry.Manifest, entry.Distribution)
	if err != nil {
		return App{}, err
	}
	localizations, err := parseRemoteCatalogLocalizations(appID, entry.Localizations)
	if err != nil {
		return App{}, err
	}
	return App{
		Manifest:      entry.Manifest,
		Localizations: localizations,
		Distribution:  distribution,
	}, nil
}

func compareCatalogAppVersions(left App, right App) int {
	leftVersion, leftOK := tuttitypes.NormalizeSemver(left.Manifest.Version)
	rightVersion, rightOK := tuttitypes.NormalizeSemver(right.Manifest.Version)
	if leftOK && rightOK {
		if comparison := semver.Compare(leftVersion, rightVersion); comparison != 0 {
			return comparison
		}
	}
	if leftOK != rightOK {
		if leftOK {
			return 1
		}
		return -1
	}
	return strings.Compare(left.Manifest.Version, right.Manifest.Version)
}

func isSupportedRemoteCatalogSchemaVersion(schemaVersion string) bool {
	return schemaVersion == remoteCatalogSchemaVersionV1
}
