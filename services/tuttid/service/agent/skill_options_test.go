package agent

import (
	"bytes"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDiscoverComposerSkillOptionsCodexUsesProviderNativeTriggers(t *testing.T) {
	tempDir := t.TempDir()
	homeDir := filepath.Join(tempDir, "home")
	repoDir := filepath.Join(tempDir, "repo")
	cwd := filepath.Join(repoDir, "packages", "app")
	codexHome := filepath.Join(tempDir, "runtime", "codex-home")
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)

	writeSkill(t, filepath.Join(repoDir, ".codex", "skills", "architecture-review", "SKILL.md"), `---
description: Review architecture changes.
---

Review repository changes.
`)
	writeSkill(t, filepath.Join(homeDir, ".agents", "skills", "lark-doc", "SKILL.md"), `---
description: >
  Work with Lark documents.
  Search and edit cloud docs.
---
`)
	writeSkill(t, filepath.Join(homeDir, ".agents", "skills", "broken-agents", "SKILL.md"), `description: Missing frontmatter delimiter.
---
`)
	writeSkill(t, filepath.Join(homeDir, ".codex", "skills", "caveman", "SKILL.md"), `---
description: >
  Ultra-compressed communication mode.
  Use when the user asks to be brief.
---
`)
	writeSkill(t, filepath.Join(homeDir, ".codex", "skills", "broken-codex", "SKILL.md"), `---
description: Missing closing delimiter.
`)
	writeSkill(t, filepath.Join(homeDir, ".codex", "skills", ".system", "hidden", "SKILL.md"), `---
description: Hidden system skill.
---
`)
	writeSkill(t, filepath.Join(codexHome, "skills", ".system", "imagegen", "SKILL.md"), `---
description: Generate images.
---
`)
	writeSkill(t, filepath.Join(codexHome, "skills", "tutti-cli", "SKILL.md"), `---
description: Internal Tutti CLI.
---
`)

	options := discoverComposerSkillOptions("codex", cwd, []string{
		"CODEX_HOME=" + codexHome,
	})

	triggers := composerSkillOptionTriggers(options)
	want := []string{"$architecture-review", "$caveman", "$lark-doc", "$imagegen"}
	if !equalStringSlices(triggers, want) {
		t.Fatalf("triggers = %#v, want %#v", triggers, want)
	}
	if options[0].SourceKind != "project" || options[1].SourceKind != "personal" || options[2].SourceKind != "personal" || options[3].SourceKind != "system" {
		t.Fatalf("source kinds = %#v", options)
	}
	if options[1].Description != "Ultra-compressed communication mode. Use when the user asks to be brief." {
		t.Fatalf("codex personal description = %q", options[1].Description)
	}
	if options[2].Description != "Work with Lark documents. Search and edit cloud docs." {
		t.Fatalf("folded description = %q", options[2].Description)
	}
}

func TestDiscoverComposerSkillOptionsClaudeUsesSlashAndPluginNamespace(t *testing.T) {
	tempDir := t.TempDir()
	homeDir := filepath.Join(tempDir, "home")
	repoDir := filepath.Join(tempDir, "repo")
	cwd := filepath.Join(repoDir, "apps", "desktop")
	pluginDir := filepath.Join(tempDir, "plugins", "product-design")
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)

	writeSkill(t, filepath.Join(repoDir, ".claude", "skills", "summarize", "SKILL.md"), `---
description: Summarize changes.
---
`)
	writeSkill(t, filepath.Join(homeDir, ".claude", "skills", "personal-review", "SKILL.md"), `---
description: Review personal workflow.
---
`)
	writeSkill(t, filepath.Join(pluginDir, "skills", "frontend-design", "SKILL.md"), `---
description: Design frontend UI.
---
`)
	writeSkill(t, filepath.Join(pluginDir, "skills", "tutti-cli", "SKILL.md"), `---
description: Internal Tutti CLI.
---
`)

	options := discoverComposerSkillOptions("claude-code", cwd, []string{
		"TUTTI_CLAUDE_PLUGIN_DIR=" + pluginDir,
	})

	triggers := composerSkillOptionTriggers(options)
	want := []string{"/summarize", "/personal-review", "/product-design:frontend-design"}
	if !equalStringSlices(triggers, want) {
		t.Fatalf("triggers = %#v, want %#v", triggers, want)
	}
	if options[2].PluginName != "product-design" || options[2].SourceKind != "plugin" {
		t.Fatalf("plugin option = %#v", options[2])
	}
}

func TestDiscoverComposerSkillOptionsCursorUsesPluginDir(t *testing.T) {
	tempDir := t.TempDir()
	homeDir := filepath.Join(tempDir, "home")
	repoDir := filepath.Join(tempDir, "repo")
	cwd := filepath.Join(repoDir, "apps", "desktop")
	pluginDir := filepath.Join(tempDir, "plugins", "tutti-cli")
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)

	writeSkill(t, filepath.Join(repoDir, ".cursor", "skills", "project-skill", "SKILL.md"), `---
description: Project Cursor skill.
---
`)
	writeSkill(t, filepath.Join(homeDir, ".cursor", "skills", "personal-skill", "SKILL.md"), `---
description: Personal Cursor skill.
---
`)
	writeSkill(t, filepath.Join(pluginDir, "skills", "workflow-check", "SKILL.md"), `---
description: Runtime Cursor plugin skill.
---
`)
	writeSkill(t, filepath.Join(pluginDir, "skills", "tutti-cli", "SKILL.md"), `---
description: Internal Tutti CLI.
---
`)

	options := discoverComposerSkillOptions("cursor", cwd, []string{
		"TUTTI_CURSOR_PLUGIN_DIR=" + pluginDir,
	})

	triggers := composerSkillOptionTriggers(options)
	want := []string{"$project-skill", "$personal-skill", "$workflow-check"}
	if !equalStringSlices(triggers, want) {
		t.Fatalf("triggers = %#v, want %#v", triggers, want)
	}
	if options[2].PluginName != "tutti-cli" || options[2].SourceKind != "plugin" {
		t.Fatalf("plugin option = %#v", options[2])
	}
}

func TestDiscoverComposerSkillOptionsWarnsOnceForUnchangedInvalidSkill(t *testing.T) {
	tempDir := t.TempDir()
	homeDir := filepath.Join(tempDir, "home")
	cwd := filepath.Join(tempDir, "repo")
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)
	skillPath := filepath.Join(homeDir, ".codex", "skills", "broken", "SKILL.md")
	writeSkill(t, skillPath, `description: Missing frontmatter delimiter.
---
`)
	skillMetadataCache.mu.Lock()
	skillMetadataCache.entries = make(map[string]skillMetadataCacheEntry)
	skillMetadataCache.mu.Unlock()
	var output bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&output, nil)))
	t.Cleanup(func() {
		slog.SetDefault(previousLogger)
	})

	_ = discoverComposerSkillOptions("codex", cwd, nil)
	_ = discoverComposerSkillOptions("codex", cwd, nil)

	if count := strings.Count(output.String(), "skill_frontmatter_invalid"); count != 1 {
		t.Fatalf("invalid frontmatter warnings = %d, want 1; output:\n%s", count, output.String())
	}

	writeSkill(t, skillPath, `description: Still missing frontmatter delimiter.
---
`)
	modTime := time.Now().Add(2 * time.Second)
	if err := os.Chtimes(skillPath, modTime, modTime); err != nil {
		t.Fatalf("Chtimes: %v", err)
	}
	_ = discoverComposerSkillOptions("codex", cwd, nil)

	if count := strings.Count(output.String(), "skill_frontmatter_invalid"); count != 2 {
		t.Fatalf("invalid frontmatter warnings after modification = %d, want 2; output:\n%s", count, output.String())
	}
}

func TestReadSkillMetadataSupportsFoldedDescription(t *testing.T) {
	path := filepath.Join(t.TempDir(), "SKILL.md")
	writeSkill(t, path, `---
name: lark-whiteboard
version: 1.0.0
description: >
  飞书画板：查询和编辑飞书云文档中的画板。
  支持导出画板为预览图片、导出原始节点结构。
metadata:
  requires:
    bins: ["lark-cli"]
---
`)

	metadata, ok := readSkillMetadata(path)
	if !ok {
		t.Fatalf("readSkillMetadata() ok = false, want true")
	}
	if metadata.name != "lark-whiteboard" {
		t.Fatalf("name = %q", metadata.name)
	}
	want := "飞书画板：查询和编辑飞书云文档中的画板。 支持导出画板为预览图片、导出原始节点结构。"
	if metadata.description != want {
		t.Fatalf("description = %q, want %q", metadata.description, want)
	}
}

func TestReadSkillMetadataRejectsMissingDelimitedFrontmatter(t *testing.T) {
	tempDir := t.TempDir()
	tests := []struct {
		name    string
		content string
	}{
		{
			name: "missing start delimiter",
			content: `name: broken
---
`,
		},
		{
			name: "missing end delimiter",
			content: `---
name: broken
`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(tempDir, test.name, "SKILL.md")
			writeSkill(t, path, test.content)

			metadata, ok := readSkillMetadata(path)

			if ok {
				t.Fatalf("readSkillMetadata() ok = true, want false")
			}
			if metadata.name != "" || metadata.description != "" {
				t.Fatalf("metadata = %#v, want empty", metadata)
			}
		})
	}
}

func writeSkill(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
}

func composerSkillOptionTriggers(options []ComposerSkillOption) []string {
	triggers := make([]string, 0, len(options))
	for _, option := range options {
		triggers = append(triggers, option.Trigger)
	}
	return triggers
}

func equalStringSlices(left []string, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
