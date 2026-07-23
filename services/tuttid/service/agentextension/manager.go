package agentextension

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"time"

	"golang.org/x/mod/semver"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	"github.com/tutti-os/tutti/packages/agent/daemon/runtimecmd"
	agentextensionbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentextension"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

var safeKey = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$`)

type Manager struct {
	Sources           []tuttitypes.AgentExtensionSource
	RuntimeInstallDir string
	RuntimeBinDir     string
	Store             workspacedata.AgentTargetStore
	Installations     InstallationStore
	Discovery         SetupDiscoveryDirectory
	Preferences       workspacedata.PreferencesStore
	Client            *http.Client
	RuntimeResolver   runtimecmd.Resolver
	reconcileMu       sync.Mutex
	versionCacheOnce  sync.Once
	runtimeVersions   *runtimeVersionCache
}

type Installation = agentextensionbiz.Installation
type Manifest = agentextensionbiz.Manifest

type DiscoverySearchPath struct {
	Scope string `json:"scope"`
	Path  string `json:"path"`
}

type DiscoveryCandidate struct {
	BinaryNames []string              `json:"binaryNames"`
	SearchPaths []DiscoverySearchPath `json:"searchPaths,omitempty"`
	Version     struct {
		Args       []string `json:"args"`
		Constraint string   `json:"constraint"`
	} `json:"version"`
	LaunchArgs []string `json:"launchArgs"`
	Probe      struct {
		Kind      string `json:"kind"`
		TimeoutMS int    `json:"timeoutMs"`
	} `json:"probe,omitempty"`
}

type DiscoveryProfile struct {
	SchemaVersion string               `json:"schemaVersion"`
	Candidates    []DiscoveryCandidate `json:"candidates"`
}

func (m *Manager) Reconcile(ctx context.Context) []error {
	m.reconcileMu.Lock()
	defer m.reconcileMu.Unlock()

	featureFlags := map[string]bool{}
	if m.Preferences != nil {
		preferences, err := m.Preferences.GetDesktopPreferences(ctx)
		if err != nil {
			return []error{fmt.Errorf("read agent extension feature flags: %w", err)}
		}
		featureFlags = preferences.FeatureFlags
	}
	return m.reconcile(ctx, featureFlags)
}

func (m *Manager) ReconcileDesktopPreferencesChange(ctx context.Context, previous, current preferencesbiz.DesktopPreferences) []error {
	if !m.sourceActivationChanged(previous.FeatureFlags, current.FeatureFlags) {
		return nil
	}
	if m.Preferences != nil {
		return m.Reconcile(ctx)
	}
	m.reconcileMu.Lock()
	defer m.reconcileMu.Unlock()
	return m.reconcile(ctx, current.FeatureFlags)
}

func (m *Manager) reconcile(ctx context.Context, featureFlags map[string]bool) []error {
	var errs []error
	for _, source := range m.Sources {
		if !sourceEnabled(source, featureFlags) {
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

func (m *Manager) sourceActivationChanged(previous, current map[string]bool) bool {
	for _, source := range m.Sources {
		if sourceEnabled(source, previous) != sourceEnabled(source, current) {
			return true
		}
	}
	return false
}

func sourceEnabled(source tuttitypes.AgentExtensionSource, featureFlags map[string]bool) bool {
	enabled, ok := featureFlags["agent.extension."+source.Key]
	if ok {
		return enabled
	}
	return source.Enabled
}

func (m *Manager) ResolveRuntime(ctx context.Context, installationID string) (RuntimeBinding, error) {
	discoveryRoot, err := m.ensureDiscoveryRoot(ctx)
	if err != nil {
		return RuntimeBinding{}, err
	}
	return m.resolveRuntime(ctx, installationID, discoveryRoot)
}

func (m *Manager) ResolveRuntimeForCWD(ctx context.Context, installationID, cwd string) (RuntimeBinding, error) {
	cwd = strings.TrimSpace(cwd)
	if cwd == "" {
		var err error
		cwd, err = m.ensureDiscoveryRoot(ctx)
		if err != nil {
			return RuntimeBinding{}, err
		}
	}
	return m.resolveRuntime(ctx, installationID, cwd)
}

func (m *Manager) resolveRuntime(ctx context.Context, installationID, cwd string) (RuntimeBinding, error) {
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
		env, err := m.discoveryRuntimeEnv(candidate)
		if err != nil {
			return RuntimeBinding{}, err
		}
		for _, name := range candidate.BinaryNames {
			path := m.RuntimeResolver.ResolveBinary([]string{name}, pathOverrideFromEnv(env))
			if path == "" {
				continue
			}
			if m.isManagedRuntimeExecutable(path) {
				continue
			}
			version, err := m.runtimeVersionWithEnv(ctx, path, candidate.Version.Args, candidate.Version.Constraint, env)
			if err != nil {
				continue
			}
			return m.runtimeBinding(installation, append([]string{path}, candidate.LaunchArgs...), version, "local")
		}
	}
	if binding, err := m.resolveInstalledManagedRuntime(ctx, installation, profile, cwd); err == nil {
		return binding, nil
	} else if errors.Is(err, ErrManagedRuntimeIntegrity) {
		return RuntimeBinding{}, err
	}
	return RuntimeBinding{}, fmt.Errorf("compatible local runtime for %s is not installed", installation.AgentKey)
}

func (m *Manager) discoveryRuntimeEnv(candidate DiscoveryCandidate) ([]string, error) {
	baseEnv := m.RuntimeResolver.Env(nil)
	if len(candidate.SearchPaths) == 0 {
		return baseEnv, nil
	}
	homeDir := m.RuntimeResolver.HomeDir
	var home string
	var err error
	if homeDir != nil {
		home, err = homeDir()
	} else {
		home, err = os.UserHomeDir()
	}
	if err != nil || strings.TrimSpace(home) == "" {
		return nil, errors.New("resolve extension discovery user directory")
	}
	searchDirs := make([]string, 0, len(candidate.SearchPaths))
	for _, searchPath := range candidate.SearchPaths {
		if searchPath.Scope != "user" {
			return nil, errors.New("unsupported extension discovery search path scope")
		}
		searchDirs = append(searchDirs, filepath.Join(home, filepath.FromSlash(searchPath.Path)))
	}
	searchDirs = append(searchDirs, filepath.SplitList(environmentValue(baseEnv, "PATH"))...)
	return m.RuntimeResolver.Env([]string{"PATH=" + strings.Join(searchDirs, string(os.PathListSeparator))}), nil
}

func pathOverrideFromEnv(env []string) []string {
	return []string{"PATH=" + environmentValue(env, "PATH")}
}

func environmentValue(env []string, key string) string {
	for index := len(env) - 1; index >= 0; index-- {
		candidateKey, value, ok := strings.Cut(env[index], "=")
		if ok && strings.EqualFold(candidateKey, key) {
			return value
		}
	}
	return ""
}

func (m *Manager) ensureDiscoveryRoot(ctx context.Context) (string, error) {
	if m.Discovery == nil {
		return "", errors.New("agent extension discovery directory is not configured")
	}
	return m.Discovery.Ensure(ctx)
}

func (m *Manager) runtimeBinding(installation Installation, command []string, version, source string) (RuntimeBinding, error) {
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
	planModeDisabledRuntimeID := ""
	if enabled, disabled := composerProfile.PlanRuntimeIDs(); enabled != "" {
		planModeRuntimeID = enabled
		planModeDisabledRuntimeID = disabled
	}
	var launchPermission *agentruntime.StandardACPLaunchPermissionSetting
	if setting := composerProfile.LaunchPermissionSetting(); setting != nil {
		launchPermission = &agentruntime.StandardACPLaunchPermissionSetting{
			Placeholder:     setting.Placeholder,
			DefaultSemantic: setting.DefaultSemantic,
			Values:          setting.Values,
		}
	}
	var executableIdentity *agentruntime.ExecutableIdentity
	if source == "managed" && installation.Manifest.Runtime.Install.Runner == "binary" {
		artifact, err := runtimeBinaryArtifactForPlatform(installation.Manifest, runtimePlatform())
		if err != nil {
			return RuntimeBinding{}, err
		}
		executableIdentity = &agentruntime.ExecutableIdentity{SHA256: artifact.SHA256, SizeBytes: artifact.SizeBytes}
	}
	return RuntimeBinding{
		Installation: installation, Command: command, Version: version, Source: source,
		ToolAliases: aliases, ModelConfigOptionID: modelConfigOptionID,
		PermissionConfigOptionID: permissionConfigOptionID, ReasoningConfigOptionID: reasoningConfigOptionID,
		PermissionModes: permissionModes, AutomaticPermissionDecisions: composerProfile.AutomaticPermissionDecisions(),
		PlanModeRuntimeID:            planModeRuntimeID,
		PlanModeDisabledRuntimeID:    planModeDisabledRuntimeID,
		PlanModeUsesLaunchPermission: composerProfile.PlanUpdateStrategy() == "restart-with-launch-permission",
		LaunchPermission:             launchPermission,
		SetModelReasoningEffortMeta:  composerProfile.SetModelReasoningEffortMeta(), Capabilities: capabilities,
		ExecutableIdentity: executableIdentity,
	}, nil
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
	if strings.TrimSpace(source.LocalPackageDir) != "" {
		return m.installLocalPackage(source.Key, source.LocalPackageDir)
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
	if installed, err := m.loadActive(source.Key); err == nil && installed.Version == record.Version &&
		installed.ReleaseArtifactSHA256 == strings.ToLower(record.Release.ArtifactSHA256) &&
		installed.ReleaseArtifactSizeBytes == record.Release.ArtifactSizeBytes {
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
	return m.installVerifiedRelease(record.Release, artifact, source)
}

func (m *Manager) installVerifiedRelease(release Release, artifact []byte, source tuttitypes.AgentExtensionSource) (Installation, error) {
	if m.Installations == nil {
		return Installation{}, errors.New("agent extension installation store is not configured")
	}
	if err := verifyRelease(release, source); err != nil {
		return Installation{}, err
	}
	artifactDigest := sha256.Sum256(artifact)
	actualArtifactSHA256 := hex.EncodeToString(artifactDigest[:])
	if release.ArtifactSHA256 != "" && strings.ToLower(release.ArtifactSHA256) != actualArtifactSHA256 {
		return Installation{}, errors.New("extension artifact does not match release SHA-256")
	}
	if release.ArtifactSizeBytes != 0 && release.ArtifactSizeBytes != int64(len(artifact)) {
		return Installation{}, errors.New("extension artifact does not match release size")
	}
	release.ArtifactSHA256 = actualArtifactSHA256
	release.ArtifactSizeBytes = int64(len(artifact))
	finalDir, err := m.Installations.PackageDir(release.AgentKey, release.Version)
	if err != nil {
		return Installation{}, err
	}
	root := filepath.Dir(finalDir)
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
	if !reflect.DeepEqual(manifest, release.Manifest) {
		return Installation{}, errors.New("signed release manifest does not match artifact package")
	}
	if err := persistSignedPackageAuthority(staging, release, artifact); err != nil {
		return Installation{}, err
	}
	contentDigest, err := packageContentSHA256(staging)
	if err != nil {
		return Installation{}, err
	}
	signedContentDigest, err := packageArchiveContentSHA256(artifact)
	if err != nil || signedContentDigest != contentDigest {
		return Installation{}, errors.New("extracted extension package does not match signed artifact content")
	}
	if err := activateExtensionPackage(staging, finalDir, contentDigest); err != nil {
		return Installation{}, err
	}
	authorityManifest, authorityDigest, authorityRelease, err := m.verifySignedPackageAuthority(finalDir, release.AgentKey, release.Version)
	if err != nil || authorityDigest != contentDigest || !reflect.DeepEqual(authorityManifest, manifest) ||
		authorityRelease.ArtifactSHA256 != release.ArtifactSHA256 {
		if err != nil {
			return Installation{}, err
		}
		return Installation{}, errors.New("activated extension package does not match signed release authority")
	}
	installation := Installation{
		SchemaVersion: "tutti.agent.installation.v1", ID: release.AgentKey + "@" + release.Version,
		AgentKey: release.AgentKey, Version: release.Version, Provider: "acp:" + release.AgentKey,
		PackageDir: finalDir, PackageContentSHA256: contentDigest,
		ReleaseArtifactSHA256: strings.ToLower(release.ArtifactSHA256), ReleaseArtifactSizeBytes: release.ArtifactSizeBytes,
		Manifest: manifest, InstalledAt: time.Now().UTC(),
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
	if err := m.Installations.PutActive(installation); err != nil {
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
	maskIconURL := ""
	if installation.Manifest.MaskIcon.Src != "" {
		maskIconURL, err = packageAssetDataURL(installation.PackageDir, installation.Manifest.MaskIcon.Src)
		if err != nil {
			return err
		}
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
		IconURL: iconURL, MaskIconURL: maskIconURL, HeroImageURL: heroImageURL, Enabled: true, Source: agenttargetbiz.SourceSystem, SortOrder: 700,
	})
	return err
}

func (m *Manager) loadActive(key string) (Installation, error) {
	if m.Installations == nil {
		return Installation{}, errors.New("agent extension installation store is not configured")
	}
	value, err := m.Installations.ReadActive(key)
	if err != nil {
		return Installation{}, err
	}
	if value.AgentKey != key || value.ID != key+"@"+value.Version {
		return Installation{}, errors.New("active installation identity is invalid")
	}
	legacy := legacyRemoteInstallationRecord(value)
	validated, err := m.validateInstallation(value)
	if err != nil {
		return Installation{}, err
	}
	if legacy && value.PackageContentSHA256 == "" {
		if err := m.Installations.PutActive(validated); err != nil {
			return Installation{}, fmt.Errorf("migrate legacy extension installation identity: %w", err)
		}
	}
	return validated, nil
}

func (m *Manager) loadInstallationByID(id string) (Installation, error) {
	parts := strings.Split(id, "@")
	if len(parts) != 2 || !safeKey.MatchString(parts[0]) || !validSemver(parts[1]) {
		return Installation{}, errors.New("invalid extension installation id")
	}
	if m.Installations == nil {
		return Installation{}, errors.New("agent extension installation store is not configured")
	}
	value, err := m.Installations.ReadInstallation(id)
	if err != nil {
		return Installation{}, err
	}
	if value.ID != id || value.AgentKey != parts[0] || value.Version != parts[1] {
		return Installation{}, errors.New("extension installation identity mismatch")
	}
	return m.validateInstallation(value)
}

func (m *Manager) validateInstallation(value Installation) (Installation, error) {
	if m.Installations == nil {
		return Installation{}, errors.New("agent extension installation store is not configured")
	}
	expectedDir, err := m.Installations.PackageDir(value.AgentKey, value.Version)
	if err != nil {
		return Installation{}, err
	}
	if filepath.Clean(value.PackageDir) != expectedDir {
		return Installation{}, errors.New("extension installation package path is invalid")
	}
	var manifest Manifest
	if strings.Contains(value.Version, localPackageVersionMarker) {
		if !validPackageContentSHA256(value.PackageContentSHA256) {
			return Installation{}, errors.New("local extension installation content identity is missing or invalid")
		}
		contentDigest, err := packageContentSHA256(expectedDir)
		if err != nil {
			return Installation{}, fmt.Errorf("fingerprint local extension package: %w", err)
		}
		if contentDigest != value.PackageContentSHA256 {
			return Installation{}, errors.New("local extension installation content does not match snapshot")
		}
		manifest, err = validateInstalledPackage(expectedDir, value.AgentKey, value.Version)
		if err != nil {
			return Installation{}, err
		}
	} else if legacyRemoteInstallationRecord(value) {
		var contentDigest string
		manifest, contentDigest, err = validateLegacyRemoteInstallation(expectedDir, value)
		if err != nil {
			return Installation{}, err
		}
		if value.PackageContentSHA256 != "" && value.PackageContentSHA256 != contentDigest {
			return Installation{}, errors.New("legacy extension installation content does not match migrated snapshot")
		}
		value.PackageContentSHA256 = contentDigest
	} else {
		var release Release
		var authorityDigest string
		manifest, authorityDigest, release, err = m.verifySignedPackageAuthority(expectedDir, value.AgentKey, value.Version)
		if err != nil {
			return Installation{}, err
		}
		if value.PackageContentSHA256 != authorityDigest || value.ReleaseArtifactSHA256 != strings.ToLower(release.ArtifactSHA256) ||
			value.ReleaseArtifactSizeBytes != release.ArtifactSizeBytes {
			return Installation{}, errors.New("extension installation record does not match signed release authority")
		}
	}
	if !reflect.DeepEqual(manifest, value.Manifest) {
		return Installation{}, errors.New("extension installation manifest does not match signed package authority")
	}
	value.PackageDir = expectedDir
	return value, nil
}

func legacyRemoteInstallationRecord(value Installation) bool {
	return !strings.Contains(value.Version, localPackageVersionMarker) &&
		value.ReleaseArtifactSHA256 == "" && value.ReleaseArtifactSizeBytes == 0
}

func validateLegacyRemoteInstallation(root string, value Installation) (Manifest, string, error) {
	if value.SchemaVersion != "tutti.agent.installation.v1" ||
		(value.Manifest.Runtime.Install.Runner != "npm" && value.Manifest.Runtime.Install.Runner != "pnpm" && value.Manifest.Runtime.Install.Runner != "uv") ||
		len(value.Manifest.Runtime.Install.Artifacts) != 0 || value.Manifest.Runtime.Launch.PublishUserCommand != nil {
		return Manifest{}, "", errors.New("legacy extension installation contract is invalid")
	}
	for _, name := range []string{signedReleaseRecordName, signedReleaseArtifactName} {
		if _, err := os.Lstat(filepath.Join(root, name)); err == nil {
			return Manifest{}, "", errors.New("legacy extension installation contains partial signed authority")
		} else if !errors.Is(err, os.ErrNotExist) {
			return Manifest{}, "", err
		}
	}
	before, err := packageContentSHA256(root)
	if err != nil {
		return Manifest{}, "", fmt.Errorf("fingerprint legacy extension package before validation: %w", err)
	}
	manifest, err := validateInstalledPackage(root, value.AgentKey, value.Version)
	if err != nil {
		return Manifest{}, "", err
	}
	if !reflect.DeepEqual(manifest, value.Manifest) {
		return Manifest{}, "", errors.New("legacy extension installation manifest does not match package")
	}
	after, err := packageContentSHA256(root)
	if err != nil {
		return Manifest{}, "", fmt.Errorf("fingerprint legacy extension package after validation: %w", err)
	}
	if before != after {
		return Manifest{}, "", errors.New("legacy extension installation changed during validation")
	}
	return manifest, after, nil
}

func activateExtensionPackage(staging, finalDir, expectedDigest string) error {
	if _, err := packageContentSHA256(finalDir); err != nil && !errors.Is(err, os.ErrNotExist) {
		if info, statErr := os.Lstat(finalDir); statErr != nil || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("existing extension package root is unsafe")
		}
	}
	backup := finalDir + ".previous"
	if err := os.RemoveAll(backup); err != nil {
		return err
	}
	hadPrevious := false
	if _, err := os.Lstat(finalDir); err == nil {
		if err := os.Rename(finalDir, backup); err != nil {
			return err
		}
		hadPrevious = true
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Rename(staging, finalDir); err != nil {
		if hadPrevious {
			_ = os.Rename(backup, finalDir)
		}
		return err
	}
	installedDigest, err := packageContentSHA256(finalDir)
	if err != nil || installedDigest != expectedDigest {
		_ = os.RemoveAll(finalDir)
		if hadPrevious {
			_ = os.Rename(backup, finalDir)
		}
		if err != nil {
			return err
		}
		return errors.New("activated extension package content identity changed")
	}
	_ = os.RemoveAll(backup)
	return nil
}

func runtimeVersionWithEnv(ctx context.Context, executable string, args []string, constraint string, env []string) (string, error) {
	if len(args) == 0 {
		return "", nil
	}
	probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	command := exec.CommandContext(probeCtx, executable, args...)
	command.Env = env
	output, err := command.CombinedOutput()
	if err != nil {
		return "", err
	}
	version := regexp.MustCompile(`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`).FindString(string(output))
	if !validSemver(version) || !matchesConstraint(version, constraint) {
		return "", errors.New("runtime version is incompatible")
	}
	return version, nil
}

func (m *Manager) runtimeVersionWithEnv(
	ctx context.Context,
	executable string,
	args []string,
	constraint string,
	env []string,
) (string, error) {
	return m.runtimeVersionCache().load(executable, args, constraint, func() (string, error) {
		return runtimeVersionWithEnv(ctx, executable, args, constraint, env)
	})
}

func (m *Manager) runtimeVersionWithIdentity(
	ctx context.Context,
	executable string,
	args []string,
	constraint string,
	identity *agentruntime.ExecutableIdentity,
) (string, error) {
	return m.runtimeVersionCache().load(executable, args, constraint, func() (string, error) {
		return runtimeVersionWithIdentity(ctx, executable, args, constraint, identity)
	})
}

func (m *Manager) runtimeVersionCache() *runtimeVersionCache {
	m.versionCacheOnce.Do(func() {
		m.runtimeVersions = newRuntimeVersionCache()
	})
	return m.runtimeVersions
}

func runtimeVersionWithIdentity(
	ctx context.Context,
	executable string,
	args []string,
	constraint string,
	identity *agentruntime.ExecutableIdentity,
) (string, error) {
	if len(args) == 0 {
		return "", nil
	}
	probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var output []byte
	var err error
	if identity != nil {
		output, err = agentruntime.RunVerifiedExecutable(probeCtx, executable, args, identity)
	} else {
		output, err = exec.CommandContext(probeCtx, executable, args...).CombinedOutput()
	}
	if err != nil {
		return "", err
	}
	version := regexp.MustCompile(`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`).FindString(string(output))
	if !validSemver(version) || !matchesConstraint(version, constraint) {
		return "", errors.New("runtime version is incompatible")
	}
	return version, nil
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

func validSemver(value string) bool { return semver.IsValid("v" + value) }
func targetID(key string) string    { return "extension:" + key }
