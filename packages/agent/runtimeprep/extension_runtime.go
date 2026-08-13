package runtimeprep

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

var extensionRuntimeEnvName = regexp.MustCompile(`^[A-Z_][A-Z0-9_]*$`)

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
	if input.Manifest != nil {
		input.Manifest.RecordManagedFile(sessionHome, "provider-extension-home", true)
	}
	return strings.TrimSpace(home.EnvVar) + "=" + sessionHome, nil
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
	return nil
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
