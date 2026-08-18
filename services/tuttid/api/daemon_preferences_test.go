package api

import (
	"context"
	"net/http"
	"testing"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	preferencesservice "github.com/tutti-os/tutti/services/tuttid/service/preferences"
)

type stubPreferencesService struct {
	getFn func(context.Context) (preferencesbiz.DesktopPreferences, error)
	putFn func(context.Context, preferencesservice.PutInput) (preferencesbiz.DesktopPreferences, error)
}

func (s stubPreferencesService) Get(ctx context.Context) (preferencesbiz.DesktopPreferences, error) {
	if s.getFn == nil {
		return preferencesbiz.DefaultDesktopPreferences(), nil
	}
	return s.getFn(ctx)
}

func (s stubPreferencesService) Put(ctx context.Context, input preferencesservice.PutInput) (preferencesbiz.DesktopPreferences, error) {
	if s.putFn == nil {
		return preferencesbiz.DesktopPreferences{
			AgentConversationDetailMode: input.AgentConversationDetailMode,
			AgentDockLayout:             input.AgentDockLayout,
			DefaultAgentProvider:        input.DefaultAgentProvider,

			DockIconStyle:       "default",
			DockPlacement:       input.DockPlacement,
			Initialized:         true,
			Locale:              input.Locale,
			SleepPreventionMode: input.SleepPreventionMode,
			ThemeSource:         input.ThemeSource,
			UpdateChannel:       input.UpdateChannel,
			UpdatePolicy:        input.UpdatePolicy,
		}, nil
	}
	return s.putFn(ctx, input)
}

func TestDaemonAPIGeneratedRoutesGetDesktopPreferences(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		PreferencesService: stubPreferencesService{
			getFn: func(context.Context) (preferencesbiz.DesktopPreferences, error) {
				return preferencesbiz.DesktopPreferences{
					AgentConversationDetailMode: "general",
					AgentDockLayout:             "unified",
					DefaultAgentProvider:        "claude-code",

					DockIconStyle:       "default",
					DockPlacement:       "left",
					Initialized:         true,
					Locale:              "zh-CN",
					MinimizeAnimation:   "scale",
					SleepPreventionMode: "whileAgentRunning",
					ThemeSource:         "dark",
					UpdateChannel:       "rc",
					UpdatePolicy:        "auto",
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodGet, "/v1/preferences/desktop", nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.DesktopPreferencesStateResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if !response.Initialized {
		t.Fatal("initialized = false, want true")
	}
	if response.Preferences.DockPlacement != tuttigenerated.Left {
		t.Fatalf("dockPlacement = %q, want %q", response.Preferences.DockPlacement, tuttigenerated.Left)
	}
	if response.Preferences.Locale != tuttigenerated.ZhCN {
		t.Fatalf("locale = %q, want %q", response.Preferences.Locale, tuttigenerated.ZhCN)
	}
	if response.Preferences.DefaultAgentProvider != tuttigenerated.DesktopDefaultAgentProviderClaudeCode {
		t.Fatalf("defaultAgentProvider = %q, want %q", response.Preferences.DefaultAgentProvider, tuttigenerated.DesktopDefaultAgentProviderClaudeCode)
	}
	if response.Preferences.AgentConversationDetailMode != tuttigenerated.General {
		t.Fatalf("agentConversationDetailMode = %q, want %q", response.Preferences.AgentConversationDetailMode, tuttigenerated.General)
	}
	if response.Preferences.AgentDockLayout != tuttigenerated.Unified {
		t.Fatalf("agentDockLayout = %q, want %q", response.Preferences.AgentDockLayout, tuttigenerated.Unified)
	}
	if response.Preferences.ThemeSource != tuttigenerated.DesktopThemeSourceDark {
		t.Fatalf("themeSource = %q, want %q", response.Preferences.ThemeSource, tuttigenerated.DesktopThemeSourceDark)
	}
	if response.Preferences.SleepPreventionMode != tuttigenerated.WhileAgentRunning {
		t.Fatalf("sleepPreventionMode = %q, want %q", response.Preferences.SleepPreventionMode, tuttigenerated.WhileAgentRunning)
	}
	if response.Preferences.UpdateChannel != tuttigenerated.Rc {
		t.Fatalf("updateChannel = %q, want %q", response.Preferences.UpdateChannel, tuttigenerated.Rc)
	}
	if response.Preferences.UpdatePolicy != tuttigenerated.DesktopUpdatePolicyAuto {
		t.Fatalf("updatePolicy = %q, want %q", response.Preferences.UpdatePolicy, tuttigenerated.DesktopUpdatePolicyAuto)
	}
}

func TestDaemonAPIGeneratedRoutesPutDesktopPreferencesPersistsAgentGUIConversationRailPreference(t *testing.T) {
	mux := http.NewServeMux()
	var captured preferencesservice.PutInput
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		PreferencesService: stubPreferencesService{
			putFn: func(_ context.Context, input preferencesservice.PutInput) (preferencesbiz.DesktopPreferences, error) {
				captured = input
				return preferencesbiz.DesktopPreferences{
					AgentCLIUpdateCheckEnabled:                  input.AgentCLIUpdateCheckEnabled,
					AgentGUIConversationRailCollapsedByProvider: input.AgentGUIConversationRailCollapsedByProvider,
					AgentConversationDetailMode:                 input.AgentConversationDetailMode,
					AgentDockLayout:                             input.AgentDockLayout,
					AppCatalogChannel:                           input.AppCatalogChannel,
					DefaultAgentProvider:                        input.DefaultAgentProvider,
					DockIconStyle:                               input.DockIconStyle,
					DockPlacement:                               input.DockPlacement,
					Initialized:                                 true,
					Locale:                                      input.Locale,
					SleepPreventionMode:                         input.SleepPreventionMode,
					ThemeSource:                                 input.ThemeSource,
					UpdateChannel:                               input.UpdateChannel,
					UpdatePolicy:                                input.UpdatePolicy,
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodPut, "/v1/preferences/desktop", map[string]any{
		"writeMode": "initializeIfAbsent",
		"preferences": map[string]any{
			"agentCliUpdateCheckEnabled":      false,
			"agentComposerDefaultsByProvider": map[string]any{},
			"agentGuiConversationRailCollapsedByProvider": map[string]any{
				"claude-code": false,
				"codex":       true,
			},
			"agentConversationDetailMode": "general",
			"agentDockLayout":             "legacySplit",
			"defaultAgentProvider":        "codex",
			"appCatalogChannel":           "staging",
			"dockIconStyle":               "default",
			"dockPlacement":               "bottom",
			"locale":                      "zh-CN",
			"minimizeAnimation":           "scale",
			"sleepPreventionMode":         "never",
			"themeSource":                 "dark",
			"updateChannel":               "stable",
			"updatePolicy":                "prompt",
		},
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	if captured.WriteMode != preferencesservice.DesktopPreferencesWriteModeInitializeIfAbsent {
		t.Fatalf("captured write mode = %q, want initializeIfAbsent", captured.WriteMode)
	}
	if captured.AgentCLIUpdateCheckEnabled {
		t.Fatal("captured agent CLI update check = true, want false")
	}
	if !captured.AgentGUIConversationRailCollapsedByProvider["codex"] {
		t.Fatalf("captured rail preference = %#v, want codex true", captured.AgentGUIConversationRailCollapsedByProvider)
	}
	if collapsed, ok := captured.AgentGUIConversationRailCollapsedByProvider["claude-code"]; !ok || collapsed {
		t.Fatalf("captured rail preference = %#v, want claude-code false", captured.AgentGUIConversationRailCollapsedByProvider)
	}
	if captured.AgentDockLayout != "legacySplit" {
		t.Fatalf("captured agentDockLayout = %q, want legacySplit", captured.AgentDockLayout)
	}
	if captured.AppCatalogChannel != "staging" {
		t.Fatalf("captured appCatalogChannel = %q, want staging", captured.AppCatalogChannel)
	}
	if captured.AgentConversationDetailMode != "general" {
		t.Fatalf("captured agentConversationDetailMode = %q, want general", captured.AgentConversationDetailMode)
	}
	var response tuttigenerated.DesktopPreferencesStateResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if response.Preferences.AgentCliUpdateCheckEnabled {
		t.Fatal("response agent CLI update check = true, want false")
	}
	if response.Preferences.AgentGuiConversationRailCollapsedByProvider.Codex == nil ||
		!*response.Preferences.AgentGuiConversationRailCollapsedByProvider.Codex {
		t.Fatalf("response rail codex = %#v, want true", response.Preferences.AgentGuiConversationRailCollapsedByProvider.Codex)
	}
	if response.Preferences.AgentGuiConversationRailCollapsedByProvider.ClaudeCode == nil ||
		*response.Preferences.AgentGuiConversationRailCollapsedByProvider.ClaudeCode {
		t.Fatalf("response rail claude-code = %#v, want false", response.Preferences.AgentGuiConversationRailCollapsedByProvider.ClaudeCode)
	}
	if response.Preferences.AgentConversationDetailMode != tuttigenerated.General {
		t.Fatalf("response agentConversationDetailMode = %q, want general", response.Preferences.AgentConversationDetailMode)
	}
	if response.Preferences.AppCatalogChannel != tuttigenerated.Staging {
		t.Fatalf("response appCatalogChannel = %q, want staging", response.Preferences.AppCatalogChannel)
	}
}

func TestDaemonAPIGeneratedRoutesPutDesktopPreferencesRejectsUnsupportedWriteMode(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		PreferencesService: stubPreferencesService{
			putFn: func(context.Context, preferencesservice.PutInput) (preferencesbiz.DesktopPreferences, error) {
				t.Fatal("Put should not be called when write mode is invalid")
				return preferencesbiz.DesktopPreferences{}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodPut, "/v1/preferences/desktop", map[string]any{
		"writeMode":   "merge",
		"preferences": map[string]any{},
	})
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusBadRequest, recorder.Body.String())
	}

	assertGeneratedRouteError(
		t,
		recorder,
		tuttigenerated.InvalidRequest,
		"unsupported_desktop_preferences_write_mode",
		"desktop preferences write mode is unsupported",
	)
}

func TestDaemonAPIGeneratedRoutesPutDesktopPreferencesRequiresAgentConversationDetailMode(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		PreferencesService: stubPreferencesService{
			putFn: func(context.Context, preferencesservice.PutInput) (preferencesbiz.DesktopPreferences, error) {
				t.Fatal("Put should not be called when agent conversation detail mode is missing")
				return preferencesbiz.DesktopPreferences{}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodPut, "/v1/preferences/desktop", map[string]any{
		"preferences": map[string]any{
			"defaultAgentProvider": "codex",
			"appCatalogChannel":    "production",
			"dockIconStyle":        "default",
			"dockPlacement":        "bottom",
			"locale":               "en",
			"minimizeAnimation":    "scale",
			"sleepPreventionMode":  "never",
			"themeSource":          "dark",
			"updateChannel":        "stable",
			"updatePolicy":         "prompt",
		},
	})
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusBadRequest, recorder.Body.String())
	}

	assertGeneratedRouteError(
		t,
		recorder,
		tuttigenerated.InvalidRequest,
		"missing_desktop_agent_conversation_detail_mode",
		"desktop agent conversation detail mode is required",
	)
}

func TestDaemonAPIGeneratedRoutesPutDesktopPreferencesValidatesAgentConversationDetailMode(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		PreferencesService: stubPreferencesService{
			putFn: func(context.Context, preferencesservice.PutInput) (preferencesbiz.DesktopPreferences, error) {
				t.Fatal("Put should not be called when agent conversation detail mode is invalid")
				return preferencesbiz.DesktopPreferences{}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodPut, "/v1/preferences/desktop", map[string]any{
		"preferences": map[string]any{
			"agentConversationDetailMode": "daily",
			"agentDockLayout":             "legacySplit",
			"defaultAgentProvider":        "codex",
			"appCatalogChannel":           "production",
			"dockIconStyle":               "default",
			"dockPlacement":               "bottom",
			"locale":                      "en",
			"minimizeAnimation":           "scale",
			"sleepPreventionMode":         "never",
			"themeSource":                 "dark",
			"updateChannel":               "stable",
			"updatePolicy":                "prompt",
		},
	})
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusBadRequest, recorder.Body.String())
	}

	assertGeneratedRouteError(
		t,
		recorder,
		tuttigenerated.InvalidRequest,
		"unsupported_desktop_agent_conversation_detail_mode",
		"desktop agent conversation detail mode is unsupported",
	)
}

func TestDaemonAPIGeneratedRoutesPutDesktopPreferencesValidatesLocale(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		PreferencesService: stubPreferencesService{
			putFn: func(context.Context, preferencesservice.PutInput) (preferencesbiz.DesktopPreferences, error) {
				t.Fatal("Put should not be called for invalid locale")
				return preferencesbiz.DesktopPreferences{}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodPut, "/v1/preferences/desktop", map[string]any{
		"preferences": map[string]any{
			"agentConversationDetailMode": "general",
			"agentDockLayout":             "legacySplit",
			"defaultAgentProvider":        "codex",
			"appCatalogChannel":           "production",
			"dockIconStyle":               "default",
			"dockPlacement":               "bottom",
			"locale":                      "fr",
			"minimizeAnimation":           "scale",
			"sleepPreventionMode":         "never",
			"themeSource":                 "dark",
			"updateChannel":               "stable",
			"updatePolicy":                "prompt",
		},
	})
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusBadRequest, recorder.Body.String())
	}

	assertGeneratedRouteError(
		t,
		recorder,
		tuttigenerated.InvalidRequest,
		"unsupported_desktop_locale",
		"desktop locale is unsupported",
	)
}

func TestDaemonAPIGeneratedRoutesPutDesktopPreferencesRequiresAgentDockLayout(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		PreferencesService: stubPreferencesService{
			putFn: func(context.Context, preferencesservice.PutInput) (preferencesbiz.DesktopPreferences, error) {
				t.Fatal("Put should not be called when agent dock layout is missing")
				return preferencesbiz.DesktopPreferences{}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodPut, "/v1/preferences/desktop", map[string]any{
		"preferences": map[string]any{
			"agentConversationDetailMode": "general",
			"defaultAgentProvider":        "codex",
			"appCatalogChannel":           "production",
			"dockIconStyle":               "default",
			"dockPlacement":               "bottom",
			"locale":                      "en",
			"minimizeAnimation":           "scale",
			"sleepPreventionMode":         "never",
			"themeSource":                 "dark",
			"updateChannel":               "stable",
			"updatePolicy":                "prompt",
		},
	})
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusBadRequest, recorder.Body.String())
	}

	assertGeneratedRouteError(
		t,
		recorder,
		tuttigenerated.InvalidRequest,
		"missing_desktop_agent_dock_layout",
		"desktop agent dock layout is required",
	)
}
