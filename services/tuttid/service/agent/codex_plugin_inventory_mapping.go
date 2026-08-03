package agent

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// This file owns the strict, local Plugin -> Skill proof used solely for
// Slash presentation. It deliberately does not affect authoritative Skill
// discovery or prompt injection.
func parseCodexPluginInventory(raw json.RawMessage) ([]codexPluginInventoryRecord, []string) {
	var response struct {
		Marketplaces []struct {
			Name    string           `json:"name"`
			Path    string           `json:"path"`
			Plugins []map[string]any `json:"plugins"`
		} `json:"marketplaces"`
		MarketplaceLoadErrors []map[string]any `json:"marketplaceLoadErrors"`
	}
	if json.Unmarshal(raw, &response) != nil {
		return nil, []string{"plugin/list response is invalid"}
	}
	bySemantic := make(map[string]codexPluginInventoryRecord, 3)
	ambiguous := make(map[string]bool, 3)
	for _, marketplace := range response.Marketplaces {
		for _, plugin := range marketplace.Plugins {
			pluginID := firstNonEmptyString(codexTextValue(plugin, "id"), codexTextValue(plugin, "pluginId"))
			pluginName := firstNonEmptyString(codexTextValue(plugin, "pluginName"), codexTextValue(plugin, "name"))
			if pluginID == "" {
				pluginID = pluginName + "@" + strings.TrimSpace(marketplace.Name)
			}
			semantic := codexPluginSemantic(pluginID)
			if semantic == "" {
				continue
			}
			source := codexNestedMap(plugin, "source")
			sourceType := strings.ToLower(codexTextValue(source, "type"))
			sourceRoot := ""
			if sourceType == "local" {
				sourceRoot = codexTextValue(source, "path")
			}
			pluginInterface := codexNestedMap(plugin, "interface")
			record := codexPluginInventoryRecord{
				option: ComposerPluginOption{
					ID:          "plugin:" + pluginID,
					Name:        pluginName,
					Label:       firstNonEmptyString(codexTextValue(pluginInterface, "displayName"), pluginName),
					Description: firstNonEmptyString(codexTextValue(pluginInterface, "shortDescription"), codexTextValue(plugin, "description"), codexTextValue(plugin, "summary")),
					Semantic:    semantic,
					Status:      codexPluginStatus(plugin),
				},
				pluginID:              pluginID,
				pluginName:            pluginName,
				marketplacePath:       strings.TrimSpace(marketplace.Path),
				remoteMarketplaceName: strings.TrimSpace(marketplace.Name),
				marketplaceIsRemote:   sourceType == "remote",
				sourceRoot:            sourceRoot,
			}
			if _, alreadyPresent := bySemantic[semantic]; alreadyPresent {
				delete(bySemantic, semantic)
				ambiguous[semantic] = true
				continue
			}
			if !ambiguous[semantic] {
				bySemantic[semantic] = record
			}
		}
	}
	records := make([]codexPluginInventoryRecord, 0, len(bySemantic))
	for _, semantic := range []string{"browserUse", "computerUse", "sites"} {
		if record, ok := bySemantic[semantic]; ok {
			records = append(records, record)
		}
	}
	if codexPluginInventoryHasNativeMarketplaceLoadError(response.MarketplaceLoadErrors) {
		return mergeUnknownCodexPluginInventoryRecords(records), []string{"native plugin marketplace failed to load"}
	}
	return mergeUnknownCodexPluginInventoryRecords(records), nil
}

func codexPluginInventoryHasNativeMarketplaceLoadError(errors []map[string]any) bool {
	for _, loadError := range errors {
		for _, value := range loadError {
			text := strings.ToLower(strings.TrimSpace(fmt.Sprint(value)))
			if strings.Contains(text, "openai-bundled") ||
				strings.Contains(text, "browser@openai-bundled") ||
				strings.Contains(text, "computer-use@openai-bundled") ||
				strings.Contains(text, "sites@openai-bundled") {
				return true
			}
		}
	}
	return false
}

func codexPluginSemantic(id string) string {
	switch strings.ToLower(strings.TrimSpace(id)) {
	case "computer-use@openai-bundled":
		return "computerUse"
	case "browser@openai-bundled":
		return "browserUse"
	case "sites@openai-bundled":
		return "sites"
	default:
		return ""
	}
}

func codexPluginStatus(plugin map[string]any) ComposerPluginStatus {
	if strings.EqualFold(codexTextValue(plugin, "availability"), "DISABLED_BY_ADMIN") {
		return ComposerPluginStatusDisabledByAdmin
	}
	if strings.EqualFold(codexTextValue(plugin, "installPolicy"), "NOT_AVAILABLE") {
		return ComposerPluginStatusUnsupported
	}
	if installed, known := codexBoolValue(plugin, "installed"); known && !installed {
		return ComposerPluginStatusNotInstalled
	}
	if enabled, known := codexBoolValue(plugin, "enabled"); known && !enabled {
		return ComposerPluginStatusDisabled
	}
	return ComposerPluginStatusReady
}

func eligibleCodexPluginRead(record codexPluginInventoryRecord) bool {
	return record.option.Status == ComposerPluginStatusReady &&
		strings.TrimSpace(record.pluginName) != "" &&
		((strings.TrimSpace(record.marketplacePath) != "" && strings.TrimSpace(record.sourceRoot) != "") ||
			(record.marketplaceIsRemote && strings.TrimSpace(record.remoteMarketplaceName) != ""))
}

func verifyCodexPluginReadMapping(raw json.RawMessage, record codexPluginInventoryRecord) ([]ComposerPluginBundledSkill, bool) {
	var response struct {
		Plugin struct {
			MarketplacePath string `json:"marketplacePath"`
			Summary         struct {
				ID     string `json:"id"`
				Name   string `json:"name"`
				Source struct {
					Type string `json:"type"`
					Path string `json:"path"`
				} `json:"source"`
			} `json:"summary"`
			Skills []struct {
				Enabled bool   `json:"enabled"`
				Name    string `json:"name"`
				Path    string `json:"path"`
			} `json:"skills"`
		} `json:"plugin"`
	}
	if json.Unmarshal(raw, &response) != nil ||
		strings.TrimSpace(response.Plugin.MarketplacePath) != record.marketplacePath ||
		strings.TrimSpace(response.Plugin.Summary.ID) != record.pluginID ||
		strings.TrimSpace(response.Plugin.Summary.Name) != record.pluginName ||
		!strings.EqualFold(strings.TrimSpace(response.Plugin.Summary.Source.Type), "local") ||
		strings.TrimSpace(response.Plugin.Summary.Source.Path) != record.sourceRoot {
		return nil, false
	}
	root, ok := canonicalLocalPluginRoot(record.sourceRoot)
	if !ok {
		return nil, false
	}
	summaryRoot, ok := canonicalLocalPluginRoot(response.Plugin.Summary.Source.Path)
	if !ok || summaryRoot != root {
		return nil, false
	}
	seen := map[string]struct{}{}
	skills := make([]ComposerPluginBundledSkill, 0, len(response.Plugin.Skills))
	for _, skill := range response.Plugin.Skills {
		name := strings.TrimSpace(skill.Name)
		if !skill.Enabled || name == "" {
			return nil, false
		}
		path, ok := canonicalLocalPluginPath(skill.Path)
		if !ok || !isPathWithin(root, path) {
			return nil, false
		}
		identity := name + "\x00" + path
		if _, duplicate := seen[identity]; duplicate {
			return nil, false
		}
		seen[identity] = struct{}{}
		skills = append(skills, ComposerPluginBundledSkill{Name: name, Path: path})
	}
	return skills, true
}

func canonicalLocalPluginPath(path string) (string, bool) {
	if !filepath.IsAbs(strings.TrimSpace(path)) {
		return "", false
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", false
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", false
	}
	return filepath.Clean(resolved), true
}

func canonicalLocalPluginRoot(path string) (string, bool) {
	root, ok := canonicalLocalPluginPath(path)
	if !ok {
		return "", false
	}
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		return "", false
	}
	return root, true
}

func isPathWithin(root string, path string) bool {
	relative, err := filepath.Rel(root, path)
	if err != nil || relative == "." || relative == ".." {
		return false
	}
	return !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
}
