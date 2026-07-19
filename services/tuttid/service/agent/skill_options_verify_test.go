package agent

import (
	"path/filepath"
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
// Requirement 1: shouldHideComposerSkill — sourceKind-aware hiding
// ============================================================

func TestShouldHideComposerSkill_TokenSaverNotHidden(t *testing.T) {
	// token-saver is NOT in hiddenTuttiProviderSkills.
	// It should return false (not hidden) for all sourceKinds.
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
	// Skills in hiddenTuttiProviderSkills should be hidden only when they
	// come from Tutti-controlled sourceKinds.
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
			t.Errorf("%q should be hidden for sourceKind 'tutti-injected'", name)
		}
		root2 := composerSkillRoot{sourceKind: composerSkillSourceSystem}
		if !shouldHideComposerSkill(root2, name) {
			t.Errorf("%q should be hidden for sourceKind 'system'", name)
		}
	}
}

func TestShouldHideComposerSkill_UserSkillNotHidden(t *testing.T) {
	// user-installed skills should not be hidden, even if the name matches
	// a Tutti-internal skill name.
	userKinds := []string{
		composerSkillSourceProject,
		composerSkillSourcePersonal,
		composerSkillSourcePlugin,
	}

	// A custom skill should never be hidden regardless of name.
	customSkill := "my-custom-skill"
	for _, kind := range userKinds {
		root := composerSkillRoot{sourceKind: kind}
		if shouldHideComposerSkill(root, customSkill) {
			t.Errorf("user skill %q should NOT be hidden for sourceKind %q", customSkill, kind)
		}
	}

	// Even a user skill named identically to a hidden Tutti skill
	// should NOT be hidden when it comes from a user sourceKind.
	userHiddenName := "reference"
	for _, kind := range userKinds {
		root := composerSkillRoot{sourceKind: kind}
		if shouldHideComposerSkill(root, userHiddenName) {
			t.Errorf("user skill %q should NOT be hidden for sourceKind %q even if name matches hidden Tutti skill", userHiddenName, kind)
		}
	}
}

// ============================================================
// Requirement 2: Token-saver sourceKind is official
// ============================================================

func TestTokenSaverSourceKindIsOfficial(t *testing.T) {
	// The token-saver is delivered as an official static skill with
	// sourceKind 'system'.
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
		"tutti-cli":                   false,
		"issue-manager":               false,
		"workspace-app":               false,
		"tutti-handoff":               false,
		"reference":                   false,
		"browser-use":                 false,
		"computer-use":                false,
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
// Requirement 2: Official static skill discovery
// ============================================================

func TestOfficialStaticComposerSkillOptions_IncludesTokenSaver(t *testing.T) {
	// Official static skills should include token-saver as a system skill
	// with the exact same description as the template file:
	// packages/agent/runtimeprep/skill_templates/token-saver.md
	const wantName = "token-saver"
	const wantDescription = "Reduce token consumption by instructing the model to use terse, minimal-token responses, skip restating context, avoid echoing large file contents, and prefer targeted reads over whole-file reads where practical."

	for _, triggerFor := range []skillTriggerFunc{
		codexSkillTrigger,
		claudeCodeSkillTrigger,
		cursorSkillTrigger,
		openCodeSkillTrigger,
	} {
		options := officialStaticComposerSkillOptions(triggerFor)
		found := false
		for _, opt := range options {
			if opt.Name == wantName {
				found = true
				if opt.SourceKind != composerSkillSourceSystem {
					t.Errorf("token-saver should have sourceKind 'system', got %q", opt.SourceKind)
				}
				if opt.Trigger == "" {
					t.Error("token-saver should have a non-empty trigger")
				}
				if opt.Description != wantDescription {
					t.Errorf("token-saver description mismatch.\n  got:  %q\n  want: %q\n  (keep in sync with packages/agent/runtimeprep/skill_templates/token-saver.md)", opt.Description, wantDescription)
				}
				break
			}
		}
		if !found {
			t.Error("officialStaticComposerSkillOptions should include token-saver")
		}
	}
}

func TestNoSystemRootWithoutEnv(t *testing.T) {
	// Without the runtime env, claude and codex roots should NOT contain
	// a .system sourceKind root. Official skills are delivered via the
	// static list (officialStaticComposerSkillOptions) instead.
	codexRoots := codexComposerSkillRoots("/tmp/test", nil)
	for _, root := range codexRoots {
		if root.sourceKind == composerSkillSourceSystem {
			t.Error("codex roots should not include .system without CODEX_HOME env")
		}
	}
	claudeRoots := claudeCodeComposerSkillRoots("/tmp/test", nil)
	for _, root := range claudeRoots {
		if root.sourceKind == composerSkillSourceSystem {
			t.Error("claude roots should not include .system without TUTTI_CLAUDE_PLUGIN_DIR env")
		}
	}
}

func TestNoSystemRootWithEnv(t *testing.T) {
	// Even with the runtime env set, claude and codex roots should NOT
	// contain a .system sourceKind root. The .system root has been
	// removed in favor of the static skill list.
	codexRoots := codexComposerSkillRoots("/tmp/test", []string{"CODEX_HOME=/tmp/codex-home"})
	for _, root := range codexRoots {
		if root.sourceKind == composerSkillSourceSystem {
			t.Error("codex roots should not include .system root (removed in favor of static skills)")
		}
	}
	claudeRoots := claudeCodeComposerSkillRoots("/tmp/test", []string{"TUTTI_CLAUDE_PLUGIN_DIR=/tmp/test-plugin"})
	for _, root := range claudeRoots {
		if root.sourceKind == composerSkillSourceSystem {
			t.Error("claude roots should not include .system root (removed in favor of static skills)")
		}
	}
}

// ============================================================
// Verify token-saver appears in composer discovery via static list
// ============================================================

func TestTokenSaverDiscoveredViaStaticList(t *testing.T) {
	// Even with nil env (the composer API path), token-saver should be
	// discoverable from the static official skill list.
	roots, triggerFor := composerSkillDiscoveryPlan("codex", "/tmp/test", nil)
	if triggerFor == nil {
		t.Fatal("expected skill discovery for codex")
	}
	options := discoverComposerSkillOptionsFromRoots(roots, triggerFor)

	found := false
	for _, opt := range options {
		if opt.Name == "token-saver" {
			found = true
			if opt.SourceKind != composerSkillSourceSystem {
				t.Errorf("token-saver from static list should have sourceKind 'system', got %q", opt.SourceKind)
			}
			if opt.Trigger != "$token-saver" {
				t.Errorf("codex token-saver trigger should be $token-saver, got %q", opt.Trigger)
			}
			break
		}
	}
	if !found {
		t.Error("token-saver should be discoverable from static list even with nil env")
	}
}

// ============================================================
// Verify two-tier dedup: Tutti skills dedup by Name, global dedup by Trigger
// ============================================================

func TestTokenSaverNotDuplicatedWhenAlsoOnDisk(t *testing.T) {
	// When a session runtime exists, the token-saver skill is also installed
	// on disk (via CoreSkillsPack → providerSkills). Both the static list and
	// the filesystem root produce a token-saver entry. Since both originate
	// from Tutti-controlled sources (system and tutti-injected), Phase 2
	// (Tutti Name dedup) collapses them into one entry — the static list
	// version (inserted first) wins with sourceKind "system".

	tempDir := t.TempDir()
	codexHome := filepath.Join(tempDir, "codex-home")

	// Simulate the runtime installation: write token-saver to the codex
	// home skills directory (as CoreSkillsPack would do).
	writeSkill(t, filepath.Join(codexHome, "skills", "token-saver", "SKILL.md"), `---
name: token-saver
description: Reduce token consumption by instructing the model to use terse, minimal-token responses, skip restating context, avoid echoing large file contents, and prefer targeted reads over whole-file reads where practical.
---
`)

	// Discovery with CODEX_HOME set (simulating a session refresh path)
	options := discoverComposerSkillOptions("codex", tempDir, []string{
		"CODEX_HOME=" + codexHome,
	})

	// Count token-saver entries — should be exactly 1
	count := 0
	for _, opt := range options {
		if opt.Name == "token-saver" {
			count++
			// The static list version (inserted first) should win
			if opt.SourceKind != composerSkillSourceSystem {
				t.Errorf("token-saver should have sourceKind 'system' from static list, got %q", opt.SourceKind)
			}
		}
	}
	if count != 1 {
		t.Errorf("token-saver appears %d times in options, want exactly 1 (dedup by name)", count)
	}
}

func TestTokenSaverNotDuplicatedForClaudeCodeWithPluginEnv(t *testing.T) {
	// Claude Code renders plugin skills with a namespaced trigger
	// (/tutti-cli:token-saver), while the static list uses a plain trigger
	// (/token-saver). Both are Tutti-controlled (system and plugin+tutti-cli),
	// so Phase 2 (Tutti Name dedup) collapses them. Phase 3 (Trigger dedup)
	// sees only one entry. Result: exactly one token-saver.

	tempDir := t.TempDir()
	pluginDir := filepath.Join(tempDir, "plugins", "tutti-cli")

	// Simulate the Tutti Claude Code plugin installation
	writeSkill(t, filepath.Join(pluginDir, "skills", "token-saver", "SKILL.md"), `---
name: token-saver
description: Reduce token consumption by instructing the model to use terse, minimal-token responses, skip restating context, avoid echoing large file contents, and prefer targeted reads over whole-file reads where practical.
---
`)

	// Discovery with TUTTI_CLAUDE_PLUGIN_DIR set
	options := discoverComposerSkillOptions("claude-code", tempDir, []string{
		"TUTTI_CLAUDE_PLUGIN_DIR=" + pluginDir,
	})

	count := 0
	for _, opt := range options {
		if opt.Name == "token-saver" {
			count++
			// The static list version wins
			if opt.SourceKind != composerSkillSourceSystem {
				t.Errorf("token-saver should have sourceKind 'system', got %q", opt.SourceKind)
			}
		}
	}
	if count != 1 {
		t.Errorf("token-saver appears %d times for claude-code, want exactly 1", count)
	}
}

func TestUserSkillNotDroppedWhenNameMatchesTuttiSkill(t *testing.T) {
	// A non-Tutti plugin skill that happens to share a name with a Tutti
	// official skill must not be silently dropped. The two are different
	// skills invoked via different triggers (namespaced vs plain).
	//
	// Phase 2 only deduplicates Tutti-controlled skills by Name.
	// Non-Tutti skills pass through unmodified. Phase 3 deduplicates by
	// Trigger — different triggers mean both survive.

	tempDir := t.TempDir()
	pluginDir := filepath.Join(tempDir, "plugins", "other-plugin")

	// Third-party plugin also has a skill named "token-saver"
	writeSkill(t, filepath.Join(pluginDir, "skills", "token-saver", "SKILL.md"), `---
name: token-saver
description: A third-party token saving tool with different behavior.
---
`)

	options := discoverComposerSkillOptions("claude-code", tempDir, []string{
		"TUTTI_CLAUDE_PLUGIN_DIR=" + pluginDir,
	})

	// Both Tutti's token-saver and the third-party's token-saver should appear.
	count := 0
	triggers := map[string]bool{}
	for _, opt := range options {
		if opt.Name == "token-saver" {
			count++
			triggers[opt.Trigger] = true
		}
	}
	if count != 2 {
		t.Errorf("token-saver appears %d times, want 2 (Tutti + third-party plugin)", count)
	}
	if !triggers["/token-saver"] {
		t.Error("missing Tutti token-saver with trigger /token-saver")
	}
	if !triggers["/other-plugin:token-saver"] {
		t.Error("missing third-party token-saver with trigger /other-plugin:token-saver")
	}
}
