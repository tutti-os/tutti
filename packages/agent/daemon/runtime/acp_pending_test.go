package agentruntime

import (
	"strings"
	"testing"
)

func TestNormalizeACPAskUserPermissionBridgeRejectsUnsupportedShapes(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		questions []any
		wantState acpAskUserPermissionBridgeState
		wantError string
	}{
		{
			name: "single select",
			questions: []any{map[string]any{
				"question": "How are you?",
				"options": []any{
					map[string]any{"label": "Good"},
					map[string]any{"label": "Okay"},
				},
			}},
			wantState: acpAskUserPermissionBridgeSupported,
		},
		{
			name: "multiple questions",
			questions: []any{
				map[string]any{"question": "First?", "options": []any{map[string]any{"label": "Good"}, map[string]any{"label": "Okay"}}},
				map[string]any{"question": "Second?", "options": []any{map[string]any{"label": "Good"}, map[string]any{"label": "Okay"}}},
			},
			wantState: acpAskUserPermissionBridgeUnsupported,
			wantError: "exactly one question",
		},
		{
			name: "malformed question list",
			questions: []any{
				map[string]any{"question": "First?", "options": []any{map[string]any{"label": "Good"}, map[string]any{"label": "Okay"}}},
				"not a question",
			},
			wantState: acpAskUserPermissionBridgeUnsupported,
			wantError: "malformed question list",
		},
		{
			name:      "nil question",
			questions: []any{map[string]any(nil)},
			wantState: acpAskUserPermissionBridgeUnsupported,
			wantError: "malformed question list",
		},
		{
			name: "multi select",
			questions: []any{map[string]any{
				"question":    "Pick any",
				"multiSelect": true,
				"options":     []any{map[string]any{"label": "Good"}, map[string]any{"label": "Okay"}},
			}},
			wantState: acpAskUserPermissionBridgeUnsupported,
			wantError: "does not support multi-select",
		},
		{
			name: "invalid multi-select flag",
			questions: []any{map[string]any{
				"question":    "Pick one",
				"multiSelect": "sometimes",
				"options":     []any{map[string]any{"label": "Good"}, map[string]any{"label": "Okay"}},
			}},
			wantState: acpAskUserPermissionBridgeUnsupported,
			wantError: "invalid multi-select flag",
		},
		{
			name: "conflicting multi-select aliases",
			questions: []any{map[string]any{
				"question":     "Pick one",
				"multiSelect":  true,
				"multi_select": false,
				"options":      []any{map[string]any{"label": "Good"}, map[string]any{"label": "Okay"}},
			}},
			wantState: acpAskUserPermissionBridgeUnsupported,
			wantError: "invalid multi-select flag",
		},
		{
			name: "free text",
			questions: []any{map[string]any{
				"question":      "How are you?",
				"allowFreeText": true,
				"options":       []any{map[string]any{"label": "Good"}, map[string]any{"label": "Okay"}},
			}},
			wantState: acpAskUserPermissionBridgeUnsupported,
			wantError: "does not support free-text",
		},
		{
			name: "conflicting free-text aliases",
			questions: []any{map[string]any{
				"question":        "How are you?",
				"allowFreeText":   true,
				"allow_free_text": false,
				"options":         []any{map[string]any{"label": "Good"}, map[string]any{"label": "Okay"}},
			}},
			wantState: acpAskUserPermissionBridgeUnsupported,
			wantError: "invalid free-text flag",
		},
		{
			name: "malformed question options",
			questions: []any{map[string]any{
				"question": "How are you?",
				"options":  []any{map[string]any{"label": "Good"}, "not an option", map[string]any{"label": "Okay"}},
			}},
			wantState: acpAskUserPermissionBridgeUnsupported,
			wantError: "malformed question option list",
		},
		{
			name: "provider option mismatch",
			questions: []any{map[string]any{
				"question": "How are you?",
				"options":  []any{map[string]any{"label": "Good"}},
			}},
			wantState: acpAskUserPermissionBridgeUnsupported,
			wantError: "do not match",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			pending := acpAskUserPermissionTestPending(tt.questions)
			_, state, err := normalizeACPAskUserPermissionBridge(pending)
			if state != tt.wantState {
				t.Fatalf("bridge state = %v, want %v", state, tt.wantState)
			}
			if tt.wantError == "" {
				if err != nil {
					t.Fatalf("normalize bridge: %v", err)
				}
				questions := payloadArray(pending.input["questions"])
				if len(questions) != 1 ||
					asString(questions[0]["id"]) != "question-1" ||
					questions[0]["allowFreeText"] != false {
					t.Fatalf("normalized questions = %#v, want stable option-only question", questions)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.wantError) {
				t.Fatalf("normalize bridge error = %v, want containing %q", err, tt.wantError)
			}
		})
	}
}

func TestNormalizeACPAskUserPermissionBridgeUsesPermissionKindForRejection(t *testing.T) {
	t.Parallel()

	pending := acpAskUserPermissionTestPending([]any{map[string]any{
		"question": "Continue?",
		"options": []any{
			map[string]any{"label": "Good"},
			map[string]any{"label": "No"},
		},
	}})
	pending.options[1]["name"] = "No"

	bridge, state, err := normalizeACPAskUserPermissionBridge(pending)
	if err != nil || state != acpAskUserPermissionBridgeSupported {
		t.Fatalf("normalize bridge state = %v, error = %v, want supported", state, err)
	}
	if bridge.optionIDByLabel["No"] != "q0_opt_1" {
		t.Fatalf("option map = %#v, want allow_once option named No preserved", bridge.optionIDByLabel)
	}
	if bridge.rejectionOption != "q0_skip" {
		t.Fatalf("rejection option = %q, want q0_skip", bridge.rejectionOption)
	}
}

func TestNormalizeACPAskUserPermissionBridgeWaitsForQuestionOptions(t *testing.T) {
	t.Parallel()

	pending := acpAskUserPermissionTestPending([]any{map[string]any{
		"question": "How are you?",
	}})

	_, state, err := normalizeACPAskUserPermissionBridge(pending)
	if state != acpAskUserPermissionBridgeIncomplete || err != nil {
		t.Fatalf("normalize bridge state = %v, error = %v, want incomplete", state, err)
	}
}

func TestNormalizeACPAskUserPermissionBridgeRejectsDuplicateProviderOptionIDs(t *testing.T) {
	t.Parallel()

	pending := acpAskUserPermissionTestPending([]any{map[string]any{
		"question": "How are you?",
		"options": []any{
			map[string]any{"label": "Good"},
			map[string]any{"label": "Okay"},
		},
	}})
	pending.options[1]["optionId"] = "q0_opt_0"

	_, state, err := normalizeACPAskUserPermissionBridge(pending)
	if state != acpAskUserPermissionBridgeUnsupported ||
		err == nil ||
		!strings.Contains(err.Error(), "duplicate option id") {
		t.Fatalf("normalize bridge state = %v, error = %v, want duplicate option id rejection", state, err)
	}
}

func TestNormalizeACPAskUserPermissionBridgeRejectsAmbiguousOptionMappings(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		mutate    func(*pendingInteractiveRequest)
		wantError string
	}{
		{
			name: "duplicate provider label",
			mutate: func(pending *pendingInteractiveRequest) {
				pending.options[1]["name"] = "Good"
			},
			wantError: "duplicate option label",
		},
		{
			name: "duplicate question label",
			mutate: func(pending *pendingInteractiveRequest) {
				questions := pending.input["questions"].([]any)
				question := questions[0].(map[string]any)
				options := question["options"].([]any)
				options[1].(map[string]any)["label"] = "Good"
			},
			wantError: "duplicate option label",
		},
		{
			name: "rejection id conflicts with selectable id",
			mutate: func(pending *pendingInteractiveRequest) {
				pending.options[2]["optionId"] = "q0_opt_0"
			},
			wantError: "duplicate option id",
		},
		{
			name: "question label has no provider option",
			mutate: func(pending *pendingInteractiveRequest) {
				questions := pending.input["questions"].([]any)
				question := questions[0].(map[string]any)
				options := question["options"].([]any)
				options[1].(map[string]any)["label"] = "Different"
			},
			wantError: "has no provider permission option",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			pending := acpAskUserPermissionTestPending([]any{map[string]any{
				"question": "How are you?",
				"options": []any{
					map[string]any{"label": "Good"},
					map[string]any{"label": "Okay"},
				},
			}})
			tt.mutate(pending)

			_, state, err := normalizeACPAskUserPermissionBridge(pending)
			if state != acpAskUserPermissionBridgeUnsupported ||
				err == nil ||
				!strings.Contains(err.Error(), tt.wantError) {
				t.Fatalf("normalize bridge state = %v, error = %v, want containing %q", state, err, tt.wantError)
			}
		})
	}
}

func TestACPAskUserPermissionOptionIDUsesOnlyCanonicalSingleAnswer(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		optionID  string
		action    string
		payload   map[string]any
		want      string
		wantError string
	}{
		{
			name:   "canonical answer",
			action: "submit",
			payload: map[string]any{
				"answers":             []any{"Okay"},
				"answersByQuestionId": map[string]any{"question-1": "Good"},
			},
			want: "q0_opt_0",
		},
		{
			name:      "display answer is not a routing fallback",
			action:    "submit",
			payload:   map[string]any{"answers": []any{"Good"}},
			wantError: "exactly one canonical answer",
		},
		{
			name:   "multiple question answers",
			action: "submit",
			payload: map[string]any{
				"answersByQuestionId": map[string]any{"question-1": "Good", "question-2": "Okay"},
			},
			wantError: "exactly one canonical answer",
		},
		{
			name:   "array answer",
			action: "submit",
			payload: map[string]any{
				"answersByQuestionId": map[string]any{"question-1": []any{"Good"}},
			},
			wantError: "must be one selected option",
		},
		{
			name:   "wrong question id",
			action: "submit",
			payload: map[string]any{
				"answersByQuestionId": map[string]any{"other": "Good"},
			},
			wantError: `question "question-1" is required`,
		},
		{
			name:   "Other free text is not mapped",
			action: "submit",
			payload: map[string]any{
				"answersByQuestionId": map[string]any{"question-1": "Other: custom answer"},
			},
			wantError: "does not match",
		},
		{
			name:     "explicit option conflicts",
			optionID: "q0_opt_1",
			action:   "submit",
			payload: map[string]any{
				"answersByQuestionId": map[string]any{"question-1": "Good"},
			},
			wantError: "conflicts",
		},
		{
			name:   "cancel maps to provider dismissal",
			action: "cancel",
			want:   "q0_skip",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			pending := acpAskUserPermissionTestPending([]any{map[string]any{
				"question": "How are you?",
				"options": []any{
					map[string]any{"label": "Good"},
					map[string]any{"label": "Okay"},
				},
			}})
			got, err := acpAskUserPermissionOptionID(pending, tt.optionID, tt.action, tt.payload)
			if tt.wantError == "" {
				if err != nil || got != tt.want {
					t.Fatalf("permission option = %q, error = %v, want %q", got, err, tt.want)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.wantError) {
				t.Fatalf("permission option error = %v, want containing %q", err, tt.wantError)
			}
		})
	}
}

func acpAskUserPermissionTestPending(questions []any) *pendingInteractiveRequest {
	return &pendingInteractiveRequest{
		kind:  "ask-user",
		input: map[string]any{"questions": questions},
		options: []map[string]any{
			{"optionId": "q0_opt_0", "name": "Good", "kind": "allow_once"},
			{"optionId": "q0_opt_1", "name": "Okay", "kind": "allow_once"},
			{"optionId": "q0_skip", "name": "Skip", "kind": "reject_once"},
		},
	}
}
