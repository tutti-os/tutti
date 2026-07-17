package agentextension

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"runtime"
	"strings"

	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

var (
	ErrInvalidInstallPlanRequest = errors.New("invalid agent target install plan request")
	ErrUnsupportedInstallTarget  = errors.New("agent target does not support managed runtime installation")
)

type WorkspaceLookup interface {
	Get(context.Context, string) (workspacebiz.Summary, error)
}

type AgentTargetLookup interface {
	GetAgentTarget(context.Context, string) (agenttargetbiz.Target, error)
}

type InstallPlanService struct {
	Manager    *Manager
	Workspaces WorkspaceLookup
	Targets    AgentTargetLookup
}

type InstallPlanInput struct {
	WorkspaceID   string
	AgentTargetID string
}

type InstallPlan struct {
	AgentTargetID           string   `json:"agentTargetId"`
	ExtensionInstallationID string   `json:"extensionInstallationId"`
	AgentKey                string   `json:"agentKey"`
	ExtensionVersion        string   `json:"extensionVersion"`
	RuntimeIdentity         string   `json:"runtimeIdentity"`
	RuntimeKind             string   `json:"runtimeKind"`
	Platform                string   `json:"platform"`
	Runner                  string   `json:"runner"`
	PackageName             string   `json:"packageName"`
	PackageVersion          string   `json:"packageVersion"`
	InstallRoot             string   `json:"installRoot"`
	InstallCommand          []string `json:"installCommand"`
	Executable              string   `json:"executable"`
	LaunchArgs              []string `json:"launchArgs"`
	PlanDigest              string   `json:"planDigest,omitempty"`
}

func (s InstallPlanService) GetInstallPlan(ctx context.Context, input InstallPlanInput) (InstallPlan, error) {
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	targetID := strings.TrimSpace(input.AgentTargetID)
	if workspaceID == "" || targetID == "" {
		return InstallPlan{}, ErrInvalidInstallPlanRequest
	}
	if s.Manager == nil || s.Workspaces == nil || s.Targets == nil {
		return InstallPlan{}, errors.New("agent target install plan service is not configured")
	}
	if _, err := s.Workspaces.Get(ctx, workspaceID); err != nil {
		return InstallPlan{}, err
	}
	target, err := s.Targets.GetAgentTarget(ctx, targetID)
	if err != nil {
		return InstallPlan{}, err
	}
	target, err = agenttargetbiz.NormalizeTarget(target)
	if err != nil {
		return InstallPlan{}, fmt.Errorf("%w: %w", ErrUnsupportedInstallTarget, err)
	}
	if !target.Enabled {
		return InstallPlan{}, fmt.Errorf("%w: agent target is disabled", ErrUnsupportedInstallTarget)
	}
	launchRef, err := agenttargetbiz.RuntimeProviderTargetRef(target)
	if err != nil || launchRef["kind"] != agenttargetbiz.LaunchRefTypeAgentExtension {
		return InstallPlan{}, ErrUnsupportedInstallTarget
	}
	installationID, _ := launchRef["extensionInstallationId"].(string)
	installation, err := s.Manager.loadInstallationByID(installationID)
	if err != nil {
		return InstallPlan{}, fmt.Errorf("load agent extension installation: %w", err)
	}
	if installation.Provider != target.Provider {
		return InstallPlan{}, fmt.Errorf("%w: target provider does not match extension installation", ErrUnsupportedInstallTarget)
	}
	return buildInstallPlan(target.ID, s.Manager.RuntimeInstallDir, installation)
}

func buildInstallPlan(targetID, runtimeInstallDir string, installation Installation) (InstallPlan, error) {
	manifest := installation.Manifest
	packageName, packageVersion, err := exactRuntimePackage(manifest.Runtime.Install.Runner, manifest.Runtime.Install.Args)
	if err != nil {
		return InstallPlan{}, err
	}
	platform := runtime.GOOS + "-" + runtime.GOARCH
	var profile DiscoveryProfile
	if err := readJSON(filepath.Join(installation.PackageDir, installation.Manifest.Profiles.Discovery), &profile); err != nil {
		return InstallPlan{}, fmt.Errorf("read discovery profile: %w", err)
	}
	runtimeIdentity, err := managedRuntimeIdentity(installation, profile, packageName, packageVersion, platform)
	if err != nil {
		return InstallPlan{}, err
	}
	installRoot := managedRuntimeRoot(runtimeInstallDir, installation.AgentKey, runtimeIdentity)
	if err := validateManagedRuntimeRoot(installRoot, runtimeInstallDir, installation.AgentKey, runtimeIdentity); err != nil {
		return InstallPlan{}, err
	}
	resolve := func(value string) string {
		return strings.NewReplacer(
			"${installRoot}", installRoot,
			"${platform}", platform,
		).Replace(value)
	}
	installArgs := make([]string, len(manifest.Runtime.Install.Args))
	for index, argument := range manifest.Runtime.Install.Args {
		installArgs[index] = resolve(argument)
	}
	executable := filepath.Clean(resolve(manifest.Runtime.Launch.Executable))
	if !pathWithin(executable, installRoot) {
		return InstallPlan{}, errors.New("extension runtime executable escapes install root")
	}
	launchArgs := make([]string, len(manifest.Runtime.Launch.Args))
	for index, argument := range manifest.Runtime.Launch.Args {
		launchArgs[index] = resolve(argument)
	}
	plan := InstallPlan{
		AgentTargetID:           targetID,
		ExtensionInstallationID: installation.ID, AgentKey: installation.AgentKey,
		ExtensionVersion: installation.Version, RuntimeIdentity: runtimeIdentity, RuntimeKind: manifest.Runtime.Kind,
		Platform: platform, Runner: manifest.Runtime.Install.Runner,
		PackageName: packageName, PackageVersion: packageVersion, InstallRoot: installRoot,
		InstallCommand: append([]string{manifest.Runtime.Install.Runner}, installArgs...),
		Executable:     executable, LaunchArgs: launchArgs,
	}
	encoded, err := json.Marshal(plan)
	if err != nil {
		return InstallPlan{}, fmt.Errorf("encode agent target install plan: %w", err)
	}
	digest := sha256.Sum256(encoded)
	plan.PlanDigest = hex.EncodeToString(digest[:])
	return plan, nil
}

func managedRuntimeIdentity(
	installation Installation,
	profile DiscoveryProfile,
	packageName string,
	packageVersion string,
	platform string,
) (string, error) {
	value := struct {
		SchemaVersion  string           `json:"schemaVersion"`
		AgentKey       string           `json:"agentKey"`
		RuntimeKind    string           `json:"runtimeKind"`
		Platform       string           `json:"platform"`
		Runner         string           `json:"runner"`
		PackageName    string           `json:"packageName"`
		PackageVersion string           `json:"packageVersion"`
		InstallArgs    []string         `json:"installArgs"`
		Launch         runtimeLaunchKey `json:"launch"`
		Discovery      DiscoveryProfile `json:"discovery"`
	}{
		SchemaVersion: "tutti.agent.managed-runtime-identity.v1",
		AgentKey:      installation.AgentKey, RuntimeKind: installation.Manifest.Runtime.Kind,
		Platform: platform, Runner: installation.Manifest.Runtime.Install.Runner,
		PackageName: packageName, PackageVersion: packageVersion,
		InstallArgs: append([]string(nil), installation.Manifest.Runtime.Install.Args...),
		Launch: runtimeLaunchKey{
			Executable: installation.Manifest.Runtime.Launch.Executable,
			Args:       append([]string(nil), installation.Manifest.Runtime.Launch.Args...),
		},
		Discovery: profile,
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", fmt.Errorf("encode managed runtime identity: %w", err)
	}
	digest := sha256.Sum256(encoded)
	return "runtime-" + hex.EncodeToString(digest[:])[:16], nil
}

type runtimeLaunchKey struct {
	Executable string   `json:"executable"`
	Args       []string `json:"args"`
}

func managedRuntimeRoot(runtimeInstallDir, agentKey, runtimeIdentity string) string {
	return filepath.Join(strings.TrimSpace(runtimeInstallDir), agentKey, runtimeIdentity)
}

func exactRuntimePackage(runner string, arguments []string) (string, string, error) {
	var name, version string
	for _, argument := range arguments {
		candidateName, candidateVersion, ok := exactRuntimePackageArgument(runner, argument)
		if !ok {
			continue
		}
		if name != "" {
			return "", "", errors.New("extension runtime install names multiple exact packages")
		}
		name, version = candidateName, candidateVersion
	}
	if name == "" {
		return "", "", errors.New("extension runtime install does not name an exact package")
	}
	return name, version, nil
}

func exactRuntimePackageArgument(runner, argument string) (string, string, bool) {
	switch runner {
	case "npm", "pnpm":
		if !strings.HasPrefix(argument, "@") {
			return "", "", false
		}
		separator := strings.LastIndex(argument, "@")
		if separator <= 0 || separator == len(argument)-1 {
			return "", "", false
		}
		return argument[:separator], argument[separator+1:], true
	case "uv":
		name, version, ok := strings.Cut(argument, "==")
		if !ok || name == "" || version == "" {
			return "", "", false
		}
		return name, version, true
	default:
		return "", "", false
	}
}

func pathWithin(path, root string) bool {
	relative, err := filepath.Rel(filepath.Clean(root), filepath.Clean(path))
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func validateManagedRuntimeRoot(installRoot, runtimeInstallDir, agentKey, runtimeIdentity string) error {
	runtimeInstallDir = strings.TrimSpace(runtimeInstallDir)
	if runtimeInstallDir == "" || !filepath.IsAbs(runtimeInstallDir) {
		return fmt.Errorf("%w: managed runtime install directory is invalid", ErrInvalidInstallPlanRequest)
	}
	if strings.TrimSpace(agentKey) == "" || strings.TrimSpace(runtimeIdentity) == "" || strings.Contains(runtimeIdentity, string(filepath.Separator)) {
		return fmt.Errorf("%w: managed runtime identity is invalid", ErrInvalidInstallPlanRequest)
	}
	expected := filepath.Join(runtimeInstallDir, agentKey, runtimeIdentity)
	if filepath.Clean(installRoot) != expected {
		return fmt.Errorf("%w: managed runtime root is invalid", ErrInvalidInstallPlanRequest)
	}
	return nil
}
