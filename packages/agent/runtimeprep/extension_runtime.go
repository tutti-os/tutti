package runtimeprep

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
)

var extensionRuntimeEnvName = regexp.MustCompile(`^[A-Z_][A-Z0-9_]*$`)
var extensionRuntimeSharedDirsMu sync.Mutex

type ExtensionRuntimePreparer struct{}

func (ExtensionRuntimePreparer) Provider() string {
	return ""
}

func (ExtensionRuntimePreparer) Prepare(ctx context.Context, input ProviderPrepareInput) (ProviderPrepareResult, error) {
	if input.ExtensionRuntimePrep == nil {
		return InstructionFilePreparer{}.Prepare(ctx, input)
	}
	if err := ValidateExtensionRuntimePrep(*input.ExtensionRuntimePrep); err != nil {
		return ProviderPrepareResult{}, err
	}
	if err := writeExtensionRuntimeInstructions(input); err != nil {
		return ProviderPrepareResult{}, err
	}
	if input.ExtensionRuntimePrep.Home == nil {
		skillRoots, err := cwdExtensionSkillRoots(input.ExtensionSkillRoots)
		if err != nil {
			return ProviderPrepareResult{}, err
		}
		if err := materializeExtensionRuntimeSkills(input, skillRoots, true); err != nil {
			return ProviderPrepareResult{}, err
		}
		return ProviderPrepareResult{Cwd: input.Cwd}, nil
	}
	env, err := prepareExtensionRuntimeHome(input, *input.ExtensionRuntimePrep.Home)
	if err != nil {
		return ProviderPrepareResult{}, err
	}
	return ProviderPrepareResult{
		Cwd: input.Cwd,
		Env: []string{env},
	}, nil
}

func writeExtensionRuntimeInstructions(input ProviderPrepareInput) error {
	fileName := strings.TrimSpace(input.ExtensionRuntimePrep.InstructionsFile)
	if fileName == "" {
		fileName = "AGENTS.md"
	}
	path := filepath.Join(input.Cwd, fileName)
	policy, err := tuttiCLIPolicy(input.PrepareInput)
	if err != nil {
		return err
	}
	writeResult, err := input.Store.WriteManagedBlock(path, policy)
	if err != nil {
		return err
	}
	if input.Manifest != nil {
		input.Manifest.RecordManagedFile(path, "provider-instructions", writeResult.Created)
	}
	return nil
}

func prepareExtensionRuntimeHome(input ProviderPrepareInput, home ExtensionRuntimeHome) (string, error) {
	sessionHome := filepath.Join(input.RuntimeRoot, filepath.FromSlash(strings.TrimSpace(home.DirName)))
	if err := os.MkdirAll(sessionHome, 0o700); err != nil {
		return "", fmt.Errorf("create extension runtime home: %w", err)
	}

	sourceHome := resolveExtensionRuntimeSourceHome(home)
	if err := exposeExtensionRuntimeSharedDirs(input, sourceHome, sessionHome, home); err != nil {
		return "", err
	}
	userConfig, err := copyExtensionRuntimeHomeFiles(sourceHome, sessionHome, home)
	if err != nil {
		return "", err
	}
	externalDirs, err := extensionRuntimeExternalDirs(input, sourceHome, home)
	if err != nil {
		return "", err
	}
	if err := writeExtensionRuntimeConfig(filepath.Join(sessionHome, filepath.FromSlash(home.ConfigFile)), userConfig, externalDirs, home); err != nil {
		return "", err
	}
	if err := prepareExtensionRTKIntegration(input, sessionHome, home); err != nil {
		return "", err
	}
	if input.Manifest != nil {
		input.Manifest.RecordManagedFile(sessionHome, "provider-extension-home", true)
	}
	return strings.TrimSpace(home.EnvVar) + "=" + sessionHome, nil
}

// exposeExtensionRuntimeSharedDirs keeps explicitly declared mutable runtime
// directories stable across otherwise isolated session homes. This is useful
// for provider-owned caches or verified helper binaries that would otherwise
// be fetched again for every fresh session. The signed profile selects only
// relative paths beneath its ordinary source home; runtimeprep remains
// provider-neutral.
func exposeExtensionRuntimeSharedDirs(input ProviderPrepareInput, sourceHome, sessionHome string, home ExtensionRuntimeHome) error {
	if len(home.SharedDirs) == 0 {
		return nil
	}
	if strings.TrimSpace(sourceHome) == "" {
		return nil
	}

	// Preparation can run concurrently for multiple sessions in one daemon.
	// Serialize adoption and projection so two first sessions cannot race while
	// creating the same stable provider-owned directory.
	extensionRuntimeSharedDirsMu.Lock()
	defer extensionRuntimeSharedDirsMu.Unlock()

	for _, declared := range home.SharedDirs {
		rel := filepath.Clean(filepath.FromSlash(strings.TrimSpace(declared)))
		source := filepath.Join(sourceHome, rel)
		target := filepath.Join(sessionHome, rel)
		seedExtensionRuntimeSharedDirFromLegacySessions(input, home, rel, source)
		if err := exposeExtensionRuntimeSharedDir(source, target); err != nil {
			return fmt.Errorf("expose extension runtime shared dir %s: %w", declared, err)
		}
	}
	return nil
}

type extensionRuntimeLegacySharedDir struct {
	agentSessionID string
	path           string
	updatedAt      int64
}

// seedExtensionRuntimeSharedDirFromLegacySessions is an upgrade bridge for
// sessions created before sharedDirs existed. Those sessions may already hold
// an expensive provider-owned helper or cache while the newly created stable
// source directory is still empty. Only same-provider runtime roots with a
// manifest-owned extension home are eligible; symlink projections created by
// the new scheme are ignored.
func seedExtensionRuntimeSharedDirFromLegacySessions(
	input ProviderPrepareInput,
	home ExtensionRuntimeHome,
	sharedRel string,
	stableDir string,
) {
	if extensionRuntimeSharedDirHasEntries(stableDir) {
		return
	}
	candidates := extensionRuntimeLegacySharedDirCandidates(input, home, sharedRel)
	for _, candidate := range candidates {
		if err := mergeExtensionRuntimeSharedDir(candidate.path, stableDir); err != nil {
			slog.Warn("extension runtime legacy shared directory migration skipped",
				"event", "agent.runtime_prepare.extension_shared_dir.legacy_migration_skipped",
				"provider", strings.TrimSpace(input.Provider),
				"agent_session_id", strings.TrimSpace(input.AgentSessionID),
				"legacy_agent_session_id", candidate.agentSessionID,
				"shared_dir", filepath.ToSlash(sharedRel),
				"error", err,
			)
			continue
		}
		if !extensionRuntimeSharedDirHasEntries(stableDir) {
			continue
		}
		slog.Info("extension runtime legacy shared directory migrated",
			"event", "agent.runtime_prepare.extension_shared_dir.legacy_migrated",
			"provider", strings.TrimSpace(input.Provider),
			"agent_session_id", strings.TrimSpace(input.AgentSessionID),
			"legacy_agent_session_id", candidate.agentSessionID,
			"shared_dir", filepath.ToSlash(sharedRel),
		)
		return
	}
}

func extensionRuntimeSharedDirHasEntries(dir string) bool {
	entries, err := os.ReadDir(dir)
	return err == nil && len(entries) > 0
}

func extensionRuntimeLegacySharedDirCandidates(
	input ProviderPrepareInput,
	home ExtensionRuntimeHome,
	sharedRel string,
) []extensionRuntimeLegacySharedDir {
	currentRoot := filepath.Clean(strings.TrimSpace(input.RuntimeRoot))
	runsRoot := filepath.Dir(currentRoot)
	entries, err := os.ReadDir(runsRoot)
	if err != nil {
		return nil
	}

	provider := strings.TrimSpace(input.Provider)
	homeRel := filepath.Clean(filepath.FromSlash(strings.TrimSpace(home.DirName)))
	result := make([]extensionRuntimeLegacySharedDir, 0)
	for _, entry := range entries {
		if !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		candidateRoot := filepath.Join(runsRoot, entry.Name())
		if sameSharedRuntimePath(candidateRoot, currentRoot) {
			continue
		}
		content, err := os.ReadFile(filepath.Join(candidateRoot, SidecarManifestFileName))
		if err != nil {
			continue
		}
		var manifest Manifest
		if json.Unmarshal(content, &manifest) != nil || strings.TrimSpace(manifest.Provider) != provider {
			continue
		}
		if !sameSharedRuntimePath(strings.TrimSpace(manifest.RuntimeRoot), candidateRoot) {
			continue
		}
		candidateHome := filepath.Join(candidateRoot, homeRel)
		if !extensionRuntimeManifestOwnsHome(manifest, candidateHome) {
			continue
		}
		candidatePath := filepath.Join(candidateHome, sharedRel)
		info, err := os.Lstat(candidatePath)
		if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			continue
		}
		result = append(result, extensionRuntimeLegacySharedDir{
			agentSessionID: strings.TrimSpace(manifest.AgentSessionID),
			path:           candidatePath,
			updatedAt:      manifest.UpdatedAtUnixMS,
		})
	}
	sort.SliceStable(result, func(i, j int) bool {
		return result[i].updatedAt > result[j].updatedAt
	})
	return result
}

func extensionRuntimeManifestOwnsHome(manifest Manifest, homePath string) bool {
	for _, managed := range manifest.ManagedFiles {
		if strings.TrimSpace(managed.Kind) == "provider-extension-home" &&
			sameSharedRuntimePath(strings.TrimSpace(managed.Path), homePath) {
			return true
		}
	}
	return false
}

func exposeExtensionRuntimeSharedDir(source, target string) error {
	if same, err := sameResolvedPath(source, target); err == nil && same {
		return nil
	}

	targetInfo, targetErr := os.Lstat(target)
	if targetErr != nil && !os.IsNotExist(targetErr) {
		return fmt.Errorf("inspect session directory: %w", targetErr)
	}
	if targetErr == nil && targetInfo.Mode()&os.ModeSymlink != 0 {
		return errors.New("session directory points at an unexpected location")
	}
	if targetErr == nil && !targetInfo.IsDir() {
		return errors.New("session path is not a directory")
	}

	sourceInfo, sourceErr := os.Stat(source)
	if sourceErr != nil && !os.IsNotExist(sourceErr) {
		return fmt.Errorf("inspect stable directory: %w", sourceErr)
	}
	if sourceErr == nil && !sourceInfo.IsDir() {
		return errors.New("stable path is not a directory")
	}

	if targetErr == nil && os.IsNotExist(sourceErr) {
		if err := os.MkdirAll(filepath.Dir(source), 0o700); err != nil {
			return fmt.Errorf("create stable directory parent: %w", err)
		}
		if err := os.Rename(target, source); err == nil {
			targetErr = os.ErrNotExist
			sourceErr = nil
		} else if err := mergeExtensionRuntimeSharedDir(target, source); err != nil {
			return err
		}
	}
	if os.IsNotExist(sourceErr) {
		if err := os.MkdirAll(source, 0o700); err != nil {
			return fmt.Errorf("create stable directory: %w", err)
		}
	}
	if targetErr == nil {
		if err := mergeExtensionRuntimeSharedDir(target, source); err != nil {
			return err
		}
		if err := os.RemoveAll(target); err != nil {
			return fmt.Errorf("remove adopted session directory: %w", err)
		}
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return fmt.Errorf("create session directory parent: %w", err)
	}
	return exposeSharedRuntimeDirectory(source, target)
}

func sameResolvedPath(left, right string) (bool, error) {
	resolvedLeft, err := filepath.EvalSymlinks(left)
	if err != nil {
		return false, err
	}
	resolvedRight, err := filepath.EvalSymlinks(right)
	if err != nil {
		return false, err
	}
	return sameSharedRuntimePath(resolvedLeft, resolvedRight), nil
}

func mergeExtensionRuntimeSharedDir(source, target string) error {
	info, err := os.Stat(source)
	if err != nil {
		return fmt.Errorf("inspect session shared directory: %w", err)
	}
	if !info.IsDir() {
		return errors.New("session shared path is not a directory")
	}
	if err := os.MkdirAll(target, 0o700); err != nil {
		return fmt.Errorf("create stable shared directory: %w", err)
	}
	entries, err := os.ReadDir(source)
	if err != nil {
		return fmt.Errorf("read session shared directory: %w", err)
	}
	for _, entry := range entries {
		src := filepath.Join(source, entry.Name())
		dst := filepath.Join(target, entry.Name())
		entryInfo, err := os.Lstat(src)
		if err != nil {
			return fmt.Errorf("inspect session shared entry: %w", err)
		}
		if entryInfo.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("session shared directory contains a symlink: %s", src)
		}
		if entryInfo.IsDir() {
			if err := mergeExtensionRuntimeSharedDir(src, dst); err != nil {
				return err
			}
			continue
		}
		if !entryInfo.Mode().IsRegular() {
			return fmt.Errorf("session shared directory contains an unsupported entry: %s", src)
		}
		if _, err := os.Stat(dst); err == nil {
			continue
		} else if !os.IsNotExist(err) {
			return fmt.Errorf("inspect stable shared entry: %w", err)
		}
		content, err := os.ReadFile(src)
		if err != nil {
			return fmt.Errorf("read session shared entry: %w", err)
		}
		if err := os.WriteFile(dst, content, entryInfo.Mode().Perm()); err != nil {
			return fmt.Errorf("write stable shared entry: %w", err)
		}
	}
	return nil
}

const hermesRTKPluginPython = `"""Session-scoped RTK command rewriting for Hermes."""

import shutil
import subprocess
import sys


def register(ctx):
    if shutil.which("rtk") is None:
        print("rtk: hermes plugin disabled; executable not found", file=sys.stderr)
        return
    ctx.register_hook("pre_tool_call", _pre_tool_call)


def _pre_tool_call(tool_name=None, args=None, **_kwargs):
    if tool_name != "terminal" or not isinstance(args, dict):
        return
    command = args.get("command")
    if not isinstance(command, str) or not command.strip():
        return
    try:
        result = subprocess.run(
            ["rtk", "rewrite", command],
            shell=False,
            timeout=2,
            capture_output=True,
            text=True,
        )
    except Exception as exc:
        print(f"rtk: hermes rewrite failed: {exc}", file=sys.stderr)
        return
    if result.returncode not in {0, 3}:
        return
    rewritten = result.stdout.strip()
    if rewritten and rewritten != command:
        args["command"] = rewritten
`

const hermesRTKPluginManifest = `name: rtk-rewrite
version: "0.1.0"
description: Rewrite Hermes terminal commands through session-scoped RTK.
author: Tutti
hooks:
  - pre_tool_call
provides_hooks:
  - pre_tool_call
`

func prepareExtensionRTKIntegration(input ProviderPrepareInput, sessionHome string, home ExtensionRuntimeHome) error {
	if !input.RTKSaverMode || !strings.EqualFold(strings.TrimSpace(input.Provider), "acp:hermes") {
		return nil
	}
	pluginDir := filepath.Join(sessionHome, "plugins", "rtk-rewrite")
	if err := os.MkdirAll(pluginDir, 0o700); err != nil {
		return fmt.Errorf("create Hermes RTK plugin directory: %w", err)
	}
	if err := os.WriteFile(filepath.Join(pluginDir, "__init__.py"), []byte(hermesRTKPluginPython), 0o600); err != nil {
		return fmt.Errorf("write Hermes RTK plugin: %w", err)
	}
	if err := os.WriteFile(filepath.Join(pluginDir, "plugin.yaml"), []byte(hermesRTKPluginManifest), 0o600); err != nil {
		return fmt.Errorf("write Hermes RTK plugin manifest: %w", err)
	}
	configFile := strings.TrimSpace(home.ConfigFile)
	if configFile == "" {
		return errors.New("hermes RTK integration requires a session config file")
	}
	configPath := filepath.Join(sessionHome, filepath.FromSlash(configFile))
	config, err := os.ReadFile(configPath)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("read Hermes session config for RTK plugin: %w", err)
	}
	merged, err := mergeYAMLStringList(string(config), []string{"plugins", "enabled"}, []string{"rtk-rewrite"})
	if err != nil {
		return fmt.Errorf("enable Hermes RTK plugin: %w", err)
	}
	if err := os.WriteFile(configPath, []byte(merged), 0o600); err != nil {
		return fmt.Errorf("write Hermes session config with RTK plugin: %w", err)
	}
	return nil
}

func resolveExtensionRuntimeSourceHome(home ExtensionRuntimeHome) string {
	if sourceEnv := strings.TrimSpace(home.SourceEnvVar); sourceEnv != "" {
		if v := strings.TrimSpace(os.Getenv(sourceEnv)); v != "" {
			return v
		}
	}
	rel := strings.TrimSpace(home.SourceDefaultRel)
	if rel == "" {
		return ""
	}

	candidates := []string{}
	if platformHome := extensionRuntimePlatformSourceHome(rel); platformHome != "" {
		candidates = appendUniquePath(candidates, platformHome)
	}
	if userHome, err := os.UserHomeDir(); err == nil && userHome != "" {
		candidates = appendUniquePath(candidates, filepath.Join(userHome, filepath.FromSlash(rel)))
	}
	for _, candidate := range candidates {
		info, err := os.Stat(candidate)
		if err == nil && info.IsDir() {
			return candidate
		}
		if err != nil && !os.IsNotExist(err) {
			return candidate
		}
	}
	if len(candidates) > 0 {
		// Preserve the original default even when it has not been created yet.
		return candidates[0]
	}
	return ""
}

func copyExtensionRuntimeHomeFiles(sourceHome string, sessionHome string, home ExtensionRuntimeHome) ([]byte, error) {
	var config []byte
	if sourceHome == "" {
		return nil, nil
	}
	configFile := filepath.Clean(filepath.FromSlash(strings.TrimSpace(home.ConfigFile)))
	if configFile != "." && configFile != "" {
		data, err := os.ReadFile(filepath.Join(sourceHome, configFile))
		if err != nil && !os.IsNotExist(err) {
			return nil, fmt.Errorf("read extension runtime %s: %w", configFile, err)
		}
		if err == nil {
			config = data
		}
	}
	for _, file := range home.CopyFiles {
		name := filepath.Clean(filepath.FromSlash(strings.TrimSpace(file)))
		if name == configFile {
			continue
		}
		src := filepath.Join(sourceHome, name)
		if err := copyExtensionRuntimeHomeFile(src, filepath.Join(sessionHome, name)); err != nil {
			return nil, err
		}
	}
	return config, nil
}

func copyExtensionRuntimeHomeFile(src string, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read extension runtime %s: %w", filepath.Base(src), err)
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return fmt.Errorf("create extension runtime home subdir: %w", err)
	}
	return os.WriteFile(dst, data, 0o600)
}

func extensionRuntimeExternalDirs(input ProviderPrepareInput, sourceHome string, home ExtensionRuntimeHome) ([]string, error) {
	externalDirs := []string{}
	if home.IncludeSkillRoots {
		skillRoots, err := extensionRuntimeSkillRoots(input, input.ExtensionSkillRoots)
		if err != nil {
			return nil, err
		}
		if err := materializeExtensionRuntimeSkills(input, skillRoots, false); err != nil {
			return nil, err
		}
		for _, root := range skillRoots {
			externalDirs = appendUniquePath(externalDirs, root)
		}
	}
	if home.IncludeUserHomeDir && sourceHome != "" {
		userSkillDir := strings.TrimSpace(home.UserHomeSkillDir)
		if userSkillDir == "" {
			userSkillDir = "skills"
		}
		globalSkills := filepath.Join(sourceHome, filepath.FromSlash(userSkillDir))
		if info, err := os.Stat(globalSkills); err == nil && info.IsDir() {
			externalDirs = appendUniquePath(externalDirs, globalSkills)
		} else if err != nil && !os.IsNotExist(err) {
			return nil, fmt.Errorf("inspect extension runtime user skill dir: %w", err)
		}
	}
	return externalDirs, nil
}

func extensionRuntimeSkillRoots(input ProviderPrepareInput, declaredRoots []string) ([]string, error) {
	roots := make([]string, 0, len(declaredRoots))
	for _, root := range declaredRoots {
		root = strings.TrimSpace(root)
		if root == "" {
			continue
		}
		if err := validateExtensionRuntimeRelPath(root, "extension runtime skill root"); err != nil {
			return nil, err
		}
		root = filepath.Clean(filepath.FromSlash(root))
		roots = appendUniquePath(roots, filepath.Join(input.RuntimeRoot, "extension-skills", root))
	}
	return roots, nil
}

func materializeExtensionRuntimeSkills(input ProviderPrepareInput, roots []string, fallback bool) error {
	skillRoots := append([]string(nil), roots...)
	if len(skillRoots) == 0 && fallback {
		if root := providerSkillRoot(input.Cwd, input.Provider); root != "" {
			skillRoots = []string{root}
		}
	}
	for _, skillRoot := range skillRoots {
		if !filepath.IsAbs(skillRoot) {
			skillRoot = filepath.Join(input.Cwd, skillRoot)
		}
		skillPaths, err := installProviderNativeSkillsStable(skillRoot, input.PrepareInput)
		if err != nil {
			return err
		}
		if input.Manifest != nil {
			for _, skillPath := range skillPaths {
				input.Manifest.RecordManagedFile(skillPath, "provider-skill", true)
			}
		}
	}
	return nil
}

func writeExtensionRuntimeConfig(path string, userConfig []byte, externalDirs []string, home ExtensionRuntimeHome) error {
	if strings.TrimSpace(home.ConfigFile) == "" {
		return nil
	}
	config := string(userConfig)
	if len(home.ExternalDirsKey) > 0 {
		var err error
		config, err = mergeYAMLStringList(config, home.ExternalDirsKey, externalDirs)
		if err != nil {
			return err
		}
	}
	if strings.TrimSpace(config) == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create extension runtime config dir: %w", err)
	}
	if err := os.WriteFile(path, []byte(config), 0o600); err != nil {
		return fmt.Errorf("write extension runtime config: %w", err)
	}
	return nil
}

func ValidateExtensionRuntimePrep(prep ExtensionRuntimePrep) error {
	if file := strings.TrimSpace(prep.InstructionsFile); file != "" {
		if err := validateExtensionRuntimeRelPath(file, "extension runtime instructions file"); err != nil {
			return err
		}
	}
	if prep.Home == nil {
		return nil
	}
	home := *prep.Home
	if !extensionRuntimeEnvName.MatchString(strings.TrimSpace(home.EnvVar)) {
		return errors.New("extension runtime home env is unsupported")
	}
	if err := validateExtensionRuntimeRelPath(home.DirName, "extension runtime home dir"); err != nil {
		return err
	}
	if sourceEnv := strings.TrimSpace(home.SourceEnvVar); sourceEnv != "" && !extensionRuntimeEnvName.MatchString(sourceEnv) {
		return errors.New("extension runtime source env is unsupported")
	}
	if sourceRel := strings.TrimSpace(home.SourceDefaultRel); sourceRel != "" {
		if err := validateExtensionRuntimeRelPath(sourceRel, "extension runtime source default path"); err != nil {
			return err
		}
	}
	if strings.TrimSpace(home.ConfigFormat) != "" && strings.TrimSpace(home.ConfigFormat) != "yaml" {
		return errors.New("extension runtime config format is unsupported")
	}
	for _, file := range home.CopyFiles {
		if err := validateExtensionRuntimeRelPath(file, "extension runtime copy file"); err != nil {
			return err
		}
	}
	for _, dir := range home.SharedDirs {
		if err := validateExtensionRuntimeRelPath(dir, "extension runtime shared dir"); err != nil {
			return err
		}
	}
	if configFile := strings.TrimSpace(home.ConfigFile); configFile != "" {
		if err := validateExtensionRuntimeRelPath(configFile, "extension runtime config file"); err != nil {
			return err
		}
	}
	if len(home.ExternalDirsKey) > 0 && !slices.Equal(home.ExternalDirsKey, []string{"skills", "external_dirs"}) {
		return errors.New("extension runtime external dirs key is unsupported")
	}
	if userSkillDir := strings.TrimSpace(home.UserHomeSkillDir); userSkillDir != "" {
		if err := validateExtensionRuntimeRelPath(userSkillDir, "extension runtime user skill dir"); err != nil {
			return err
		}
	}
	return validateExtensionRuntimeHomePathConflicts(home)
}

func validateExtensionRuntimeHomePathConflicts(home ExtensionRuntimeHome) error {
	files := append([]string(nil), home.CopyFiles...)
	if configFile := strings.TrimSpace(home.ConfigFile); configFile != "" {
		files = append(files, configFile)
	}
	seen := map[string]bool{}
	for _, sharedDir := range home.SharedDirs {
		sharedDir = filepath.Clean(filepath.FromSlash(strings.TrimSpace(sharedDir)))
		for existing := range seen {
			if extensionRuntimePathsOverlap(existing, sharedDir) {
				return fmt.Errorf("extension runtime shared dirs overlap: %s and %s", existing, sharedDir)
			}
		}
		seen[sharedDir] = true
		for _, file := range files {
			file = filepath.Clean(filepath.FromSlash(strings.TrimSpace(file)))
			if extensionRuntimePathsOverlap(sharedDir, file) {
				return fmt.Errorf("extension runtime shared dir %s conflicts with copied file %s", sharedDir, file)
			}
		}
	}
	return nil
}

func extensionRuntimePathsOverlap(left, right string) bool {
	return left == right || strings.HasPrefix(left, right+string(filepath.Separator)) || strings.HasPrefix(right, left+string(filepath.Separator))
}

func validateExtensionRuntimeRelPath(value string, label string) error {
	trimmed := strings.TrimSpace(value)
	portable := strings.ReplaceAll(trimmed, `\`, "/")
	cleaned := filepath.Clean(filepath.FromSlash(trimmed))
	// Runtime descriptors use slash-separated paths, so reject absolute
	// spellings from both the descriptor syntax and the host OS.
	if cleaned == "." || cleaned == "" || isPortableAbsolutePath(trimmed, portable) || cleaned == ".." || strings.HasPrefix(cleaned, ".."+string(filepath.Separator)) {
		return fmt.Errorf("%s must be a safe relative path", label)
	}
	return nil
}

func isPortableAbsolutePath(trimmed, portable string) bool {
	return filepath.IsAbs(filepath.FromSlash(trimmed)) || path.IsAbs(portable) || portableDrivePath(portable)
}

func portableDrivePath(value string) bool {
	return len(value) >= 2 && value[1] == ':' &&
		((value[0] >= 'a' && value[0] <= 'z') || (value[0] >= 'A' && value[0] <= 'Z'))
}

func appendUniquePath(paths []string, path string) []string {
	path = filepath.Clean(strings.TrimSpace(path))
	if path == "." || path == "" {
		return paths
	}
	if slices.Contains(paths, path) {
		return paths
	}
	return append(paths, path)
}
