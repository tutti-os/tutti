package agentextension

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/mod/semver"

	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

var (
	ErrRuntimeUpdateUnavailable = errors.New("agent target runtime update is unavailable")
	ErrRuntimeUpdateChanged     = errors.New("agent target runtime update changed")
)

type RuntimeUpdateInput struct {
	WorkspaceID   string
	AgentTargetID string
}

type ApplyRuntimeUpdateInput struct {
	WorkspaceID    string
	AgentTargetID  string
	CurrentVersion string
	LatestVersion  string
}

type RuntimeUpdateSnapshot struct {
	WorkspaceID    string
	AgentTargetID  string
	Available      bool
	CurrentVersion string
	LatestVersion  string
}

type runtimeUpdateResolution struct {
	snapshot     RuntimeUpdateSnapshot
	target       agenttargetbiz.Target
	installation Installation
	record       VersionRecord
	source       tuttitypes.AgentExtensionSource
}

func (s *SetupService) GetRuntimeUpdate(ctx context.Context, input RuntimeUpdateInput) (RuntimeUpdateSnapshot, error) {
	if s.Plans.Manager == nil {
		return RuntimeUpdateSnapshot{}, errors.New("agent extension manager is not configured")
	}
	s.Plans.Manager.reconcileMu.Lock()
	defer s.Plans.Manager.reconcileMu.Unlock()
	resolution, err := s.resolveRuntimeUpdate(ctx, input)
	return resolution.snapshot, err
}

func (s *SetupService) ApplyRuntimeUpdate(ctx context.Context, input ApplyRuntimeUpdateInput) (RuntimeUpdateSnapshot, error) {
	if s.Plans.Manager == nil {
		return RuntimeUpdateSnapshot{}, errors.New("agent extension manager is not configured")
	}
	manager := s.Plans.Manager
	manager.reconcileMu.Lock()
	defer manager.reconcileMu.Unlock()

	resolution, err := s.resolveRuntimeUpdate(ctx, RuntimeUpdateInput{
		WorkspaceID: input.WorkspaceID, AgentTargetID: input.AgentTargetID,
	})
	if err != nil {
		return RuntimeUpdateSnapshot{}, err
	}
	if !resolution.snapshot.Available {
		return resolution.snapshot, ErrRuntimeUpdateUnavailable
	}
	if strings.TrimSpace(input.CurrentVersion) != resolution.snapshot.CurrentVersion ||
		strings.TrimSpace(input.LatestVersion) != resolution.snapshot.LatestVersion {
		return resolution.snapshot, ErrRuntimeUpdateChanged
	}

	artifact, err := manager.downloadReleaseArtifact(ctx, resolution.record.Release)
	if err != nil {
		return resolution.snapshot, err
	}
	candidate, err := manager.prepareVerifiedRelease(resolution.record.Release, artifact, resolution.source, true)
	if err != nil {
		return resolution.snapshot, err
	}
	plan, err := buildInstallPlan(resolution.target.ID, manager.RuntimeInstallDir, candidate)
	if err != nil {
		return resolution.snapshot, err
	}
	discoveryRoot, err := s.ensureDiscoveryRoot(ctx)
	if err != nil {
		return resolution.snapshot, err
	}
	if err := s.executeInstall(ctx, plan, discoveryRoot, func(SetupActionPhase) error { return nil }); err != nil {
		return resolution.snapshot, err
	}
	if err := manager.Installations.PutActive(candidate); err != nil {
		return resolution.snapshot, err
	}
	rollback := func(cause error) error {
		rollbackErr := manager.Installations.PutActive(resolution.installation)
		if rollbackErr == nil {
			rollbackErr = manager.registerTarget(context.WithoutCancel(ctx), resolution.installation)
		}
		if rollbackErr != nil {
			return errors.Join(cause, fmt.Errorf("restore previous agent extension installation: %w", rollbackErr))
		}
		return cause
	}
	if err := manager.registerTarget(ctx, candidate); err != nil {
		return resolution.snapshot, rollback(err)
	}
	binding, err := manager.ResolveRuntimeForCWD(ctx, candidate.ID, discoveryRoot)
	if err != nil || binding.Source != "managed" ||
		!validSemver(binding.Version) || semver.Compare("v"+binding.Version, "v"+resolution.snapshot.LatestVersion) < 0 {
		if err == nil {
			err = errors.New("updated managed runtime did not converge on the requested version")
		}
		return resolution.snapshot, rollback(err)
	}
	return RuntimeUpdateSnapshot{
		WorkspaceID: input.WorkspaceID, AgentTargetID: input.AgentTargetID,
		CurrentVersion: binding.Version, LatestVersion: binding.Version,
	}, nil
}

func (s *SetupService) resolveRuntimeUpdate(ctx context.Context, input RuntimeUpdateInput) (runtimeUpdateResolution, error) {
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	targetID := strings.TrimSpace(input.AgentTargetID)
	if workspaceID == "" || targetID == "" {
		return runtimeUpdateResolution{}, ErrInvalidInstallPlanRequest
	}
	if s.Plans.Workspaces == nil || s.Plans.Targets == nil || s.Plans.Manager == nil {
		return runtimeUpdateResolution{}, errors.New("agent target runtime update service is not configured")
	}
	if _, err := s.Plans.Workspaces.Get(ctx, workspaceID); err != nil {
		return runtimeUpdateResolution{}, err
	}
	target, err := s.Plans.Targets.GetAgentTarget(ctx, targetID)
	if err != nil {
		return runtimeUpdateResolution{}, err
	}
	target, err = agenttargetbiz.NormalizeTarget(target)
	if err != nil || !target.Enabled {
		return runtimeUpdateResolution{}, ErrUnsupportedInstallTarget
	}
	launchRef, err := agenttargetbiz.RuntimeProviderTargetRef(target)
	if err != nil || launchRef["kind"] != agenttargetbiz.LaunchRefTypeAgentExtension {
		return runtimeUpdateResolution{}, ErrUnsupportedInstallTarget
	}
	installationID, _ := launchRef["extensionInstallationId"].(string)
	manager := s.Plans.Manager
	installation, err := manager.loadInstallationByID(installationID)
	if err != nil {
		return runtimeUpdateResolution{}, err
	}
	result := runtimeUpdateResolution{
		target: target, installation: installation,
		snapshot: RuntimeUpdateSnapshot{WorkspaceID: workspaceID, AgentTargetID: targetID},
	}
	if installation.HasLocalPackageProvenance() {
		return result, nil
	}
	source, ok := manager.sourceForAgentKey(installation.AgentKey)
	if !ok {
		return result, nil
	}
	record, err := manager.resolveReleaseRecord(ctx, source)
	if err != nil {
		return runtimeUpdateResolution{}, err
	}
	discoveryRoot, err := s.ensureDiscoveryRoot(ctx)
	if err != nil {
		return runtimeUpdateResolution{}, err
	}
	binding, err := manager.ResolveRuntimeForCWD(ctx, installation.ID, discoveryRoot)
	if err != nil || !validSemver(binding.Version) {
		// Initial setup and broken runtimes stay owned by the existing setup gate;
		// they must not be mislabeled as an available update.
		return result, nil
	}
	_, latestVersion, _, err := runtimeInstallIdentity(record.Release.Manifest, runtimePlatform())
	if err != nil || !validSemver(latestVersion) {
		return runtimeUpdateResolution{}, err
	}
	result.snapshot.CurrentVersion = binding.Version
	result.snapshot.LatestVersion = latestVersion
	result.snapshot.Available = semver.Compare("v"+latestVersion, "v"+binding.Version) > 0
	result.record = record
	result.source = source
	return result, nil
}

func (m *Manager) sourceForAgentKey(key string) (tuttitypes.AgentExtensionSource, bool) {
	for _, source := range m.Sources {
		if source.Key == key && !sourceUsesLocalPackage(source) {
			return source, true
		}
	}
	return tuttitypes.AgentExtensionSource{}, false
}

func (m *Manager) downloadReleaseArtifact(ctx context.Context, release Release) ([]byte, error) {
	artifact, err := m.getBytes(ctx, release.ArtifactURL, maxArtifact)
	if err != nil {
		return nil, err
	}
	if int64(len(artifact)) != release.ArtifactSizeBytes {
		return nil, errors.New("artifact size does not match signed release")
	}
	digest := sha256.Sum256(artifact)
	if hex.EncodeToString(digest[:]) != strings.ToLower(release.ArtifactSHA256) {
		return nil, errors.New("artifact SHA-256 does not match signed release")
	}
	return artifact, nil
}

func (m *Manager) releaseRequiresUserRuntimeUpdate(ctx context.Context, installed Installation, release Release) bool {
	_, installedVersion, _, installedErr := runtimeInstallIdentity(installed.Manifest, runtimePlatform())
	_, releaseVersion, _, releaseErr := runtimeInstallIdentity(release.Manifest, runtimePlatform())
	if installedErr != nil || releaseErr != nil || !validSemver(installedVersion) || !validSemver(releaseVersion) ||
		semver.Compare("v"+releaseVersion, "v"+installedVersion) <= 0 {
		return false
	}
	binding, err := m.ResolveRuntime(ctx, installed.ID)
	if err != nil || !validSemver(binding.Version) {
		return true
	}
	return semver.Compare("v"+releaseVersion, "v"+binding.Version) > 0
}
