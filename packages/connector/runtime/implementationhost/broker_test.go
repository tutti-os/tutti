package implementationhost

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseConnectorSkillUsesYAMLFrontmatter(t *testing.T) {
	skill, err := parseConnectorSkill("---\nname: calendar\ndescription: >-\n  Find meetings for the\n  current account.\n---\n\n# Calendar\n")
	if err != nil {
		t.Fatal(err)
	}
	if skill.Name != "calendar" || skill.Title != "Calendar" || skill.Description != "Find meetings for the current account." {
		t.Fatalf("skill = %+v", skill)
	}
}

func TestParseConnectorSkillUsesNameWhenTitleIsAbsent(t *testing.T) {
	skill, err := parseConnectorSkill("---\nname: whiteboard\ndescription: Edit a whiteboard.\n---\n\nUse the packaged references.\n")
	if err != nil {
		t.Fatal(err)
	}
	if skill.Title != "whiteboard" {
		t.Fatalf("title = %q, want Skill name fallback", skill.Title)
	}
}

func TestLoadConnectorSkillsRecursivelyDiscoversEntriesWithoutManifestList(t *testing.T) {
	root := t.TempDir()
	writeConnectorSkillTestFile(t, filepath.Join(root, "skills", "calendar", "SKILL.md"), "calendar", "Calendar")
	writeConnectorSkillTestFile(t, filepath.Join(root, "skills", "workflows", "standup", "SKILL.md"), "standup", "Standup")
	if err := os.WriteFile(filepath.Join(root, "tutti.connector.json"), []byte(`{"skills":["./skills/not-used/SKILL.md"]}`), 0o600); err != nil {
		t.Fatal(err)
	}

	skills, err := loadConnectorSkills(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(skills) != 2 || skills[0].Name != "calendar" || skills[1].Name != "standup" {
		t.Fatalf("skills = %#v", skills)
	}
	if skills[1].EntryPath != filepath.Join(root, "skills", "workflows", "standup", "SKILL.md") ||
		skills[1].BasePath != filepath.Join(root, "skills", "workflows", "standup") {
		t.Fatalf("standup paths = %#v", skills[1].SkillSummary)
	}
}

func TestLoadConnectorSkillsAllowsMissingOptionalTree(t *testing.T) {
	skills, err := loadConnectorSkills(t.TempDir())
	if err != nil || len(skills) != 0 {
		t.Fatalf("skills = %#v, err = %v", skills, err)
	}
}

func TestLoadConnectorSkillsRejectsDuplicateNames(t *testing.T) {
	root := t.TempDir()
	writeConnectorSkillTestFile(t, filepath.Join(root, "skills", "first", "SKILL.md"), "duplicate", "First")
	writeConnectorSkillTestFile(t, filepath.Join(root, "skills", "second", "SKILL.md"), "duplicate", "Second")
	_, err := loadConnectorSkills(root)
	if err == nil || !strings.Contains(err.Error(), `duplicate Connector Skill "duplicate"`) {
		t.Fatalf("error = %v", err)
	}
}

func writeConnectorSkillTestFile(t *testing.T, path, name, title string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	content := "---\nname: " + name + "\ndescription: Test " + name + ".\n---\n\n# " + title + "\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}
