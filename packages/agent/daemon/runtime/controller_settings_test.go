package agentruntime

import (
	"context"
	"errors"
	"testing"
)

func TestControllerUpdateSettingsMergesModelPatchWithoutRequiringPermissionMode(t *testing.T) {
	t.Parallel()

	adapter := &statefulInteractiveAdapter{}
	controller := NewController([]Adapter{adapter}, nil)

	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		CWD:            "/workspace",
		Title:          "Codex",
		Settings: &SessionSettings{
			CodexSaverMode:   true,
			Model:            "gpt-5.2-codex",
			ReasoningEffort:  "high",
			Speed:            "standard",
			PlanMode:         true,
			PermissionModeID: "full-access",
		},
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if started.Session.Settings == nil {
		t.Fatal("session settings = nil, want round-tripped settings")
	}

	updated, err := controller.UpdateSettings(context.Background(), UpdateSettingsInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Settings: SessionSettingsPatch{
			Model: stringPtr("gpt-5.4"),
			Speed: stringPtr("fast"),
		},
	})
	if err != nil {
		t.Fatalf("UpdateSettings: %v", err)
	}
	if updated.Settings.PermissionModeID != "full-access" {
		t.Fatalf("updated settings permission mode = %q, want %q", updated.Settings.PermissionModeID, "full-access")
	}
	if updated.Settings.Model != "gpt-5.4" {
		t.Fatalf("updated settings model = %q, want %q", updated.Settings.Model, "gpt-5.4")
	}
	if updated.Settings.Speed != "fast" {
		t.Fatalf("updated settings speed = %q, want fast", updated.Settings.Speed)
	}
	if updated.Settings.ReasoningEffort != "high" || !updated.Settings.PlanMode || !updated.Settings.CodexSaverMode {
		t.Fatalf("updated settings = %#v, want non-updated fields preserved", updated.Settings)
	}
}

func TestControllerUpdateSettingsAppliesLiveAdapterSettingsPatch(t *testing.T) {
	t.Parallel()

	adapter := &statefulInteractiveAdapter{
		snapshot: SessionStateSnapshot{
			Settings: &SessionSettings{
				Model:            "gpt-5.2-codex",
				ReasoningEffort:  "high",
				PlanMode:         false,
				PermissionModeID: "full-access",
			},
		},
	}
	controller := NewController([]Adapter{adapter}, nil)

	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		CWD:            "/workspace",
		Title:          "Codex",
		Settings: &SessionSettings{
			Model:            "gpt-5.2-codex",
			ReasoningEffort:  "high",
			PlanMode:         false,
			PermissionModeID: "full-access",
		},
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	if _, err := controller.UpdateSettings(context.Background(), UpdateSettingsInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Settings: SessionSettingsPatch{
			Model: stringPtr("gpt-5.4"),
		},
	}); err != nil {
		t.Fatalf("UpdateSettings: %v", err)
	}

	if len(adapter.appliedSettings) != 1 {
		t.Fatalf("applied settings = %#v, want one live patch", adapter.appliedSettings)
	}
	if adapter.appliedSettings[0].Model == nil || *adapter.appliedSettings[0].Model != "gpt-5.4" {
		t.Fatalf("applied settings model = %#v, want gpt-5.4", adapter.appliedSettings[0].Model)
	}

	state, err := controller.State("room-1", started.Session.AgentSessionID)
	if err != nil {
		t.Fatalf("State: %v", err)
	}
	if state.Settings == nil || state.Settings.Model != "gpt-5.4" {
		t.Fatalf("state settings = %#v, want live model override updated", state.Settings)
	}
}

func TestControllerUpdateSettingsRejectsSettingsThatRequireNewSession(t *testing.T) {
	t.Parallel()

	adapter := &statefulInteractiveAdapter{requiresNewSession: true}
	controller := NewController([]Adapter{adapter}, nil)

	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		CWD:            "/workspace",
		Title:          "Codex",
		Settings: &SessionSettings{
			Model:            "gpt-5.2-codex",
			ReasoningEffort:  "high",
			PermissionModeID: "full-access",
		},
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	_, err = controller.UpdateSettings(context.Background(), UpdateSettingsInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Settings: SessionSettingsPatch{
			Model: stringPtr("gpt-5.3-codex-spark"),
		},
	})
	if !errors.Is(err, ErrSessionSettingsRequireNewSession) {
		t.Fatalf("UpdateSettings error = %v, want ErrSessionSettingsRequireNewSession", err)
	}
	if len(adapter.appliedSettings) != 0 {
		t.Fatalf("applied live settings = %#v, want none for new-session-only setting", adapter.appliedSettings)
	}
	session, ok := controller.Session("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Session returned ok=false after rejected update")
	}
	if session.Settings == nil || session.Settings.Model != "gpt-5.2-codex" {
		t.Fatalf("session settings after rejected update = %#v, want original model preserved", session.Settings)
	}
}

func TestControllerUpdateSettingsDoesNotPersistFailedLivePatch(t *testing.T) {
	t.Parallel()

	adapter := &statefulInteractiveAdapter{
		applySettingsErr: errors.New("live settings unavailable"),
	}
	controller := NewController([]Adapter{adapter}, nil)

	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		CWD:            "/workspace",
		Title:          "Codex",
		Settings: &SessionSettings{
			Model:            "gpt-5.2-codex",
			ReasoningEffort:  "high",
			PermissionModeID: "full-access",
		},
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	_, err = controller.UpdateSettings(context.Background(), UpdateSettingsInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Settings: SessionSettingsPatch{
			Model: stringPtr("gpt-5.4"),
		},
	})
	if err == nil {
		t.Fatal("UpdateSettings: expected live settings failure")
	}

	session, ok := controller.Session("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Session returned ok=false after failed update")
	}
	if session.Settings == nil {
		t.Fatal("session settings = nil after failed update")
	}
	if session.Settings.Model != "gpt-5.2-codex" {
		t.Fatalf("session settings model = %q, want original value after failed update", session.Settings.Model)
	}

	state, err := controller.State("room-1", started.Session.AgentSessionID)
	if err != nil {
		t.Fatalf("State: %v", err)
	}
	if state.Settings == nil {
		t.Fatal("state settings = nil after failed update")
	}
	if state.Settings.Model != "gpt-5.2-codex" {
		t.Fatalf("state settings model = %q, want original value after failed update", state.Settings.Model)
	}
}

func TestControllerUpdateSettingsDoesNotAdvanceSessionUpdatedAt(t *testing.T) {
	t.Parallel()

	adapter := &statefulInteractiveAdapter{}
	controller := NewController([]Adapter{adapter}, nil)

	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		CWD:            "/workspace",
		Title:          "Codex",
		Settings: &SessionSettings{
			Model:            "gpt-5.2-codex",
			ReasoningEffort:  "high",
			PermissionModeID: "full-access",
		},
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	controller.mu.Lock()
	session := controller.sessions[sessionKey("room-1", started.Session.AgentSessionID)]
	session.UpdatedAtUnixMS = 123
	controller.sessions[sessionKey("room-1", started.Session.AgentSessionID)] = session
	controller.mu.Unlock()

	if _, err := controller.UpdateSettings(context.Background(), UpdateSettingsInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Settings: SessionSettingsPatch{
			Model: stringPtr("gpt-5.4"),
		},
	}); err != nil {
		t.Fatalf("UpdateSettings: %v", err)
	}

	updated, ok := controller.Session("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Session returned ok=false after update")
	}
	if updated.UpdatedAtUnixMS != 123 {
		t.Fatalf("UpdatedAtUnixMS = %d, want preserved value 123", updated.UpdatedAtUnixMS)
	}

	state, err := controller.State("room-1", started.Session.AgentSessionID)
	if err != nil {
		t.Fatalf("State: %v", err)
	}
	if state.UpdatedAtUnixMS != 123 {
		t.Fatalf("state UpdatedAtUnixMS = %d, want preserved value 123", state.UpdatedAtUnixMS)
	}
}

func TestControllerStateAppliesAdapterSettingsOverride(t *testing.T) {
	t.Parallel()

	adapter := &statefulInteractiveAdapter{
		snapshot: SessionStateSnapshot{
			PermissionModeID: "full-access",
			Settings: &SessionSettings{
				Model:            "opus",
				ReasoningEffort:  "low",
				PlanMode:         true,
				PermissionModeID: "full-access",
			},
		},
	}
	controller := NewController([]Adapter{adapter}, nil)

	_, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		CWD:            "/workspace",
		Title:          "Codex",
		Settings: &SessionSettings{
			Model:            "gpt-5.2-codex",
			ReasoningEffort:  "high",
			PermissionModeID: "read-only",
		},
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	state, err := controller.State("room-1", "agent-session-1")
	if err != nil {
		t.Fatalf("State: %v", err)
	}
	if state.PermissionModeID != "full-access" {
		t.Fatalf("state permission mode = %q, want %q", state.PermissionModeID, "full-access")
	}
	if state.Settings == nil {
		t.Fatal("state settings = nil, want adapter override")
	}
	if state.Settings.Model != "opus" || state.Settings.ReasoningEffort != "low" || !state.Settings.PlanMode {
		t.Fatalf("state settings = %#v, want adapter override", state.Settings)
	}
	if state.Settings.PermissionModeID != "full-access" {
		t.Fatalf("state settings permission mode = %q, want %q", state.Settings.PermissionModeID, "full-access")
	}
	if got := asString(state.RuntimeContext["model"]); got != "opus" {
		t.Fatalf("runtime context model = %q, want opus", got)
	}
	if got := asString(state.RuntimeContext["reasoningEffort"]); got != "low" {
		t.Fatalf("runtime context reasoningEffort = %q, want low", got)
	}
	if got, _ := state.RuntimeContext["planMode"].(bool); !got {
		t.Fatalf("runtime context planMode = %#v, want true", state.RuntimeContext["planMode"])
	}
}
