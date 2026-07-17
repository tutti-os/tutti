package agent

import (
	"testing"
)

// ============================================================
// Requirement 1: skillSourceRank — official skills rank first
// ============================================================

func TestSkillSourceRank_OfficialSkillsRankBeforeUserInstalled(t *testing.T) {
	// Official skills must have lower rank numbers than user-installed skills.
	officialKinds := []string{
		composerSkillSourceSystem,
		composerSkillSourceTuttiInjected,
	}
	userKinds := []string{
		composerSkillSourceProject,
		composerSkillSourcePersonal,
		composerSkillSourcePlugin,
	}

	for _, official := range officialKinds {
		officialRank := skillSourceRank(official)
		for _, user := range userKinds {
			userRank := skillSourceRank(user)
			if officialRank >= userRank {
				t.Errorf(
					"official skill %q (rank %d) should rank before user skill %q (rank %d)",
					official, officialRank, user, userRank,
				)
			}
		}
	}
}

func TestSkillSourceRank_ExactValues(t *testing.T) {
	tests := []struct {
		sourceKind string
		wantRank   int
	}{
		{composerSkillSourceSystem, 0},
		{composerSkillSourceTuttiInjected, 1},
		{composerSkillSourceProject, 2},
		{composerSkillSourcePersonal, 3},
		{composerSkillSourcePlugin, 4},
		{"unknown-kind", 9},
	}

	for _, test := range tests {
		got := skillSourceRank(test.sourceKind)
		if got != test.wantRank {
			t.Errorf("skillSourceRank(%q) = %d, want %d", test.sourceKind, got, test.wantRank)
		}
	}
}

// ============================================================
// Requirement 1: shouldHideComposerSkill — token-saver visible
// ============================================================

func TestShouldHideComposerSkill_TokenSaverNotHidden(t *testing.T) {
	// token-saver is NOT in hiddenTuttiProviderSkills and is NOT hidden by sourceKind.
	// It should return false (not hidden) regardless of sourceKind.
	kinds := []string{
		composerSkillSourceTuttiInjected,
		composerSkillSourceSystem,
		composerSkillSourceProject,
	}
	for _, kind := range kinds {
		root := composerSkillRoot{sourceKind: kind}
		if shouldHideComposerSkill(root, "token-saver") {
			t.Errorf("token-saver should NOT be hidden for sourceKind %q", kind)
		}
	}
}

func TestShouldHideComposerSkill_HiddenSkillsStayHidden(t *testing.T) {
	// Skills in hiddenTuttiProviderSkills should still be hidden.
	hiddenSkills := []string{
		"tutti-cli",
		"issue-manager",
		"workspace-app",
		"tutti-handoff",
		"reference",
		"browser-use",
		"computer-use",
	}
	for _, name := range hiddenSkills {
		root := composerSkillRoot{sourceKind: composerSkillSourceTuttiInjected}
		if !shouldHideComposerSkill(root, name) {
			t.Errorf("%q should still be hidden", name)
		}
	}
}

func TestShouldHideComposerSkill_UserSkillNotHidden(t *testing.T) {
	// user-installed skills should not be hidden.
	userSkill := "my-custom-skill"
	kinds := []string{
		composerSkillSourceProject,
		composerSkillSourcePersonal,
		composerSkillSourcePlugin,
	}
	for _, kind := range kinds {
		root := composerSkillRoot{sourceKind: kind}
		if shouldHideComposerSkill(root, userSkill) {
			t.Errorf("user skill %q should NOT be hidden for sourceKind %q", userSkill, kind)
		}
	}
}

// ============================================================
// Requirement 2: Token-saver sourceKind is official
// ============================================================

func TestTokenSaverSourceKindIsOfficial(t *testing.T) {
	// The token-saver is installed into .system/ subdirectory,
	// which maps to composerSkillSourceSystem.
	// Verify that "system" is classified as official.
	officialKinds := map[string]bool{
		composerSkillSourceSystem:        true,
		composerSkillSourceTuttiInjected: true,
	}
	if !officialKinds[composerSkillSourceSystem] {
		t.Error("system should be an official sourceKind")
	}
	if !officialKinds[composerSkillSourceTuttiInjected] {
		t.Error("tutti-injected should be an official sourceKind")
	}

	// Verify hiddenTuttiProviderSkills contains all expected entries
	expectedHidden := map[string]bool{
		"tutti-cli":     false,
		"issue-manager": false,
		"workspace-app": false,
		"tutti-handoff": false,
		"reference":     false,
		"browser-use":   false,
		"computer-use":  false,
		"tutti-workspace-app-factory": false,
		"tutti-agent-workspace-app":   false,
	}
	for name := range expectedHidden {
		if _, ok := hiddenTuttiProviderSkills[name]; !ok {
			t.Errorf("hiddenTuttiProviderSkills missing %q", name)
		}
	}
	if len(hiddenTuttiProviderSkills) != len(expectedHidden) {
		t.Errorf("hiddenTuttiProviderSkills has %d entries, want %d", len(hiddenTuttiProviderSkills), len(expectedHidden))
	}
}

// ============================================================
// Requirement 2: Claude Code .system root added
// ============================================================

func TestClaudeCodeSkillRootsIncludesSystemRoot(t *testing.T) {
	env := []string{"TUTTI_CLAUDE_PLUGIN_DIR=/tmp/test-plugin"}
	roots := claudeCodeComposerSkillRoots("/tmp/test", env)

	foundSystem := false
	for _, root := range roots {
		if root.sourceKind == composerSkillSourceSystem {
			foundSystem = true
			break
		}
	}
	if !foundSystem {
		t.Error("claudeCodeComposerSkillRoots should include a .system root with sourceKind 'system'")
	}
}

func TestClaudeCodeSkillRootsWithoutPluginDir(t *testing.T) {
	roots := claudeCodeComposerSkillRoots("/tmp/test", nil)
	for _, root := range roots {
		if root.sourceKind == composerSkillSourceSystem {
			t.Error("without TUTTI_CLAUDE_PLUGIN_DIR, no .system root should be present")
		}
	}
}
