package agentstatus

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	"github.com/tutti-os/tutti/packages/agent/daemon/runtimecmd"
	externalagentregistry "github.com/tutti-os/tutti/services/tuttid/service/externalagentregistry"
	managedruntime "github.com/tutti-os/tutti/services/tuttid/service/managedruntime"
)

const ReasonExternalAgentRegistryUnavailable = "external_agent_registry_unavailable"
const ReasonManagedRuntimeUnavailable = "managed_runtime_unavailable"
const ReasonClaudeSDKSidecarUnavailable = "claude_sdk_sidecar_unavailable"

const claudeSDKSidecarCommandEnv = "TUTTI_CLAUDE_SDK_SIDECAR_COMMAND"
const claudeSDKSidecarEntryPathEnv = "TUTTI_CLAUDE_SDK_SIDECAR_ENTRY_PATH"
const claudeSDKSidecarDefaultNodeArg = "--experimental-strip-types"

type ProviderCommandResolution struct {
	Command []string
	Env     []string
}

func (s Service) selectProviderSpecs(ctx context.Context, providers []string, requireManagedRuntime bool) ([]ProviderSpec, error) {
	specs, err := s.registry().Select(providers)
	if err != nil {
		return nil, err
	}
	result := make([]ProviderSpec, 0, len(specs))
	for _, spec := range specs {
		resolved, err := s.resolveProviderSpec(ctx, spec, requireManagedRuntime)
		if err != nil {
			return nil, err
		}
		result = append(result, resolved)
	}
	return result, nil
}

func (s Service) ResolveProviderCommand(ctx context.Context, provider string) (ProviderCommandResolution, error) {
	specs, err := s.selectProviderSpecs(ctx, []string{provider}, true)
	if err != nil {
		return ProviderCommandResolution{}, err
	}
	if len(specs) == 0 {
		return ProviderCommandResolution{}, ErrInvalidProvider
	}
	spec := specs[0]
	if isCodexStatusSpec(spec) && s.CodexRuntimeSelectionStore != nil {
		selection, err := s.resolveCodexRuntimeSelection(ctx, spec)
		if err != nil {
			return ProviderCommandResolution{}, err
		}
		candidate, found := selection.candidate()
		if !found || !selection.Launchable {
			return ProviderCommandResolution{}, fmt.Errorf("%s", firstNonBlank(selection.ReasonCode, "codex_runtime_selection_unavailable"))
		}
		command := cloneStrings(spec.AdapterCommand)
		if len(command) == 0 {
			return ProviderCommandResolution{}, fmt.Errorf("acp_adapter_not_found")
		}
		command[0] = candidate.Candidate.LauncherPath
		return ProviderCommandResolution{Command: command, Env: s.adapterCommandEnv(ctx, spec)}, nil
	}
	if len(spec.AdapterCommand) == 0 || strings.TrimSpace(spec.AdapterCommand[0]) == "" {
		reason := firstNonBlank(spec.AdapterUnavailableReasonCode, "acp_adapter_not_found")
		return ProviderCommandResolution{}, fmt.Errorf("%s", reason)
	}
	return ProviderCommandResolution{
		Command: cloneStrings(spec.AdapterCommand),
		Env:     s.adapterCommandEnv(ctx, spec),
	}, nil
}

func (s Service) resolveProviderSpec(ctx context.Context, spec ProviderSpec, requireManagedRuntime bool) (ProviderSpec, error) {
	if isClaudeStatusSpec(spec) {
		spec = s.resolveClaudeCodeProviderSpec(ctx, spec, requireManagedRuntime)
	}
	if strings.TrimSpace(spec.ExternalRegistryID) == "" {
		return s.resolveStaticProviderSpec(ctx, spec, requireManagedRuntime), nil
	}
	agent, err := s.externalAgentRegistry().Agent(ctx, spec.ExternalRegistryID)
	if err != nil {
		spec.AdapterUnavailableReasonCode = ReasonExternalAgentRegistryUnavailable
		return spec, nil
	}
	if agent.Distribution.NPM != nil {
		return s.resolveExternalRegistryNPMSpec(ctx, spec, agent, *agent.Distribution.NPM, requireManagedRuntime), nil
	}
	if len(agent.Distribution.Binary) > 0 {
		return s.resolveExternalRegistryBinarySpec(spec, agent), nil
	}
	spec.AdapterUnavailableReasonCode = "external_agent_registry_distribution_unavailable"
	return spec, nil
}

func (s Service) resolveClaudeCodeProviderSpec(ctx context.Context, spec ProviderSpec, requireManagedRuntime bool) ProviderSpec {
	spec.ExternalRegistryID = ""
	spec.AdapterPackage = AdapterPackageRequirement{}
	spec.AdapterInstall = InstallerSpec{}
	spec.AdapterUnavailableReasonCode = ""

	if command := strings.TrimSpace(os.Getenv(claudeSDKSidecarCommandEnv)); command != "" {
		spec.AdapterCommand = strings.Fields(command)
		if len(spec.AdapterCommand) > 0 {
			spec.AdapterBinaryNames = []string{spec.AdapterCommand[0]}
		}
		return spec
	}

	entry := s.resolveClaudeSDKSidecarEntryPath()
	if entry == "" {
		spec.AdapterCommand = nil
		spec.AdapterBinaryNames = []string{"tutti-claude-sdk-sidecar-missing"}
		spec.AdapterUnavailableReasonCode = ReasonClaudeSDKSidecarUnavailable
		return spec
	}

	nodeBinary := nodeBinaryName()
	nodeCommand := nodeBinary
	if appRuntime, ok := s.resolveManagedNodeRuntimeForProvider(ctx, requireManagedRuntime); ok {
		spec.AdapterEnv = append(s.managedRuntimeAdapterEnv(appRuntime), spec.AdapterEnv...)
		nodeCommand = appRuntime.Node
	} else if requireManagedRuntime {
		spec.AdapterUnavailableReasonCode = ReasonManagedRuntimeUnavailable
	}
	spec.AdapterCommand = []string{nodeCommand, claudeSDKSidecarDefaultNodeArg, entry}
	spec.AdapterBinaryNames = []string{nodeBinary}
	return spec
}

func (s Service) resolveClaudeSDKSidecarEntryPath() string {
	env := s.commandResolver().Env(nil)
	if entry := strings.TrimSpace(managedruntime.EnvValue(env, claudeSDKSidecarEntryPathEnv)); entry != "" {
		if s.fileExists(entry) {
			return entry
		}
		return ""
	}
	root := findClaudeSDKRepoRoot()
	if root == "" {
		return ""
	}
	entry := filepath.Join(root, "packages/agent/claude-sdk-sidecar/src/main.ts")
	if s.fileExists(entry) {
		return entry
	}
	return ""
}

func findClaudeSDKRepoRoot() string {
	dir, err := os.Getwd()
	if err != nil {
		return ""
	}
	for {
		if fileExistsPath(filepath.Join(dir, "pnpm-workspace.yaml")) &&
			fileExistsPath(filepath.Join(dir, "packages/agent/claude-sdk-sidecar/src/main.ts")) {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

func fileExistsPath(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func (s Service) resolveStaticProviderSpec(ctx context.Context, spec ProviderSpec, requireManagedRuntime bool) ProviderSpec {
	resolverKind := spec.StaticSpecResolverKind
	if resolverKind == "" {
		if status, ok := migratedProviderStatus(spec.Provider); ok {
			resolverKind = status.StaticSpecResolverKind
		}
	}
	switch resolverKind {
	case providerregistry.StaticSpecResolverKindCursor:
		return s.resolveCursorProviderSpec(spec)
	case providerregistry.StaticSpecResolverKindGeneric:
		if isStandardACPStatusSpec(spec) {
			return s.resolveGenericProviderSpec(spec)
		}
		return spec
	case providerregistry.StaticSpecResolverKindManagedNode:
	default:
		return spec
	}
	if s.userNodeRuntimeAvailable(spec.AdapterEnv) {
		return s.resolveCodexProviderSpec(ctx, spec)
	}
	appRuntime, ok := s.resolveManagedNodeRuntimeForProvider(ctx, requireManagedRuntime)
	if !ok {
		if requireManagedRuntime {
			spec.AdapterUnavailableReasonCode = ReasonManagedRuntimeUnavailable
		}
		return s.resolveCodexProviderSpec(ctx, spec)
	}
	spec.AdapterEnv = append(s.managedRuntimeAdapterEnv(appRuntime), spec.AdapterEnv...)
	return s.resolveCodexProviderSpec(ctx, spec)
}

// resolveGenericProviderSpec makes sessions, status, login and model catalog
// calls consume one resolved executable. On Windows the isolated managed npm
// package is authoritative when present; this avoids selecting a stale .cmd
// shim that happens to appear earlier on PATH.
func (s Service) resolveGenericProviderSpec(spec ProviderSpec) ProviderSpec {
	if len(spec.AdapterCommand) == 0 {
		return spec
	}
	adapterBinaryNames := cloneStrings(spec.AdapterBinaryNames)
	if len(adapterBinaryNames) == 0 {
		adapterBinaryNames = []string{spec.AdapterCommand[0]}
	}
	path := ""
	if runtime.GOOS == "windows" && managedNPMProvidesAdapter(spec, adapterBinaryNames) {
		path = s.resolveManagedNPMPackageBinary(spec)
	}
	if path == "" {
		path = s.commandResolver().ResolveBinary(adapterBinaryNames, spec.AdapterEnv)
	}
	if strings.TrimSpace(path) == "" {
		return spec
	}
	command := cloneStrings(spec.AdapterCommand)
	command[0] = path
	spec.AdapterCommand = command
	return spec
}

func managedNPMProvidesAdapter(spec ProviderSpec, adapterBinaryNames []string) bool {
	if spec.Install.ManagedNPM == nil {
		return false
	}
	managedBinaryName := strings.TrimSpace(spec.Install.ManagedNPM.BinaryName)
	for _, name := range adapterBinaryNames {
		if strings.EqualFold(strings.TrimSpace(name), managedBinaryName) {
			return true
		}
	}
	return false
}

func (s Service) resolveManagedNPMPackageBinary(spec ProviderSpec) string {
	managed := spec.Install.ManagedNPM
	if managed == nil || strings.TrimSpace(managed.PackageName) == "" || strings.TrimSpace(managed.BinaryName) == "" {
		return ""
	}
	installBinDirs := []string{strings.TrimSpace(managed.InstallDir)}
	if installBinDirs[0] == "" {
		home, err := s.homeDir()
		if err != nil || strings.TrimSpace(home) == "" {
			return ""
		}
		installBinDirs = runtimecmd.UserManagedNPMExecutableDirs(home)
	}
	for _, installBinDir := range installBinDirs {
		prefix := runtimecmd.ResolveNPMGlobalLayout(installBinDir).PrefixDir
		packageDir, ok := managedNPMGlobalPackageDir(prefix, managed.PackageName)
		if !ok {
			continue
		}
		path := installedNPMPackageBinaryPath(packageDir, managed.PackageName, managed.BinaryName)
		if path != "" && s.executableFile(path) {
			return path
		}
	}
	return ""
}

func installedNPMPackageBinaryPath(packageDir, packageName, binaryName string) string {
	manifestPath := filepath.Join(packageDir, "package.json")
	if !regularNonSymlinkFile(manifestPath) {
		return ""
	}
	content, err := os.ReadFile(manifestPath)
	if err != nil {
		return ""
	}
	var manifest struct {
		Name string          `json:"name"`
		Bin  json.RawMessage `json:"bin"`
	}
	if json.Unmarshal(content, &manifest) != nil || strings.TrimSpace(manifest.Name) != strings.TrimSpace(packageName) {
		return ""
	}
	var relative string
	if json.Unmarshal(manifest.Bin, &relative) != nil {
		var bins map[string]string
		if json.Unmarshal(manifest.Bin, &bins) != nil {
			return ""
		}
		relative = bins[strings.TrimSpace(binaryName)]
	}
	relative = strings.TrimSpace(relative)
	if relative == "" || filepath.IsAbs(relative) {
		return ""
	}
	path := filepath.Clean(filepath.Join(packageDir, filepath.FromSlash(relative)))
	within, err := filepath.Rel(packageDir, path)
	if err != nil || within == ".." || strings.HasPrefix(within, ".."+string(os.PathSeparator)) {
		return ""
	}
	if !regularNonSymlinkFile(path) {
		return ""
	}
	return path
}

func regularNonSymlinkFile(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0
}

func (s Service) userNodeRuntimeAvailable(overrides []string) bool {
	return s.userNodeRuntimePath(overrides) != ""
}

func (s Service) userNodeRuntimePath(overrides []string) string {
	env := []string(nil)
	if s.Environ != nil {
		env = s.Environ()
	} else {
		env = os.Environ()
	}
	env = append(cloneStrings(env), overrides...)
	for _, dir := range filepath.SplitList(managedruntime.EnvValue(env, "PATH")) {
		if strings.TrimSpace(dir) == "" {
			continue
		}
		candidate := filepath.Join(dir, nodeBinaryName())
		if s.executableFile(candidate) {
			return candidate
		}
	}
	return ""
}

// resolveCursorProviderSpec swaps the installed Cursor CLI binary into the
// adapter command. Cursor's installer has shipped the CLI as `cursor-agent`
// and, more recently, as `agent`; the static AdapterCommand assumes the
// former, so re-point it at whichever binary actually resolves.
func (s Service) resolveCursorProviderSpec(spec ProviderSpec) ProviderSpec {
	if len(spec.AdapterCommand) == 0 {
		return spec
	}
	path := s.commandResolver().ResolveBinary(spec.BinaryNames, spec.AdapterEnv)
	if strings.TrimSpace(path) == "" {
		return spec
	}
	command := cloneStrings(spec.AdapterCommand)
	command[0] = path
	spec.AdapterCommand = command
	return spec
}

func (s Service) resolveExternalRegistryNPMSpec(
	ctx context.Context,
	spec ProviderSpec,
	agent externalagentregistry.Agent,
	distribution externalagentregistry.NPMDistribution,
	requireManagedRuntime bool,
) ProviderSpec {
	registry := s.externalAgentRegistry()
	prefixDir := registry.PackagePrefix(agent.ID)
	if err := os.MkdirAll(prefixDir, 0o755); err != nil {
		spec.AdapterCommand = nil
		spec.AdapterEnv = nil
		spec.AdapterUnavailableReasonCode = "external_agent_registry_package_dir_unavailable"
		return spec
	}
	packageName, packageVersion := splitNPMPackageSpec(distribution.Package)
	packageDir := npmPackageInstallDir(prefixDir, packageName)
	spec.AdapterPackage = AdapterPackageRequirement{
		Name:    packageName,
		Version: firstNonBlank(packageVersion, agent.Version),
	}
	spec.AdapterInstall = InstallerSpec{
		Kind:           InstallerKindExternalAgentRegistryNPM,
		DisplayCommand: "Install " + agent.ID + " from ACP External Agent Registry",
		RegistryNPM: &ExternalAgentRegistryNPMInstallerSpec{
			AgentID:    agent.ID,
			Package:    distribution.Package,
			Args:       cloneStrings(distribution.Args),
			Env:        cloneStringMap(distribution.Env),
			PrefixDir:  prefixDir,
			PackageDir: packageDir,
			Version:    firstNonBlank(packageVersion, agent.Version),
		},
	}
	appRuntime, ok := s.resolveManagedRuntimeForProvider(ctx, requireManagedRuntime)
	if !ok {
		spec.AdapterCommand = nil
		spec.AdapterEnv = nil
		spec.AdapterUnavailableReasonCode = ReasonManagedRuntimeUnavailable
		return spec
	}
	var command []string
	if binPath := s.installedNPMBinPath(prefixDir, packageDir, packageName); binPath != "" {
		command = []string{binPath}
	} else {
		command = []string{
			appRuntime.NPM,
			"--prefix",
			prefixDir,
			"exec",
			"--yes",
			"--",
			boundedNPMPackageSpec(distribution.Package),
		}
	}
	command = append(command, distribution.Args...)
	spec.AdapterCommand = command
	spec.AdapterEnv = append(s.managedRuntimeAdapterEnv(appRuntime), envMapToList(distribution.Env)...)
	// Seed the registry for the `npm exec` fallback. Callers that actually execute
	// this fallback re-rank providers first, because this single-shot path can't
	// retry a chain.
	spec.AdapterEnv = withAgentNPMRegistry(spec.AdapterEnv, s.primaryAgentNPMRegistry())
	// Pin a dedicated cache for the `npm exec` fallback too, so it never trips over
	// a root-owned global ~/.npm. Harmless when running the installed bin directly.
	spec.AdapterEnv = withAgentNPMCache(spec.AdapterEnv, filepath.Join(prefixDir, agentNPMCacheDirName))
	return spec
}

func adapterCommandUsesNPMExecFallback(command []string) bool {
	for _, arg := range command {
		if strings.TrimSpace(arg) == "exec" {
			return true
		}
	}
	return false
}

func (s Service) adapterCommandEnv(ctx context.Context, spec ProviderSpec) []string {
	env := cloneStrings(spec.AdapterEnv)
	if spec.AdapterInstall.RegistryNPM == nil || !adapterCommandUsesNPMExecFallback(spec.AdapterCommand) {
		return env
	}
	packageName, _ := splitNPMPackageSpec(spec.AdapterInstall.RegistryNPM.Package)
	return withAgentNPMRegistry(env, s.preferredAgentNPMRegistry(ctx, packageName))
}

func (s Service) resolveExternalRegistryBinarySpec(spec ProviderSpec, agent externalagentregistry.Agent) ProviderSpec {
	target, ok := agent.Distribution.Binary[externalagentregistry.CurrentPlatformKey()]
	if !ok {
		spec.AdapterUnavailableReasonCode = "external_agent_registry_platform_unavailable"
		return spec
	}
	installDir := s.externalAgentRegistry().BinaryInstallDir(agent.ID)
	binaryName := filepath.Base(strings.TrimPrefix(strings.TrimPrefix(target.Command, "./"), ".\\"))
	spec.AdapterInstall = InstallerSpec{
		Kind:           InstallerKindGitHubReleaseBinary,
		DisplayCommand: "Install " + agent.ID + " from ACP External Agent Registry",
		ReleaseBinary: &ReleaseBinaryInstallerSpec{
			BinaryName: binaryName,
			Version:    agent.Version,
			InstallDir: installDir,
			Assets: map[string]ReleaseBinaryAsset{
				releaseBinaryPlatformKey(runtimeGOOS(), runtimeGOARCH()): {
					URL:    target.Archive,
					SHA256: target.SHA256,
				},
			},
		},
	}
	command := []string{filepath.Join(installDir, binaryName)}
	command = append(command, target.Args...)
	spec.AdapterCommand = command
	spec.AdapterEnv = envMapToList(target.Env)
	return spec
}

func (s Service) managedRuntimeAdapterEnv(appRuntime managedruntime.ResolvedRuntime) []string {
	env := make([]string, 0, len(appRuntime.EnvOverrides)+1)
	for _, override := range appRuntime.EnvOverrides {
		key, _, ok := strings.Cut(override, "=")
		if ok && strings.EqualFold(key, "PATH") {
			continue
		}
		env = append(env, override)
	}
	basePath := managedruntime.EnvValue(s.commandResolver().Env(nil), "PATH")
	pathDirs := append([]string{}, appRuntime.BinDirs...)
	pathDirs = append(pathDirs, filepath.SplitList(basePath)...)
	env = append(env, "PATH="+strings.Join(pathDirs, string(os.PathListSeparator)))
	return env
}

func (s Service) resolveManagedNodeRuntimeForProvider(ctx context.Context, require bool) (managedruntime.ResolvedRuntime, bool) {
	resolver := s.managedRuntimeResolver()
	if managed, ok := resolver.(managedruntime.DefaultResolver); ok {
		root := strings.TrimSpace(managed.RuntimeRoot)
		if root == "" {
			root = managed.DefaultRoot()
		}
		if runtime, ok := resolvedExistingManagedNodeRuntime(root, s.Environ); ok {
			return runtime, true
		}
		if !require {
			return managedruntime.ResolvedRuntime{}, false
		}
	}
	runtime, err := s.resolveCodexManagedNodeRuntime(ctx)
	if err != nil {
		return managedruntime.ResolvedRuntime{}, false
	}
	return runtime, true
}

func resolvedExistingManagedNodeRuntime(root string, environ func() []string) (managedruntime.ResolvedRuntime, bool) {
	root = strings.TrimSpace(root)
	if root == "" {
		return managedruntime.ResolvedRuntime{}, false
	}
	nodeBinDir := filepath.Join(root, "node", "bin")
	nodePath := filepath.Join(nodeBinDir, nodeBinaryName())
	npmPath := filepath.Join(nodeBinDir, npmBinaryName())
	if !managedruntime.NodeReady(root) {
		return managedruntime.ResolvedRuntime{}, false
	}
	baseEnv := os.Environ()
	if environ != nil {
		baseEnv = environ()
	}
	basePath := managedruntime.EnvValue(baseEnv, "PATH")
	return managedruntime.ResolvedRuntime{
		Root:    root,
		Node:    nodePath,
		NPM:     npmPath,
		BinDirs: []string{nodeBinDir},
		EnvOverrides: []string{
			"TUTTI_APP_RUNTIME_ROOT=" + root,
			"TUTTI_APP_NODE=" + nodePath,
			"TUTTI_APP_NPM=" + npmPath,
			"PATH=" + strings.Join(append([]string{nodeBinDir}, filepath.SplitList(basePath)...), string(os.PathListSeparator)),
		},
	}, true
}

func (s Service) resolveManagedRuntimeForProvider(ctx context.Context, require bool) (managedruntime.ResolvedRuntime, bool) {
	resolver := s.managedRuntimeResolver()
	if !require {
		if managed, ok := resolver.(managedruntime.DefaultResolver); ok {
			root := strings.TrimSpace(managed.RuntimeRoot)
			if root == "" {
				root = managed.DefaultRoot()
			}
			if !managedruntime.NodeReady(root) {
				return managedruntime.ResolvedRuntime{}, false
			}
		}
	}
	var runtime managedruntime.ResolvedRuntime
	var err error
	if profileResolver, ok := resolver.(managedruntime.ProfileResolver); ok {
		runtime, err = profileResolver.ResolveProfile(ctx, managedruntime.NodeStaticProfile)
	} else {
		runtime, err = resolver.Resolve(ctx)
	}
	if err != nil {
		return managedruntime.ResolvedRuntime{}, false
	}
	return runtime, true
}

func (s Service) externalAgentRegistry() externalagentregistry.Store {
	registry := s.ExternalAgentRegistry
	if registry.HTTPClient == nil {
		registry.HTTPClient = s.httpClient()
	}
	return registry
}

func (s Service) managedRuntimeResolver() managedruntime.Resolver {
	if s.ManagedRuntime != nil {
		return s.ManagedRuntime
	}
	return managedruntime.DefaultResolver{
		Environ:    s.Environ,
		HTTPClient: s.httpClient(),
	}
}

func installedNPMPackageVersion(packageDir string, packageName string) string {
	if strings.TrimSpace(packageDir) == "" || strings.TrimSpace(packageName) == "" {
		return ""
	}
	content, err := os.ReadFile(filepath.Join(packageDir, "package.json"))
	if err != nil {
		return ""
	}
	var manifest struct {
		Name    string `json:"name"`
		Version string `json:"version"`
	}
	if err := json.Unmarshal(content, &manifest); err != nil {
		return ""
	}
	if strings.TrimSpace(manifest.Name) != strings.TrimSpace(packageName) {
		return ""
	}
	return strings.TrimSpace(manifest.Version)
}

func (s Service) installedNPMBinPath(prefixDir string, packageDir string, packageName string) string {
	binName := installedNPMPackageBinName(packageDir, packageName)
	if binName == "" {
		return ""
	}
	candidates := []string{filepath.Join(prefixDir, "node_modules", ".bin", binName)}
	if runtime.GOOS == "windows" {
		candidates = append([]string{candidates[0] + ".cmd"}, candidates...)
	}
	for _, candidate := range candidates {
		if s.executableFile(candidate) {
			return candidate
		}
	}
	return ""
}

func installedNPMPackageBinName(packageDir string, packageName string) string {
	if strings.TrimSpace(packageDir) == "" || strings.TrimSpace(packageName) == "" {
		return ""
	}
	content, err := os.ReadFile(filepath.Join(packageDir, "package.json"))
	if err != nil {
		return ""
	}
	var manifest struct {
		Name string          `json:"name"`
		Bin  json.RawMessage `json:"bin"`
	}
	if err := json.Unmarshal(content, &manifest); err != nil {
		return ""
	}
	if strings.TrimSpace(manifest.Name) != strings.TrimSpace(packageName) || len(manifest.Bin) == 0 {
		return ""
	}
	defaultName := defaultNPMBinName(packageName)
	var binString string
	if err := json.Unmarshal(manifest.Bin, &binString); err == nil && strings.TrimSpace(binString) != "" {
		return defaultName
	}
	var binMap map[string]string
	if err := json.Unmarshal(manifest.Bin, &binMap); err != nil || len(binMap) == 0 {
		return ""
	}
	if _, ok := binMap[defaultName]; ok {
		return defaultName
	}
	if len(binMap) == 1 {
		for name := range binMap {
			return strings.TrimSpace(name)
		}
	}
	return ""
}

func defaultNPMBinName(packageName string) string {
	packageName = strings.TrimSpace(packageName)
	if strings.HasPrefix(packageName, "@") {
		_, name, ok := strings.Cut(packageName, "/")
		if ok {
			return strings.TrimSpace(name)
		}
	}
	return packageName
}

func npmPackageInstallDir(prefixDir string, packageName string) string {
	packageName = strings.TrimSpace(packageName)
	if strings.HasPrefix(packageName, "@") {
		scope, name, ok := strings.Cut(packageName, "/")
		if ok {
			return filepath.Join(prefixDir, "node_modules", scope, name)
		}
	}
	return filepath.Join(prefixDir, "node_modules", packageName)
}

func splitNPMPackageSpec(packageSpec string) (string, string) {
	packageSpec = strings.TrimSpace(packageSpec)
	index := strings.LastIndex(packageSpec, "@")
	if index <= 0 {
		return packageSpec, ""
	}
	return packageSpec[:index], packageSpec[index+1:]
}

var npmSemverPattern = regexp.MustCompile(`^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$`)

func boundedNPMPackageSpec(packageSpec string) string {
	name, version := splitNPMPackageSpec(packageSpec)
	if strings.TrimSpace(name) == "" || !npmSemverPattern.MatchString(strings.TrimSpace(version)) {
		return strings.TrimSpace(packageSpec)
	}
	return strings.TrimSpace(name) + "@0.0.0 - " + strings.TrimSpace(version)
}

func envMapToList(env map[string]string) []string {
	if len(env) == 0 {
		return nil
	}
	result := make([]string, 0, len(env))
	for key, value := range env {
		if strings.TrimSpace(key) == "" {
			continue
		}
		result = append(result, key+"="+value)
	}
	return result
}

func cloneStringMap(input map[string]string) map[string]string {
	if len(input) == 0 {
		return nil
	}
	output := make(map[string]string, len(input))
	for key, value := range input {
		output[key] = value
	}
	return output
}

func runtimeGOOS() string {
	return runtime.GOOS
}

func runtimeGOARCH() string {
	return runtime.GOARCH
}
