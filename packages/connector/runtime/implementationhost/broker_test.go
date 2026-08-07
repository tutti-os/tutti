package implementationhost

import "testing"

func TestParseConnectorSkillUsesYAMLFrontmatter(t *testing.T) {
	skill, err := parseConnectorSkill("---\nname: calendar\ndescription: >-\n  Find meetings for the\n  current account.\n---\n\n# Calendar\n")
	if err != nil {
		t.Fatal(err)
	}
	if skill.Name != "calendar" || skill.Title != "Calendar" || skill.Description != "Find meetings for the current account." {
		t.Fatalf("skill = %+v", skill)
	}
}
