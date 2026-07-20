package preferences

// Lab feature flag keys. This registry is the daemon-side key contract for
// Lab experiments: it carries keys and defaults only, never semantics. Each
// feature owns what "off" means; the renderer mirror lives in
// apps/desktop/src/shared/featureFlags/catalog.ts and must carry identical
// keys and defaults. See docs/conventions/feature-flags.md.
const (
	LabFlagTuttiMode       = "lab.tuttiMode"
	LabFlagModelPlans      = "lab.modelPlans"
	LabFlagWorkspaceAgents = "lab.workspaceAgents"
	LabFlagAutomationRules = "lab.automationRules"
)

// labFlagDefaults is fail-closed: every Lab flag defaults to off.
var labFlagDefaults = map[string]bool{
	LabFlagTuttiMode:       false,
	LabFlagModelPlans:      false,
	LabFlagWorkspaceAgents: false,
	LabFlagAutomationRules: false,
}

// IsLabFlag reports whether key is a registered Lab flag.
func IsLabFlag(key string) bool {
	_, ok := labFlagDefaults[key]
	return ok
}

// LabFlagDefault returns the registered default for a Lab flag.
func LabFlagDefault(key string) (bool, bool) {
	defaultValue, ok := labFlagDefaults[key]
	return defaultValue, ok
}

// IsLabFlagEnabled resolves a flag against stored desktop feature flags.
// A stored value wins; absent keys fall back to the registry default
// (fail-closed), and absent unregistered keys resolve to false. This mirrors
// the renderer isFeatureEnabled resolution in
// apps/desktop/src/shared/featureFlags/catalog.ts.
func IsLabFlagEnabled(flags map[string]bool, key string) bool {
	if enabled, ok := flags[key]; ok {
		return enabled
	}
	return labFlagDefaults[key]
}
