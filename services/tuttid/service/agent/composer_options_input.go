package agent

import modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"

type ComposerOptionsInput struct {
	AgentTargetID            string
	Cwd                      string
	Locale                   string
	Provider                 string
	WorkspaceID              string
	Settings                 ComposerSettings
	IncludeCapabilityCatalog *bool
	// ResolvedModelPlan is a daemon-only exact plan override supplied by a
	// WorkspaceAgent resolver. It may contain a credential and must never be
	// serialized into runtime context or transport responses.
	ResolvedModelPlan *modelplanbiz.Plan
	// IgnoreModelPlanBinding forces provider-native credentials and model
	// discovery for internal probes and subscription checks that must not
	// inherit the workspace target binding. It is daemon-only and must not be
	// exposed as a user-facing session setting.
	IgnoreModelPlanBinding                 bool
	requireFreshLiveModelCatalog           bool
	liveModelCatalogInvalidationGeneration uint64
	providerTargetRef                      map[string]any
	extensionComposerProfile               ExtensionComposerProfile
}
