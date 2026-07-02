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

	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	externalagentregistry "github.com/tutti-os/tutti/services/tuttid/service/externalagentregistry"
	managedruntime "github.com/tutti-os/tutti/services/tuttid/service/managedruntime"
)

const ReasonExternalAgentRegistryUnavailable = "external_agent_registry_unavailable"
const ReasonManagedRuntimeUnavailable = "managed_runtime_unavailable"
const ReasonClaudeSDKSidecarUnavailable = "claude_sdk_sidecar_unavailable"

const claudeCodeRuntimeEnv = "TUTTI_CLAUDE_CODE_RUNTIME"
const claudeCodeRuntimeACP = "acp"
const claudeCodeRuntimeSDK = "sdk"
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
	if spec.Provider == agentprovider.ClaudeCode {
		spec = s.resolveClaudeCodeRuntimeSpec(ctx, spec, requireManagedRuntime)
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

func (s Service) resolveClaudeCodeRuntimeSpec(ctx context.Context, spec ProviderSpec, requireManagedRuntime bool) ProviderSpec {
	if claudeCodeAgentStatusRuntime() == claudeCodeRuntimeACP {
		return claudeCodeACPProviderSpec(spec)
	}
	return s.resolveClaudeCodeSDKProviderSpec(ctx, spec, requireManagedRuntime)
}

func claudeCodeAgentStatusRuntime() string {
	runtime := strings.TrimSpace(os.Getenv(claudeCodeRuntimeEnv))
	if strings.EqualFold(runtime, claudeCodeRuntimeACP) {
		return claudeCodeRuntimeACP
	}
	return claudeCodeRuntimeSDK
}

func claudeCodeACPProviderSpec(spec ProviderSpec) ProviderSpec {
	spec.ExternalRegistryID = firstNonBlank(spec.ExternalRegistryID, "claude-acp")
	if spec.AdapterInstall.Kind == "" {
		spec.AdapterInstall.Kind = InstallerKindExternalAgentRegistryNPM
	}
	spec.AdapterInstall.DisplayCommand = firstNonBlank(
		spec.AdapterInstall.DisplayCommand,
		"Install claude-acp from ACP External Agent Registry",
	)
	if spec.AdapterInstall.PostInstall == InstallerPostStepNone {
		spec.AdapterInstall.PostInstall = InstallerPostStepPatchClaudeAgentACP
	}
	return spec
}

func (s Service) resolveClaudeCodeSDKProviderSpec(ctx context.Context, spec ProviderSpec, requireManagedRuntime bool) ProviderSpec {
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
	if spec.Provider != agentprovider.Codex {
		return spec
	}
	appRuntime, ok := s.resolveManagedNodeRuntimeForProvider(ctx, requireManagedRuntime)
	if !ok {
		if requireManagedRuntime {
			spec.AdapterUnavailableReasonCode = ReasonManagedRuntimeUnavailable
		}
		return spec
	}
	spec.AdapterEnv = append(s.managedRuntimeAdapterEnv(appRuntime), spec.AdapterEnv...)
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
		PostInstall: spec.AdapterInstall.PostInstall,
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
	if !isExecutablePath(nodePath) || !isExecutablePath(npmPath) {
		return managedruntime.ResolvedRuntime{}, false
	}
	baseEnv := []string(nil)
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

func isExecutablePath(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir() && info.Mode().Perm()&0o111 != 0
}

func (s Service) resolveManagedRuntimeForProvider(ctx context.Context, require bool) (managedruntime.ResolvedRuntime, bool) {
	resolver := s.managedRuntimeResolver()
	if !require {
		if managed, ok := resolver.(managedruntime.DefaultResolver); ok {
			root := strings.TrimSpace(managed.RuntimeRoot)
			if root == "" {
				root = managed.DefaultRoot()
			}
			if !managedruntime.RootReady(root) {
				return managedruntime.ResolvedRuntime{}, false
			}
		}
	}
	runtime, err := resolver.Resolve(ctx)
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
