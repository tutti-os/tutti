package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	market "github.com/tutti-os/tutti/packages/connector/daemon/core"

	"golang.org/x/mod/semver"
	"gopkg.in/yaml.v3"
)

const (
	cliInstallationReceiptSchema = "tutti.connector.cli-installation.v1"
	cliInstallationReceiptFile   = ".tutti-cli-installation.json"
	defaultConnectorPnpmVersion  = "10.11.0"
	maxCLIInstallationOutput     = 4 << 20
)

type NodePackageInstallerConfig struct {
	RootDir     string
	Runtimes    ConnectorRuntimeResolver
	Processes   agentruntime.ProcessTransport
	PnpmVersion string
	Timeout     time.Duration
	Environ     func() []string
}

// NodePackageInstaller compiles validated node_package intents into pnpm
// invocations. All connectors share one content-addressed store and one
// Corepack cache while retaining a release-scoped node_modules link tree.
type NodePackageInstaller struct {
	rootDir        string
	runtimes       ConnectorRuntimeResolver
	processes      agentruntime.ProcessTransport
	pnpmVersion    string
	timeout        time.Duration
	environ        func() []string
	mu             sync.Mutex
	connectorLanes map[string]*sync.Mutex
	installSlots   chan struct{}
}

var _ market.CLIInstallationManager = (*NodePackageInstaller)(nil)

func NewNodePackageInstaller(config NodePackageInstallerConfig) (*NodePackageInstaller, error) {
	root := strings.TrimSpace(config.RootDir)
	if !filepath.IsAbs(root) {
		return nil, errors.New("connector node package root must be absolute")
	}
	if config.Runtimes == nil || config.Processes == nil {
		return nil, errors.New("connector node package runtime and process transport are required")
	}
	pnpmVersion := strings.TrimSpace(config.PnpmVersion)
	if pnpmVersion == "" {
		pnpmVersion = defaultConnectorPnpmVersion
	}
	if !semver.IsValid("v" + pnpmVersion) {
		return nil, errors.New("connector pnpm version must be exact semver")
	}
	timeout := config.Timeout
	if timeout <= 0 {
		timeout = 5 * time.Minute
	}
	environ := config.Environ
	if environ == nil {
		environ = os.Environ
	}
	return &NodePackageInstaller{rootDir: filepath.Clean(root), runtimes: config.Runtimes,
		processes: config.Processes, pnpmVersion: pnpmVersion, timeout: timeout, environ: environ,
		connectorLanes: make(map[string]*sync.Mutex), installSlots: make(chan struct{}, 4)}, nil
}

func (installer *NodePackageInstaller) InstallCLI(ctx context.Context, request market.InstallCLIRequest) (market.CLIInstallationReceipt, error) {
	if installer == nil {
		return market.CLIInstallationReceipt{}, errors.New("connector node package installer is unavailable")
	}
	if err := market.ValidateReleaseShape(request.Release); err != nil {
		return market.CLIInstallationReceipt{}, err
	}
	managed, cli, nodePackage, err := nodePackageIntent(request.Release)
	if err != nil {
		return market.CLIInstallationReceipt{}, err
	}
	if strings.TrimSpace(request.OperationID) == "" {
		return market.CLIInstallationReceipt{}, errors.New("connector CLI installation operation id is required")
	}
	releaseLane := installer.lockConnector(request.Release.ConnectorKey)
	defer releaseLane()
	select {
	case installer.installSlots <- struct{}{}:
		defer func() { <-installer.installSlots }()
	case <-ctx.Done():
		return market.CLIInstallationReceipt{}, ctx.Err()
	}

	resolved, node, err := installer.resolveNode(ctx, managed.Runtime)
	if err != nil {
		return market.CLIInstallationReceipt{}, err
	}
	target := installer.installRoot(request.Release.ConnectorKey, request.Release.ReleaseDigest)
	if receipt, err := installer.readAndVerifyReceipt(request.Release, cli.Entrypoint, resolved, node, target); err == nil {
		receipt.OperationID = request.OperationID
		return receipt, nil
	}
	if err := os.RemoveAll(target); err != nil {
		return market.CLIInstallationReceipt{}, fmt.Errorf("remove invalid connector CLI installation: %w", err)
	}
	staging := filepath.Join(installer.rootDir, "staging", request.OperationID)
	if !pathWithin(installer.rootDir, staging) {
		return market.CLIInstallationReceipt{}, errors.New("connector CLI staging path escapes package root")
	}
	if err := os.RemoveAll(staging); err != nil {
		return market.CLIInstallationReceipt{}, fmt.Errorf("reset connector CLI staging: %w", err)
	}
	defer os.RemoveAll(staging)
	shared := installer.sharedPaths()
	for _, directory := range []string{staging, shared.store, shared.corepack, shared.npmCache, shared.pnpmHome} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return market.CLIInstallationReceipt{}, fmt.Errorf("create connector CLI package directory: %w", err)
		}
	}
	privateHome := filepath.Join(staging, ".home")
	if err := os.MkdirAll(privateHome, 0o700); err != nil {
		return market.CLIInstallationReceipt{}, err
	}
	if err := writeConnectorPackageJSON(staging, *nodePackage, installer.pnpmVersion); err != nil {
		return market.CLIInstallationReceipt{}, err
	}
	corepackEntrypoint := filepath.Join(resolved.Root, "node", "lib", "node_modules", "corepack", "dist", "corepack.js")
	if !ordinaryFile(corepackEntrypoint) {
		return market.CLIInstallationReceipt{}, errors.New("managed Node runtime Corepack entrypoint is unavailable")
	}
	installArgs := []string{corepackEntrypoint, "pnpm@" + installer.pnpmVersion, "install", "--dir", staging,
		"--ignore-workspace", "--ignore-scripts", "--store-dir", shared.store, "--package-import-method", "hardlink"}
	if err := installer.runManagedNode(ctx, resolved, node, staging, privateHome, shared, installArgs); err != nil {
		return market.CLIInstallationReceipt{}, fmt.Errorf("install connector node package: %w", err)
	}
	packageRoot, err := installedNodePackageRoot(staging, nodePackage.Package)
	if err != nil {
		return market.CLIInstallationReceipt{}, err
	}
	for _, lifecycle := range nodePackage.Lifecycle {
		entrypoint, err := safeInstalledFile(packageRoot, lifecycle.Entrypoint)
		if err != nil {
			return market.CLIInstallationReceipt{}, fmt.Errorf("resolve connector node package lifecycle: %w", err)
		}
		args := append([]string{entrypoint}, lifecycle.Arguments...)
		if err := installer.runManagedNode(ctx, resolved, node, packageRoot, privateHome, shared, args); err != nil {
			return market.CLIInstallationReceipt{}, fmt.Errorf("run connector node package %s: %w", lifecycle.Event, err)
		}
	}
	receipt, err := installer.buildReceipt(request, cli.Entrypoint, resolved, node, staging, shared.store)
	if err != nil {
		return market.CLIInstallationReceipt{}, err
	}
	receipt.InstallRoot = target
	if err := writeCLIInstallationReceipt(staging, receipt); err != nil {
		return market.CLIInstallationReceipt{}, err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return market.CLIInstallationReceipt{}, err
	}
	if err := os.Rename(staging, target); err != nil {
		return market.CLIInstallationReceipt{}, fmt.Errorf("activate connector CLI installation: %w", err)
	}
	return receipt, nil
}

func (installer *NodePackageInstaller) ResolveCLI(ctx context.Context, release market.Release) (market.CLIInstallationReceipt, error) {
	if installer == nil {
		return market.CLIInstallationReceipt{}, errors.New("connector node package installer is unavailable")
	}
	managed, cli, _, err := nodePackageIntent(release)
	if err != nil {
		return market.CLIInstallationReceipt{}, err
	}
	releaseLane := installer.lockConnector(release.ConnectorKey)
	defer releaseLane()
	resolved, node, err := installer.resolveNode(ctx, managed.Runtime)
	if err != nil {
		return market.CLIInstallationReceipt{}, err
	}
	root := installer.installRoot(release.ConnectorKey, release.ReleaseDigest)
	if _, statErr := os.Stat(root); errors.Is(statErr, os.ErrNotExist) {
		return market.CLIInstallationReceipt{}, market.ErrReleaseInstallationAbsent
	} else if statErr != nil {
		return market.CLIInstallationReceipt{}, fmt.Errorf("inspect connector CLI installation: %w", statErr)
	}
	receipt, err := installer.readAndVerifyReceipt(release, cli.Entrypoint, resolved, node, root)
	if err != nil {
		return market.CLIInstallationReceipt{}, fmt.Errorf("%w: %v", market.ErrReleaseInstallationInvalid, err)
	}
	return receipt, nil
}

func (installer *NodePackageInstaller) RemoveCLI(ctx context.Context, request market.RemoveCLIRequest) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if installer == nil || !safeCLIPathSegment(request.ConnectorKey) || !isSHA256Hex(request.ReleaseDigest) {
		return errors.New("connector CLI removal identity is invalid")
	}
	releaseLane := installer.lockConnector(request.ConnectorKey)
	defer releaseLane()
	target := installer.installRoot(request.ConnectorKey, request.ReleaseDigest)
	if !pathWithin(installer.rootDir, target) {
		return errors.New("connector CLI removal path escapes package root")
	}
	if err := removeAllWithinRoot(installer.rootDir, target); err != nil {
		return fmt.Errorf("remove connector CLI installation: %w", err)
	}
	return nil
}

func (installer *NodePackageInstaller) RemoveConnector(
	ctx context.Context,
	request market.RemoveConnectorInstallationRequest,
) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if installer == nil || !safeCLIPathSegment(request.ConnectorKey) {
		return errors.New("connector CLI removal identity is invalid")
	}
	releaseLane := installer.lockConnector(request.ConnectorKey)
	defer releaseLane()
	target := filepath.Join(installer.rootDir, "packages", request.ConnectorKey)
	if !pathWithin(installer.rootDir, target) {
		return errors.New("connector CLI removal path escapes package root")
	}
	if err := removeAllWithinRoot(installer.rootDir, target); err != nil {
		return fmt.Errorf("remove Connector CLI installations: %w", err)
	}
	return nil
}

func (installer *NodePackageInstaller) lockConnector(connectorKey string) func() {
	installer.mu.Lock()
	lane := installer.connectorLanes[connectorKey]
	if lane == nil {
		lane = &sync.Mutex{}
		installer.connectorLanes[connectorKey] = lane
	}
	installer.mu.Unlock()
	lane.Lock()
	return lane.Unlock
}

type connectorNodeSharedPaths struct{ store, corepack, npmCache, pnpmHome string }

func (installer *NodePackageInstaller) sharedPaths() connectorNodeSharedPaths {
	root := filepath.Join(installer.rootDir, "shared")
	return connectorNodeSharedPaths{store: filepath.Join(root, "pnpm-store"), corepack: filepath.Join(root, "corepack"),
		npmCache: filepath.Join(root, "npm-cache"), pnpmHome: filepath.Join(root, "pnpm-home")}
}

func (installer *NodePackageInstaller) installRoot(connectorKey, releaseDigest string) string {
	return filepath.Join(installer.rootDir, "packages", connectorKey, releaseDigest)
}

func (installer *NodePackageInstaller) resolveNode(ctx context.Context, requirement market.RuntimeRequirement) (ResolvedConnectorRuntime, ConnectorExecutable, error) {
	resolved, err := installer.runtimes.ResolveProfile(ctx, requirement.Profile)
	if err != nil {
		return ResolvedConnectorRuntime{}, ConnectorExecutable{}, err
	}
	if err := VerifyRuntimeABI(requirement, resolved); err != nil {
		return ResolvedConnectorRuntime{}, ConnectorExecutable{}, err
	}
	nodeVersion := resolved.Components["node"]
	if !nodeVersionSatisfies(nodeVersion, requirement.VersionRange) {
		return ResolvedConnectorRuntime{}, ConnectorExecutable{}, fmt.Errorf("managed Node %s does not satisfy %s", nodeVersion, requirement.VersionRange)
	}
	node, err := installer.runtimes.VerifyLaunch(requirement.Profile, "node")
	return resolved, node, err
}

func (installer *NodePackageInstaller) runManagedNode(ctx context.Context, resolved ResolvedConnectorRuntime,
	node ConnectorExecutable, cwd, privateHome string, shared connectorNodeSharedPaths, args []string) error {
	runCtx, cancel := context.WithTimeout(ctx, installer.timeout)
	defer cancel()
	temporaryRoot := filepath.Join(privateHome, "tmp")
	if err := os.MkdirAll(temporaryRoot, 0o700); err != nil {
		return err
	}
	inheritedEnv := installer.environ()
	pathEntries := append([]string{filepath.Join(resolved.Root, "node", "bin")},
		filepath.SplitList(environmentValue(inheritedEnv, "PATH"))...)
	pathValue := strings.Join(uniquePaths(pathEntries), string(os.PathListSeparator))
	env := allowedNodePackageInstallEnvironment(inheritedEnv)
	env = append(env, "HOME="+privateHome, "USERPROFILE="+privateHome, "COREPACK_HOME="+shared.corepack,
		"TMPDIR="+temporaryRoot, "TMP="+temporaryRoot, "TEMP="+temporaryRoot,
		"NPM_CONFIG_CACHE="+shared.npmCache, "PNPM_HOME="+shared.pnpmHome, "PATH="+pathValue)
	connection, err := installer.processes.Start(runCtx, agentruntime.ProcessSpec{Provider: "connector-installer", CWD: cwd,
		Command: append([]string{node.Path}, args...), Env: env,
		ExecutableIdentity: &agentruntime.ExecutableIdentity{SHA256: node.SHA256, SizeBytes: node.SizeBytes}})
	if err != nil {
		if errors.Is(err, agentruntime.ErrProcessSpecInvalid) {
			return fmt.Errorf("%w: %w", market.ErrPermanentInstallFailure, err)
		}
		return err
	}
	defer connection.Close()
	if graceful, ok := connection.(agentruntime.GracefulProcessConnection); ok {
		_ = graceful.CloseInput()
	}
	return waitCLIInstallation(runCtx, connection)
}

func waitCLIInstallation(ctx context.Context, connection agentruntime.ProcessConnection) error {
	var output strings.Builder
	for {
		var frame agentruntime.ProcessFrame
		var err error
		if contextual, ok := connection.(agentruntime.ContextProcessConnection); ok {
			frame, err = contextual.RecvContext(ctx)
		} else {
			frame, err = connection.Recv()
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		output.Write(frame.Stdout)
		output.Write(frame.Stderr)
		if output.Len() > maxCLIInstallationOutput {
			return errors.New("connector CLI installation output exceeded its limit")
		}
		if frame.ExitCode != nil {
			if *frame.ExitCode != 0 {
				message := strings.TrimSpace(output.String())
				if len(message) > 4096 {
					message = message[len(message)-4096:]
				}
				return fmt.Errorf("managed package command exited with code %d: %s", *frame.ExitCode, message)
			}
			return nil
		}
	}
}

func uniquePaths(values []string) []string {
	result := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if strings.TrimSpace(value) == "" {
			continue
		}
		value = filepath.Clean(value)
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

// allowedNodePackageInstallEnvironment projects the inherited environment onto
// the installer allow-list. Keys are folded case-insensitively and emitted in
// one canonical upper-case form: the connector process contract rejects two
// entries that differ only by case, so POSIX hosts exporting both HTTP_PROXY
// and http_proxy must not produce two entries here.
func allowedNodePackageInstallEnvironment(environment []string) []string {
	allowed := map[string]struct{}{
		"ALL_PROXY": {}, "COMSPEC": {}, "HTTP_PROXY": {}, "HTTPS_PROXY": {},
		"LANG": {}, "LC_ALL": {}, "LC_CTYPE": {}, "LC_MESSAGES": {}, "NO_PROXY": {},
		"NODE_EXTRA_CA_CERTS": {}, "PATHEXT": {}, "SSL_CERT_DIR": {}, "SSL_CERT_FILE": {},
		"SYSTEMROOT": {},
	}
	values := make(map[string]string, len(allowed))
	for _, item := range environment {
		key, value, ok := strings.Cut(item, "=")
		if !ok {
			continue
		}
		canonical := strings.ToUpper(key)
		if _, permitted := allowed[canonical]; !permitted {
			continue
		}
		values[canonical] = value
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]string, 0, len(keys))
	for _, key := range keys {
		result = append(result, key+"="+values[key])
	}
	return result
}

func environmentValue(environment []string, key string) string {
	for index := len(environment) - 1; index >= 0; index-- {
		candidateKey, value, ok := strings.Cut(environment[index], "=")
		if ok && strings.EqualFold(candidateKey, key) {
			return value
		}
	}
	return ""
}

func nodePackageIntent(release market.Release) (*market.ManagedStdioImplementation, *market.ManagedCLIInterface, *market.NodePackageInstallation, error) {
	managed := release.Manifest.Implementation.ManagedStdio
	if managed == nil || managed.CLI == nil || managed.CLI.Install == nil || managed.CLI.Install.Kind != "node_package" || managed.CLI.Install.NodePackage == nil {
		return nil, nil, nil, errors.New("connector release does not declare a node package CLI installation")
	}
	return managed, managed.CLI, managed.CLI.Install.NodePackage, nil
}

func writeConnectorPackageJSON(root string, install market.NodePackageInstallation, pnpmVersion string) error {
	payload := struct {
		Private        bool              `json:"private"`
		PackageManager string            `json:"packageManager"`
		Dependencies   map[string]string `json:"dependencies"`
	}{Private: true, PackageManager: "pnpm@" + pnpmVersion, Dependencies: map[string]string{install.Package: install.Version}}
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(root, "package.json"), data, 0o600)
}

func (*NodePackageInstaller) buildReceipt(request market.InstallCLIRequest, executable string,
	resolved ResolvedConnectorRuntime, node ConnectorExecutable, root, storeRoot string) (market.CLIInstallationReceipt, error) {
	_, _, install, _ := nodePackageIntent(request.Release)
	verified, err := verifyInstalledNodePackage(root, *install, executable)
	if err != nil {
		return market.CLIInstallationReceipt{}, err
	}
	entrypointDigest, err := cliFileSHA256(verified.entrypoint)
	if err != nil {
		return market.CLIInstallationReceipt{}, err
	}
	if install.Launch.Kind == "native" && entrypointDigest != install.Launch.SHA256 {
		return market.CLIInstallationReceipt{}, errors.New("installed connector native CLI digest does not match manifest")
	}
	return market.CLIInstallationReceipt{SchemaVersion: cliInstallationReceiptSchema, OperationID: request.OperationID,
		ConnectorKey: request.Release.ConnectorKey, ReleaseDigest: request.Release.ReleaseDigest,
		RuntimeProfile: request.Release.Manifest.Implementation.ManagedStdio.Runtime.Profile,
		RuntimeABI:     resolved.ABI, NodeVersion: resolved.Components["node"], NodeSHA256: node.SHA256,
		Package: install.Package, PackageVersion: install.Version, PackageIntegrity: install.Integrity, LaunchKind: install.Launch.Kind,
		InstallRoot: root, StoreRoot: storeRoot, Entrypoint: verified.relativeEntrypoint,
		EntrypointSHA256: entrypointDigest, EntrypointSize: verified.entrypointSize, LockSHA256: verified.lockDigest}, nil
}

func (installer *NodePackageInstaller) readAndVerifyReceipt(release market.Release, executable string,
	resolved ResolvedConnectorRuntime, node ConnectorExecutable, root string) (market.CLIInstallationReceipt, error) {
	data, err := os.ReadFile(filepath.Join(root, cliInstallationReceiptFile))
	if err != nil || len(data) > 1<<20 {
		return market.CLIInstallationReceipt{}, errors.New("connector CLI installation receipt is unavailable")
	}
	var receipt market.CLIInstallationReceipt
	if json.Unmarshal(data, &receipt) != nil {
		return market.CLIInstallationReceipt{}, errors.New("connector CLI installation receipt is invalid")
	}
	_, _, install, _ := nodePackageIntent(release)
	shared := installer.sharedPaths()
	if receipt.SchemaVersion != cliInstallationReceiptSchema || receipt.ConnectorKey != release.ConnectorKey ||
		receipt.ReleaseDigest != release.ReleaseDigest || receipt.RuntimeProfile != release.Manifest.Implementation.ManagedStdio.Runtime.Profile ||
		receipt.RuntimeABI != resolved.ABI || receipt.NodeVersion != resolved.Components["node"] || receipt.NodeSHA256 != node.SHA256 ||
		receipt.Package != install.Package || receipt.PackageVersion != install.Version || receipt.PackageIntegrity != install.Integrity ||
		receipt.LaunchKind != install.Launch.Kind || receipt.EntrypointSize <= 0 ||
		filepath.Clean(receipt.InstallRoot) != filepath.Clean(root) || filepath.Clean(receipt.StoreRoot) != filepath.Clean(shared.store) {
		return market.CLIInstallationReceipt{}, errors.New("connector CLI installation receipt identity is invalid")
	}
	verified, err := verifyInstalledNodePackage(root, *install, executable)
	if err != nil || verified.relativeEntrypoint != receipt.Entrypoint || verified.lockDigest != receipt.LockSHA256 ||
		verified.entrypointSize != receipt.EntrypointSize {
		return market.CLIInstallationReceipt{}, errors.New("connector CLI installation changed after activation")
	}
	digest, err := cliFileSHA256(verified.entrypoint)
	if err != nil || digest != receipt.EntrypointSHA256 || (install.Launch.Kind == "native" && digest != install.Launch.SHA256) {
		return market.CLIInstallationReceipt{}, errors.New("connector CLI entrypoint changed after activation")
	}
	return receipt, nil
}

func writeCLIInstallationReceipt(root string, receipt market.CLIInstallationReceipt) error {
	data, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(root, cliInstallationReceiptFile), data, 0o600)
}

type installedPackageJSON struct {
	Name    string          `json:"name"`
	Version string          `json:"version"`
	Bin     json.RawMessage `json:"bin"`
}

type verifiedInstalledNodePackage struct {
	entrypoint         string
	relativeEntrypoint string
	lockDigest         string
	entrypointSize     int64
}

func verifyInstalledNodePackage(root string, install market.NodePackageInstallation, executable string) (verifiedInstalledNodePackage, error) {
	packageRoot, err := installedNodePackageRoot(root, install.Package)
	if err != nil {
		return verifiedInstalledNodePackage{}, err
	}
	data, err := os.ReadFile(filepath.Join(packageRoot, "package.json"))
	if err != nil {
		return verifiedInstalledNodePackage{}, fmt.Errorf("read installed connector package manifest: %w", err)
	}
	var manifest installedPackageJSON
	if json.Unmarshal(data, &manifest) != nil || manifest.Name != install.Package || manifest.Version != install.Version {
		return verifiedInstalledNodePackage{}, errors.New("installed connector package identity does not match manifest")
	}
	entrypointPath := install.Launch.Entrypoint
	if install.Launch.Kind == "node_script" {
		entrypointPath, err = packageBinEntrypoint(manifest.Bin, install.Package, executable)
		if err != nil {
			return verifiedInstalledNodePackage{}, err
		}
	}
	entrypoint, err := safeInstalledFile(packageRoot, entrypointPath)
	if err != nil {
		return verifiedInstalledNodePackage{}, err
	}
	rootReal, err := filepath.EvalSymlinks(root)
	if err != nil {
		return verifiedInstalledNodePackage{}, errors.New("installed connector CLI root is unavailable")
	}
	relative, err := filepath.Rel(rootReal, entrypoint)
	if err != nil || !safeRelativePath(relative) {
		return verifiedInstalledNodePackage{}, errors.New("installed connector CLI entrypoint escapes installation root")
	}
	lockDigest, err := verifyPnpmLock(filepath.Join(root, "pnpm-lock.yaml"), install.Package, install.Version, install.Integrity)
	if err != nil {
		return verifiedInstalledNodePackage{}, err
	}
	info, err := os.Stat(entrypoint)
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 {
		return verifiedInstalledNodePackage{}, errors.New("installed connector CLI entrypoint identity is unavailable")
	}
	return verifiedInstalledNodePackage{entrypoint: entrypoint, relativeEntrypoint: filepath.ToSlash(relative),
		lockDigest: lockDigest, entrypointSize: info.Size()}, nil
}

func installedNodePackageRoot(root, packageName string) (string, error) {
	parts := strings.Split(packageName, "/")
	if len(parts) > 2 || len(parts) == 0 {
		return "", errors.New("connector node package name is invalid")
	}
	segments := append([]string{root, "node_modules"}, parts...)
	packageRoot := filepath.Join(segments...)
	if !pathWithin(root, packageRoot) {
		return "", errors.New("connector node package root escapes installation")
	}
	return packageRoot, nil
}

func packageBinEntrypoint(raw json.RawMessage, packageName, executable string) (string, error) {
	var entries map[string]string
	if json.Unmarshal(raw, &entries) == nil {
		if value := strings.TrimSpace(entries[executable]); value != "" {
			return value, nil
		}
	}
	var single string
	if json.Unmarshal(raw, &single) == nil && executable == strings.TrimPrefix(packageName[strings.LastIndex(packageName, "/")+1:], "@") {
		return single, nil
	}
	return "", errors.New("installed connector package does not expose the declared CLI entrypoint")
}

func safeInstalledFile(root, relative string) (string, error) {
	if !safeRelativePath(relative) {
		return "", errors.New("installed connector package entrypoint is unsafe")
	}
	target := filepath.Join(root, filepath.FromSlash(relative))
	rootReal, rootErr := filepath.EvalSymlinks(root)
	targetReal, targetErr := filepath.EvalSymlinks(target)
	if rootErr != nil || targetErr != nil || !pathWithin(rootReal, targetReal) || !ordinaryFile(targetReal) {
		return "", errors.New("installed connector package entrypoint is unavailable")
	}
	return targetReal, nil
}

func safeRelativePath(value string) bool {
	value = filepath.ToSlash(strings.TrimSpace(value))
	clean := filepath.ToSlash(filepath.Clean(filepath.FromSlash(value)))
	return value != "" && value == clean && clean != "." && clean != ".." && !strings.HasPrefix(clean, "../") && !filepath.IsAbs(value)
}

func ordinaryFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

func pathWithin(root, target string) bool {
	root = filepath.Clean(root)
	target = filepath.Clean(target)
	return target != root && strings.HasPrefix(target, root+string(filepath.Separator))
}

func removeAllWithinRoot(root, target string) error {
	root = filepath.Clean(root)
	target = filepath.Clean(target)
	if !pathWithin(root, target) {
		return errors.New("removal path escapes configured root")
	}
	relative, err := filepath.Rel(root, target)
	if err != nil {
		return err
	}
	current := root
	parts := strings.Split(relative, string(filepath.Separator))
	for index, part := range append([]string{""}, parts...) {
		if index > 0 {
			current = filepath.Join(current, part)
		}
		info, statErr := os.Lstat(current)
		if errors.Is(statErr, os.ErrNotExist) {
			return nil
		}
		if statErr != nil {
			return statErr
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return errors.New("removal path contains a symbolic link")
		}
		if index < len(parts) && !info.IsDir() {
			return errors.New("removal path parent is not a directory")
		}
	}
	return os.RemoveAll(target)
}

func safeCLIPathSegment(value string) bool {
	return value != "" && value == filepath.Base(value) && value != "." && value != ".." && !strings.ContainsAny(value, `/\\\x00`)
}

func cliFileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

type pnpmLock struct {
	Packages map[string]struct {
		Resolution struct {
			Integrity string `yaml:"integrity"`
		} `yaml:"resolution"`
	} `yaml:"packages"`
}

func verifyPnpmLock(path, packageName, version, integrity string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read connector pnpm lock: %w", err)
	}
	var lock pnpmLock
	if yaml.Unmarshal(data, &lock) != nil {
		return "", errors.New("connector pnpm lock is invalid")
	}
	wanted := packageName + "@" + version
	found := false
	for key, entry := range lock.Packages {
		normalized := strings.TrimPrefix(key, "/")
		if normalized == wanted || strings.HasPrefix(normalized, wanted+"(") {
			if entry.Resolution.Integrity != integrity {
				return "", errors.New("connector package integrity does not match the published manifest")
			}
			found = true
			break
		}
	}
	if !found {
		return "", errors.New("connector package is missing from pnpm lock")
	}
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:]), nil
}

func nodeVersionSatisfies(version, constraint string) bool {
	version = "v" + strings.TrimPrefix(strings.TrimSpace(version), "v")
	if !semver.IsValid(version) {
		return false
	}
	for _, part := range strings.Fields(constraint) {
		operator := ""
		for _, candidate := range []string{">=", "<=", ">", "<"} {
			if strings.HasPrefix(part, candidate) {
				operator = candidate
				break
			}
		}
		candidate := "v" + strings.TrimPrefix(strings.TrimSpace(strings.TrimPrefix(part, operator)), "v")
		if operator == "" || !semver.IsValid(candidate) {
			return false
		}
		comparison := semver.Compare(version, candidate)
		if (operator == ">=" && comparison < 0) || (operator == ">" && comparison <= 0) ||
			(operator == "<=" && comparison > 0) || (operator == "<" && comparison >= 0) {
			return false
		}
	}
	return strings.TrimSpace(constraint) != ""
}

func isSHA256Hex(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	for _, character := range value {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}
