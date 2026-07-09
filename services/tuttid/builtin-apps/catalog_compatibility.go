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
	Apps map[string][]remoteCatalogCompatibilityEntry `json:"apps"`
}

type remoteCatalogCompatibilityEntry struct {
	MinTuttiVersion string           `json:"minTuttiVersion"`
	App             remoteCatalogApp `json:"app"`
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
	return parseRemoteCatalogForTuttiVersion(data, "")
}

func parseRemoteCatalogForTuttiVersion(data []byte, tuttiVersion string) ([]App, error) {
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

	hostVersion, hostVersionValid := tuttitypes.NormalizeSemver(tuttiVersion)
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
				if !hasSelected || compareCatalogAppVersions(app, selected) > 0 {
					selected = app
					hasSelected = true
				}
			}
			if hasSelected {
				appsByID[appID] = selected
			}
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

func parseRemoteCatalogApp(entry remoteCatalogApp) (App, error) {
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
