package agentstatus

import (
	"fmt"
	"runtime"
	"strings"
)

type InstallerKind string

const (
	InstallerKindShellCommand             InstallerKind = "shell_command"
	InstallerKindOfficialScript           InstallerKind = "official_script"
	InstallerKindGitHubReleaseBinary      InstallerKind = "github_release_binary"
	InstallerKindExternalAgentRegistryNPM InstallerKind = "external_agent_registry_npm"
	InstallerKindCodexCLILatest           InstallerKind = "codex_cli_latest"
)

// InstallerPostStep names an optional, idempotent step run after a successful
// install (best-effort; failures are surfaced but do not fail the install).
type InstallerPostStep string

const (
	InstallerPostStepNone InstallerPostStep = ""
	// InstallerPostStepPatchClaudeAgentACP patches the claude-agent-acp bridge
	// to advertise a `fast` config option backed by the SDK's `Settings.fastMode`.
	InstallerPostStepPatchClaudeAgentACP InstallerPostStep = "patch_claude_agent_acp"
)

type InstallerSpec struct {
	Kind           InstallerKind
	DisplayCommand string
	ShellCommand   string
	ScriptURL      string
	ScriptShell    string
	ReleaseBinary  *ReleaseBinaryInstallerSpec
	RegistryNPM    *ExternalAgentRegistryNPMInstallerSpec
	CodexCLI       *CodexCLILatestInstallerSpec
	PostInstall    InstallerPostStep
}

type ExternalAgentRegistryNPMInstallerSpec struct {
	AgentID    string
	Package    string
	Args       []string
	Env        map[string]string
	PrefixDir  string
	PackageDir string
	Version    string
}

type ReleaseBinaryInstallerSpec struct {
	BinaryName string
	Version    string
	InstallDir string
	Assets     map[string]ReleaseBinaryAsset
}

type ReleaseBinaryAsset struct {
	URL    string
	SHA256 string
}

type CodexCLILatestInstallerSpec struct {
	BaseURL    string
	InstallDir string
}

func (s InstallerSpec) displayCommand() string {
	switch s.Kind {
	case InstallerKindShellCommand:
		return firstNonBlank(s.DisplayCommand, s.ShellCommand)
	case InstallerKindOfficialScript:
		return firstNonBlank(s.DisplayCommand, s.ScriptURL)
	case InstallerKindGitHubReleaseBinary:
		if asset, ok := s.releaseAsset(runtime.GOOS, runtime.GOARCH); ok {
			return firstNonBlank(s.DisplayCommand, asset.URL)
		}
		return strings.TrimSpace(s.DisplayCommand)
	case InstallerKindExternalAgentRegistryNPM:
		if s.RegistryNPM != nil {
			return firstNonBlank(s.DisplayCommand, "Install "+s.RegistryNPM.Package+" from ACP External Agent Registry")
		}
		return strings.TrimSpace(s.DisplayCommand)
	case InstallerKindCodexCLILatest:
		return firstNonBlank(s.DisplayCommand, "Install Codex CLI latest from GitHub releases")
	default:
		return ""
	}
}

func (s InstallerSpec) releaseAsset(goos string, goarch string) (ReleaseBinaryAsset, bool) {
	if s.ReleaseBinary == nil || len(s.ReleaseBinary.Assets) == 0 {
		return ReleaseBinaryAsset{}, false
	}
	asset, ok := s.ReleaseBinary.Assets[releaseBinaryPlatformKey(goos, goarch)]
	return asset, ok
}

func releaseBinaryPlatformKey(goos string, goarch string) string {
	return strings.TrimSpace(goos) + "-" + strings.TrimSpace(goarch)
}

func validateInstallerSpec(spec InstallerSpec) error {
	switch spec.Kind {
	case InstallerKindShellCommand:
		if strings.TrimSpace(spec.ShellCommand) == "" {
			return fmt.Errorf("shell installer command is required")
		}
	case InstallerKindOfficialScript:
		if strings.TrimSpace(spec.ScriptURL) == "" {
			return fmt.Errorf("official script url is required")
		}
		if strings.TrimSpace(spec.ScriptShell) == "" {
			return fmt.Errorf("official script shell is required")
		}
	case InstallerKindGitHubReleaseBinary:
		if spec.ReleaseBinary == nil {
			return fmt.Errorf("release binary installer config is required")
		}
		if strings.TrimSpace(spec.ReleaseBinary.BinaryName) == "" {
			return fmt.Errorf("release binary installer binary name is required")
		}
		if strings.TrimSpace(spec.ReleaseBinary.Version) == "" {
			return fmt.Errorf("release binary installer version is required")
		}
		if _, ok := spec.releaseAsset(runtime.GOOS, runtime.GOARCH); !ok {
			return fmt.Errorf("release binary installer asset is unavailable for %s", releaseBinaryPlatformKey(runtime.GOOS, runtime.GOARCH))
		}
	case InstallerKindExternalAgentRegistryNPM:
		if spec.RegistryNPM == nil {
			return fmt.Errorf("external agent registry npm installer config is required")
		}
		if strings.TrimSpace(spec.RegistryNPM.AgentID) == "" {
			return fmt.Errorf("external agent registry npm installer agent id is required")
		}
		if strings.TrimSpace(spec.RegistryNPM.Package) == "" {
			return fmt.Errorf("external agent registry npm installer package is required")
		}
		if strings.TrimSpace(spec.RegistryNPM.PrefixDir) == "" {
			return fmt.Errorf("external agent registry npm installer prefix dir is required")
		}
	case InstallerKindCodexCLILatest:
		if spec.CodexCLI == nil {
			return fmt.Errorf("codex CLI latest installer config is required")
		}
		if _, ok := codexCLIPackageTarget(runtime.GOOS, runtime.GOARCH); !ok {
			return fmt.Errorf("codex CLI latest installer asset is unavailable for %s", releaseBinaryPlatformKey(runtime.GOOS, runtime.GOARCH))
		}
	default:
		return fmt.Errorf("unsupported installer kind %q", spec.Kind)
	}
	return nil
}
