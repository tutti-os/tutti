package runtime

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
)

var runtimeIdentityPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$`)

// ErrCLIInstallationUnavailable reports that the release-scoped CLI files or
// their verified receipt no longer match the signed installation contract.
// Callers may treat this as explicit installation drift; runtime/profile
// failures remain ordinary errors and must not rewrite durable installation
// truth.
var ErrCLIInstallationUnavailable = errors.New("connector CLI installation is unavailable")

type ManagedRoutePlannerConfig struct {
	StateRoot        string
	UserHome         string
	Runtimes         ConnectorRuntimeResolver
	CLIInstallations market.CLIInstallationManager
}

type ManagedRoutePlanner struct {
	stateRoot        string
	userHome         string
	runtimes         ConnectorRuntimeResolver
	cliInstallations market.CLIInstallationManager
}

type ManagedRoutePlan struct {
	Managed       *market.ManagedStdioImplementation
	Prepared      market.PreparedArtifactReceipt
	Resolved      ResolvedConnectorRuntime
	Executable    ConnectorExecutable
	InstalledCLI  *market.CLIInstallationReceipt
	StateDir      string
	UserHome      string
	ArtifactTrees []agentruntime.ArtifactTreeIdentity
}

func NewManagedRoutePlanner(config ManagedRoutePlannerConfig) (*ManagedRoutePlanner, error) {
	if !filepath.IsAbs(strings.TrimSpace(config.StateRoot)) || !filepath.IsAbs(strings.TrimSpace(config.UserHome)) || config.Runtimes == nil {
		return nil, errors.New("connector managed route planner dependencies are invalid")
	}
	return &ManagedRoutePlanner{stateRoot: filepath.Clean(config.StateRoot), userHome: filepath.Clean(config.UserHome), runtimes: config.Runtimes,
		cliInstallations: config.CLIInstallations}, nil
}

// Build verifies the portable managed-runtime contract before a host adapter
// binds protocol-specific MCP/CLI capabilities.
func (planner *ManagedRoutePlanner) Build(ctx context.Context, request market.RuntimeReconcileRequest, prepared market.PreparedArtifactReceipt) (ManagedRoutePlan, error) {
	implementation := request.Connector.Release.Manifest.Implementation
	if implementation.Kind != market.ImplementationKindManagedStdio || implementation.ManagedStdio == nil {
		return ManagedRoutePlan{}, errors.New("only managed_stdio connector implementations are supported")
	}
	managed := implementation.ManagedStdio
	resolved, err := planner.runtimes.ResolveProfile(ctx, managed.Runtime.Profile)
	if err != nil {
		return ManagedRoutePlan{}, fmt.Errorf("resolve connector managed runtime: %w", err)
	}
	executable, err := planner.runtimes.VerifyLaunch(managed.Runtime.Profile, managed.Runtime.Language)
	if err != nil {
		return ManagedRoutePlan{}, fmt.Errorf("verify connector managed runtime launch: %w", err)
	}
	if err := VerifyRuntimeABI(managed.Runtime, resolved); err != nil {
		return ManagedRoutePlan{}, err
	}
	stateDir, err := SecureConnectorStateDir(planner.stateRoot, request.ConnectionID, request.Connector.Key)
	if err != nil {
		return ManagedRoutePlan{}, err
	}
	artifactTrees := []agentruntime.ArtifactTreeIdentity{{Root: prepared.PreparedPath, SHA256: prepared.InventoryDigest}}
	var installed *market.CLIInstallationReceipt
	if managed.CLI != nil && managed.CLI.Install != nil {
		if planner.cliInstallations == nil {
			return ManagedRoutePlan{}, errors.New("connector CLI installation resolver is unavailable")
		}
		receipt, resolveErr := planner.cliInstallations.ResolveCLI(ctx, request.Connector.Release)
		if resolveErr != nil {
			return ManagedRoutePlan{}, fmt.Errorf("%w: %v", ErrCLIInstallationUnavailable, resolveErr)
		}
		installed = &receipt
	}
	return ManagedRoutePlan{Managed: managed, Prepared: prepared, Resolved: resolved, Executable: executable,
		InstalledCLI: installed, StateDir: stateDir, UserHome: planner.userHome, ArtifactTrees: artifactTrees}, nil
}

func SecureConnectorStateDir(root, connectionID, connectorKey string) (string, error) {
	if !runtimeIdentityPattern.MatchString(connectionID) || !runtimeIdentityPattern.MatchString(connectorKey) {
		return "", errors.New("connector state identity is invalid")
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return "", err
	}
	rootReal, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", err
	}
	target := filepath.Join(rootReal, connectionID, connectorKey)
	relative, err := filepath.Rel(rootReal, target)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", errors.New("connector state directory escapes state root")
	}
	if err := os.MkdirAll(target, 0o700); err != nil {
		return "", err
	}
	targetReal, err := filepath.EvalSymlinks(target)
	if err != nil || (targetReal != rootReal && !strings.HasPrefix(targetReal, rootReal+string(filepath.Separator))) {
		return "", errors.New("connector state directory escapes state root")
	}
	return targetReal, nil
}

func ContainsPermissionScope(values []string, expected string) bool {
	for _, value := range values {
		if value == expected || strings.HasPrefix(value, expected+":") {
			return true
		}
	}
	return false
}

func PreparedEntrypoint(root, relative string) (string, error) {
	if !filepath.IsAbs(root) || filepath.IsAbs(relative) || strings.TrimSpace(relative) == "" {
		return "", errors.New("connector entrypoint is invalid")
	}
	root = filepath.Clean(root)
	clean := filepath.Clean(filepath.FromSlash(relative))
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", errors.New("connector entrypoint escapes prepared artifact")
	}
	entrypoint := filepath.Join(root, clean)
	if entrypoint != root && !strings.HasPrefix(entrypoint, root+string(filepath.Separator)) {
		return "", errors.New("connector entrypoint escapes prepared artifact")
	}
	info, err := os.Lstat(entrypoint)
	if err != nil || !info.Mode().IsRegular() {
		return "", errors.New("connector entrypoint is not a regular file")
	}
	return entrypoint, nil
}

func ConnectorProcessSpec(connectionID, connectorKey, language string, executable ConnectorExecutable, cwd string, args []string,
	stateDir, userHome string, artifactTrees []agentruntime.ArtifactTreeIdentity) agentruntime.ProcessSpec {
	command := append([]string{executable.Path}, args...)
	return agentruntime.ProcessSpec{Provider: "connector:" + connectorKey, RoomID: connectionID, CWD: cwd, Command: command,
		Env: []string{"TUTTI_CONNECTOR_CONNECTION_ID=" + connectionID, "TUTTI_CONNECTOR_KEY=" + connectorKey,
			"TUTTI_CONNECTOR_LANGUAGE=" + language, "TUTTI_CONNECTOR_STATE_DIR=" + stateDir,
			"HOME=" + userHome, "USERPROFILE=" + userHome},
		ExecutableIdentity: &agentruntime.ExecutableIdentity{SHA256: executable.SHA256, SizeBytes: executable.SizeBytes},
		ArtifactTrees:      append([]agentruntime.ArtifactTreeIdentity(nil), artifactTrees...)}
}
