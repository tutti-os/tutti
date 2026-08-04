package agent

import "testing"

func TestComposerSettingsWithRuntimeSnapshotRestoresCodexSaverMode(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		name     string
		stored   bool
		snapshot *bool
		want     bool
	}{
		{name: "enabled snapshot wins over stale runtime", stored: false, snapshot: boolPointer(true), want: true},
		{name: "disabled snapshot wins over stale runtime", stored: true, snapshot: boolPointer(false), want: false},
		{name: "legacy snapshot preserves observed setting", stored: true, snapshot: nil, want: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			input := CreateSessionInput{AgentTargetID: "local:codex"}
			if test.snapshot != nil {
				input.CodexSaverMode = test.snapshot
			}
			runtimeContext := runtimeContextWithSessionRuntimeSnapshot(
				nil,
				input,
				"codex",
				modelPlanResolution{ModelConfiguration: newProviderNativeModelConfiguration("codex", "local:codex")},
			)

			got := composerSettingsWithRuntimeSnapshot(
				ComposerSettings{CodexSaverMode: test.stored},
				runtimeContext,
			)
			if got.CodexSaverMode != test.want {
				t.Fatalf("codex saver mode = %t, want %t", got.CodexSaverMode, test.want)
			}
		})
	}
}
