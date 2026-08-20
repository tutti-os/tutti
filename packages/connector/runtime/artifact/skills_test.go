package artifact

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInspectSkillsValidatesAndProjectsRecursiveTree(t *testing.T) {
	root := t.TempDir()
	writeSkillTestFile(t, filepath.Join(root, "skills", "calendar", "SKILL.md"), "calendar", "Calendar")
	writeSkillTestFile(t, filepath.Join(root, "skills", "workflows", "standup", "SKILL.md"), "standup", "Standup")
	projection, err := InspectSkills(root)
	if err != nil {
		t.Fatal(err)
	}
	if projection.Root != filepath.Join(root, "skills") || len(projection.Skills) != 2 ||
		projection.Skills[0].Name != "calendar" || projection.Skills[1].Name != "standup" {
		t.Fatalf("projection = %#v", projection)
	}
}

func TestInspectSkillsAllowsMissingOptionalTree(t *testing.T) {
	projection, err := InspectSkills(t.TempDir())
	if err != nil || projection.Root != "" || len(projection.Skills) != 0 {
		t.Fatalf("projection = %#v, err = %v", projection, err)
	}
}

func TestInspectSkillsRejectsDuplicateNames(t *testing.T) {
	root := t.TempDir()
	writeSkillTestFile(t, filepath.Join(root, "skills", "first", "SKILL.md"), "duplicate", "First")
	writeSkillTestFile(t, filepath.Join(root, "skills", "second", "SKILL.md"), "duplicate", "Second")
	_, err := InspectSkills(root)
	if err == nil || !strings.Contains(err.Error(), `duplicate Connector Skill "duplicate"`) {
		t.Fatalf("error = %v", err)
	}
}

func TestInspectSkillsRejectsSymlink(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "outside")
	writeSkillTestFile(t, filepath.Join(target, "SKILL.md"), "outside", "Outside")
	if err := os.MkdirAll(filepath.Join(root, "skills"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(root, "skills", "linked")); err != nil {
		t.Fatal(err)
	}
	if _, err := InspectSkills(root); err == nil || !strings.Contains(err.Error(), "contains symlink") {
		t.Fatalf("error = %v", err)
	}
}

func TestInspectSkillsDoesNotCountSupportingTreeEntriesAsSkills(t *testing.T) {
	root := t.TempDir()
	writeSkillTestFile(t, filepath.Join(root, "skills", "calendar", "SKILL.md"), "calendar", "Calendar")
	for index := 0; index <= connectorSkillMaxCount; index++ {
		path := filepath.Join(root, "skills", "calendar", "references", fmt.Sprintf("reference-%d.md", index))
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("supporting reference"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	projection, err := InspectSkills(root)
	if err != nil || len(projection.Skills) != 1 || projection.Skills[0].Name != "calendar" {
		t.Fatalf("projection = %#v, error = %v", projection, err)
	}
}

func TestInspectSkillsBoundsSkillCount(t *testing.T) {
	root := t.TempDir()
	for index := 0; index <= connectorSkillMaxCount; index++ {
		name := fmt.Sprintf("skill-%d", index)
		writeSkillTestFile(t, filepath.Join(root, "skills", name, "SKILL.md"), name, name)
	}
	if _, err := InspectSkills(root); err == nil || !strings.Contains(err.Error(), "Skill count exceeds") {
		t.Fatalf("error = %v", err)
	}
}

func TestValidateSkillSummariesBoundsFieldsAndTotalProjection(t *testing.T) {
	valid := SkillSummary{Name: "calendar", Title: "Calendar", Description: "Manage calendar events"}
	tests := []struct {
		name      string
		summaries []SkillSummary
		want      string
	}{
		{name: "name", summaries: []SkillSummary{{Name: strings.Repeat("n", ConnectorSkillNameMaxBytes+1), Title: valid.Title, Description: valid.Description}}, want: "name exceeds"},
		{name: "title", summaries: []SkillSummary{{Name: valid.Name, Title: strings.Repeat("t", ConnectorSkillTitleMaxBytes+1), Description: valid.Description}}, want: "title exceeds"},
		{name: "description", summaries: []SkillSummary{{Name: valid.Name, Title: valid.Title, Description: strings.Repeat("d", ConnectorSkillDescriptionMaxBytes+1)}}, want: "description exceeds"},
		{name: "total", summaries: func() []SkillSummary {
			result := make([]SkillSummary, connectorSkillMaxCount)
			for index := range result {
				result[index] = SkillSummary{Name: fmt.Sprintf("skill-%03d", index), Title: strings.Repeat("t", ConnectorSkillTitleMaxBytes), Description: strings.Repeat("d", ConnectorSkillDescriptionMaxBytes)}
			}
			return result
		}(), want: "projection exceeds"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := ValidateSkillSummaries(test.summaries); err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("ValidateSkillSummaries() error = %v", err)
			}
		})
	}
}

func writeSkillTestFile(t *testing.T, path, name, title string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	content := "---\nname: " + name + "\ndescription: Test " + name + ".\n---\n\n# " + title + "\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}
