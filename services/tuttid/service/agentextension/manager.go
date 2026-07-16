package agentextension

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"golang.org/x/mod/semver"

	"github.com/tutti-os/tutti/packages/agent/daemon/httpx"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

const (
	versionsSchema = "tutti.agent.versions.v1"
	releaseSchema  = "tutti.agent.release.v1"
	manifestSchema = "tutti.agent.manifest.v1"
	maxIndexBytes  = 2 << 20
	maxArtifact    = 20 << 20
	maxFiles       = 256
)

var safeKey = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$`)

type Manager struct {
	Sources  []tuttitypes.AgentExtensionSource
	StateDir string
	Store    workspacedata.AgentTargetStore
	Client   *http.Client
}

type Installation struct {
	SchemaVersion string    `json:"schemaVersion"`
	ID            string    `json:"id"`
	AgentKey      string    `json:"agentKey"`
	Version       string    `json:"version"`
	Provider      string    `json:"provider"`
	PackageDir    string    `json:"packageDir"`
	Manifest      Manifest  `json:"manifest"`
	InstalledAt   time.Time `json:"installedAt"`
	DisplayName   string    `json:"displayName"`
	AuthMessage   string    `json:"authMessage"`
}

type Versions struct {
	SchemaVersion string          `json:"schemaVersion"`
	AgentKey      string          `json:"agentKey"`
	Versions      []VersionRecord `json:"versions"`
}

type VersionRecord struct {
	Version                  string   `json:"version"`
	MinTuttiVersion          string   `json:"minTuttiVersion"`
	RequiredHostCapabilities []string `json:"requiredHostCapabilities"`
	Status                   string   `json:"status"`
	Release                  Release  `json:"release"`
}

type Release struct {
	SchemaVersion     string           `json:"schemaVersion"`
	AgentKey          string           `json:"agentKey"`
	Version           string           `json:"version"`
	Manifest          Manifest         `json:"manifest"`
	ArtifactURL       string           `json:"artifactUrl"`
	ArtifactSHA256    string           `json:"artifactSha256"`
	ArtifactSizeBytes int64            `json:"artifactSizeBytes"`
	PublishedAt       string           `json:"publishedAt"`
	GitSHA            string           `json:"gitSha"`
	Signature         ReleaseSignature `json:"signature"`
}

type ReleaseSignature struct {
	Algorithm string `json:"algorithm"`
	KeyID     string `json:"keyId"`
	Value     string `json:"value"`
}

type Manifest struct {
	SchemaVersion    string `json:"schemaVersion"`
	AgentKey         string `json:"agentKey"`
	Version          string `json:"version"`
	Name             string `json:"name"`
	Description      string `json:"description,omitempty"`
	LocalizationInfo struct {
		DefaultLocale     string `json:"defaultLocale"`
		DefaultFile       string `json:"defaultFile"`
		AdditionalLocales []struct {
			Locale string `json:"locale"`
			File   string `json:"file"`
		} `json:"additionalLocales,omitempty"`
	} `json:"localizationInfo"`
	Icon struct {
		Type string `json:"type"`
		Src  string `json:"src"`
	} `json:"icon"`
	HeroImage struct {
		Type string `json:"type"`
		Src  string `json:"src"`
	} `json:"heroImage,omitempty"`
	Runtime struct {
		Kind    string `json:"kind"`
		Install struct {
			Runner string   `json:"runner"`
			Args   []string `json:"args"`
		} `json:"install"`
		Launch struct {
			Executable string   `json:"executable"`
			Args       []string `json:"args"`
		} `json:"launch"`
	} `json:"runtime"`
	Profiles struct {
		Discovery    string `json:"discovery"`
		Tools        string `json:"tools,omitempty"`
		Capabilities string `json:"capabilities,omitempty"`
		Composer     string `json:"composer,omitempty"`
		Events       string `json:"events,omitempty"`
	} `json:"profiles"`
}

type DiscoveryProfile struct {
	SchemaVersion string `json:"schemaVersion"`
	Candidates    []struct {
		BinaryNames []string `json:"binaryNames"`
		Version     struct {
			Args       []string `json:"args"`
			Constraint string   `json:"constraint"`
		} `json:"version"`
		LaunchArgs []string `json:"launchArgs"`
		Probe      struct {
			Kind      string `json:"kind"`
			TimeoutMS int    `json:"timeoutMs"`
		} `json:"probe,omitempty"`
	} `json:"candidates"`
}

func (m *Manager) Reconcile(ctx context.Context) []error {
	var errs []error
	for _, source := range m.Sources {
		if !source.Enabled {
			if m.Store != nil {
				if err := m.Store.DeleteAgentTarget(ctx, targetID(source.Key)); err != nil {
					errs = append(errs, fmt.Errorf("disable extension %s target: %w", source.Key, err))
				}
			}
			continue
		}
		installation, reconcileErr := m.reconcileSource(ctx, source)
		if reconcileErr != nil {
			var fallbackErr error
			installation, fallbackErr = m.loadActive(source.Key)
			if fallbackErr != nil {
				errs = append(errs, fmt.Errorf(
					"reconcile agent extension %s: %w",
					source.Key,
					errors.Join(reconcileErr, fmt.Errorf("load active installation fallback: %w", fallbackErr)),
				))
				continue
			}
		}
		if err := m.registerTarget(ctx, installation); err != nil {
			errs = append(errs, fmt.Errorf("register agent extension %s: %w", source.Key, err))
		}
	}
	return errs
}

func (m *Manager) ResolveRuntime(ctx context.Context, installationID string) (RuntimeBinding, error) {
	installation, err := m.loadInstallationByID(installationID)
	if err != nil {
		return RuntimeBinding{}, err
	}
	var profile DiscoveryProfile
	if err := readJSON(filepath.Join(installation.PackageDir, installation.Manifest.Profiles.Discovery), &profile); err != nil {
		return RuntimeBinding{}, fmt.Errorf("read discovery profile: %w", err)
	}
	if profile.SchemaVersion != "tutti.agent.discovery.v1" {
		return RuntimeBinding{}, errors.New("unsupported discovery profile schema")
	}
	for _, candidate := range profile.Candidates {
		for _, name := range candidate.BinaryNames {
			path, err := exec.LookPath(name)
			if err != nil {
				continue
			}
			if err := checkRuntimeVersion(ctx, path, candidate.Version.Args, candidate.Version.Constraint); err != nil {
				continue
			}
			aliases, err := loadToolAliases(installation)
			if err != nil {
				return RuntimeBinding{}, err
			}
			permissionModes, planModeRuntimeID, err := loadComposerModes(installation)
			if err != nil {
				return RuntimeBinding{}, err
			}
			capabilities, err := loadDeclaredCapabilities(installation)
			if err != nil {
				return RuntimeBinding{}, err
			}
			composerProfile, err := m.LoadComposerProfile(installation.ID)
			if err != nil {
				return RuntimeBinding{}, err
			}
			modelConfigOptionID, permissionConfigOptionID, reasoningConfigOptionID := composerProfile.ACPConfigOptionIDs()
			return RuntimeBinding{
				Installation:             installation,
				Command:                  append([]string{path}, candidate.LaunchArgs...),
				ToolAliases:              aliases,
				ModelConfigOptionID:      modelConfigOptionID,
				PermissionConfigOptionID: permissionConfigOptionID,
				ReasoningConfigOptionID:  reasoningConfigOptionID,
				PermissionModes:          permissionModes,
				PlanModeRuntimeID:        planModeRuntimeID,
				Capabilities:             capabilities,
			}, nil
		}
	}
	return RuntimeBinding{}, fmt.Errorf("compatible local runtime for %s is not installed", installation.AgentKey)
}

func (m *Manager) ResolveAgentTargetAvailability(ctx context.Context, target agenttargetbiz.Target) (string, string) {
	launchRef, err := agenttargetbiz.RuntimeProviderTargetRef(target)
	if err != nil || launchRef["kind"] != agenttargetbiz.LaunchRefTypeAgentExtension {
		return "unknown", "invalid_extension_launch_ref"
	}
	installationID, _ := launchRef["extensionInstallationId"].(string)
	if _, err := m.ResolveRuntime(ctx, installationID); err != nil {
		return "not_installed", "compatible_runtime_not_installed"
	}
	return "ready", ""
}

func (m *Manager) reconcileSource(ctx context.Context, source tuttitypes.AgentExtensionSource) (Installation, error) {
	if !safeKey.MatchString(source.Key) {
		return Installation{}, errors.New("invalid extension key")
	}
	var versions Versions
	if err := m.getJSON(ctx, source.ReleaseIndexURL, maxIndexBytes, &versions); err != nil {
		return Installation{}, err
	}
	record, err := selectVersion(versions, source.Key, tuttitypes.ResolveAppVersion())
	if err != nil {
		return Installation{}, err
	}
	if err := verifyRelease(record.Release, source); err != nil {
		return Installation{}, err
	}
	if installed, err := m.loadActive(source.Key); err == nil && installed.Version == record.Version {
		return installed, nil
	}
	artifact, err := m.getBytes(ctx, record.Release.ArtifactURL, maxArtifact)
	if err != nil {
		return Installation{}, err
	}
	if int64(len(artifact)) != record.Release.ArtifactSizeBytes {
		return Installation{}, errors.New("artifact size does not match signed release")
	}
	digest := sha256.Sum256(artifact)
	if hex.EncodeToString(digest[:]) != strings.ToLower(record.Release.ArtifactSHA256) {
		return Installation{}, errors.New("artifact SHA-256 does not match signed release")
	}
	return m.install(record.Release, artifact)
}

func (m *Manager) install(release Release, artifact []byte) (Installation, error) {
	root := filepath.Join(m.root(), release.AgentKey)
	finalDir := filepath.Join(root, release.Version)
	if err := os.MkdirAll(root, 0o700); err != nil {
		return Installation{}, err
	}
	staging, err := os.MkdirTemp(root, ".install-")
	if err != nil {
		return Installation{}, err
	}
	defer os.RemoveAll(staging)
	if err := extractPackage(artifact, staging); err != nil {
		return Installation{}, err
	}
	manifest, err := validateInstalledPackage(staging, release.AgentKey, release.Version)
	if err != nil {
		return Installation{}, err
	}
	if _, err := os.Stat(finalDir); errors.Is(err, os.ErrNotExist) {
		if err := os.Rename(staging, finalDir); err != nil {
			return Installation{}, err
		}
	} else if err != nil {
		return Installation{}, err
	}
	installation := Installation{
		SchemaVersion: "tutti.agent.installation.v1",
		ID:            release.AgentKey + "@" + release.Version,
		AgentKey:      release.AgentKey,
		Version:       release.Version,
		Provider:      "acp:" + release.AgentKey,
		PackageDir:    finalDir,
		Manifest:      manifest,
		InstalledAt:   time.Now().UTC(),
	}
	locales := map[string]string{}
	if err := readJSON(filepath.Join(finalDir, filepath.FromSlash(manifest.LocalizationInfo.DefaultFile)), &locales); err != nil {
		return Installation{}, fmt.Errorf("read extension default locale: %w", err)
	}
	installation.DisplayName = strings.TrimSpace(locales["agent.name"])
	if installation.DisplayName == "" {
		installation.DisplayName = manifest.Name
	}
	installation.AuthMessage = strings.TrimSpace(locales["runtime.authRequired"])
	if err := writeJSONAtomic(filepath.Join(finalDir, "installation.json"), installation); err != nil {
		return Installation{}, err
	}
	if err := writeJSONAtomic(filepath.Join(root, "active.json"), installation); err != nil {
		return Installation{}, err
	}
	return installation, nil
}

func (m *Manager) registerTarget(ctx context.Context, installation Installation) error {
	if m.Store == nil {
		return errors.New("agent target store is not configured")
	}
	launchRef, err := agenttargetbiz.CanonicalLaunchRefJSON(installation.Provider, agenttargetbiz.LaunchRef{
		Type: agenttargetbiz.LaunchRefTypeAgentExtension, ExtensionInstallationID: installation.ID,
	})
	if err != nil {
		return err
	}
	iconURL, err := packageAssetDataURL(installation.PackageDir, installation.Manifest.Icon.Src)
	if err != nil {
		return err
	}
	heroImageURL := ""
	if installation.Manifest.HeroImage.Src != "" {
		heroImageURL, err = packageAssetDataURL(installation.PackageDir, installation.Manifest.HeroImage.Src)
		if err != nil {
			return err
		}
	}
	_, err = m.Store.PutAgentTarget(ctx, agenttargetbiz.Target{
		ID: targetID(installation.AgentKey), Provider: installation.Provider, LaunchRefJSON: launchRef,
		Name: installation.DisplayName, IconKey: "extension:" + installation.AgentKey,
		IconURL: iconURL, HeroImageURL: heroImageURL, Enabled: true, Source: agenttargetbiz.SourceSystem, SortOrder: 700,
	})
	return err
}

func (m *Manager) loadActive(key string) (Installation, error) {
	var value Installation
	err := readJSON(filepath.Join(m.root(), key, "active.json"), &value)
	if err != nil {
		return Installation{}, err
	}
	if value.AgentKey != key || value.ID != key+"@"+value.Version {
		return Installation{}, errors.New("active installation identity is invalid")
	}
	return m.validateInstallation(value)
}

func (m *Manager) loadInstallationByID(id string) (Installation, error) {
	parts := strings.Split(id, "@")
	if len(parts) != 2 || !safeKey.MatchString(parts[0]) || !validSemver(parts[1]) {
		return Installation{}, errors.New("invalid extension installation id")
	}
	var value Installation
	err := readJSON(filepath.Join(m.root(), parts[0], parts[1], "installation.json"), &value)
	if err != nil {
		return Installation{}, err
	}
	if value.ID != id || value.AgentKey != parts[0] || value.Version != parts[1] {
		return Installation{}, errors.New("extension installation identity mismatch")
	}
	return m.validateInstallation(value)
}

func (m *Manager) validateInstallation(value Installation) (Installation, error) {
	expectedDir := filepath.Join(m.root(), value.AgentKey, value.Version)
	if filepath.Clean(value.PackageDir) != expectedDir {
		return Installation{}, errors.New("extension installation package path is invalid")
	}
	manifest, err := validateInstalledPackage(expectedDir, value.AgentKey, value.Version)
	if err != nil {
		return Installation{}, err
	}
	if manifest.Name != value.Manifest.Name || manifest.Icon.Src != value.Manifest.Icon.Src || manifest.HeroImage.Src != value.Manifest.HeroImage.Src || manifest.Runtime.Kind != value.Manifest.Runtime.Kind {
		return Installation{}, errors.New("extension installation manifest does not match package")
	}
	value.PackageDir = expectedDir
	return value, nil
}

func (m *Manager) root() string {
	root := strings.TrimSpace(m.StateDir)
	if root == "" {
		root = tuttitypes.DefaultStateDir()
	}
	return filepath.Join(root, "agent", "extensions")
}

func (m *Manager) getJSON(ctx context.Context, rawURL string, limit int64, target any) error {
	data, err := m.getBytes(ctx, rawURL, limit)
	if err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	return decoder.Decode(target)
}

func (m *Manager) getBytes(ctx context.Context, rawURL string, limit int64) ([]byte, error) {
	if !strings.HasPrefix(rawURL, "https://") {
		return nil, errors.New("agent extension URL must use HTTPS")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	client := m.Client
	if client == nil {
		client = httpx.NewClient(30 * time.Second)
	}
	response, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.Request == nil || response.Request.URL.Scheme != "https" {
		return nil, errors.New("agent extension download redirected away from HTTPS")
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("agent extension download returned HTTP %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errors.New("agent extension download exceeds size limit")
	}
	return data, nil
}

func selectVersion(document Versions, key string, appVersion string) (VersionRecord, error) {
	if document.SchemaVersion != versionsSchema || document.AgentKey != key {
		return VersionRecord{}, errors.New("invalid extension versions identity")
	}
	candidates := append([]VersionRecord(nil), document.Versions...)
	sort.SliceStable(candidates, func(i, j int) bool { return semver.Compare("v"+candidates[i].Version, "v"+candidates[j].Version) > 0 })
	for _, record := range candidates {
		if record.Status != "active" || !validSemver(record.Version) || !validSemver(record.MinTuttiVersion) {
			continue
		}
		if semver.Compare("v"+appVersion, "v"+record.MinTuttiVersion) < 0 {
			continue
		}
		if len(record.RequiredHostCapabilities) == 0 {
			return record, nil
		}
	}
	return VersionRecord{}, errors.New("no compatible active extension version")
}

func verifyRelease(release Release, source tuttitypes.AgentExtensionSource) error {
	if release.SchemaVersion != releaseSchema || release.AgentKey != source.Key || release.Version != release.Manifest.Version {
		return errors.New("signed release identity is invalid")
	}
	if release.Signature.Algorithm != "ed25519" || release.Signature.KeyID != source.SigningKeyID {
		return errors.New("signed release key identity is invalid")
	}
	block, _ := pem.Decode([]byte(source.SigningPublicKey))
	if block == nil {
		return errors.New("extension signing public key is invalid")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return err
	}
	publicKey, ok := parsed.(ed25519.PublicKey)
	if !ok {
		return errors.New("extension signing key must be Ed25519")
	}
	raw, err := json.Marshal(release)
	if err != nil {
		return err
	}
	var unsigned map[string]any
	if err := json.Unmarshal(raw, &unsigned); err != nil {
		return err
	}
	delete(unsigned, "signature")
	payload, err := json.Marshal(unsigned)
	if err != nil {
		return err
	}
	signature, err := base64.StdEncoding.DecodeString(release.Signature.Value)
	if err != nil || !ed25519.Verify(publicKey, payload, signature) {
		return errors.New("agent extension release signature is invalid")
	}
	return nil
}

func extractPackage(data []byte, destination string) error {
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return err
	}
	if len(reader.File) == 0 || len(reader.File) > maxFiles {
		return errors.New("agent extension archive file count is invalid")
	}
	var total uint64
	for _, file := range reader.File {
		name := filepath.Clean(filepath.FromSlash(file.Name))
		if name == "." || filepath.IsAbs(name) || name == ".." || strings.HasPrefix(name, ".."+string(filepath.Separator)) {
			return errors.New("agent extension archive contains unsafe path")
		}
		if file.Mode()&os.ModeSymlink != 0 {
			return errors.New("agent extension archive contains symlink")
		}
		if file.FileInfo().IsDir() {
			if err := os.MkdirAll(filepath.Join(destination, name), 0o700); err != nil {
				return err
			}
			continue
		}
		if file.Mode()&0o111 != 0 {
			return errors.New("agent extension archive contains executable")
		}
		if !allowedExtension(filepath.Ext(name)) {
			return fmt.Errorf("agent extension archive contains forbidden file type %s", name)
		}
		total += file.UncompressedSize64
		if total > maxArtifact {
			return errors.New("agent extension archive exceeds expanded size limit")
		}
		path := filepath.Join(destination, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return err
		}
		source, err := file.Open()
		if err != nil {
			return err
		}
		target, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			source.Close()
			return err
		}
		_, copyErr := io.Copy(target, source)
		closeErr := target.Close()
		source.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	return nil
}

func validateInstalledPackage(root, key, version string) (Manifest, error) {
	var manifest Manifest
	if err := readJSON(filepath.Join(root, "tutti.agent.json"), &manifest); err != nil {
		return Manifest{}, err
	}
	if manifest.SchemaVersion != manifestSchema || manifest.AgentKey != key || manifest.Version != version || strings.TrimSpace(manifest.Name) == "" {
		return Manifest{}, errors.New("installed extension manifest identity is invalid")
	}
	if manifest.Icon.Type != "asset" || !safeRelativePath(manifest.Icon.Src) || manifest.Runtime.Kind != "standard-acp" || !safeRelativePath(manifest.Profiles.Discovery) {
		return Manifest{}, errors.New("installed extension manifest contract is invalid")
	}
	if manifest.HeroImage.Src != "" && (manifest.HeroImage.Type != "asset" || !safeRelativePath(manifest.HeroImage.Src)) {
		return Manifest{}, errors.New("installed extension hero image is invalid")
	}
	if err := validateRuntimeContract(manifest); err != nil {
		return Manifest{}, err
	}
	if !safeRelativePath(manifest.LocalizationInfo.DefaultFile) {
		return Manifest{}, errors.New("installed extension default locale is invalid")
	}
	for _, referenced := range []string{manifest.Icon.Src, manifest.HeroImage.Src, manifest.LocalizationInfo.DefaultFile, manifest.Profiles.Discovery, manifest.Profiles.Tools, manifest.Profiles.Capabilities, manifest.Profiles.Composer, manifest.Profiles.Events} {
		if referenced == "" {
			continue
		}
		if !safeRelativePath(referenced) {
			return Manifest{}, errors.New("installed extension reference is unsafe")
		}
		info, err := os.Stat(filepath.Join(root, filepath.FromSlash(referenced)))
		if err != nil || !info.Mode().IsRegular() {
			return Manifest{}, fmt.Errorf("installed extension reference is missing: %s", referenced)
		}
	}
	for _, locale := range manifest.LocalizationInfo.AdditionalLocales {
		if !safeRelativePath(locale.File) {
			return Manifest{}, errors.New("installed extension locale reference is unsafe")
		}
		info, err := os.Stat(filepath.Join(root, filepath.FromSlash(locale.File)))
		if err != nil || !info.Mode().IsRegular() {
			return Manifest{}, fmt.Errorf("installed extension locale is missing: %s", locale.File)
		}
	}
	if err := validateInstalledProfiles(root, manifest); err != nil {
		return Manifest{}, fmt.Errorf("validate installed extension profiles: %w", err)
	}
	return manifest, nil
}

func validateRuntimeContract(manifest Manifest) error {
	if manifest.Runtime.Install.Runner != "npm" && manifest.Runtime.Install.Runner != "pnpm" && manifest.Runtime.Install.Runner != "uv" {
		return errors.New("extension runtime install runner is unsupported")
	}
	allArguments := append(append([]string(nil), manifest.Runtime.Install.Args...), manifest.Runtime.Launch.Args...)
	allArguments = append(allArguments, manifest.Runtime.Launch.Executable)
	for _, argument := range allArguments {
		if strings.TrimSpace(argument) == "" || strings.ContainsAny(argument, "|;&`\n\r<>") || strings.Contains(argument, "$(") {
			return errors.New("extension runtime argument contains forbidden shell syntax")
		}
		for _, match := range regexp.MustCompile(`\$\{[^}]+\}`).FindAllString(argument, -1) {
			if match != "${projectRoot}" && match != "${installRoot}" && match != "${platform}" {
				return errors.New("extension runtime argument contains unsupported placeholder")
			}
		}
	}
	if !strings.Contains(strings.Join(manifest.Runtime.Install.Args, "\x00"), "${installRoot}") || !strings.HasPrefix(manifest.Runtime.Launch.Executable, "${installRoot}/") {
		return errors.New("extension runtime install and launch must stay under installRoot")
	}
	if manifest.Runtime.Install.Runner == "npm" || manifest.Runtime.Install.Runner == "pnpm" {
		packagePattern := regexp.MustCompile(`^@[a-z0-9._-]+/[a-z0-9._-]+@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$`)
		count := 0
		for _, argument := range manifest.Runtime.Install.Args {
			if strings.HasPrefix(argument, "@") {
				if !packagePattern.MatchString(argument) {
					return errors.New("extension runtime package must use an exact scoped version")
				}
				count++
			}
		}
		if count != 1 {
			return errors.New("extension runtime install must name exactly one scoped package")
		}
	}
	return nil
}

func packageAssetDataURL(root, relative string) (string, error) {
	if !safeRelativePath(relative) {
		return "", errors.New("unsafe extension asset path")
	}
	data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(relative)))
	if err != nil {
		return "", err
	}
	if len(data) > 256<<10 {
		return "", errors.New("extension presentation asset exceeds size limit")
	}
	if strings.EqualFold(filepath.Ext(relative), ".svg") {
		lower := strings.ToLower(string(data))
		for _, forbidden := range []string{"<script", "<foreignobject", "javascript:", "href=\"http", "href='http", "url(http", " onload=", " onclick="} {
			if strings.Contains(lower, forbidden) {
				return "", errors.New("extension SVG contains unsafe active or remote content")
			}
		}
	}
	contentType := mime.TypeByExtension(strings.ToLower(filepath.Ext(relative)))
	if contentType == "" {
		return "", errors.New("unsupported extension presentation asset type")
	}
	return "data:" + contentType + ";base64," + base64.StdEncoding.EncodeToString(data), nil
}

func checkRuntimeVersion(ctx context.Context, executable string, args []string, constraint string) error {
	if len(args) == 0 {
		return nil
	}
	probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	output, err := exec.CommandContext(probeCtx, executable, args...).CombinedOutput()
	if err != nil {
		return err
	}
	version := regexp.MustCompile(`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`).FindString(string(output))
	if !validSemver(version) || !matchesConstraint(version, constraint) {
		return errors.New("runtime version is incompatible")
	}
	return nil
}

func matchesConstraint(version, constraint string) bool {
	for _, part := range strings.Fields(constraint) {
		switch {
		case strings.HasPrefix(part, ">="):
			if semver.Compare("v"+version, "v"+strings.TrimPrefix(part, ">=")) < 0 {
				return false
			}
		case strings.HasPrefix(part, ">"):
			if semver.Compare("v"+version, "v"+strings.TrimPrefix(part, ">")) <= 0 {
				return false
			}
		case strings.HasPrefix(part, "<="):
			if semver.Compare("v"+version, "v"+strings.TrimPrefix(part, "<=")) > 0 {
				return false
			}
		case strings.HasPrefix(part, "<"):
			if semver.Compare("v"+version, "v"+strings.TrimPrefix(part, "<")) >= 0 {
				return false
			}
		default:
			return false
		}
	}
	return true
}

func allowedExtension(ext string) bool {
	switch strings.ToLower(ext) {
	case ".json", ".md", ".svg", ".png", ".jpg", ".jpeg", ".webp":
		return true
	}
	return false
}
func validSemver(value string) bool { return semver.IsValid("v" + value) }
func safeRelativePath(value string) bool {
	if strings.Contains(value, "\\") || strings.ContainsRune(value, 0) {
		return false
	}
	clean := filepath.Clean(filepath.FromSlash(value))
	return value != "" && !filepath.IsAbs(clean) && clean != ".." && !strings.HasPrefix(clean, ".."+string(filepath.Separator))
}
func targetID(key string) string { return "extension:" + key }
func readJSON(path string, target any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	return decoder.Decode(target)
}
func writeJSONAtomic(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".write-")
	if err != nil {
		return err
	}
	name := temp.Name()
	defer os.Remove(name)
	if err := temp.Chmod(0o600); err != nil {
		temp.Close()
		return err
	}
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}
