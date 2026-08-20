package agentruntime

import (
	"testing"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func TestClaudeCodeSDKAdapterWaitsForContextWindowBeforePublishingUsage(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{liveState: newClaudeSDKLiveState()}
	adapterSession.applyConfigOption("model", "opus")
	adapter.storeSession(session.AgentSessionID, adapterSession)

	events, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-1", claudeSDKSidecarEvent{
		Type: "usage_updated",
		Payload: map[string]any{
			"turnId": "turn-1",
			"usage": map[string]any{
				"input_tokens":                100,
				"output_tokens":               20,
				"cache_read_input_tokens":     7,
				"cache_creation_input_tokens": 3,
			},
		},
	})
	if err != nil || terminal {
		t.Fatalf("usage_updated terminal=%v err=%v", terminal, err)
	}
	if len(events) != 0 {
		t.Fatalf("usage events = %#v, want none before context window is known", events)
	}
	state := adapter.SessionState(session)
	if usage := state.RuntimeContext["usage"]; usage != nil {
		t.Fatalf("runtime usage = %#v, want unavailable before context window is known", usage)
	}
}

func TestClaudeSDKReportedUsageTokensKeepsAggregateSeparateFromLatestIteration(t *testing.T) {
	usage := map[string]any{
		"input_tokens":                int64(22),
		"output_tokens":               int64(8_172),
		"cache_read_input_tokens":     int64(5_054_371),
		"cache_creation_input_tokens": int64(511_644),
		"iterations": []any{
			map[string]any{
				"input_tokens":            int64(22),
				"output_tokens":           int64(8_172),
				"cache_read_input_tokens": int64(504_411),
			},
		},
	}
	if got := claudeSDKUsageTokens(usage); got != 512_605 {
		t.Fatalf("latest iteration tokens = %d, want 512605", got)
	}
	if got := claudeSDKReportedUsageTokens(usage); got != 5_574_209 {
		t.Fatalf("reported aggregate tokens = %d, want 5574209", got)
	}
}

func TestClaudeCodeSDKAdapterMapsModelUsageContextWindowMap(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{liveState: newClaudeSDKLiveState()}
	adapter.storeSession(session.AgentSessionID, adapterSession)
	adapterSession.applyConfigOption("model", "sonnet")

	events, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-1", claudeSDKSidecarEvent{
		Type: "usage_updated",
		Payload: map[string]any{
			"turnId": "turn-1",
			"usage": map[string]any{
				"input_tokens":                2,
				"output_tokens":               13,
				"cache_read_input_tokens":     18622,
				"cache_creation_input_tokens": 17466,
			},
			"modelUsage": map[string]any{
				"claude-haiku-4-5-20251001": map[string]any{
					"contextWindow": 200_000,
				},
				"claude-sonnet-5": map[string]any{
					"contextWindow": 1_000_000,
				},
			},
		},
	})
	if err != nil || terminal {
		t.Fatalf("usage_updated terminal=%v err=%v", terminal, err)
	}
	if len(events) != 1 || events[0].Type != activityshared.EventSessionUpdated {
		t.Fatalf("usage events = %#v, want session.updated", events)
	}
	state := adapter.SessionState(session)
	usage, _ := state.RuntimeContext["usage"].(map[string]any)
	contextWindow, _ := usage["contextWindow"].(map[string]any)
	if got, ok := int64Value(contextWindow["usedTokens"]); !ok || got != 36103 {
		t.Fatalf("usedTokens = %#v, want 36103", contextWindow["usedTokens"])
	}
	if got, ok := int64Value(contextWindow["totalTokens"]); !ok || got != 1_000_000 {
		t.Fatalf("totalTokens = %#v, want model usage context window", contextWindow["totalTokens"])
	}
}

func TestClaudeCodeSDKContextWindowDoesNotBorrowAnotherModel(t *testing.T) {
	total := claudeSDKContextWindowTokens(map[string]any{
		"modelUsage": map[string]any{
			"claude-haiku-4-5":  map[string]any{"contextWindow": 200_000},
			"claude-sonnet-4-6": map[string]any{"contextWindow": 1_000_000},
		},
	}, "opus")
	if total != 0 {
		t.Fatalf("context window=%d, want no value for unmatched active model", total)
	}
}

func TestClaudeCodeSDKAdapterPublishesFirstTurnUsageAfterModelWindowArrives(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{liveState: newClaudeSDKLiveState()}
	adapter.storeSession(session.AgentSessionID, adapterSession)
	adapterSession.applyConfigOption("model", "opus")

	events, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-1", claudeSDKSidecarEvent{
		Type: "usage_updated",
		Payload: map[string]any{
			"turnId": "turn-1",
			"usage": map[string]any{
				"input_tokens":  30_000,
				"output_tokens": 8_551,
			},
		},
	})
	if err != nil || terminal {
		t.Fatalf("usage_updated terminal=%v err=%v", terminal, err)
	}
	if len(events) != 0 {
		t.Fatalf("usage events = %#v, want none before modelUsage arrives", events)
	}
	state := adapter.SessionState(session)
	if usage := state.RuntimeContext["usage"]; usage != nil {
		t.Fatalf("runtime usage = %#v, want unavailable before modelUsage arrives", usage)
	}

	events, terminal, err = adapter.sidecarTurnEvents(adapterSession, session, "turn-1", claudeSDKSidecarEvent{
		Type: "usage_updated",
		Payload: map[string]any{
			"turnId": "turn-1",
			"usage": map[string]any{
				"input_tokens":  32_000,
				"output_tokens": 8_859,
			},
			"modelUsage": map[string]any{
				"claude-opus-4-6": map[string]any{
					"contextWindow": 1_000_000,
				},
			},
		},
	})
	if err != nil || terminal {
		t.Fatalf("usage_updated (final) terminal=%v err=%v", terminal, err)
	}
	if len(events) != 1 {
		t.Fatalf("usage events (final) = %#v", events)
	}
	state = adapter.SessionState(session)
	usage, _ := state.RuntimeContext["usage"].(map[string]any)
	contextWindow, _ := usage["contextWindow"].(map[string]any)
	if got, ok := int64Value(contextWindow["usedTokens"]); !ok || got != 40_859 {
		t.Fatalf("usedTokens (final) = %#v, want 40,859", contextWindow["usedTokens"])
	}
	if got, ok := int64Value(contextWindow["totalTokens"]); !ok || got != 1_000_000 {
		t.Fatalf("totalTokens (final) = %#v, want 1,000,000 from modelUsage", contextWindow["totalTokens"])
	}
}

func TestClaudeCodeSDKAdapterDoesNotCarryContextWindowAcrossModelChange(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{liveState: newClaudeSDKLiveState()}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	adapterSession.applyConfigOption("model", "haiku")
	events, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-1", claudeSDKSidecarEvent{
		Type: "usage_updated",
		Payload: map[string]any{
			"turnId": "turn-1",
			"contextWindow": map[string]any{
				"usedTokens":  20_000,
				"totalTokens": 200_000,
			},
		},
	})
	if err != nil || terminal || len(events) != 1 {
		t.Fatalf("haiku usage events=%#v terminal=%v err=%v, want session.updated", events, terminal, err)
	}

	adapterSession.applyConfigOption("model", "sonnet")
	events, terminal, err = adapter.sidecarTurnEvents(adapterSession, session, "turn-2", claudeSDKSidecarEvent{
		Type: "usage_updated",
		Payload: map[string]any{
			"turnId": "turn-2",
			"usage": map[string]any{
				"input_tokens":                2,
				"output_tokens":               13,
				"cache_read_input_tokens":     18_622,
				"cache_creation_input_tokens": 17_466,
			},
			"modelUsage": map[string]any{
				"claude-sonnet-5": map[string]any{
					"contextWindow": 1_000_000,
				},
			},
		},
	})
	if err != nil || terminal || len(events) != 1 {
		t.Fatalf("sonnet usage events=%#v terminal=%v err=%v, want session.updated", events, terminal, err)
	}

	adapterSession.applyConfigOption("model", "haiku")
	events, terminal, err = adapter.sidecarTurnEvents(adapterSession, session, "turn-3", claudeSDKSidecarEvent{
		Type: "usage_updated",
		Payload: map[string]any{
			"turnId": "turn-3",
			"contextWindow": map[string]any{
				"usedTokens": 29_538,
			},
		},
	})
	if err != nil || terminal {
		t.Fatalf("haiku context usage terminal=%v err=%v", terminal, err)
	}
	if len(events) != 0 {
		t.Fatalf("haiku context usage events=%#v, want none before the new model window is known", events)
	}
	state := adapter.SessionState(session)
	usage, _ := state.RuntimeContext["usage"].(map[string]any)
	contextWindow, _ := usage["contextWindow"].(map[string]any)
	if got, ok := int64Value(contextWindow["usedTokens"]); !ok || got != 36_103 {
		t.Fatalf("usedTokens = %#v, want previous published usage until the new model window is known", contextWindow["usedTokens"])
	}
	if got, ok := int64Value(contextWindow["totalTokens"]); !ok || got != 1_000_000 {
		t.Fatalf("totalTokens = %#v, want previous published context window until the new model window is known", contextWindow["totalTokens"])
	}
}

func TestClaudeCodeSDKAdapterReusesKnownContextWindowForSameModel(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{liveState: newClaudeSDKLiveState()}
	adapterSession.applyConfigOption("model", "opus")
	adapterSession.liveState.usage = claudeSDKUsageState{
		contextUsedTokens:   20_000,
		contextWindowTokens: 1_000_000,
		contextKnown:        true,
		contextModel:        "opus",
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	events, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-2", claudeSDKSidecarEvent{
		Type: "usage_updated",
		Payload: map[string]any{
			"turnId": "turn-2",
			"usage": map[string]any{
				"input_tokens":  30_000,
				"output_tokens": 8_551,
			},
		},
	})
	if err != nil || terminal || len(events) != 1 {
		t.Fatalf("usage events=%#v terminal=%v err=%v, want same-model session.updated", events, terminal, err)
	}
	state := adapter.SessionState(session)
	usage, _ := state.RuntimeContext["usage"].(map[string]any)
	contextWindow, _ := usage["contextWindow"].(map[string]any)
	if got, ok := int64Value(contextWindow["usedTokens"]); !ok || got != 38_551 {
		t.Fatalf("usedTokens = %#v, want 38,551", contextWindow["usedTokens"])
	}
	if got, ok := int64Value(contextWindow["totalTokens"]); !ok || got != 1_000_000 {
		t.Fatalf("totalTokens = %#v, want retained same-model context window", contextWindow["totalTokens"])
	}
}

func TestClaudeCodeSDKAdapterInvalidatesContextWindowWhenSettingsChangeModel(t *testing.T) {
	adapterSession := &claudeSDKAdapterSession{liveState: newClaudeSDKLiveState()}
	adapterSession.applyConfigOption("model", "haiku")
	adapterSession.liveState.usage = claudeSDKUsageState{
		contextUsedTokens:   20_000,
		contextWindowTokens: 200_000,
		contextKnown:        true,
		contextModel:        "haiku",
		quotas: []map[string]any{{
			"quotaType": "weekly", "percentRemaining": 75.5,
		}},
	}

	if !adapterSession.applySettingsPayload(map[string]any{"model": "opus"}) {
		t.Fatal("applySettingsPayload() changed=false, want model change")
	}
	if adapterSession.liveState.usage.contextKnown {
		t.Fatalf("context usage=%#v, want invalidated after model change", adapterSession.liveState.usage)
	}
	if len(adapterSession.liveState.usage.quotas) != 1 {
		t.Fatalf("quotas=%#v, want preserved quotas", adapterSession.liveState.usage.quotas)
	}
}

func TestClaudeCodeSDKAdapterMapsContextUsageUpdatedIntoRuntimeContext(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{liveState: newClaudeSDKLiveState()}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	events, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-1", claudeSDKSidecarEvent{
		Type: "usage_updated",
		Payload: map[string]any{
			"turnId": "turn-1",
			"contextWindow": map[string]any{
				"usedTokens":  50_062,
				"totalTokens": 200_000,
			},
		},
	})
	if err != nil || terminal {
		t.Fatalf("usage_updated terminal=%v err=%v", terminal, err)
	}
	if len(events) != 1 || events[0].Type != activityshared.EventSessionUpdated {
		t.Fatalf("usage events = %#v, want session.updated", events)
	}
	state := adapter.SessionState(session)
	usage, _ := state.RuntimeContext["usage"].(map[string]any)
	contextWindow, _ := usage["contextWindow"].(map[string]any)
	if got, ok := int64Value(contextWindow["usedTokens"]); !ok || got != 50_062 {
		t.Fatalf("usedTokens = %#v, want getContextUsage snapshot", contextWindow["usedTokens"])
	}
	if got, ok := int64Value(contextWindow["totalTokens"]); !ok || got != 200_000 {
		t.Fatalf("totalTokens = %#v, want model context window", contextWindow["totalTokens"])
	}
}

func TestClaudeCodeSDKAdapterStartAppliesRestoreUsageBeforeSessionStarted(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{liveState: newClaudeSDKLiveState()}

	events := adapter.applySidecarSessionEvent(adapterSession, session, claudeSDKSidecarEvent{
		Type: "usage_updated",
		Payload: map[string]any{
			"contextWindow": map[string]any{
				"usedTokens":  50_062,
				"totalTokens": 200_000,
			},
		},
	})
	if len(events) != 0 {
		t.Fatalf("restore usage events = %#v, want buffered state only", events)
	}
	events = adapter.applySidecarSessionEvent(adapterSession, session, claudeSDKSidecarEvent{
		Type: "session_started",
		Payload: map[string]any{
			"providerSessionId": "provider-session-1",
		},
	})
	if len(events) != 1 || events[0].Type != activityshared.EventSessionStarted {
		t.Fatalf("session_started events = %#v, want started event", events)
	}
	usage, _ := events[0].Payload.Metadata["usage"].(map[string]any)
	contextWindow, _ := usage["contextWindow"].(map[string]any)
	if got, ok := int64Value(contextWindow["usedTokens"]); !ok || got != 50_062 {
		t.Fatalf("started runtime usage = %#v, want restore snapshot", events[0].Payload.Metadata["usage"])
	}
}

func TestClaudeCodeSDKAdapterSessionStartedUsesSidecarModelConfigOptions(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{liveState: newClaudeSDKLiveState()}

	events := adapter.applySidecarSessionEvent(adapterSession, session, claudeSDKSidecarEvent{
		Type: "session_started",
		Payload: map[string]any{
			"providerSessionId": "provider-session-1",
			"model":             "mimo-v2.5-pro",
			"configOptions": []any{
				map[string]any{
					"id":           "model",
					"currentValue": "mimo-v2.5-pro",
					"options": []any{
						map[string]any{
							"value":       "default",
							"name":        "Default",
							"description": "Provider default",
						},
						map[string]any{
							"value":       "mimo-v2.5-pro",
							"name":        "Mimo v2.5 Pro",
							"description": "Custom Mimo model",
						},
					},
				},
			},
		},
	})

	if len(events) != 1 || events[0].Type != activityshared.EventSessionStarted {
		t.Fatalf("session_started events = %#v, want started event", events)
	}
	configOptions, ok := events[0].Payload.Metadata["configOptions"].([]map[string]any)
	if !ok {
		t.Fatalf("configOptions = %#v, want descriptors", events[0].Payload.Metadata["configOptions"])
	}
	modelOption := configOptionByID(configOptions, "model")
	if modelOption == nil {
		t.Fatalf("configOptions = %#v, missing model option", configOptions)
	}
	if modelOption["currentValue"] != "mimo-v2.5-pro" {
		t.Fatalf("model option currentValue = %#v, want mimo", modelOption["currentValue"])
	}
	modelOptions := configOptionEntries(modelOption["options"])
	if len(modelOptions) != 2 || modelOptions[1]["value"] != "mimo-v2.5-pro" || modelOptions[1]["name"] != "Mimo v2.5 Pro" {
		t.Fatalf("model options = %#v, want sidecar options", modelOptions)
	}
	if events[0].Payload.Metadata["model"] != "mimo-v2.5-pro" {
		t.Fatalf("runtime model = %#v, want mimo", events[0].Payload.Metadata["model"])
	}
}
