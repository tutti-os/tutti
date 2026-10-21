package agent

import (
	"reflect"
	"slices"
	"testing"
)

func TestComposerOpenCodeMiniMaxModels(t *testing.T) {
	const flash = "opencode/minimax-m3.1-flash-free"
	const m3 = "opencode/minimax-m3"
	const legacy = "opencode/minimax-m2.7"
	for _, test := range []struct {
		name        string
		models      []AgentModelOption
		selected    string
		want        []string
		wantDefault string
	}{
		{"MiniMax default", []AgentModelOption{{ID: legacy, IsDefault: true}, {ID: m3}, {ID: flash}}, "", []string{flash, m3}, flash},
		{"explicit legacy", []AgentModelOption{{ID: legacy, IsDefault: true}, {ID: m3}, {ID: flash}}, legacy, []string{flash, m3, legacy}, flash},
		{"M3 only", []AgentModelOption{{ID: legacy, IsDefault: true}, {ID: m3}}, "", []string{m3}, m3},
		{"no invented replacement", []AgentModelOption{{ID: legacy}}, "", []string{}, ""},
		{"preserve neighbors", []AgentModelOption{{ID: "openai/gpt-5", IsDefault: true}, {ID: legacy}, {ID: "opencode/speech-2.8-hd"}, {ID: m3}, {ID: "opencode-minimax/MiniMax-M2.7"}, {ID: flash}}, "", []string{"openai/gpt-5", flash, m3, "opencode/speech-2.8-hd", "opencode-minimax/MiniMax-M2.7"}, "openai/gpt-5"},
	} {
		t.Run(test.name, func(t *testing.T) {
			before := slices.Clone(test.models)
			got := composerOpenCodeMiniMaxModels(test.models, test.selected)
			ids := make([]string, 0, len(got))
			defaultID := ""
			for _, model := range got {
				ids = append(ids, model.ID)
				if model.IsDefault {
					defaultID = model.ID
				}
			}
			if !slices.Equal(ids, test.want) || defaultID != test.wantDefault {
				t.Fatalf("choices %v default %q, want %v default %q", ids, defaultID, test.want, test.wantDefault)
			}
			if !reflect.DeepEqual(test.models, before) {
				t.Fatal("raw catalog mutated")
			}
		})
	}
}
