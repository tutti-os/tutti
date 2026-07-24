package agentstatus

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var (
	openCodeEnvReference  = regexp.MustCompile(`\{env:([^}]+)\}`)
	openCodeFileReference = regexp.MustCompile(`\{file:([^}]+)\}`)
)

type openCodeProviderOption struct {
	sourceDir string
	value     string
}

// openCodeConfigHasAPICredential checks the same global and explicit config
// sources OpenCode can use without a workspace cwd. Project-local config is
// intentionally excluded because provider readiness is shared across
// workspaces and cannot safely resolve one project's precedence here.
func (s Service) openCodeConfigHasAPICredential() bool {
	options := s.openCodeProviderOptions()
	for _, option := range options["apiKey"] {
		if value, valid := s.resolveOpenCodeConfigValue(option); valid &&
			strings.TrimSpace(value) != "" {
			return true
		}
	}
	return false
}

func (s Service) openCodeConfigDeclaresProviderOption(keys ...string) bool {
	options := s.openCodeProviderOptions()
	for _, key := range keys {
		for _, option := range options[key] {
			if value, valid := s.resolveOpenCodeConfigValue(option); valid &&
				strings.TrimSpace(value) != "" {
				return true
			}
		}
	}
	return false
}

// openCodeProviderOptions applies OpenCode's merge order for provider options:
// legacy global JSON, global JSON, global JSONC, an explicit config path, an
// explicit config directory, then inline config. A later declaration for the
// same provider and option replaces the earlier one.
func (s Service) openCodeProviderOptions() map[string]map[string]openCodeProviderOption {
	byOption := make(map[string]map[string]openCodeProviderOption)
	applyFile := func(path string) {
		content, err := os.ReadFile(path)
		if err != nil {
			return
		}
		applyOpenCodeProviderOptions(byOption, content, filepath.Dir(path))
	}

	if configDir := s.openCodeGlobalConfigDir(); configDir != "" {
		for _, name := range []string{"config.json", "opencode.json", "opencode.jsonc"} {
			applyFile(filepath.Join(configDir, name))
		}
	}
	if path := strings.TrimSpace(s.lookupEnv("OPENCODE_CONFIG")); path != "" {
		applyFile(expandOpenCodeHomePath(path, s.openCodeHomeDir()))
	}
	if configDir := strings.TrimSpace(s.lookupEnv("OPENCODE_CONFIG_DIR")); configDir != "" {
		configDir = expandOpenCodeHomePath(configDir, s.openCodeHomeDir())
		for _, name := range []string{"opencode.json", "opencode.jsonc"} {
			applyFile(filepath.Join(configDir, name))
		}
	}
	if content := strings.TrimSpace(s.lookupEnv("OPENCODE_CONFIG_CONTENT")); content != "" {
		applyOpenCodeProviderOptions(byOption, []byte(content), "")
	}
	return byOption
}

func applyOpenCodeProviderOptions(
	byOption map[string]map[string]openCodeProviderOption,
	content []byte,
	sourceDir string,
) {
	var parsed struct {
		Provider map[string]struct {
			Options map[string]json.RawMessage `json:"options"`
		} `json:"provider"`
	}
	if err := json.Unmarshal(normalizeOpenCodeJSONC(content), &parsed); err != nil {
		return
	}
	for providerID, provider := range parsed.Provider {
		for optionName, raw := range provider.Options {
			var value string
			if err := json.Unmarshal(raw, &value); err != nil {
				value = ""
			}
			providers := byOption[optionName]
			if providers == nil {
				providers = make(map[string]openCodeProviderOption)
				byOption[optionName] = providers
			}
			providers[providerID] = openCodeProviderOption{
				sourceDir: sourceDir,
				value:     value,
			}
		}
	}
}

func (s Service) resolveOpenCodeConfigValue(option openCodeProviderOption) (string, bool) {
	value := openCodeEnvReference.ReplaceAllStringFunc(option.value, func(match string) string {
		parts := openCodeEnvReference.FindStringSubmatch(match)
		if len(parts) != 2 {
			return ""
		}
		return s.lookupEnv(parts[1])
	})
	valid := true
	value = openCodeFileReference.ReplaceAllStringFunc(value, func(match string) string {
		parts := openCodeFileReference.FindStringSubmatch(match)
		if len(parts) != 2 {
			valid = false
			return ""
		}
		path := expandOpenCodeHomePath(strings.TrimSpace(parts[1]), s.openCodeHomeDir())
		if path == "" {
			valid = false
			return ""
		}
		if !filepath.IsAbs(path) {
			if option.sourceDir == "" {
				valid = false
				return ""
			}
			path = filepath.Join(option.sourceDir, path)
		}
		content, err := os.ReadFile(path)
		if err != nil {
			valid = false
			return ""
		}
		return strings.TrimSpace(string(content))
	})
	return value, valid
}

func (s Service) openCodeGlobalConfigDir() string {
	if root := strings.TrimSpace(s.lookupEnv("XDG_CONFIG_HOME")); root != "" {
		return filepath.Join(root, "opencode")
	}
	if home := s.openCodeHomeDir(); home != "" {
		return filepath.Join(home, ".config", "opencode")
	}
	return ""
}

func (s Service) openCodeHomeDir() string {
	home, err := s.homeDir()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(home)
}

func expandOpenCodeHomePath(path string, home string) string {
	path = strings.TrimSpace(path)
	if path == "~" {
		return home
	}
	if strings.HasPrefix(path, "~/") && home != "" {
		return filepath.Join(home, strings.TrimPrefix(path, "~/"))
	}
	return path
}

// normalizeOpenCodeJSONC removes comments and trailing commas while preserving
// quoted strings. OpenCode accepts both JSON and JSONC for all config sources.
func normalizeOpenCodeJSONC(content []byte) []byte {
	withoutComments := make([]byte, 0, len(content))
	inString := false
	escaped := false
	for index := 0; index < len(content); index++ {
		current := content[index]
		if inString {
			withoutComments = append(withoutComments, current)
			if escaped {
				escaped = false
			} else if current == '\\' {
				escaped = true
			} else if current == '"' {
				inString = false
			}
			continue
		}
		if current == '"' {
			inString = true
			withoutComments = append(withoutComments, current)
			continue
		}
		if current == '/' && index+1 < len(content) {
			next := content[index+1]
			if next == '/' {
				index += 2
				for index < len(content) && content[index] != '\n' && content[index] != '\r' {
					index++
				}
				if index < len(content) {
					withoutComments = append(withoutComments, content[index])
				}
				continue
			}
			if next == '*' {
				index += 2
				for index+1 < len(content) && (content[index] != '*' || content[index+1] != '/') {
					if content[index] == '\n' || content[index] == '\r' {
						withoutComments = append(withoutComments, content[index])
					}
					index++
				}
				if index+1 < len(content) {
					index++
				}
				continue
			}
		}
		withoutComments = append(withoutComments, current)
	}

	normalized := make([]byte, 0, len(withoutComments))
	inString = false
	escaped = false
	for index := 0; index < len(withoutComments); index++ {
		current := withoutComments[index]
		if inString {
			normalized = append(normalized, current)
			if escaped {
				escaped = false
			} else if current == '\\' {
				escaped = true
			} else if current == '"' {
				inString = false
			}
			continue
		}
		if current == '"' {
			inString = true
			normalized = append(normalized, current)
			continue
		}
		if current == ',' {
			next := index + 1
			for next < len(withoutComments) &&
				(withoutComments[next] == ' ' || withoutComments[next] == '\t' ||
					withoutComments[next] == '\n' || withoutComments[next] == '\r') {
				next++
			}
			if next < len(withoutComments) &&
				(withoutComments[next] == '}' || withoutComments[next] == ']') {
				continue
			}
		}
		normalized = append(normalized, current)
	}
	return normalized
}
