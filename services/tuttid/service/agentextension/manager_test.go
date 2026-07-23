package agentextension

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/runtimecmd"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	agentextensiondata "github.com/tutti-os/tutti/services/tuttid/data/agentextension"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

type targetStoreStub struct {
	targets map[string]agenttargetbiz.Target
}

type preferencesStoreStub struct {
	preferences preferencesbiz.DesktopPreferences
}

func (s *preferencesStoreStub) GetDesktopPreferences(context.Context) (preferencesbiz.DesktopPreferences, error) {
	return s.preferences, nil
}

func (s *preferencesStoreStub) PutDesktopPreferences(_ context.Context, preferences preferencesbiz.DesktopPreferences) (preferencesbiz.DesktopPreferences, error) {
	s.preferences = preferences
	return preferences, nil
}

func (s *targetStoreStub) DeleteAgentTarget(_ context.Context, id string) error {
	delete(s.targets, id)
	return nil
}
func (s *targetStoreStub) GetAgentTarget(_ context.Context, id string) (agenttargetbiz.Target, error) {
	target, ok := s.targets[id]
	if !ok {
		return agenttargetbiz.Target{}, workspacedata.ErrAgentTargetNotFound
	}
	return target, nil
}
func (s *targetStoreStub) ListAgentTargets(context.Context) ([]agenttargetbiz.Target, error) {
	result := make([]agenttargetbiz.Target, 0, len(s.targets))
	for _, target := range s.targets {
		result = append(result, target)
	}
	return result, nil
}
func (s *targetStoreStub) PutAgentTarget(_ context.Context, target agenttargetbiz.Target) (agenttargetbiz.Target, error) {
	s.targets[target.ID] = target
	return target, nil
}

func TestManagerReconcileInstallsVerifiedPackageAndFallsBackOffline(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	artifact := testPackageZIP(t)
	digest := sha256Bytes(artifact)
	var baseURL string
	release := Release{
		SchemaVersion: releaseSchema, AgentKey: "gemini", Version: "1.0.0",
		Manifest: testManifest(), ArtifactSHA256: digest, ArtifactSizeBytes: int64(len(artifact)),
		PublishedAt: "2026-07-14T00:00:00Z", GitSHA: "abc",
		Signature: ReleaseSignature{Algorithm: "ed25519", KeyID: "test-key"},
	}
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/versions.json":
			release.ArtifactURL = baseURL + "/gemini.zip"
			release.Signature.Value = signTestRelease(t, release, privateKey)
			_ = json.NewEncoder(w).Encode(Versions{SchemaVersion: versionsSchema, AgentKey: "gemini", Versions: []VersionRecord{{Version: "1.0.0", MinTuttiVersion: "0.0.0", Status: "active", Release: release}}})
		case "/gemini.zip":
			_, _ = w.Write(artifact)
		default:
			http.NotFound(w, request)
		}
	}))
	baseURL = server.URL
	store := &targetStoreStub{targets: map[string]agenttargetbiz.Target{}}
	manager := Manager{Installations: agentextensiondata.NewFileInstallationStore(t.TempDir()), Store: store, Client: server.Client(), Sources: []tuttitypes.AgentExtensionSource{{Key: "gemini", ReleaseIndexURL: server.URL + "/versions.json", SigningKeyID: "test-key", SigningPublicKey: publicKeyPEM(t, publicKey), Enabled: true}}}
	if errs := manager.Reconcile(context.Background()); len(errs) != 0 {
		t.Fatalf("Reconcile() errors = %v", errs)
	}
	target := store.targets["extension:gemini"]
	if target.Provider != "acp:gemini" || !strings.HasPrefix(target.IconURL, "data:image/svg+xml") {
		t.Fatalf("registered target = %#v", target)
	}
	if !strings.HasPrefix(target.MaskIconURL, "data:image/svg+xml") {
		t.Fatalf("registered target mask icon = %q", target.MaskIconURL)
	}
	if !strings.HasPrefix(target.HeroImageURL, "data:image/jpeg;base64,") {
		t.Fatalf("registered target hero image = %q", target.HeroImageURL)
	}
	installation, err := manager.loadActive("gemini")
	if err != nil {
		t.Fatal(err)
	}
	if !validPackageContentSHA256(installation.PackageContentSHA256) || installation.ReleaseArtifactSHA256 != digest ||
		installation.ReleaseArtifactSizeBytes != int64(len(artifact)) {
		t.Fatalf("verified installation content identity = %#v", installation)
	}
	var discovery DiscoveryProfile
	if err := readJSON(
		filepath.Join(installation.PackageDir, installation.Manifest.Profiles.Discovery),
		&discovery,
	); err != nil {
		t.Fatal(err)
	}
	if len(discovery.Candidates) != 1 ||
		discovery.Candidates[0].Probe.Kind != "acp-initialize" ||
		discovery.Candidates[0].Probe.TimeoutMS != 5_000 {
		t.Fatalf("discovery profile = %#v", discovery)
	}
	aliases, err := loadToolAliases(installation)
	if err != nil || aliases["replace"] != "Edit" {
		t.Fatalf("tool aliases = %#v, error = %v", aliases, err)
	}
	permissionModes, planModeRuntimeID, err := loadComposerModes(installation)
	if err != nil || permissionModes["read-only"] != "default" || permissionModes["auto"] != "auto_edit" || permissionModes["full-access"] != "yolo" || permissionModes["plan"] != "plan" || planModeRuntimeID != "plan" {
		t.Fatalf("composer modes = %#v, plan = %q, error = %v", permissionModes, planModeRuntimeID, err)
	}
	server.Close()
	if errs := manager.Reconcile(context.Background()); len(errs) != 0 {
		t.Fatalf("offline Reconcile() errors = %v", errs)
	}
}

func TestManagerReconcileMigratesLegacyRemoteV2InstallationAndFallsBackOffline(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "offline", http.StatusServiceUnavailable)
	}))
	defer server.Close()

	installationStore := agentextensiondata.NewFileInstallationStore(t.TempDir())
	legacy := writeLegacyRemoteInstallationFixture(t, installationStore)
	legacyRecord, err := os.ReadFile(filepath.Join(legacy.PackageDir, installationRecordName))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(legacyRecord, []byte("packageContentSha256")) ||
		bytes.Contains(legacyRecord, []byte("releaseArtifactSha256")) ||
		bytes.Contains(legacyRecord, []byte("releaseArtifactSizeBytes")) {
		t.Fatalf("legacy fixture unexpectedly contains new authority fields: %s", legacyRecord)
	}

	targets := &targetStoreStub{targets: map[string]agenttargetbiz.Target{}}
	manager := &Manager{
		Installations: installationStore, Store: targets, Client: server.Client(),
		Sources: []tuttitypes.AgentExtensionSource{{
			Key: "gemini", ReleaseIndexURL: server.URL + "/versions.json", Enabled: true,
		}},
	}
	if errs := manager.Reconcile(context.Background()); len(errs) != 0 {
		t.Fatalf("legacy offline Reconcile() errors = %v", errs)
	}
	if target := targets.targets["extension:gemini"]; target.Provider != "acp:gemini" {
		t.Fatalf("legacy offline target = %#v", target)
	}
	migrated, err := installationStore.ReadActive("gemini")
	if err != nil {
		t.Fatal(err)
	}
	if !validPackageContentSHA256(migrated.PackageContentSHA256) || migrated.ReleaseArtifactSHA256 != "" || migrated.ReleaseArtifactSizeBytes != 0 {
		t.Fatalf("migrated legacy installation identity = %#v", migrated)
	}
	loaded, err := manager.loadInstallationByID(legacy.ID)
	if err != nil || loaded.PackageContentSHA256 != migrated.PackageContentSHA256 {
		t.Fatalf("load migrated legacy installation = %#v, error = %v", loaded, err)
	}

	localePath := filepath.Join(legacy.PackageDir, filepath.FromSlash(legacy.Manifest.LocalizationInfo.DefaultFile))
	if err := os.WriteFile(localePath, []byte(`{"agent.name":"Tampered"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.loadActive("gemini"); err == nil || !strings.Contains(err.Error(), "migrated snapshot") {
		t.Fatalf("tampered migrated legacy package error = %v", err)
	}
}

func TestManagerReconcileSnapshotsDevelopmentLocalPackage(t *testing.T) {
	sourceDir := t.TempDir()
	if err := extractPackage(testPackageZIP(t), sourceDir); err != nil {
		t.Fatal(err)
	}
	store := &targetStoreStub{targets: map[string]agenttargetbiz.Target{}}
	stateDir := t.TempDir()
	manager := Manager{
		Installations: agentextensiondata.NewFileInstallationStore(stateDir),
		Store:         store,
		Sources: []tuttitypes.AgentExtensionSource{{
			Key: "gemini", LocalPackageDir: sourceDir, Enabled: true,
		}},
	}
	if errs := manager.Reconcile(context.Background()); len(errs) != 0 {
		t.Fatalf("Reconcile() errors = %v", errs)
	}
	first, err := manager.loadActive("gemini")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(first.Version, "1.0.0+local.") || first.Manifest.Version != first.Version {
		t.Fatalf("local installation version = %#v", first)
	}
	if first.PackageDir == sourceDir || !strings.HasPrefix(first.PackageDir, filepath.Join(stateDir, "agent", "extensions", "gemini")) {
		t.Fatalf("local package was not snapshotted into daemon state: %q", first.PackageDir)
	}
	if target := store.targets["extension:gemini"]; !strings.Contains(target.LaunchRefJSON, first.ID) {
		t.Fatalf("registered target = %#v, want installation %q", target, first.ID)
	}

	localePath := filepath.Join(sourceDir, "locales", "en.json")
	if err := os.WriteFile(localePath, []byte(`{"agent.name":"Local Gemini"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if errs := manager.Reconcile(context.Background()); len(errs) != 0 {
		t.Fatalf("second Reconcile() errors = %v", errs)
	}
	second, err := manager.loadActive("gemini")
	if err != nil {
		t.Fatal(err)
	}
	if second.Version == first.Version || second.DisplayName != "Local Gemini" {
		t.Fatalf("changed local package did not activate a new snapshot: first=%#v second=%#v", first, second)
	}
}

func TestManagerResolveRuntimeUsesSignedUserSearchPath(t *testing.T) {
	homeDir := t.TempDir()
	binDir := filepath.Join(homeDir, ".kimi-code", "bin")
	if err := os.MkdirAll(binDir, 0o700); err != nil {
		t.Fatal(err)
	}
	executable := filepath.Join(binDir, "kimi")
	versionProbeLog := filepath.Join(homeDir, "version-probes.log")
	if err := os.WriteFile(executable, []byte("#!/bin/sh\nprintf 'probe\\n' >> \"$VERSION_PROBE_LOG\"\nprintf '0.28.0\\n'\n"), 0o700); err != nil {
		t.Fatal(err)
	}

	manifest := testManifest()
	manifest.AgentKey = "kimi-code"
	manifest.Name = "Kimi Code"
	discovery := `{"schemaVersion":"tutti.agent.discovery.v1","candidates":[{"binaryNames":["kimi"],"searchPaths":[{"scope":"user","path":".kimi-code/bin"}],"version":{"args":["--version"],"constraint":">=0.28.0 <1.0.0"},"launchArgs":["acp"],"probe":{"kind":"acp-initialize","timeoutMs":15000}}]}`
	manager := Manager{
		Installations: agentextensiondata.NewFileInstallationStore(t.TempDir()),
		RuntimeResolver: runtimecmd.Resolver{
			Environ: func() []string {
				return []string{
					"PATH=/usr/bin:/bin",
					"VERSION_PROBE_LOG=" + versionProbeLog,
				}
			},
			HomeDir: func() (string, error) { return homeDir, nil },
		},
	}
	installation, err := installTestPackage(
		t,
		&manager,
		Release{AgentKey: manifest.AgentKey, Version: manifest.Version},
		testPackageZIPFor(t, manifest, discovery),
	)
	if err != nil {
		t.Fatal(err)
	}

	binding, err := manager.ResolveRuntimeForCWD(context.Background(), installation.ID, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if binding.Source != "local" || binding.Version != "0.28.0" || len(binding.Command) != 2 || binding.Command[0] != executable || binding.Command[1] != "acp" {
		t.Fatalf("ResolveRuntimeForCWD() = %#v", binding)
	}
	if _, err := manager.ResolveRuntimeForCWD(context.Background(), installation.ID, t.TempDir()); err != nil {
		t.Fatal(err)
	}
	probes, err := os.ReadFile(versionProbeLog)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Count(string(probes), "probe\n"); got != 1 {
		t.Fatalf("version probes = %d, want 1 across repeated runtime resolution", got)
	}
}

func TestManagerLoadRejectsPackageBytesChangedAfterVerifiedInstall(t *testing.T) {
	manager := &Manager{Installations: agentextensiondata.NewFileInstallationStore(t.TempDir())}
	installation, err := installTestPackage(t, manager, Release{AgentKey: "gemini", Version: "1.0.0"}, testPackageZIP(t))
	if err != nil {
		t.Fatal(err)
	}
	discoveryPath := filepath.Join(installation.PackageDir, installation.Manifest.Profiles.Discovery)
	if err := os.WriteFile(discoveryPath, []byte(`{"schemaVersion":"tutti.agent.discovery.v1","candidates":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	installation.Manifest.Description = "attacker-controlled manifest"
	if err := writeJSONAtomic(filepath.Join(installation.PackageDir, "tutti.agent.json"), installation.Manifest); err != nil {
		t.Fatal(err)
	}
	installation.PackageContentSHA256, err = packageContentSHA256(installation.PackageDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.Installations.PutActive(installation); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.loadInstallationByID(installation.ID); err == nil || !strings.Contains(err.Error(), "signed artifact content") {
		t.Fatalf("tampered package load error = %v", err)
	}
}

func TestManagerLoadRejectsChangedSignedReleaseIdentityRecord(t *testing.T) {
	manager := &Manager{Installations: agentextensiondata.NewFileInstallationStore(t.TempDir())}
	installation, err := installTestPackage(t, manager, Release{AgentKey: "gemini", Version: "1.0.0"}, testPackageZIP(t))
	if err != nil {
		t.Fatal(err)
	}
	installation.ReleaseArtifactSHA256 = ""
	if err := writeJSONAtomic(filepath.Join(installation.PackageDir, installationRecordName), installation); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.loadInstallationByID(installation.ID); err == nil || !strings.Contains(err.Error(), "record does not match signed release authority") {
		t.Fatalf("changed signed release identity error = %v", err)
	}
}

func TestManagerLoadDoesNotDowngradeStrippedSignedAuthorityToLegacy(t *testing.T) {
	manager := &Manager{Installations: agentextensiondata.NewFileInstallationStore(t.TempDir())}
	installation, err := installTestPackage(t, manager, Release{AgentKey: "gemini", Version: "1.0.0"}, testPackageZIP(t))
	if err != nil {
		t.Fatal(err)
	}
	installation.PackageContentSHA256 = ""
	installation.ReleaseArtifactSHA256 = ""
	installation.ReleaseArtifactSizeBytes = 0
	if err := writeJSONAtomic(filepath.Join(installation.PackageDir, installationRecordName), installation); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.loadInstallationByID(installation.ID); err == nil || !strings.Contains(err.Error(), "partial signed authority") {
		t.Fatalf("stripped signed authority downgrade error = %v", err)
	}
}

func TestManagerLoadReverifiesPersistedSignedAuthority(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*testing.T, Installation)
		want   string
	}{
		{
			name: "release signature",
			mutate: func(t *testing.T, installation Installation) {
				var release Release
				path := filepath.Join(installation.PackageDir, signedReleaseRecordName)
				if err := readJSON(path, &release); err != nil {
					t.Fatal(err)
				}
				release.Manifest.Description = "mutable authority"
				if err := writeJSONAtomic(path, release); err != nil {
					t.Fatal(err)
				}
			},
			want: "signature is invalid",
		},
		{
			name: "release artifact",
			mutate: func(t *testing.T, installation Installation) {
				path := filepath.Join(installation.PackageDir, signedReleaseArtifactName)
				if err := os.Chmod(path, 0o600); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte("changed signed artifact"), 0o400); err != nil {
					t.Fatal(err)
				}
			},
			want: "artifact is missing or unsafe",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			manager := &Manager{Installations: agentextensiondata.NewFileInstallationStore(t.TempDir())}
			installation, err := installTestPackage(t, manager, Release{AgentKey: "gemini", Version: "1.0.0"}, testPackageZIP(t))
			if err != nil {
				t.Fatal(err)
			}
			test.mutate(t, installation)
			if _, err := manager.loadInstallationByID(installation.ID); err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("mutated signed authority error = %v", err)
			}
		})
	}
}

func TestManagerInstallAtomicallyReplacesDifferentExistingVersionBytes(t *testing.T) {
	manager := &Manager{Installations: agentextensiondata.NewFileInstallationStore(t.TempDir())}
	first, err := installTestPackage(t, manager, Release{AgentKey: "gemini", Version: "1.0.0"}, testPackageZIP(t))
	if err != nil {
		t.Fatal(err)
	}
	firstDigest := first.PackageContentSHA256
	changedManifest := testManifest()
	changedManifest.Description = "replacement signed package"
	second, err := installTestPackage(t, manager,
		Release{AgentKey: "gemini", Version: "1.0.0"},
		testPackageZIPFor(t, changedManifest, `{"schemaVersion":"tutti.agent.discovery.v1","candidates":[{"binaryNames":["gemini"],"version":{"args":["--version"],"constraint":">=0.50.0 <1.0.0"},"launchArgs":["--acp"],"probe":{"kind":"acp-initialize","timeoutMs":5000}}]}`),
	)
	if err != nil {
		t.Fatal(err)
	}
	if second.PackageContentSHA256 == firstDigest || second.Manifest.Description != changedManifest.Description {
		t.Fatalf("existing version was not replaced: first=%q second=%#v", firstDigest, second)
	}
	loaded, err := manager.loadInstallationByID(second.ID)
	if err != nil || loaded.PackageContentSHA256 != second.PackageContentSHA256 {
		t.Fatalf("load replaced package = %#v, error = %v", loaded, err)
	}
	if _, err := os.Lstat(second.PackageDir + ".previous"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("extension package backup remains: %v", err)
	}
}

func TestManagerReconcileUsesDesktopAgentExtensionFeatureFlag(t *testing.T) {
	sourceDir := t.TempDir()
	if err := extractPackage(testPackageZIP(t), sourceDir); err != nil {
		t.Fatal(err)
	}
	store := &targetStoreStub{targets: map[string]agenttargetbiz.Target{
		"extension:gemini": {ID: "extension:gemini"},
	}}
	preferences := &preferencesStoreStub{}
	manager := Manager{
		Installations: agentextensiondata.NewFileInstallationStore(t.TempDir()),
		Store:         store,
		Preferences:   preferences,
		Sources: []tuttitypes.AgentExtensionSource{{
			Key: "gemini", LocalPackageDir: sourceDir, Enabled: false,
		}},
	}

	if errs := manager.Reconcile(context.Background()); len(errs) != 0 {
		t.Fatalf("disabled Reconcile() errors = %v", errs)
	}
	if _, ok := store.targets["extension:gemini"]; ok {
		t.Fatal("disabled source target was not removed")
	}

	previous := preferencesbiz.DesktopPreferences{FeatureFlags: map[string]bool{"unrelated": true}}
	current := preferencesbiz.DesktopPreferences{FeatureFlags: map[string]bool{"agent.extension.gemini": true}}
	preferences.preferences = current
	if errs := manager.ReconcileDesktopPreferencesChange(context.Background(), previous, current); len(errs) != 0 {
		t.Fatalf("enabled ReconcileDesktopPreferencesChange() errors = %v", errs)
	}
	if _, ok := store.targets["extension:gemini"]; !ok {
		t.Fatal("enabled source target was not registered")
	}

	disabled := preferencesbiz.DesktopPreferences{FeatureFlags: map[string]bool{"agent.extension.gemini": false}}
	preferences.preferences = disabled
	if errs := manager.ReconcileDesktopPreferencesChange(context.Background(), current, disabled); len(errs) != 0 {
		t.Fatalf("disabled ReconcileDesktopPreferencesChange() errors = %v", errs)
	}
	if _, ok := store.targets["extension:gemini"]; ok {
		t.Fatal("disabled source target was not removed after preference change")
	}
}

func TestCopyLocalPackageRejectsExecutableAndSymlink(t *testing.T) {
	t.Run("executable", func(t *testing.T) {
		sourceDir := t.TempDir()
		if err := os.WriteFile(filepath.Join(sourceDir, "run.json"), []byte("{}"), 0o700); err != nil {
			t.Fatal(err)
		}
		if _, err := copyLocalPackage(sourceDir, t.TempDir()); err == nil || !strings.Contains(err.Error(), "forbidden file") {
			t.Fatalf("copyLocalPackage() error = %v", err)
		}
	})

	t.Run("symlink", func(t *testing.T) {
		sourceDir := t.TempDir()
		if err := os.Symlink(filepath.Join(sourceDir, "missing"), filepath.Join(sourceDir, "profile.json")); err != nil {
			t.Fatal(err)
		}
		if _, err := copyLocalPackage(sourceDir, t.TempDir()); err == nil || !strings.Contains(err.Error(), "symlink") {
			t.Fatalf("copyLocalPackage() error = %v", err)
		}
	})
}

func TestValidateComposerProfileAcceptsDeclarativeSkillRoots(t *testing.T) {
	var profile ComposerProfile
	if err := json.Unmarshal([]byte(`{
		"schemaVersion":"tutti.agent.composer.v1",
		"skills":{
			"invocation":"textTrigger",
			"triggerPrefix":"/",
			"roots":[
				{"scope":"workspace","path":".gemini/skills"},
				{"scope":"user","path":".agents/skills"}
			]
		}
	}`), &profile); err != nil {
		t.Fatal(err)
	}
	if err := validateComposerProfile(profile); err != nil {
		t.Fatalf("validateComposerProfile() error = %v", err)
	}
	profile.Skills.Roots[0].Path = "../outside"
	if err := validateComposerProfile(profile); err == nil {
		t.Fatal("validateComposerProfile() error = nil, want unsafe path rejection")
	}
}

func TestComposerAutomaticPermissionDecisionsAreRestrictedBySemantic(t *testing.T) {
	var profile ComposerProfile
	if err := json.Unmarshal([]byte(`{
		"schemaVersion":"tutti.agent.composer.v1",
		"permissionModes":[{"runtimeId":"dont_ask","semantic":"full-access","automaticDecision":"approved"}]
	}`), &profile); err != nil {
		t.Fatal(err)
	}
	if err := validateComposerProfile(profile); err != nil {
		t.Fatalf("validateComposerProfile() error = %v", err)
	}
	decisions := profile.AutomaticPermissionDecisions()
	if decisions["full-access"] != "approved" || decisions["dont_ask"] != "approved" {
		t.Fatalf("automatic decisions = %#v", decisions)
	}
	profile.PermissionModes[0].Semantic = "ask-before-write"
	if err := validateComposerProfile(profile); err == nil {
		t.Fatal("validateComposerProfile() accepted auto-approval outside full-access")
	}
}

func TestComposerProfileACPConfigOptionIDs(t *testing.T) {
	t.Run("canonical", func(t *testing.T) {
		profile := ComposerProfile{SchemaVersion: "tutti.agent.composer.v1"}
		profile.ConfigOptions = &struct {
			Model      ComposerConfigOptionReference `json:"model"`
			Permission ComposerConfigOptionReference `json:"permission"`
			Reasoning  ComposerConfigOptionReference `json:"reasoning"`
		}{
			Model:      ComposerConfigOptionReference{ACPOptionID: "model-choice"},
			Permission: ComposerConfigOptionReference{ACPOptionID: "approval-mode"},
			Reasoning:  ComposerConfigOptionReference{ACPOptionID: "thought-level"},
		}
		model, permission, reasoning := profile.ACPConfigOptionIDs()
		if model != "model-choice" || permission != "approval-mode" || reasoning != "thought-level" {
			t.Fatalf("config option ids = %q, %q, %q", model, permission, reasoning)
		}
	})

	t.Run("legacy", func(t *testing.T) {
		profile := ComposerProfile{
			SchemaVersion: "tutti.agent.composer.v1",
			Model:         json.RawMessage(`{"source":"acp-session-models"}`),
			Permission:    json.RawMessage(`{"source":"acp-session-modes"}`),
		}
		model, permission, reasoning := profile.ACPConfigOptionIDs()
		if model != "model" || permission != "mode" || reasoning != "reasoning_effort" {
			t.Fatalf("legacy config option ids = %q, %q, %q", model, permission, reasoning)
		}
	})

	t.Run("absent", func(t *testing.T) {
		model, permission, reasoning := (ComposerProfile{}).ACPConfigOptionIDs()
		if model != "" || permission != "" || reasoning != "" {
			t.Fatalf("absent config option ids = %q, %q, %q", model, permission, reasoning)
		}
	})
}

func TestLoadComposerModesKeepsDistinctGenericRuntimeModes(t *testing.T) {
	packageDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(packageDir, "profiles"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(packageDir, "profiles", "composer.json"), []byte(`{
		"schemaVersion":"tutti.agent.composer.v1",
		"model":{"source":"acp-session-modes"},
		"permission":{"source":"acp-session-modes"},
		"permissionModes":[
			{"runtimeId":"default","semantic":"ask-before-write"},
			{"runtimeId":"acceptEdits","semantic":"accept-edits"},
			{"runtimeId":"auto","semantic":"auto"},
			{"runtimeId":"dontAsk","semantic":"locked-down"},
			{"runtimeId":"bypassPermissions","semantic":"full-access"},
			{"runtimeId":"fullAccess","semantic":"full-access"},
			{"runtimeId":"plan","semantic":"read-only"}
		]
	}`), 0o600); err != nil {
		t.Fatal(err)
	}
	manifest := Manifest{}
	manifest.Profiles.Composer = "profiles/composer.json"
	modes, planModeRuntimeID, err := loadComposerModes(Installation{
		PackageDir: packageDir,
		Manifest:   manifest,
	})
	if err != nil {
		t.Fatalf("loadComposerModes() error = %v", err)
	}
	if modes["read-only"] != "default" ||
		modes["accept-edits"] != "acceptEdits" ||
		modes["auto"] != "auto" ||
		modes["locked-down"] != "dontAsk" ||
		modes["dontask"] != "dontAsk" ||
		modes["full-access"] != "bypassPermissions" ||
		modes["fullaccess"] != "fullAccess" ||
		modes["plan"] != "plan" ||
		planModeRuntimeID != "plan" {
		t.Fatalf("composer modes = %#v, plan = %q", modes, planModeRuntimeID)
	}
}

func TestLoadComposerModesExactRuntimeIDWinsOverSemanticAlias(t *testing.T) {
	packageDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(packageDir, "profiles"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(packageDir, "profiles", "composer.json"), []byte(`{
		"schemaVersion":"tutti.agent.composer.v1",
		"permissionModes":[
			{"runtimeId":"auto","semantic":"ask-before-write"},
			{"runtimeId":"danger","semantic":"auto"}
		]
	}`), 0o600); err != nil {
		t.Fatal(err)
	}
	manifest := Manifest{}
	manifest.Profiles.Composer = "profiles/composer.json"
	modes, _, err := loadComposerModes(Installation{PackageDir: packageDir, Manifest: manifest})
	if err != nil {
		t.Fatalf("loadComposerModes() error = %v", err)
	}
	if modes["auto"] != "auto" || modes["danger"] != "danger" {
		t.Fatalf("composer modes = %#v, want exact runtime ids to win over aliases", modes)
	}
}

func TestValidateComposerProfileRejectsInvalidSignedCommandDeclarations(t *testing.T) {
	tests := []struct {
		name string
		raw  string
	}{
		{
			name: "schema",
			raw:  `{"schemaVersion":"tutti.agent.composer.v2"}`,
		},
		{
			name: "duplicate command",
			raw:  `{"schemaVersion":"tutti.agent.composer.v1","slashCommands":{"commands":[{"name":"status"},{"name":"STATUS"}]}}`,
		},
		{
			name: "invalid command name",
			raw:  `{"schemaVersion":"tutti.agent.composer.v1","slashCommands":{"commands":[{"name":"bad command"}]}}`,
		},
		{
			name: "unsupported effect",
			raw:  `{"schemaVersion":"tutti.agent.composer.v1","slashCommands":{"commands":[{"name":"status","effect":"runArbitraryCode"}]}}`,
		},
		{
			name: "unknown launch placeholder",
			raw:  `{"schemaVersion":"tutti.agent.composer.v1","launchSettings":{"permission":{"placeholder":"${unknown}"}},"permissionModes":[{"runtimeId":"ask","semantic":"ask-before-write"},{"runtimeId":"auto","semantic":"auto"},{"runtimeId":"all","semantic":"full-access"}]}`,
		},
		{
			name: "unknown launch semantic",
			raw:  `{"schemaVersion":"tutti.agent.composer.v1","launchSettings":{"permission":{"placeholder":"${permissionMode}"}},"permissionModes":[{"runtimeId":"ask","semantic":"ask-before-write"},{"runtimeId":"auto","semantic":"auto"},{"runtimeId":"all","semantic":"full-access"},{"runtimeId":"maybe","semantic":"maybe"}]}`,
		},
		{
			name: "unknown runtime semantic",
			raw:  `{"schemaVersion":"tutti.agent.composer.v1","permissionModes":[{"runtimeId":"maybe","semantic":"maybe"}]}`,
		},
		{
			name: "duplicate runtime permission id",
			raw:  `{"schemaVersion":"tutti.agent.composer.v1","permissionModes":[{"runtimeId":"same","semantic":"ask-before-write"},{"runtimeId":"same","semantic":"full-access"}]}`,
		},
		{
			name: "duplicate launch runtime value",
			raw:  `{"schemaVersion":"tutti.agent.composer.v1","launchSettings":{"permission":{"placeholder":"${permissionMode}"}},"permissionModes":[{"runtimeId":"ask","semantic":"ask-before-write"},{"runtimeId":"ask","semantic":"auto"},{"runtimeId":"all","semantic":"full-access"}]}`,
		},
		{
			name: "shell launch runtime value",
			raw:  `{"schemaVersion":"tutti.agent.composer.v1","launchSettings":{"permission":{"placeholder":"${permissionMode}"}},"permissionModes":[{"runtimeId":"ask","semantic":"ask-before-write"},{"runtimeId":"auto;run","semantic":"auto"},{"runtimeId":"all","semantic":"full-access"}]}`,
		},
		{
			name: "non ask launch default",
			raw:  `{"schemaVersion":"tutti.agent.composer.v1","launchSettings":{"permission":{"placeholder":"${permissionMode}","defaultSemantic":"auto"}},"permissionModes":[{"runtimeId":"ask","semantic":"ask-before-write"},{"runtimeId":"auto","semantic":"auto"},{"runtimeId":"all","semantic":"full-access"}]}`,
		},
		{
			name: "ambiguous plan workflow",
			raw:  `{"schemaVersion":"tutti.agent.composer.v1","workflowModes":{"plan":{"enabledRuntimeId":"plan","disabledRuntimeId":"plan"}}}`,
		},
		{
			name: "launch restart plan without launch permission",
			raw:  `{"schemaVersion":"tutti.agent.composer.v1","workflowModes":{"plan":{"enabledRuntimeId":"plan","disabledRuntimeId":"default","updateStrategy":"restart-with-launch-permission"}}}`,
		},
		{
			name: "unknown plan update strategy",
			raw:  `{"schemaVersion":"tutti.agent.composer.v1","workflowModes":{"plan":{"enabledRuntimeId":"plan","disabledRuntimeId":"default","updateStrategy":"replace-everything"}}}`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var profile ComposerProfile
			if err := json.Unmarshal([]byte(tt.raw), &profile); err != nil {
				t.Fatal(err)
			}
			if err := validateComposerProfile(profile); err == nil {
				t.Fatal("validateComposerProfile() error = nil, want signed profile rejection")
			}
		})
	}
}

func TestValidateComposerPermissionModeErrorsIdentifyConflictingDeclaration(t *testing.T) {
	tests := []struct {
		name  string
		modes []ComposerPermissionMode
		want  []string
	}{
		{
			name: "case-insensitive runtime id conflict",
			modes: []ComposerPermissionMode{
				{RuntimeID: "Auto", Semantic: "ask-before-write"},
				{RuntimeID: "auto", Semantic: "full-access"},
			},
			want: []string{`"Auto"`, `"auto"`, "ignoring case"},
		},
		{
			name:  "unsupported semantic",
			modes: []ComposerPermissionMode{{RuntimeID: "danger", Semantic: "root"}},
			want:  []string{`"danger"`, `"root"`},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateComposerPermissionModes(test.modes)
			if err == nil {
				t.Fatal("validateComposerPermissionModes() error = nil")
			}
			for _, want := range test.want {
				if !strings.Contains(err.Error(), want) {
					t.Fatalf("error = %q, want substring %q", err, want)
				}
			}
		})
	}
}

func TestValidateComposerProfileAcceptsClosedSpawnPermissionAndWorkflowDeclarations(t *testing.T) {
	var profile ComposerProfile
	if err := json.Unmarshal([]byte(`{
		"schemaVersion":"tutti.agent.composer.v1",
		"launchSettings":{"permission":{"placeholder":"${permissionMode}"}},
		"permissionModes":[
			{"runtimeId":"default","semantic":"ask-before-write"},
			{"runtimeId":"auto","semantic":"auto"},
			{"runtimeId":"bypassPermissions","semantic":"full-access"}
		],
		"workflowModes":{"plan":{"enabledRuntimeId":"plan","disabledRuntimeId":"default","updateStrategy":"restart-with-launch-permission"}},
		"setModel":{"reasoningEffortMeta":true}
	}`), &profile); err != nil {
		t.Fatal(err)
	}
	if err := validateComposerProfile(profile); err != nil {
		t.Fatalf("validateComposerProfile: %v", err)
	}
	setting := profile.LaunchPermissionSetting()
	if setting == nil || setting.Values["ask-before-write"] != "default" || setting.Values["full-access"] != "bypassPermissions" {
		t.Fatalf("launch permission setting = %#v", setting)
	}
	if enabled, disabled := profile.PlanRuntimeIDs(); enabled != "plan" || disabled != "default" {
		t.Fatalf("plan workflow = %q/%q, want plan/default", enabled, disabled)
	}
	if strategy := profile.PlanUpdateStrategy(); strategy != "restart-with-launch-permission" {
		t.Fatalf("plan workflow update strategy = %q", strategy)
	}
	if !profile.SetModelReasoningEffortMeta() {
		t.Fatal("setModel.reasoningEffortMeta = false, want true")
	}
}

func TestValidateDiscoveryLaunchPlaceholdersFailsClosed(t *testing.T) {
	var composer ComposerProfile
	if err := json.Unmarshal([]byte(`{
		"schemaVersion":"tutti.agent.composer.v1",
		"launchSettings":{"permission":{"placeholder":"${permissionMode}"}},
		"permissionModes":[
			{"runtimeId":"default","semantic":"ask-before-write"},
			{"runtimeId":"auto","semantic":"auto"},
			{"runtimeId":"bypassPermissions","semantic":"full-access"}
		]
	}`), &composer); err != nil {
		t.Fatal(err)
	}
	profile := func(args ...string) DiscoveryProfile {
		value := DiscoveryProfile{}
		value.Candidates = append(value.Candidates, DiscoveryCandidate{LaunchArgs: args})
		return value
	}
	if err := validateDiscoveryLaunchPlaceholders(profile("--no-auto-update", "--permission-mode", "${permissionMode}", "agent", "stdio"), composer); err != nil {
		t.Fatalf("valid launch placeholders: %v", err)
	}
	for name, candidate := range map[string]DiscoveryProfile{
		"missing":          profile("agent", "stdio"),
		"unknown":          profile("agent", "${unknown}", "stdio"),
		"combined":         profile("agent", "mode=${permissionMode}", "stdio"),
		"duplicate":        profile("agent", "${permissionMode}", "${permissionMode}", "stdio"),
		"malformed dollar": profile("agent", "$permissionMode", "stdio"),
	} {
		t.Run(name, func(t *testing.T) {
			if err := validateDiscoveryLaunchPlaceholders(candidate, composer); err == nil {
				t.Fatal("validateDiscoveryLaunchPlaceholders error = nil, want rejection")
			}
		})
	}
}

func TestValidateManifestLaunchPermissionPlaceholderFailsClosed(t *testing.T) {
	var composer ComposerProfile
	if err := json.Unmarshal([]byte(`{
		"schemaVersion":"tutti.agent.composer.v1",
		"launchSettings":{"permission":{"placeholder":"${permissionMode}"}},
		"permissionModes":[
			{"runtimeId":"default","semantic":"ask-before-write"},
			{"runtimeId":"auto","semantic":"auto"},
			{"runtimeId":"bypassPermissions","semantic":"full-access"}
		]
	}`), &composer); err != nil {
		t.Fatal(err)
	}
	manifest := testManifest()
	manifest.Runtime.Launch.Args = []string{"--no-auto-update", "--permission-mode", "${permissionMode}", "agent", "stdio"}
	if err := validateRuntimeContract(manifest); err != nil {
		t.Fatalf("validateRuntimeContract: %v", err)
	}
	if err := validateManifestLaunchPlaceholders(manifest, composer); err != nil {
		t.Fatalf("validateManifestLaunchPlaceholders: %v", err)
	}
	for name, args := range map[string][]string{
		"missing":   {"agent", "stdio"},
		"combined":  {"agent", "mode=${permissionMode}", "stdio"},
		"duplicate": {"agent", "${permissionMode}", "${permissionMode}", "stdio"},
		"unknown":   {"agent", "${unknown}", "stdio"},
	} {
		t.Run(name, func(t *testing.T) {
			candidate := manifest
			candidate.Runtime.Launch.Args = args
			if err := validateManifestLaunchPlaceholders(candidate, composer); err == nil {
				t.Fatal("validateManifestLaunchPlaceholders error = nil, want rejection")
			}
		})
	}
}

func TestLoadExtensionComposerSlashCommandsAndCapabilities(t *testing.T) {
	packageDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(packageDir, "profiles"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(packageDir, "profiles", "composer.json"), []byte(`{
		"schemaVersion":"tutti.agent.composer.v1",
		"model":{"source":"acp-session-models"},
		"permission":{"source":"acp-session-modes"},
		"permissionModes":[
			{"runtimeId":"default","semantic":"ask-before-write"}
		],
		"slashCommands":{
			"commandCatalogAuthoritative":true,
			"commands":[
				{"name":"compact","effect":"submitImmediate"},
				{"name":"status","effect":"showStatus"},
				{"name":"goal","effect":"activateGoalMode"},
				{"name":"plan","effect":"togglePlanMode"}
			]
		}
	}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(packageDir, "profiles", "capabilities.json"), []byte(`{
		"schemaVersion":"tutti.agent.capabilities.v1",
		"declared":{
			"compact":true,
			"planMode":true,
			"modelSelection":true
		}
	}`), 0o600); err != nil {
		t.Fatal(err)
	}
	installation := Installation{PackageDir: packageDir}
	installation.Manifest.Profiles.Composer = "profiles/composer.json"
	installation.Manifest.Profiles.Capabilities = "profiles/capabilities.json"
	var profile ComposerProfile
	if err := readJSON(filepath.Join(packageDir, "profiles", "composer.json"), &profile); err != nil {
		t.Fatal(err)
	}
	if err := validateComposerProfile(profile); err != nil {
		t.Fatalf("validateComposerProfile() error = %v", err)
	}
	capabilities, err := loadDeclaredCapabilities(installation)
	if err != nil {
		t.Fatalf("loadDeclaredCapabilities() error = %v", err)
	}
	if strings.Join(capabilities, ",") != "compact,planMode" {
		t.Fatalf("capabilities = %#v, want only known agent capability keys", capabilities)
	}
}

func TestManagerReconcilePreservesRemoteErrorWhenNoOfflineInstallationExists(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
	}))
	defer server.Close()

	manager := Manager{
		Installations: agentextensiondata.NewFileInstallationStore(t.TempDir()),
		Client:        server.Client(),
		Sources: []tuttitypes.AgentExtensionSource{{
			Key:             "gemini",
			ReleaseIndexURL: server.URL + "/versions.json",
			Enabled:         true,
		}},
	}
	errs := manager.Reconcile(context.Background())
	if len(errs) != 1 {
		t.Fatalf("Reconcile() errors = %v", errs)
	}
	message := errs[0].Error()
	if !strings.Contains(message, "HTTP 503") || !strings.Contains(message, "load active installation fallback") {
		t.Fatalf("Reconcile() error = %q", message)
	}
}

func TestExtractPackageRejectsExecutableEntry(t *testing.T) {
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	header := &zip.FileHeader{Name: "run.sh", Method: zip.Store}
	header.SetMode(0o755)
	entry, err := writer.CreateHeader(header)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = entry.Write([]byte("echo unsafe"))
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := extractPackage(buffer.Bytes(), t.TempDir()); err == nil {
		t.Fatal("extractPackage() error = nil, want executable rejection")
	}
}

func TestValidateInstalledPackageRejectsManifestV1(t *testing.T) {
	manifest := testManifest()
	manifest.SchemaVersion = "tutti.agent.manifest.v1"
	root := t.TempDir()
	if err := extractPackage(testPackageZIPFor(t, manifest, `{"schemaVersion":"tutti.agent.discovery.v1","candidates":[]}`), root); err != nil {
		t.Fatal(err)
	}
	if _, err := validateInstalledPackage(root, manifest.AgentKey, manifest.Version); err == nil {
		t.Fatal("validateInstalledPackage() accepted manifest v1")
	}
}

func testPackageZIP(t *testing.T) []byte {
	return testPackageZIPFor(t, testManifest(), `{"schemaVersion":"tutti.agent.discovery.v1","candidates":[{"binaryNames":["gemini"],"version":{"args":["--version"],"constraint":">=0.50.0 <1.0.0"},"launchArgs":["--acp"],"probe":{"kind":"acp-initialize","timeoutMs":5000}}]}`)
}

func testPackageZIPFor(t *testing.T, manifest Manifest, discovery string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for _, name := range []string{"assets/", "profiles/", "locales/"} {
		header := &zip.FileHeader{Name: name, Method: zip.Store}
		header.SetMode(os.ModeDir | 0o755)
		if _, err := writer.CreateHeader(header); err != nil {
			t.Fatal(err)
		}
	}
	files := map[string][]byte{
		"tutti.agent.json":        mustJSON(t, manifest),
		"assets/icon.svg":         []byte(`<svg xmlns="http://www.w3.org/2000/svg"/>`),
		"assets/mask-icon.svg":    []byte(`<svg xmlns="http://www.w3.org/2000/svg"/>`),
		"assets/hero-image.jpg":   []byte("hero-image"),
		"profiles/discovery.json": []byte(discovery),
		"profiles/tools.json":     []byte(`{"schemaVersion":"tutti.agent.tools.v1","tools":[{"match":{"ids":["replace"]},"canonicalId":"Edit","category":"file-change","presentation":{"renderer":"diff","titleKey":"tools.edit.title"},"fileEffect":{"source":"acp-content-diff"}}]}`),
		"profiles/composer.json":  []byte(`{"schemaVersion":"tutti.agent.composer.v1","model":{"source":"acp-session-config"},"permission":{"source":"acp-session-config"},"permissionModes":[{"runtimeId":"default","semantic":"ask-before-write"},{"runtimeId":"auto_edit","semantic":"accept-edits"},{"runtimeId":"yolo","semantic":"full-access"},{"runtimeId":"plan","semantic":"read-only"}]}`),
		"locales/en.json":         []byte(`{"agent.name":"Gemini CLI"}`),
	}
	for name, content := range files {
		header := &zip.FileHeader{Name: name, Method: zip.Store}
		header.SetMode(0o600)
		entry, err := writer.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write(content); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func testManifest() Manifest {
	var value Manifest
	value.SchemaVersion = manifestSchema
	value.AgentKey = "gemini"
	value.Version = "1.0.0"
	value.Name = "Gemini CLI"
	value.Description = "Gemini through ACP"
	value.Icon.Type = "asset"
	value.Icon.Src = "assets/icon.svg"
	value.MaskIcon.Type = "asset"
	value.MaskIcon.Src = "assets/mask-icon.svg"
	value.HeroImage.Type = "asset"
	value.HeroImage.Src = "assets/hero-image.jpg"
	value.Runtime.Kind = "standard-acp"
	value.Runtime.Install.Runner = "npm"
	value.Runtime.Install.Args = []string{"install", "--prefix", "${installRoot}", "@google/gemini-cli@0.50.0"}
	value.Runtime.Launch.Executable = "${installRoot}/node_modules/.bin/gemini"
	value.Runtime.Launch.Args = []string{"--acp"}
	value.Profiles.Discovery = "profiles/discovery.json"
	value.Profiles.Tools = "profiles/tools.json"
	value.Profiles.Composer = "profiles/composer.json"
	value.LocalizationInfo.DefaultLocale = "en"
	value.LocalizationInfo.DefaultFile = "locales/en.json"
	return value
}

func writeLegacyRemoteInstallationFixture(
	t *testing.T,
	store *agentextensiondata.FileInstallationStore,
) Installation {
	t.Helper()
	packageDir, err := store.PackageDir("gemini", "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(packageDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := extractPackage(testPackageZIP(t), packageDir); err != nil {
		t.Fatal(err)
	}
	manifest, err := validateInstalledPackage(packageDir, "gemini", "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	installation := Installation{
		SchemaVersion: "tutti.agent.installation.v1", ID: "gemini@1.0.0",
		AgentKey: "gemini", Version: "1.0.0", Provider: "acp:gemini",
		PackageDir: packageDir, Manifest: manifest, InstalledAt: time.Unix(1_700_000_000, 0).UTC(),
		DisplayName: manifest.Name, AuthMessage: "Authentication required",
	}
	encoded, err := json.Marshal(installation)
	if err != nil {
		t.Fatal(err)
	}
	var legacyRecord map[string]any
	if err := json.Unmarshal(encoded, &legacyRecord); err != nil {
		t.Fatal(err)
	}
	delete(legacyRecord, "packageContentSha256")
	delete(legacyRecord, "releaseArtifactSha256")
	delete(legacyRecord, "releaseArtifactSizeBytes")
	encoded, err = json.MarshalIndent(legacyRecord, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	encoded = append(encoded, '\n')
	if err := writeBytesAtomic(filepath.Join(packageDir, installationRecordName), encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	agentDir, err := store.AgentDir("gemini")
	if err != nil {
		t.Fatal(err)
	}
	if err := writeBytesAtomic(filepath.Join(agentDir, "active.json"), encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	return installation
}

func installTestPackage(t *testing.T, manager *Manager, release Release, artifact []byte) (Installation, error) {
	t.Helper()
	verificationRoot := t.TempDir()
	if err := extractPackage(artifact, verificationRoot); err != nil {
		t.Fatal(err)
	}
	manifest, err := validateInstalledPackage(verificationRoot, release.AgentKey, release.Version)
	if err != nil {
		t.Fatal(err)
	}
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	keyDigest := sha256.Sum256(publicKey)
	keyID := "test-release-" + hex.EncodeToString(keyDigest[:6])
	release.SchemaVersion = releaseSchema
	release.Manifest = manifest
	release.ArtifactURL = "https://example.test/" + release.AgentKey + "-" + release.Version + ".zip"
	release.ArtifactSHA256 = sha256Bytes(artifact)
	release.ArtifactSizeBytes = int64(len(artifact))
	release.PublishedAt = "2026-07-19T00:00:00Z"
	release.GitSHA = "test"
	release.Signature = ReleaseSignature{Algorithm: "ed25519", KeyID: keyID}
	release.Signature.Value = signTestRelease(t, release, privateKey)
	source := tuttitypes.AgentExtensionSource{
		Key: release.AgentKey, SigningKeyID: keyID, SigningPublicKey: publicKeyPEM(t, publicKey),
	}
	manager.Sources = append(manager.Sources, source)
	return manager.installVerifiedRelease(release, artifact, source)
}

func signTestRelease(t *testing.T, release Release, key ed25519.PrivateKey) string {
	t.Helper()
	raw := mustJSON(t, release)
	var unsigned map[string]any
	if err := json.Unmarshal(raw, &unsigned); err != nil {
		t.Fatal(err)
	}
	delete(unsigned, "signature")
	payload := mustJSON(t, unsigned)
	return base64.StdEncoding.EncodeToString(ed25519.Sign(key, payload))
}
func publicKeyPEM(t *testing.T, key ed25519.PublicKey) string {
	t.Helper()
	raw, err := x509.MarshalPKIXPublicKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: raw}))
}
func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
func sha256Bytes(value []byte) string { sum := sha256.Sum256(value); return hex.EncodeToString(sum[:]) }
