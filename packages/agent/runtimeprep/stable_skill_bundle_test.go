package runtimeprep

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestTuttiAgentStableSkillsReuseRootAcrossSessions(t *testing.T) {
	stateDir := t.TempDir()
	storeRoot := filepath.Join(stateDir, "agent", "skill-bundles")
	preparer := TuttiAgentPreparer{
		ResolveAuthSource: func(context.Context, PrepareInput) (string, error) {
			return "", nil
		},
		StableSkillBundleRoot:       storeRoot,
		StableSystemSkillBundleRoot: filepath.Join(stateDir, "agent", "system-skill-bundles"),
	}
	wantRoot := ""
	for _, sessionID := range []string{"session-a", "session-b"} {
		runtimeRoot := filepath.Join(stateDir, "agent", "runs", sessionID)
		result, err := preparer.Prepare(t.Context(), ProviderPrepareInput{
			PrepareInput: testResolvedInput(t, PrepareInput{
				AgentSessionID: sessionID,
				AgentTargetID:  "local:tutti-agent",
				Provider:       "tutti-agent",
				CLICommand:     "tutti",
			}),
			RuntimeRoot: runtimeRoot,
			Store:       LocalStore{StateDir: stateDir},
		})
		if err != nil {
			t.Fatalf("Prepare(%s) error = %v", sessionID, err)
		}
		var roots []string
		if err := json.Unmarshal(
			[]byte(envValue(result.Env, "TUTTI_AGENT_EXTRA_SKILL_ROOTS_JSON")),
			&roots,
		); err != nil {
			t.Fatalf("Prepare(%s) extra roots = %#v: %v", sessionID, result.Env, err)
		}
		if len(roots) != 1 || !filepath.IsAbs(roots[0]) {
			t.Fatalf("Prepare(%s) roots = %#v, want one absolute root", sessionID, roots)
		}
		if root := envValue(result.Env, "TUTTI_AGENT_STABLE_SYSTEM_SKILLS_ROOT"); root != filepath.Join(stateDir, "agent", "system-skill-bundles") {
			t.Fatalf("Prepare(%s) stable system root = %q", sessionID, root)
		}
		if wantRoot == "" {
			wantRoot = roots[0]
		} else if roots[0] != wantRoot {
			t.Fatalf("stable roots differ: %q != %q", roots[0], wantRoot)
		}
		home := filepath.Join(runtimeRoot, "tutti-agent-home")
		if _, err := os.Stat(filepath.Join(home, "skills")); !os.IsNotExist(err) {
			t.Fatalf("Prepare(%s) created legacy skills root, err = %v", sessionID, err)
		}
		instructions, err := os.ReadFile(filepath.Join(home, "AGENTS.md"))
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(instructions), sessionID) {
			t.Fatalf("Prepare(%s) embedded session id in AGENTS.md", sessionID)
		}
	}
	if _, err := os.Stat(filepath.Join(wantRoot, tuttiSkillName, "SKILL.md")); err != nil {
		t.Fatalf("stable tutti-cli skill missing: %v", err)
	}
	if !strings.Contains(filepath.ToSlash(wantRoot), "/agent/skill-bundles/v1/") {
		t.Fatalf("stable root = %q, want versioned content-addressed path", wantRoot)
	}
}

func TestStableSkillBundleDigestChangesWithContentNotMapOrder(t *testing.T) {
	specA := providerSkillSpec{
		baseName: "sample",
		skillID:  "example/sample",
		files: map[string]string{
			"SKILL.md":            "sample",
			"references/guide.md": "guide",
		},
	}
	specB := providerSkillSpec{
		baseName: "sample",
		skillID:  "example/sample",
		files: map[string]string{
			"references/guide.md": "guide",
			"SKILL.md":            "sample",
		},
	}
	first, _, err := canonicalizeStableProviderSkills("tutti-agent", []providerSkillSpec{specA})
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := canonicalizeStableProviderSkills("tutti-agent", []providerSkillSpec{specB})
	if err != nil {
		t.Fatal(err)
	}
	firstJSON, _ := json.Marshal(first)
	secondJSON, _ := json.Marshal(second)
	if string(firstJSON) != string(secondJSON) {
		t.Fatalf("canonical bundle depends on map order:\n%s\n%s", firstJSON, secondJSON)
	}
	specB.files["SKILL.md"] = "changed"
	changed, _, err := canonicalizeStableProviderSkills("tutti-agent", []providerSkillSpec{specB})
	if err != nil {
		t.Fatal(err)
	}
	changedJSON, _ := json.Marshal(changed)
	if string(firstJSON) == string(changedJSON) {
		t.Fatal("canonical bundle did not change with skill content")
	}
}

func TestStableSkillBundleConcurrentMaterialization(t *testing.T) {
	input := testResolvedInput(t, PrepareInput{
		AgentSessionID: "session-a",
		AgentTargetID:  "local:tutti-agent",
		Provider:       "tutti-agent",
		CLICommand:     "tutti",
	})
	storeRoot := filepath.Join(t.TempDir(), "skill-bundles")
	const workers = 8
	roots := make(chan string, workers)
	errors := make(chan error, workers)
	var group sync.WaitGroup
	for index := 0; index < workers; index++ {
		group.Add(1)
		go func() {
			defer group.Done()
			root, err := materializeStableProviderSkills(storeRoot, input)
			if err != nil {
				errors <- err
				return
			}
			roots <- root
		}()
	}
	group.Wait()
	close(roots)
	close(errors)
	for err := range errors {
		t.Fatalf("materializeStableProviderSkills() error = %v", err)
	}
	want := ""
	for root := range roots {
		if want == "" {
			want = root
		} else if root != want {
			t.Fatalf("concurrent roots differ: %q != %q", root, want)
		}
	}
	if _, err := os.Stat(filepath.Join(want, tuttiSkillName, "SKILL.md")); err != nil {
		t.Fatalf("concurrent bundle is incomplete: %v", err)
	}
}

func TestStableSkillBundleRejectsEscapingSkillName(t *testing.T) {
	_, _, err := canonicalizeStableProviderSkills("tutti-agent", []providerSkillSpec{{
		baseName: "../escape",
		skillID:  "example/escape",
		files:    map[string]string{"SKILL.md": "escape"},
	}})
	if err == nil {
		t.Fatal("canonicalizeStableProviderSkills() error = nil, want escaping name rejection")
	}
}
