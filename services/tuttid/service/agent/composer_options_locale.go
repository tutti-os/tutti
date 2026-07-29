package agent

import (
	"embed"
	"encoding/json"
	"strings"
	"sync"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
)

//go:embed locales/*.json
var composerOptionLocaleFS embed.FS

type composerOptionLocaleCatalog struct {
	PermissionModes     map[string]map[string]composerOptionDisplayText `json:"permissionModes"`
	PermissionSemantics map[string]composerOptionDisplayText            `json:"permissionSemantics"`
	Reasoning           map[string]composerOptionDisplayText            `json:"reasoning"`
	Speed               map[string]composerOptionDisplayText            `json:"speed"`
}

type composerOptionDisplayText struct {
	Description string `json:"description"`
	Label       string `json:"label"`
}

var composerOptionLocaleCatalogs sync.Map

func reasoningEffortLabel(value string, locale string) string {
	label, _ := reasoningEffortDisplay(value, locale, "")
	return label
}

func reasoningEffortDisplay(value string, locale string, fallbackDescription string) (string, string) {
	value = strings.TrimSpace(value)
	catalog := composerOptionLocaleCatalogFor(locale)
	text, ok := catalog.Reasoning[value]
	label := value
	description := strings.TrimSpace(fallbackDescription)
	if ok {
		if localizedLabel := strings.TrimSpace(text.Label); localizedLabel != "" {
			label = localizedLabel
		}
		if localizedDescription := strings.TrimSpace(text.Description); localizedDescription != "" {
			description = localizedDescription
		}
	}
	return label, description
}

func speedDisplay(value string, locale string) (string, string) {
	value = strings.TrimSpace(value)
	catalog := composerOptionLocaleCatalogFor(locale)
	if text, ok := catalog.Speed[value]; ok && strings.TrimSpace(text.Label) != "" {
		return strings.TrimSpace(text.Label), strings.TrimSpace(text.Description)
	}
	return value, ""
}

func permissionModeDisplay(provider string, id string, semantic PermissionModeSemantic, locale string) (string, string) {
	provider = agentprovider.Normalize(provider)
	id = strings.TrimSpace(id)
	catalog := composerOptionLocaleCatalogFor(locale)
	if providerModes, ok := catalog.PermissionModes[provider]; ok {
		if text, ok := providerModes[id]; ok && strings.TrimSpace(text.Label) != "" {
			return strings.TrimSpace(text.Label), strings.TrimSpace(text.Description)
		}
	}
	if text, ok := catalog.PermissionSemantics[string(semantic)]; ok && strings.TrimSpace(text.Label) != "" {
		return strings.TrimSpace(text.Label), strings.TrimSpace(text.Description)
	}
	return id, ""
}

func composerOptionLocaleCatalogFor(locale string) composerOptionLocaleCatalog {
	locale = normalizeComposerLocale(locale)
	if value, ok := composerOptionLocaleCatalogs.Load(locale); ok {
		return value.(composerOptionLocaleCatalog)
	}
	catalog := loadComposerOptionLocaleCatalog(locale)
	if locale != preferencesbiz.DefaultDesktopLocale {
		catalog = mergeComposerOptionLocaleCatalogs(
			loadComposerOptionLocaleCatalog(preferencesbiz.DefaultDesktopLocale),
			catalog,
		)
	}
	composerOptionLocaleCatalogs.Store(locale, catalog)
	return catalog
}

func loadComposerOptionLocaleCatalog(locale string) composerOptionLocaleCatalog {
	data, err := composerOptionLocaleFS.ReadFile("locales/" + normalizeComposerLocale(locale) + ".json")
	if err != nil {
		return composerOptionLocaleCatalog{}
	}
	var catalog composerOptionLocaleCatalog
	if err := json.Unmarshal(data, &catalog); err != nil {
		return composerOptionLocaleCatalog{}
	}
	return catalog
}

func mergeComposerOptionLocaleCatalogs(base composerOptionLocaleCatalog, override composerOptionLocaleCatalog) composerOptionLocaleCatalog {
	return composerOptionLocaleCatalog{
		PermissionModes: mergeNestedDisplayTextMap(base.PermissionModes, override.PermissionModes),
		PermissionSemantics: mergeDisplayTextMap(
			base.PermissionSemantics,
			override.PermissionSemantics,
		),
		Reasoning: mergeDisplayTextMap(base.Reasoning, override.Reasoning),
		Speed:     mergeDisplayTextMap(base.Speed, override.Speed),
	}
}

func mergeNestedDisplayTextMap(
	base map[string]map[string]composerOptionDisplayText,
	override map[string]map[string]composerOptionDisplayText,
) map[string]map[string]composerOptionDisplayText {
	result := make(map[string]map[string]composerOptionDisplayText, len(base)+len(override))
	for key, values := range base {
		result[key] = mergeDisplayTextMap(values, nil)
	}
	for key, values := range override {
		result[key] = mergeDisplayTextMap(result[key], values)
	}
	return result
}

func mergeDisplayTextMap(
	base map[string]composerOptionDisplayText,
	override map[string]composerOptionDisplayText,
) map[string]composerOptionDisplayText {
	result := make(map[string]composerOptionDisplayText, len(base)+len(override))
	for key, value := range base {
		result[key] = value
	}
	for key, value := range override {
		result[key] = value
	}
	return result
}

func normalizeComposerLocale(value string) string {
	value = strings.TrimSpace(value)
	if preferencesbiz.IsDesktopLocale(value) {
		return value
	}
	return preferencesbiz.DefaultDesktopLocale
}
