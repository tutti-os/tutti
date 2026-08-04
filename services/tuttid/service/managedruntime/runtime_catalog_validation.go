package managedruntime

import (
	"fmt"
	"path/filepath"
	"runtime"
	"strings"
	"unicode"
)

func validateManagedAppRuntimeCatalogEntry(platform string, entry appRuntimeCatalogEntry) error {
	if strings.TrimSpace(platform) == "" {
		return fmt.Errorf("managed app runtime catalog contains an empty platform")
	}
	if strings.TrimSpace(entry.Version) == "" {
		return fmt.Errorf("managed app runtime catalog platform %q version is required", platform)
	}
	if len(entry.Components) == 0 {
		return fmt.Errorf("managed app runtime catalog platform %q has no components", platform)
	}
	for name, component := range entry.Components {
		if strings.TrimSpace(name) == "" {
			return fmt.Errorf("managed app runtime catalog platform %q contains an empty component", platform)
		}
		if err := validateManagedAppRuntimeCatalogComponent(platform, name, component); err != nil {
			return err
		}
	}
	if _, err := appRuntimeProfileComponentNames(entry, appRuntimeBaselineProfile); err != nil {
		return fmt.Errorf("managed app runtime catalog platform %q: %w", platform, err)
	}
	for profileName := range entry.Profiles {
		if _, err := appRuntimeProfileComponentNames(entry, profileName); err != nil {
			return fmt.Errorf("managed app runtime catalog platform %q: %w", platform, err)
		}
	}
	return nil
}

func appRuntimeProfileComponentNames(entry appRuntimeCatalogEntry, profile string) ([]string, error) {
	profile = strings.TrimSpace(profile)
	if profile == "" {
		return nil, fmt.Errorf("managed app runtime profile is required")
	}
	components, ok := entry.Profiles[profile]
	if !ok || len(components) == 0 {
		if profile == appRuntimeNodeStaticProfile {
			if _, ok := entry.Components["node"]; ok {
				return []string{"node"}, nil
			}
		}
		if profile != appRuntimeBaselineProfile {
			return nil, fmt.Errorf("managed app runtime profile %q is required", profile)
		}
		return nil, fmt.Errorf("managed app runtime baseline profile is required")
	}
	seen := map[string]struct{}{}
	names := make([]string, 0, len(components))
	for _, componentName := range components {
		name := strings.TrimSpace(componentName)
		if name == "" {
			return nil, fmt.Errorf("managed app runtime profile %q contains an empty component", profile)
		}
		if _, ok := seen[name]; ok {
			return nil, fmt.Errorf("managed app runtime profile %q contains duplicate component %q", profile, name)
		}
		seen[name] = struct{}{}
		if _, ok := entry.Components[name]; !ok {
			return nil, fmt.Errorf("managed app runtime profile %q references missing component %q", profile, name)
		}
		names = append(names, name)
	}
	return names, nil
}

func validateManagedAppRuntimeCatalogComponent(platform string, name string, component appRuntimeCatalogComponent) error {
	if strings.TrimSpace(component.Version) == "" {
		return fmt.Errorf("managed app runtime catalog platform %q component %q version is required", platform, name)
	}
	if strings.TrimSpace(component.ArtifactURL) == "" || strings.TrimSpace(component.ArtifactSHA256) == "" {
		return fmt.Errorf("managed app runtime catalog platform %q component %q artifact url and sha256 are required", platform, name)
	}
	if !isSHA256Hex(component.ArtifactSHA256) {
		return fmt.Errorf("managed app runtime catalog platform %q component %q artifact sha256 is invalid", platform, name)
	}
	return nil
}

func isSHA256Hex(value string) bool {
	trimmed := strings.TrimSpace(value)
	if len(trimmed) != 64 {
		return false
	}
	for _, char := range trimmed {
		if !unicode.IsDigit(char) && (char < 'a' || char > 'f') && (char < 'A' || char > 'F') {
			return false
		}
	}
	return true
}

func safeAppRuntimeComponentName(value string) string {
	var builder strings.Builder
	for _, char := range strings.TrimSpace(value) {
		switch {
		case unicode.IsLetter(char), unicode.IsDigit(char), char == '-', char == '_':
			builder.WriteRune(char)
		default:
			builder.WriteByte('-')
		}
	}
	if builder.Len() == 0 {
		return "component"
	}
	return builder.String()
}

func envValue(env []string, key string) string {
	for i := len(env) - 1; i >= 0; i-- {
		candidateKey, value, ok := strings.Cut(env[i], "=")
		if ok && strings.EqualFold(candidateKey, key) {
			return value
		}
	}
	return ""
}

func mergeAppPathDirs(dirs []string) []string {
	result := make([]string, 0, len(dirs))
	seen := map[string]struct{}{}
	for _, dir := range dirs {
		trimmed := strings.TrimSpace(dir)
		if trimmed == "" {
			continue
		}
		key := filepath.Clean(trimmed)
		if runtime.GOOS == "windows" {
			key = strings.ToLower(key)
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, trimmed)
	}
	return result
}
