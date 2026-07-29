package agent

import (
	"errors"
	"slices"
	"strings"
	"testing"
)

func TestProjectExtensionPermissionConfigPreservesRuntimeIDsWithSharedSemantic(t *testing.T) {
	projection, err := projectExtensionPermissionConfig(extensionPermissionProjectionInput{
		AgentTargetID: "extension:codebuddy",
		Profile: ExtensionComposerProfile{
			PermissionModeIDPolicy: ExtensionPermissionModeIDPolicyRuntime,
			PermissionModes: []ExtensionComposerPermissionMode{
				{RuntimeID: "default", Semantic: PermissionModeSemanticAskBeforeWrite},
				{RuntimeID: "bypassPermissions", Semantic: PermissionModeSemanticFullAccess},
				{RuntimeID: "fullAccess", Semantic: PermissionModeSemanticFullAccess},
			},
		},
		Runtime: &extensionPermissionRuntimeState{
			CurrentRuntimeID: "default",
			Options: []ComposerConfigOptionValue{
				{Value: "default", Label: "Default"},
				{Value: "bypassPermissions", Label: "Full access"},
				{Value: "bypassPermissions", Label: "Duplicate should not win"},
				{Value: "fullAccess", Label: "Full access"},
				{Value: "providerExperimental", Label: "Experimental"},
			},
		},
	})
	if err != nil {
		t.Fatalf("projectExtensionPermissionConfig() error = %v", err)
	}
	if projection.CurrentID != "default" || !projection.Config.Configurable {
		t.Fatalf("projection = %#v", projection)
	}
	ids := permissionModeIDs(projection.Config)
	if !slices.Equal(ids, []string{"default", "bypassPermissions", "fullAccess"}) {
		t.Fatalf("permission ids = %#v, want exact profile order", ids)
	}
	if projection.Config.Modes[1].Semantic != PermissionModeSemanticFullAccess ||
		projection.Config.Modes[2].Semantic != PermissionModeSemanticFullAccess {
		t.Fatalf("full access modes = %#v", projection.Config.Modes[1:])
	}
	if projection.Config.Modes[1].Label != "Full access (bypassPermissions)" ||
		projection.Config.Modes[2].Label != "Full access (fullAccess)" {
		t.Fatalf("disambiguated labels = %#v", projection.Config.Modes[1:])
	}
	if len(projection.Diagnostics) != 2 ||
		projection.Diagnostics[0].Reason != "permission_runtime_option_duplicate" ||
		projection.Diagnostics[1].Reason != "permission_runtime_option_undeclared" {
		t.Fatalf("diagnostics = %#v, want duplicate and undeclared runtime options", projection.Diagnostics)
	}
}

func TestProjectExtensionPermissionConfigUsesSemanticIDsOnlyForSemanticPolicy(t *testing.T) {
	projection, err := projectExtensionPermissionConfig(extensionPermissionProjectionInput{
		Profile: ExtensionComposerProfile{
			DefaultPermissionModeID: "ask-before-write",
			PermissionModeIDPolicy:  ExtensionPermissionModeIDPolicySemantic,
			PermissionModes: []ExtensionComposerPermissionMode{
				{RuntimeID: "ask", Semantic: PermissionModeSemanticAskBeforeWrite},
				{RuntimeID: "auto", Semantic: PermissionModeSemanticAuto},
				{RuntimeID: "all", Semantic: PermissionModeSemanticFullAccess},
			},
		},
		Runtime: &extensionPermissionRuntimeState{CurrentRuntimeID: "all"},
	})
	if err != nil {
		t.Fatalf("projectExtensionPermissionConfig() error = %v", err)
	}
	if projection.CurrentID != "full-access" {
		t.Fatalf("current id = %q, want runtime current mapped to semantic id", projection.CurrentID)
	}
	if got := permissionModeIDs(projection.Config); !slices.Equal(got, []string{"ask-before-write", "auto", "full-access"}) {
		t.Fatalf("permission ids = %#v, want semantic ids", got)
	}
}

func TestProjectExtensionPermissionConfigExplicitSelectionWinsOverRuntimeCurrent(t *testing.T) {
	projection, err := projectExtensionPermissionConfig(extensionPermissionProjectionInput{
		SelectedID: "bypassPermissions",
		Profile: ExtensionComposerProfile{PermissionModes: []ExtensionComposerPermissionMode{
			{RuntimeID: "default", Semantic: PermissionModeSemanticAskBeforeWrite},
			{RuntimeID: "bypassPermissions", Semantic: PermissionModeSemanticFullAccess},
		}},
		Runtime: &extensionPermissionRuntimeState{CurrentRuntimeID: "default"},
	})
	if err != nil {
		t.Fatalf("projectExtensionPermissionConfig() error = %v", err)
	}
	if projection.CurrentID != "bypassPermissions" || projection.Config.DefaultValue != "bypassPermissions" {
		t.Fatalf("projection = %#v, want explicit selection preserved", projection)
	}
}

func TestProjectExtensionPermissionConfigUsesRuntimeBeforeConfiguredAndProfileDefaults(t *testing.T) {
	profile := ExtensionComposerProfile{
		DefaultPermissionModeID: "default",
		PermissionModes: []ExtensionComposerPermissionMode{
			{RuntimeID: "default", Semantic: PermissionModeSemanticAskBeforeWrite},
			{RuntimeID: "bypassPermissions", Semantic: PermissionModeSemanticFullAccess},
		},
	}
	projection, err := projectExtensionPermissionConfig(extensionPermissionProjectionInput{
		FallbackID: "default",
		Profile:    profile,
		Runtime:    &extensionPermissionRuntimeState{CurrentRuntimeID: "bypassPermissions"},
	})
	if err != nil {
		t.Fatalf("projectExtensionPermissionConfig() error = %v", err)
	}
	if projection.CurrentID != "bypassPermissions" {
		t.Fatalf("current id = %q, want runtime current before configured default", projection.CurrentID)
	}

	projection, err = projectExtensionPermissionConfig(extensionPermissionProjectionInput{
		FallbackID: "stale-semantic-id",
		Profile:    profile,
	})
	if err != nil {
		t.Fatalf("projectExtensionPermissionConfig() stale fallback error = %v", err)
	}
	if projection.CurrentID != "default" || len(projection.Diagnostics) != 1 ||
		projection.Diagnostics[0].Reason != "permission_configured_default_unsupported" {
		t.Fatalf("projection = %#v, want stale fallback ignored before profile default", projection)
	}
}

func TestProjectExtensionPermissionConfigRejectsUnsupportedExplicitID(t *testing.T) {
	_, err := projectExtensionPermissionConfig(extensionPermissionProjectionInput{
		AgentTargetID: "extension:codebuddy",
		SelectedID:    "full-access",
		Profile: ExtensionComposerProfile{PermissionModes: []ExtensionComposerPermissionMode{
			{RuntimeID: "default", Semantic: PermissionModeSemanticAskBeforeWrite},
			{RuntimeID: "bypassPermissions", Semantic: PermissionModeSemanticFullAccess},
			{RuntimeID: "fullAccess", Semantic: PermissionModeSemanticFullAccess},
		}},
	})
	var unsupported *UnsupportedPermissionModeIDError
	if !errors.As(err, &unsupported) || !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("error = %v, want UnsupportedPermissionModeIDError", err)
	}
	if unsupported.PermissionModeID != "full-access" ||
		!slices.Equal(unsupported.AvailablePermissionModeIDs, []string{"default", "bypassPermissions", "fullAccess"}) ||
		!strings.Contains(err.Error(), "refresh Composer Options") {
		t.Fatalf("unsupported error = %#v (%v)", unsupported, err)
	}
}

func TestProjectExtensionPermissionConfigSingleModeIsConfigurableWithoutInventingCurrent(t *testing.T) {
	projection, err := projectExtensionPermissionConfig(extensionPermissionProjectionInput{
		Profile: ExtensionComposerProfile{PermissionModes: []ExtensionComposerPermissionMode{
			{RuntimeID: "default", Semantic: PermissionModeSemanticAskBeforeWrite},
		}},
	})
	if err != nil {
		t.Fatalf("projectExtensionPermissionConfig() error = %v", err)
	}
	if !projection.Config.Configurable || projection.CurrentID != "" || projection.Config.DefaultValue != "" {
		t.Fatalf("projection = %#v, want supported field without invented selection", projection)
	}
}

func TestProjectExtensionPermissionConfigRejectsInvalidProfileModes(t *testing.T) {
	tests := []struct {
		name  string
		modes []ExtensionComposerPermissionMode
	}{
		{
			name: "duplicate runtime id",
			modes: []ExtensionComposerPermissionMode{
				{RuntimeID: "same", Semantic: PermissionModeSemanticAskBeforeWrite},
				{RuntimeID: "same", Semantic: PermissionModeSemanticFullAccess},
			},
		},
		{
			name: "case-insensitive duplicate runtime id",
			modes: []ExtensionComposerPermissionMode{
				{RuntimeID: "Auto", Semantic: PermissionModeSemanticAskBeforeWrite},
				{RuntimeID: "auto", Semantic: PermissionModeSemanticFullAccess},
			},
		},
		{
			name:  "unknown semantic",
			modes: []ExtensionComposerPermissionMode{{RuntimeID: "mystery", Semantic: "whatever"}},
		},
		{
			name:  "missing runtime id",
			modes: []ExtensionComposerPermissionMode{{Semantic: PermissionModeSemanticAuto}},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := projectExtensionPermissionConfig(extensionPermissionProjectionInput{
				Profile: ExtensionComposerProfile{PermissionModes: test.modes},
			})
			if err == nil {
				t.Fatal("projectExtensionPermissionConfig() error = nil")
			}
		})
	}
}

func permissionModeIDs(config PermissionConfig) []string {
	result := make([]string, 0, len(config.Modes))
	for _, mode := range config.Modes {
		result = append(result, mode.ID)
	}
	return result
}
