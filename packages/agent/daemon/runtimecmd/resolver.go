package runtimecmd

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
)

type Resolver struct {
	Environ          func() []string
	HomeDir          func() (string, error)
	IsExecutableFile func(string) bool
	LookPath         func(string) (string, error)
	// ScutilProxy returns the raw output of `scutil --proxy` (and whether it is
	// available). It is injectable for legacy macOS parser tests; production
	// reads the platform system proxy through the build-tagged adapter.
	ScutilProxy func() (string, bool)
}

// nestingGuardEnvKeys are the environment variables a parent Claude Code
// session exports to detect (and refuse) nested launches. When tuttid itself
// runs inside a Claude Code session these leak into spawned agent subprocesses, causing
// a child `claude` to abort with "cannot be launched inside another Claude Code
// session". They are stripped from the base environment so each spawned agent
// starts as a fresh session; they are CLAUDE-specific and harmless to other runtimes.
var nestingGuardEnvKeys = []string{
	"CLAUDECODE",
	"CLAUDE_CODE_ENTRYPOINT",
	"CLAUDE_CODE_SESSION_ID",
	"CLAUDE_CODE_CHILD_SESSION",
}

func (r Resolver) Env(overrides []string) []string {
	baseEnv := stripEnvKeys(r.environ(), nestingGuardEnvKeys)
	env := append(baseEnv, overrides...)
	pathKey := pathEnvKey(env)
	pathGroups := [][]string{}
	if overridePathGroups := pathGroupsFromEnv(overrides, pathKey, envValue(baseEnv, pathKey)); len(overridePathGroups) > 0 {
		pathGroups = append(pathGroups, overridePathGroups...)
		pathGroups = append(pathGroups, preferredExecutableDirs(env))
		pathGroups = append(pathGroups, r.fallbackExecutableDirs())
	} else {
		pathGroups = append(pathGroups, preferredExecutableDirs(env))
		pathGroups = append(pathGroups, splitPathList(envValue(baseEnv, pathKey)))
		pathGroups = append(pathGroups, r.fallbackExecutableDirs())
	}
	pathDirs := mergePathDirs(pathGroups...)
	if len(pathDirs) > 0 {
		env = setEnvValue(env, pathKey, strings.Join(pathDirs, string(os.PathListSeparator)))
	}
	return r.injectSystemProxyEnv(env)
}

func (r Resolver) Resolve(command string, env []string) string {
	command = strings.TrimSpace(command)
	if command == "" || strings.ContainsAny(command, `/\`) {
		return command
	}
	if candidates := r.ResolveAll(command, env); len(candidates) > 0 {
		return candidates[0]
	}
	return command
}

// ResolveAll returns every executable match for command in the effective PATH,
// preserving directory order and removing duplicate paths. It deliberately
// does not call LookPath: callers that need an OS-specific fallback can append
// that result explicitly, while discovery callers get a complete, stable view
// of the resolver's own search plan.
func (r Resolver) ResolveAll(command string, env []string) []string {
	command = strings.TrimSpace(command)
	if command == "" || strings.ContainsAny(command, "/\\") {
		return nil
	}
	return r.ResolveAllNames([]string{command}, env)
}

// ResolveAllNames returns every executable match for a set of command names.
// Directory order is primary and name order is secondary, which lets callers
// enumerate platform launcher variants without changing PATH precedence.
func (r Resolver) ResolveAllNames(commandNames []string, env []string) []string {
	result := []string{}
	seen := map[string]struct{}{}
	for _, dir := range splitPathList(envValue(env, pathEnvKey(env))) {
		for _, command := range commandNames {
			command = strings.TrimSpace(command)
			if command == "" || strings.ContainsAny(command, `/\\`) {
				continue
			}
			for _, executableName := range executableNameCandidates(command, env) {
				candidate := filepath.Join(dir, executableName)
				if !r.isExecutableFile(candidate) {
					continue
				}
				key := executablePathKey(candidate)
				if _, ok := seen[key]; ok {
					continue
				}
				seen[key] = struct{}{}
				result = append(result, candidate)
			}
		}
	}
	return result
}

func (r Resolver) ResolveBinary(binaryNames []string, overrides []string) string {
	env := r.Env(overrides)
	for _, binaryName := range binaryNames {
		binaryName = strings.TrimSpace(binaryName)
		if binaryName == "" {
			continue
		}
		path := r.Resolve(binaryName, env)
		if path != binaryName {
			return path
		}
		if path := r.lookPath(binaryName); path != "" {
			return path
		}
	}
	return ""
}

func (r Resolver) UserBinInstallDirs(overrides []string) []string {
	baseEnv := r.environ()
	env := append([]string{}, baseEnv...)
	env = append(env, overrides...)
	pathValue := envValue(baseEnv, pathEnvKey(baseEnv))
	if overridePath, ok := envValueFrom(overrides, pathEnvKey(env)); ok {
		pathValue = overridePath
	}
	candidates := [][]string{
		splitPathList(pathValue),
	}
	home, err := r.homeDir()
	if err == nil && strings.TrimSpace(home) != "" {
		managedNPMDirs := UserManagedNPMExecutableDirs(home)
		candidates = append(candidates, managedNPMDirs, []string{filepath.Join(home, "bin")})
	}
	return mergePathDirs(candidates...)
}

func preferredExecutableDirs(env []string) []string {
	dirs := []string{}
	if nPrefix := strings.TrimSpace(envValue(env, "N_PREFIX")); nPrefix != "" {
		dirs = append([]string{filepath.Join(nPrefix, "bin")}, dirs...)
	}
	if pnpmHome := strings.TrimSpace(envValue(env, "PNPM_HOME")); pnpmHome != "" {
		dirs = append([]string{pnpmHome}, dirs...)
	}
	if voltaHome := strings.TrimSpace(envValue(env, "VOLTA_HOME")); voltaHome != "" {
		dirs = append([]string{filepath.Join(voltaHome, "bin")}, dirs...)
	}
	if asdfDataDir := strings.TrimSpace(envValue(env, "ASDF_DATA_DIR")); asdfDataDir != "" {
		dirs = append([]string{filepath.Join(asdfDataDir, "shims")}, dirs...)
	}
	if miseDataDir := strings.TrimSpace(envValue(env, "MISE_DATA_DIR")); miseDataDir != "" {
		dirs = append([]string{filepath.Join(miseDataDir, "shims")}, dirs...)
	}
	if fnmDir := strings.TrimSpace(envValue(env, "FNM_DIR")); fnmDir != "" {
		dirs = append(fnmNodeBinDirs(fnmDir), dirs...)
	}
	return dirs
}

func (r Resolver) fallbackExecutableDirs() []string {
	dirs := []string{
		"/opt/homebrew/bin",
		"/usr/local/bin",
		"/usr/bin",
		"/bin",
	}
	homeDirs := []string{}
	home, err := r.homeDir()
	if err == nil && strings.TrimSpace(home) != "" {
		homeDirs = []string{
			filepath.Join(home, ".tutti", "bin"),
			filepath.Join(home, ".opencode", "bin"),
		}
		homeDirs = append(homeDirs, UserManagedNPMExecutableDirs(home)...)
		homeDirs = append(homeDirs,
			filepath.Join(home, "bin"),
			filepath.Join(home, ".npm-global", "bin"),
			filepath.Join(home, ".n", "bin"),
			filepath.Join(home, "n", "bin"),
			filepath.Join(home, ".volta", "bin"),
			filepath.Join(home, ".asdf", "shims"),
			filepath.Join(home, ".mise", "shims"),
			filepath.Join(home, ".bun", "bin"),
			filepath.Join(home, "Library", "pnpm"),
		)
		homeDirs = append(homeDirs, nvmNodeBinDirs(home)...)
		homeDirs = append(homeDirs, fnmNodeBinDirs(filepath.Join(home, ".fnm"))...)
		// Cursor's native Windows installer places agent.ps1 and its versioned
		// payload under %LOCALAPPDATA%\\cursor-agent rather than on PATH.
		homeDirs = append(homeDirs, filepath.Join(home, "AppData", "Local", "cursor-agent"))
	}
	return append(homeDirs, dirs...)
}

func (r Resolver) environ() []string {
	if r.Environ != nil {
		return r.Environ()
	}
	return os.Environ()
}

func (r Resolver) homeDir() (string, error) {
	if r.HomeDir != nil {
		return r.HomeDir()
	}
	return os.UserHomeDir()
}

func (r Resolver) isExecutableFile(path string) bool {
	if r.IsExecutableFile != nil {
		return r.IsExecutableFile(path)
	}
	return isExecutableFile(path)
}

func (r Resolver) lookPath(binaryName string) string {
	lookPath := r.LookPath
	if lookPath == nil {
		lookPath = exec.LookPath
	}
	path, err := lookPath(binaryName)
	if err == nil && strings.TrimSpace(path) != "" {
		return strings.TrimSpace(path)
	}
	return ""
}

func nvmNodeBinDirs(home string) []string {
	matches, err := filepath.Glob(filepath.Join(home, ".nvm", "versions", "node", "*", "bin"))
	if err != nil {
		return nil
	}
	sort.SliceStable(matches, func(i, j int) bool {
		return compareNVMNodeBinDirs(matches[i], matches[j]) > 0
	})
	return matches
}

func compareNVMNodeBinDirs(left string, right string) int {
	leftVersion := nvmNodeVersion(left)
	rightVersion := nvmNodeVersion(right)
	for i := 0; i < max(len(leftVersion), len(rightVersion)); i++ {
		leftPart := versionPart(leftVersion, i)
		rightPart := versionPart(rightVersion, i)
		if leftPart > rightPart {
			return 1
		}
		if leftPart < rightPart {
			return -1
		}
	}
	return strings.Compare(left, right)
}

func nvmNodeVersion(binDir string) []int {
	versionDir := filepath.Base(filepath.Dir(binDir))
	version := strings.TrimPrefix(versionDir, "v")
	parts := strings.Split(version, ".")
	result := make([]int, 0, len(parts))
	for _, part := range parts {
		value, err := strconv.Atoi(part)
		if err != nil {
			return nil
		}
		result = append(result, value)
	}
	return result
}

func versionPart(version []int, index int) int {
	if index < 0 || index >= len(version) {
		return 0
	}
	return version[index]
}

func fnmNodeBinDirs(fnmDir string) []string {
	matches, err := filepath.Glob(filepath.Join(fnmDir, "node-versions", "*", "installation", "bin"))
	if err != nil {
		return nil
	}
	return matches
}

func mergePathDirs(groups ...[]string) []string {
	result := []string{}
	seen := map[string]bool{}
	for _, group := range groups {
		for _, dir := range group {
			normalized := strings.TrimSpace(dir)
			if normalized == "" {
				continue
			}
			key := pathDirKey(normalized)
			if seen[key] {
				continue
			}
			seen[key] = true
			result = append(result, normalized)
		}
	}
	return result
}

func pathDirKey(dir string) string {
	key := filepath.Clean(strings.TrimSpace(dir))
	if runtime.GOOS == "windows" {
		key = strings.ToLower(key)
	}
	return key
}

func executablePathKey(path string) string {
	return pathDirKey(path)
}

func pathEnvKey(env []string) string {
	for i := len(env) - 1; i >= 0; i-- {
		key, _, ok := strings.Cut(env[i], "=")
		if ok && strings.EqualFold(key, "PATH") {
			return key
		}
	}
	return "PATH"
}

func envValue(env []string, key string) string {
	value, _ := envValueFrom(env, key)
	return value
}

func envValueFrom(env []string, key string) (string, bool) {
	for i := len(env) - 1; i >= 0; i-- {
		candidateKey, value, ok := strings.Cut(env[i], "=")
		if ok && strings.EqualFold(candidateKey, key) {
			return value, true
		}
	}
	return "", false
}

func pathGroupsFromEnv(env []string, key string, basePath string) [][]string {
	groups := [][]string{}
	baseDirs := splitPathList(basePath)
	inheritedBaseDirs := []string{}
	for i := len(env) - 1; i >= 0; i-- {
		candidateKey, value, ok := strings.Cut(env[i], "=")
		if ok && strings.EqualFold(candidateKey, key) {
			dirs := splitPathList(value)
			if prefix, inherited, ok := splitInheritedPath(dirs, baseDirs); ok {
				groups = append(groups, prefix)
				if len(inheritedBaseDirs) == 0 {
					inheritedBaseDirs = inherited
				}
				continue
			}
			groups = append(groups, dirs)
		}
	}
	if len(inheritedBaseDirs) > 0 {
		groups = append(groups, inheritedBaseDirs)
	}
	return groups
}

// splitPathList follows the host separator but also accepts the colon form
// emitted by MSYS/Unix-like test and launcher environments on Windows. A
// native Windows path containing a drive letter or backslashes remains on the
// normal semicolon path-list path.
func splitPathList(value string) []string {
	if runtime.GOOS == "windows" && !strings.Contains(value, ";") &&
		strings.Contains(value, ":") && !strings.Contains(value, `\`) {
		return strings.Split(value, ":")
	}
	return filepath.SplitList(value)
}

func splitInheritedPath(dirs []string, baseDirs []string) ([]string, []string, bool) {
	if len(baseDirs) == 0 || len(dirs) < len(baseDirs) {
		return nil, nil, false
	}
	for i := 0; i+len(baseDirs) <= len(dirs); i++ {
		if pathDirSlicesEqual(dirs[i:i+len(baseDirs)], baseDirs) {
			return dirs[:i], dirs[i:], true
		}
	}
	return nil, nil, false
}

func pathDirSlicesEqual(a []string, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if pathDirKey(a[i]) != pathDirKey(b[i]) {
			return false
		}
	}
	return true
}

func stripEnvKeys(env []string, keys []string) []string {
	if len(keys) == 0 {
		return env
	}
	next := make([]string, 0, len(env))
	for _, item := range env {
		candidateKey, _, ok := strings.Cut(item, "=")
		if ok {
			drop := false
			for _, key := range keys {
				if strings.EqualFold(candidateKey, key) {
					drop = true
					break
				}
			}
			if drop {
				continue
			}
		}
		next = append(next, item)
	}
	return next
}

func setEnvValue(env []string, key string, value string) []string {
	next := make([]string, 0, len(env)+1)
	for _, item := range env {
		candidateKey, _, ok := strings.Cut(item, "=")
		if ok && strings.EqualFold(candidateKey, key) {
			continue
		}
		next = append(next, item)
	}
	return append(next, key+"="+value)
}
