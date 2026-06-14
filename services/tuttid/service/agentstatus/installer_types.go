package agentstatus

import (
	"fmt"
	"runtime"
	"strings"
)

type InstallerKind string

const (
	InstallerKindShellCommand        InstallerKind = "shell_command"
	InstallerKindOfficialScript      InstallerKind = "official_script"
	InstallerKindGitHubReleaseBinary InstallerKind = "github_release_binary"
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
	PostInstall    InstallerPostStep
}

type ReleaseBinaryInstallerSpec struct {
	BinaryName string
	Version    string
	Assets     map[string]ReleaseBinaryAsset
}

type ReleaseBinaryAsset struct {
	URL    string
	SHA256 string
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
	default:
		return fmt.Errorf("unsupported installer kind %q", spec.Kind)
	}
	return nil
}
