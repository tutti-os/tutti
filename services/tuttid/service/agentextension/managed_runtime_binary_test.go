package agentextension

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestResolveInstalledBinaryRequiresCurrentSignedFingerprint(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*RuntimeBinaryArtifact)
	}{
		{
			name: "sha256",
			mutate: func(artifact *RuntimeBinaryArtifact) {
				artifact.SHA256 = strings.Repeat("0", 64)
			},
		},
		{
			name: "size",
			mutate: func(artifact *RuntimeBinaryArtifact) {
				artifact.SizeBytes++
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			manager, installation, profile, _, _ := managedBinaryResolutionFixture(t, test.mutate)
			_, err := manager.resolveInstalledManagedRuntime(context.Background(), installation, profile, t.TempDir())
			if !errors.Is(err, ErrManagedRuntimeIntegrity) || !strings.Contains(err.Error(), "current signed artifact") {
				t.Fatalf("signed artifact mismatch error = %v", err)
			}
		})
	}
}

func TestResolveInstalledBinaryRejectsReplacementDuringVersionProbe(t *testing.T) {
	manager, installation, profile, sourceRoot, fingerprint := managedBinaryResolutionFixture(t, nil)
	t.Setenv("TUTTI_TEST_MANAGED_BINARY_REPLACE", "1")

	_, err := manager.resolveInstalledManagedRuntime(context.Background(), installation, profile, t.TempDir())
	if !errors.Is(err, ErrManagedRuntimeIntegrity) || !strings.Contains(err.Error(), "verified version probe") {
		t.Fatalf("version-probe replacement error = %v", err)
	}
	if err := verifyRuntimeExecutableUnchanged(filepath.Join(sourceRoot, "grok"), fingerprint); err != nil {
		t.Fatalf("version probe executed or changed replaceable runtime pathname: %v", err)
	}
}

func TestManagerRuntimeVersionWithIdentityReusesSuccessfulProbe(t *testing.T) {
	manager, _, profile, sourceRoot, fingerprint := managedBinaryResolutionFixture(t, nil)
	versionProbeLog := filepath.Join(t.TempDir(), "version-probes.log")
	t.Setenv("TUTTI_TEST_MANAGED_BINARY_VERSION_LOG", versionProbeLog)
	executable := filepath.Join(sourceRoot, "grok")
	candidate := profile.Candidates[0]

	for range 2 {
		version, err := manager.runtimeVersionWithIdentity(
			context.Background(),
			executable,
			candidate.Version.Args,
			candidate.Version.Constraint,
			executableIdentity(fingerprint),
		)
		if err != nil || version != "0.2.103" {
			t.Fatalf("managed runtime version = %q, %v", version, err)
		}
	}
	probes, err := os.ReadFile(versionProbeLog)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Count(string(probes), "probe\n"); got != 1 {
		t.Fatalf("managed runtime version probes = %d, want 1", got)
	}
}

func TestResolveInstalledBinaryRejectsSymlinkedActiveRoot(t *testing.T) {
	manager, installation, profile, activeRoot, fingerprint := managedBinaryResolutionFixture(t, nil)
	realRoot := activeRoot + ".real"
	if err := os.Rename(activeRoot, realRoot); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(realRoot, activeRoot); err != nil {
		t.Skipf("symlink fixture unavailable: %v", err)
	}

	_, err := manager.resolveInstalledManagedRuntime(context.Background(), installation, profile, t.TempDir())
	if !errors.Is(err, ErrManagedRuntimeIntegrity) || !strings.Contains(err.Error(), "active runtime root is unsafe") {
		t.Fatalf("symlinked active runtime root error = %v", err)
	}
	info, statErr := os.Lstat(activeRoot)
	if statErr != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("symlinked active root was replaced: info=%#v error=%v", info, statErr)
	}
	if err := verifyRuntimeExecutableUnchanged(filepath.Join(realRoot, "grok"), fingerprint); err != nil {
		t.Fatalf("symlink target executable changed: %v", err)
	}
}

func TestAdoptCompatibleBinaryRejectsCandidateFromChangedSignedArtifact(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*RuntimeBinaryArtifact)
	}{
		{name: "sha256", mutate: func(artifact *RuntimeBinaryArtifact) { artifact.SHA256 = strings.Repeat("0", 64) }},
		{name: "size", mutate: func(artifact *RuntimeBinaryArtifact) { artifact.SizeBytes++ }},
	} {
		t.Run(test.name, func(t *testing.T) {
			manager, installation, profile, sourceRoot, fingerprint := managedBinaryResolutionFixture(t, test.mutate)
			packageName, packageVersion, artifact, err := runtimeInstallIdentity(installation.Manifest, runtimePlatform())
			if err != nil {
				t.Fatal(err)
			}
			runtimeIdentity, err := managedRuntimeIdentity(installation, profile, packageName, packageVersion, runtimePlatform())
			if err != nil {
				t.Fatal(err)
			}
			targetRoot := managedRuntimeRoot(manager.RuntimeInstallDir, installation.AgentKey, runtimeIdentity)
			legacyRoot := filepath.Join(manager.RuntimeInstallDir, installation.AgentKey, "legacy-runtime")
			if err := os.Rename(sourceRoot, legacyRoot); err != nil {
				t.Fatal(err)
			}
			sourceRoot = legacyRoot
			if fingerprint == (runtimeExecutableFingerprint{SHA256: artifact.SHA256, Size: artifact.SizeBytes}) {
				t.Fatal("fixture does not represent changed signed artifact metadata")
			}

			err = manager.adoptCompatibleManagedRuntime(
				context.Background(), installation, profile, packageName, packageVersion, artifact, runtimeIdentity, targetRoot,
			)
			if !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("changed artifact adoption error = %v", err)
			}
			if _, err := os.Stat(filepath.Join(sourceRoot, "grok")); err != nil {
				t.Fatalf("rejected adoption moved source runtime: %v", err)
			}
			if _, err := os.Lstat(targetRoot); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("rejected adoption created target runtime: %v", err)
			}
		})
	}
}

func TestActivateManagedRuntimeRollsBackExistingBinaryOnVerificationFailure(t *testing.T) {
	for _, test := range []struct {
		name       string
		stage      func(*testing.T, string) runtimeExecutableFingerprint
		wantMarker string
	}{
		{
			name: "file replacement",
			stage: func(t *testing.T, staging string) runtimeExecutableFingerprint {
				path := filepath.Join(staging, "grok")
				if err := os.WriteFile(path, []byte("new executable"), 0o700); err != nil {
					t.Fatal(err)
				}
				return runtimeExecutableFingerprint{SHA256: strings.Repeat("f", 64), Size: 1}
			},
			wantMarker: "old executable",
		},
		{
			name: "unsafe symlink",
			stage: func(t *testing.T, staging string) runtimeExecutableFingerprint {
				target := filepath.Join(t.TempDir(), "foreign")
				if err := os.WriteFile(target, []byte("foreign executable"), 0o700); err != nil {
					t.Fatal(err)
				}
				fingerprint, err := fingerprintRuntimeExecutable(target)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(target, filepath.Join(staging, "grok")); err != nil {
					t.Fatal(err)
				}
				return fingerprint
			},
			wantMarker: "old executable",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			runtimeInstallDir := filepath.Join(testResolvedTempDir(t), "agent-runtimes")
			installation := Installation{AgentKey: "grok"}
			plan := InstallPlan{
				AgentKey: "grok", RuntimeIdentity: "runtime-current",
				InstallRoot: managedRuntimeRoot(runtimeInstallDir, "grok", "runtime-current"),
			}
			if err := os.MkdirAll(plan.InstallRoot, 0o700); err != nil {
				t.Fatal(err)
			}
			oldExecutable := filepath.Join(plan.InstallRoot, "grok")
			if err := os.WriteFile(oldExecutable, []byte(test.wantMarker), 0o700); err != nil {
				t.Fatal(err)
			}
			workspace, err := openManagedRuntimeWorkspace(runtimeInstallDir, "grok")
			if err != nil {
				t.Fatal(err)
			}
			defer workspace.Close()
			stagingDir, err := workspace.createTemp(".runtime-install-")
			if err != nil {
				t.Fatal(err)
			}
			defer stagingDir.Close()
			staging := stagingDir.path
			activation := managedRuntimeActivation{
				ExecutableRelativePath: "grok",
				ExecutableFingerprint:  test.stage(t, staging),
			}

			err = activateManagedRuntime(installation, workspace, stagingDir, plan, runtimeInstallDir, nil, activation)
			if err == nil {
				t.Fatal("activation verification failure error = nil")
			}
			content, readErr := os.ReadFile(oldExecutable)
			if readErr != nil || string(content) != test.wantMarker {
				t.Fatalf("previous runtime was not restored: content=%q error=%v", content, readErr)
			}
			if _, statErr := os.Lstat(plan.InstallRoot + ".previous"); !errors.Is(statErr, os.ErrNotExist) {
				t.Fatalf("activation backup remains after rollback: %v", statErr)
			}
		})
	}
}

func TestManagedBinaryActivationRecoversAfterCrashAtBothRenameBoundaries(t *testing.T) {
	for _, test := range []struct {
		name          string
		boundary      managedRuntimeRenameBoundary
		wantInstalled time.Time
	}{
		{name: "after backup rename", boundary: managedRuntimeAfterBackupRename},
		{name: "after promotion rename", boundary: managedRuntimeAfterPromotionRename, wantInstalled: time.Unix(1_700_000_000, 0).UTC()},
	} {
		t.Run(test.name, func(t *testing.T) {
			manager, installation, profile, activeRoot, fingerprint := managedBinaryResolutionFixture(t, nil)
			packageName, packageVersion, artifact, err := runtimeInstallIdentity(installation.Manifest, runtimePlatform())
			if err != nil {
				t.Fatal(err)
			}
			runtimeIdentity, err := managedRuntimeIdentity(installation, profile, packageName, packageVersion, runtimePlatform())
			if err != nil {
				t.Fatal(err)
			}
			plan := InstallPlan{
				AgentKey: installation.AgentKey, ExtensionInstallationID: installation.ID,
				RuntimeIdentity: runtimeIdentity, Runner: "binary", Platform: runtimePlatform(),
				PackageName: packageName, PackageVersion: packageVersion, Artifact: artifact,
				InstallRoot: activeRoot, Executable: filepath.Join(activeRoot, "grok"),
				InstallCommand: []string{"download", artifact.URL},
			}
			workspace, err := openManagedRuntimeWorkspaceForInstall(manager.RuntimeInstallDir, installation.AgentKey, false)
			if err != nil {
				t.Fatal(err)
			}
			staging, err := workspace.createTemp(".runtime-install-")
			if err != nil {
				workspace.Close()
				t.Fatal(err)
			}
			binary, err := os.ReadFile(filepath.Join(activeRoot, "grok"))
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(staging.path, "grok"), binary, 0o700); err != nil {
				t.Fatal(err)
			}
			activation := managedRuntimeActivation{
				SchemaVersion: managedRuntimeActivationSchema, ExtensionInstallationID: installation.ID,
				RuntimeIdentity: runtimeIdentity, PackageName: packageName, PackageVersion: packageVersion,
				ExecutableRelativePath: "grok", ExecutableFingerprint: fingerprint,
				InstalledAt: time.Unix(1_700_000_000, 0).UTC(),
			}
			if err := writeJSONAtomic(filepath.Join(staging.path, "activation.json"), activation); err != nil {
				t.Fatal(err)
			}
			crashErr := errors.New("injected activation crash")
			err = activateManagedRuntimeWithCrashInjection(
				installation, workspace, staging, plan, manager.RuntimeInstallDir, nil, activation,
				func(boundary managedRuntimeRenameBoundary) error {
					if boundary == test.boundary {
						return crashErr
					}
					return nil
				},
			)
			if !errors.Is(err, crashErr) {
				t.Fatalf("crash injection error = %v", err)
			}
			_ = staging.Close()
			_ = workspace.Close()

			_, err = manager.resolveInstalledManagedRuntime(context.Background(), installation, profile, t.TempDir())
			if err != nil && !strings.Contains(err.Error(), "profiles/tools.json") {
				t.Fatalf("resolve after injected crash: %v", err)
			}
			if err := verifyRuntimeExecutableUnchanged(filepath.Join(activeRoot, "grok"), fingerprint); err != nil {
				t.Fatalf("recovered runtime executable: %v", err)
			}
			var recovered managedRuntimeActivation
			if err := readJSON(filepath.Join(activeRoot, "activation.json"), &recovered); err != nil {
				t.Fatal(err)
			}
			if !recovered.InstalledAt.Equal(test.wantInstalled) {
				t.Fatalf("recovered activation installedAt = %v, want %v", recovered.InstalledAt, test.wantInstalled)
			}
			if _, err := os.Lstat(activeRoot + ".previous"); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("recovery left backup behind: %v", err)
			}
		})
	}
}

func TestManagedBinaryActivationNeverRestoresUnverifiedBackup(t *testing.T) {
	manager, installation, profile, activeRoot, _ := managedBinaryResolutionFixture(t, nil)
	backupRoot := activeRoot + ".previous"
	if err := os.Rename(activeRoot, backupRoot); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(backupRoot, "grok"), []byte("unverified backup"), 0o700); err != nil {
		t.Fatal(err)
	}

	_, err := manager.resolveInstalledManagedRuntime(context.Background(), installation, profile, t.TempDir())
	if !errors.Is(err, ErrManagedRuntimeIntegrity) {
		t.Fatalf("unverified backup recovery error = %v", err)
	}
	if _, err := os.Lstat(activeRoot); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unverified backup was adopted as active: %v", err)
	}
	if _, err := os.Lstat(backupRoot); err != nil {
		t.Fatalf("unverified backup was silently discarded: %v", err)
	}
}

func TestManagedRuntimeWorkspaceRejectsAncestorReplacement(t *testing.T) {
	runtimeInstallDir := filepath.Join(testResolvedTempDir(t), "agent-runtimes")
	workspace, err := openManagedRuntimeWorkspace(runtimeInstallDir, "grok")
	if err != nil {
		t.Fatal(err)
	}
	defer workspace.Close()
	staging, err := workspace.createTemp(".runtime-install-")
	if err != nil {
		t.Fatal(err)
	}
	defer staging.Close()

	originalAgentPath := workspace.agentPath + ".moved"
	if err := os.Rename(workspace.agentPath, originalAgentPath); err != nil {
		t.Fatal(err)
	}
	foreign := t.TempDir()
	if err := os.Symlink(foreign, workspace.agentPath); err != nil {
		t.Fatal(err)
	}
	if err := staging.verify(); err == nil || !strings.Contains(err.Error(), "identity changed") {
		t.Fatalf("replaced managed ancestor verification error = %v", err)
	}
	entries, err := os.ReadDir(foreign)
	if err != nil || len(entries) != 0 {
		t.Fatalf("managed workspace touched redirected directory: entries=%v error=%v", entries, err)
	}
}

func TestManagedRuntimeActivationWriteRejectsReplacedStagingPath(t *testing.T) {
	workspace, err := openManagedRuntimeWorkspace(filepath.Join(testResolvedTempDir(t), "agent-runtimes"), "grok")
	if err != nil {
		t.Fatal(err)
	}
	defer workspace.Close()
	staging, err := workspace.createTemp(".runtime-install-")
	if err != nil {
		t.Fatal(err)
	}
	defer staging.Close()

	moved := staging.path + ".moved"
	if err := os.Rename(staging.path, moved); err != nil {
		t.Fatal(err)
	}
	foreign := testResolvedTempDir(t)
	if err := os.Symlink(foreign, staging.path); err != nil {
		t.Skipf("symlink fixture unavailable: %v", err)
	}
	if err := staging.writeJSONAtomic("activation.json", managedRuntimeActivation{SchemaVersion: managedRuntimeActivationSchema}); err == nil ||
		!strings.Contains(err.Error(), "identity changed") {
		t.Fatalf("replaced staging activation write error = %v", err)
	}
	if _, err := os.Lstat(filepath.Join(foreign, "activation.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("activation metadata escaped through replaced staging path: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(moved, "activation.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("activation metadata was written after staging identity loss: %v", err)
	}
}

func TestManagedRuntimeActivationWriteDoesNotFollowTargetSymlink(t *testing.T) {
	workspace, err := openManagedRuntimeWorkspace(filepath.Join(testResolvedTempDir(t), "agent-runtimes"), "grok")
	if err != nil {
		t.Fatal(err)
	}
	defer workspace.Close()
	staging, err := workspace.createTemp(".runtime-install-")
	if err != nil {
		t.Fatal(err)
	}
	defer staging.Close()

	foreign := filepath.Join(testResolvedTempDir(t), "foreign-activation.json")
	if err := os.WriteFile(foreign, []byte("preserve"), 0o600); err != nil {
		t.Fatal(err)
	}
	activationPath := filepath.Join(staging.path, "activation.json")
	if err := os.Symlink(foreign, activationPath); err != nil {
		t.Skipf("symlink fixture unavailable: %v", err)
	}
	want := managedRuntimeActivation{SchemaVersion: managedRuntimeActivationSchema, RuntimeIdentity: "runtime-test"}
	if err := staging.writeJSONAtomic("activation.json", want); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(foreign)
	if err != nil || string(content) != "preserve" {
		t.Fatalf("activation metadata followed foreign target: content=%q error=%v", content, err)
	}
	info, err := os.Lstat(activationPath)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		t.Fatalf("activation metadata target = %#v, error = %v", info, err)
	}
	var got managedRuntimeActivation
	if err := readJSON(activationPath, &got); err != nil || got.SchemaVersion != want.SchemaVersion || got.RuntimeIdentity != want.RuntimeIdentity {
		t.Fatalf("descriptor-relative activation metadata = %#v, error = %v", got, err)
	}
}

func TestManagedRuntimeWorkspaceCreatesBinaryWithoutFollowingNestedSymlink(t *testing.T) {
	workspace, err := openManagedRuntimeWorkspace(filepath.Join(testResolvedTempDir(t), "agent-runtimes"), "grok")
	if err != nil {
		t.Fatal(err)
	}
	defer workspace.Close()
	staging, err := workspace.createTemp(".runtime-install-")
	if err != nil {
		t.Fatal(err)
	}
	defer staging.Close()
	foreign := testResolvedTempDir(t)
	if err := os.Symlink(foreign, filepath.Join(staging.path, "bin")); err != nil {
		t.Fatal(err)
	}
	if file, err := staging.createFile(filepath.Join("bin", "grok"), 0o600); err == nil {
		file.Close()
		t.Fatal("no-follow staged binary creation error = nil")
	}
	if _, err := os.Lstat(filepath.Join(foreign, "grok")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("staged binary creation followed nested symlink: %v", err)
	}
}

func TestManagedRuntimeDirectoryKeepsReturnedNestedFileDescriptorOpen(t *testing.T) {
	workspace, err := openManagedRuntimeWorkspace(filepath.Join(testResolvedTempDir(t), "agent-runtimes"), "grok")
	if err != nil {
		t.Fatal(err)
	}
	defer workspace.Close()
	directory, err := workspace.createTemp(".runtime-install-")
	if err != nil {
		t.Fatal(err)
	}
	defer directory.Close()

	relative := filepath.Join("one", "two", "three", "grok")
	created, err := directory.createFile(relative, 0o700)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := created.Write([]byte("verified executable")); err != nil {
		created.Close()
		t.Fatalf("write returned nested file descriptor: %v", err)
	}
	if err := created.Close(); err != nil {
		t.Fatal(err)
	}
	opened, err := directory.openFile(relative, os.O_RDONLY)
	if err != nil {
		t.Fatal(err)
	}
	content, readErr := io.ReadAll(opened)
	closeErr := opened.Close()
	if readErr != nil || closeErr != nil || string(content) != "verified executable" {
		t.Fatalf("returned nested file descriptor: content=%q read=%v close=%v", content, readErr, closeErr)
	}
}

func TestManagedRuntimeWorkspaceRecursiveCleanupDoesNotFollowLinks(t *testing.T) {
	workspace, err := openManagedRuntimeWorkspace(filepath.Join(testResolvedTempDir(t), "agent-runtimes"), "grok")
	if err != nil {
		t.Fatal(err)
	}
	defer workspace.Close()
	directory, err := workspace.createTemp(".runtime-install-")
	if err != nil {
		t.Fatal(err)
	}
	defer directory.Close()
	if err := os.Mkdir(filepath.Join(directory.path, "nested"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory.path, "nested", "file"), []byte("managed"), 0o600); err != nil {
		t.Fatal(err)
	}
	foreign := testResolvedTempDir(t)
	foreignFile := filepath.Join(foreign, "preserve")
	if err := os.WriteFile(foreignFile, []byte("foreign"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(foreign, filepath.Join(directory.path, "foreign-link")); err != nil {
		t.Fatal(err)
	}
	if err := workspace.remove(directory.name); err != nil {
		t.Fatal(err)
	}
	if content, err := os.ReadFile(foreignFile); err != nil || string(content) != "foreign" {
		t.Fatalf("descriptor cleanup followed foreign link: content=%q error=%v", content, err)
	}
	if _, err := os.Lstat(directory.path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("managed directory remains after descriptor cleanup: %v", err)
	}
}

func TestAdoptCompatibleBinaryRollsBackActivationWhenRenameFails(t *testing.T) {
	manager, installation, profile, sourceRoot, _ := managedBinaryResolutionFixture(t, nil)
	packageName, packageVersion, artifact, err := runtimeInstallIdentity(installation.Manifest, runtimePlatform())
	if err != nil {
		t.Fatal(err)
	}
	runtimeIdentity, err := managedRuntimeIdentity(installation, profile, packageName, packageVersion, runtimePlatform())
	if err != nil {
		t.Fatal(err)
	}
	legacyRoot := filepath.Join(manager.RuntimeInstallDir, installation.AgentKey, "legacy-runtime")
	if err := os.Rename(sourceRoot, legacyRoot); err != nil {
		t.Fatal(err)
	}
	var original managedRuntimeActivation
	if err := readJSON(filepath.Join(legacyRoot, "activation.json"), &original); err != nil {
		t.Fatal(err)
	}
	original.ExtensionInstallationID = "legacy@0.9.0"
	original.RuntimeIdentity = "legacy-runtime"
	if err := writeJSONAtomic(filepath.Join(legacyRoot, "activation.json"), original); err != nil {
		t.Fatal(err)
	}
	targetRoot := managedRuntimeRoot(manager.RuntimeInstallDir, installation.AgentKey, runtimeIdentity)
	if err := os.MkdirAll(targetRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(targetRoot, "occupied"), []byte("occupied"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := manager.adoptCompatibleManagedRuntime(
		context.Background(), installation, profile, packageName, packageVersion, artifact, runtimeIdentity, targetRoot,
	); err == nil {
		t.Fatal("adoption into occupied target error = nil")
	}
	var restored managedRuntimeActivation
	if err := readJSON(filepath.Join(legacyRoot, "activation.json"), &restored); err != nil {
		t.Fatal(err)
	}
	if restored.ExtensionInstallationID != original.ExtensionInstallationID || restored.RuntimeIdentity != original.RuntimeIdentity {
		t.Fatalf("failed adoption did not restore activation: got=%#v want=%#v", restored, original)
	}
}

func managedBinaryResolutionFixture(
	t *testing.T,
	mutateArtifact func(*RuntimeBinaryArtifact),
) (*Manager, Installation, DiscoveryProfile, string, runtimeExecutableFingerprint) {
	t.Helper()
	t.Setenv("TUTTI_TEST_MANAGED_BINARY_VERSION", "1")
	binary := managedBinaryFixtureBytes(t)
	manifest := testManifest()
	manifest.AgentKey = "grok"
	manifest.Runtime.Install.Runner = "binary"
	manifest.Runtime.Install.Args = nil
	manifest.Runtime.Install.Artifacts = []RuntimeBinaryArtifact{testRuntimeBinaryArtifact(
		"https://example.com/grok-0.2.103-"+runtimePlatform(), binary, int64(len(binary)),
	)}
	if mutateArtifact != nil {
		mutateArtifact(&manifest.Runtime.Install.Artifacts[0])
	}
	manifest.Runtime.Launch.Executable = "${installRoot}/grok"
	publish := false
	manifest.Runtime.Launch.PublishUserCommand = &publish
	manifest.Runtime.Launch.Args = []string{"--no-auto-update", "--permission-mode", "default", "agent", "stdio"}
	var profile DiscoveryProfile
	if err := json.Unmarshal([]byte(`{"schemaVersion":"tutti.agent.discovery.v1","candidates":[{"binaryNames":["grok"],"version":{"args":["-test.run=TestManagedBinaryVersionFixture"],"constraint":">=0.2.89 <0.3.0"},"launchArgs":["--no-auto-update","--permission-mode","default","agent","stdio"],"probe":{"kind":"acp-initialize","timeoutMs":5000}}]}`), &profile); err != nil {
		t.Fatal(err)
	}
	installation := Installation{ID: "grok@1.0.0", AgentKey: "grok", Version: "1.0.0", Manifest: manifest}
	packageName, packageVersion, _, err := runtimeInstallIdentity(manifest, runtimePlatform())
	if err != nil {
		t.Fatal(err)
	}
	runtimeIdentity, err := managedRuntimeIdentity(installation, profile, packageName, packageVersion, runtimePlatform())
	if err != nil {
		t.Fatal(err)
	}
	manager := &Manager{RuntimeInstallDir: filepath.Join(testResolvedTempDir(t), "agent-runtimes")}
	sourceRoot := managedRuntimeRoot(manager.RuntimeInstallDir, "grok", runtimeIdentity)
	if err := os.MkdirAll(sourceRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	executable := filepath.Join(sourceRoot, "grok")
	if err := os.WriteFile(executable, binary, 0o700); err != nil {
		t.Fatal(err)
	}
	fingerprint, err := fingerprintRuntimeExecutable(executable)
	if err != nil {
		t.Fatal(err)
	}
	activation := managedRuntimeActivation{
		SchemaVersion: managedRuntimeActivationSchema, ExtensionInstallationID: installation.ID,
		RuntimeIdentity: runtimeIdentity, PackageName: packageName, PackageVersion: packageVersion,
		ExecutableRelativePath: "grok", ExecutableFingerprint: fingerprint,
	}
	if err := writeJSONAtomic(filepath.Join(sourceRoot, "activation.json"), activation); err != nil {
		t.Fatal(err)
	}
	return manager, installation, profile, sourceRoot, fingerprint
}
