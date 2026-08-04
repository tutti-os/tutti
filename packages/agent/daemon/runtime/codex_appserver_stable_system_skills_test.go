package agentruntime

import (
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestStableSystemSkillsReuseCanonicalTargetAcrossHomes(t *testing.T) {
	storeRoot := filepath.Join(t.TempDir(), "system-skill-bundles")
	targets := make([]string, 0, 2)
	for _, session := range []string{"session-a", "session-b"} {
		home := filepath.Join(t.TempDir(), session, "tutti-agent-home")
		writeTestSystemSkills(t, filepath.Join(home, "skills", ".system"), "same-version")
		target, _, err := stabilizeTuttiAgentSystemSkills(home, storeRoot)
		if err != nil {
			t.Fatalf("stabilizeTuttiAgentSystemSkills(%s): %v", session, err)
		}
		targets = append(targets, target)
		resolved, err := filepath.EvalSymlinks(filepath.Join(home, "skills", ".system"))
		if err != nil {
			t.Fatal(err)
		}
		canonicalTarget, err := filepath.EvalSymlinks(target)
		if err != nil {
			t.Fatal(err)
		}
		if resolved != canonicalTarget {
			t.Fatalf("resolved system root = %q, want %q", resolved, canonicalTarget)
		}
	}
	if targets[0] != targets[1] {
		t.Fatalf("stable targets differ: %q != %q", targets[0], targets[1])
	}
}

func TestStableSystemSkillsDigestChangesWithProviderContent(t *testing.T) {
	storeRoot := filepath.Join(t.TempDir(), "system-skill-bundles")
	homeA := filepath.Join(t.TempDir(), "home-a")
	homeB := filepath.Join(t.TempDir(), "home-b")
	writeTestSystemSkills(t, filepath.Join(homeA, "skills", ".system"), "version-a")
	writeTestSystemSkills(t, filepath.Join(homeB, "skills", ".system"), "version-b")
	targetA, _, err := stabilizeTuttiAgentSystemSkills(homeA, storeRoot)
	if err != nil {
		t.Fatal(err)
	}
	targetB, _, err := stabilizeTuttiAgentSystemSkills(homeB, storeRoot)
	if err != nil {
		t.Fatal(err)
	}
	if targetA == targetB {
		t.Fatal("provider content change reused stable system target")
	}
}

func TestStableSystemSkillsReuseExistingSymlink(t *testing.T) {
	storeRoot := filepath.Join(t.TempDir(), "system-skill-bundles")
	home := filepath.Join(t.TempDir(), "home")
	writeTestSystemSkills(t, filepath.Join(home, "skills", ".system"), "same-version")
	firstTarget, firstDigest, err := stabilizeTuttiAgentSystemSkills(home, storeRoot)
	if err != nil {
		t.Fatal(err)
	}
	secondTarget, secondDigest, err := stabilizeTuttiAgentSystemSkills(home, storeRoot)
	if err != nil {
		t.Fatal(err)
	}
	canonicalFirst, err := filepath.EvalSymlinks(firstTarget)
	if err != nil {
		t.Fatal(err)
	}
	if secondTarget != canonicalFirst || secondDigest != firstDigest {
		t.Fatalf("existing symlink resolved to target=%q digest=%q, want %q %q", secondTarget, secondDigest, canonicalFirst, firstDigest)
	}
}

func TestStableSystemSkillsConcurrentMaterialization(t *testing.T) {
	storeRoot := filepath.Join(t.TempDir(), "system-skill-bundles")
	const workers = 8
	targets := make(chan string, workers)
	errors := make(chan error, workers)
	var group sync.WaitGroup
	for index := 0; index < workers; index++ {
		group.Add(1)
		go func(index int) {
			defer group.Done()
			home := filepath.Join(t.TempDir(), "home", string(rune('a'+index)))
			writeSystemSkillsForConcurrentTest(t, filepath.Join(home, "skills", ".system"))
			target, _, err := stabilizeTuttiAgentSystemSkills(home, storeRoot)
			if err != nil {
				errors <- err
				return
			}
			targets <- target
		}(index)
	}
	group.Wait()
	close(targets)
	close(errors)
	for err := range errors {
		t.Fatalf("concurrent stabilization: %v", err)
	}
	want := ""
	for target := range targets {
		if want == "" {
			want = target
		} else if target != want {
			t.Fatalf("concurrent targets differ: %q != %q", target, want)
		}
	}
}

func TestStableSystemSkillsRejectSymlinkInProviderBundle(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	root := filepath.Join(home, "skills", ".system")
	writeTestSystemSkills(t, root, "same-version")
	if err := os.Symlink(filepath.Join(root, "skill-creator", "SKILL.md"), filepath.Join(root, "alias")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := stabilizeTuttiAgentSystemSkills(home, filepath.Join(t.TempDir(), "store")); err == nil {
		t.Fatal("stabilization accepted a symlink in provider system skills")
	}
}

func TestSystemSkillReplacementPreservesBackupWhenActivationAndRestoreFail(t *testing.T) {
	parent := t.TempDir()
	systemRoot := filepath.Join(parent, ".system")
	writeTestSystemSkills(t, systemRoot, "same-version")
	target := filepath.Join(t.TempDir(), ".system")

	renameCalls := 0
	rename := func(oldPath string, newPath string) error {
		renameCalls++
		switch renameCalls {
		case 1:
			return os.Rename(oldPath, newPath)
		case 2:
			return errors.New("injected activation failure")
		default:
			return errors.New("injected restore failure")
		}
	}
	err := replaceSystemSkillRootWithSymlinkUsingRename(systemRoot, target, rename)
	if err == nil {
		t.Fatal("replacement error = nil, want activation and restore failure")
	}
	staging, globErr := filepath.Glob(filepath.Join(parent, ".system-stabilize-*"))
	if globErr != nil {
		t.Fatal(globErr)
	}
	if len(staging) != 1 {
		t.Fatalf("preserved staging directories = %#v, want one", staging)
	}
	backupSkill := filepath.Join(staging[0], "original", "skill-creator", "SKILL.md")
	if _, statErr := os.Stat(backupSkill); statErr != nil {
		t.Fatalf("preserved backup skill: %v", statErr)
	}
}

func writeSystemSkillsForConcurrentTest(t *testing.T, root string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(root, "skill-creator"), 0o755); err != nil {
		t.Error(err)
		return
	}
	for path, content := range map[string]string{
		systemSkillsMarkerFile:   "same-version\n",
		"skill-creator/SKILL.md": "---\nname: skill-creator\ndescription: test\n---\n",
	} {
		if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(path)), []byte(content), 0o644); err != nil {
			t.Error(err)
			return
		}
	}
}
