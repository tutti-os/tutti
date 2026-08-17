package storesqlite

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestNormalizeAgentSessionRailSectionDerivesKeyFromPath(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	canonical := NormalizeProjectPath(root)
	aliased := root
	if runtime.GOOS == "darwin" {
		// On macOS TempDir is often under /var which is a symlink to /private/var.
		if evaluated, err := filepath.EvalSymlinks(root); err == nil && evaluated != root {
			aliased = root
			canonical = evaluated
		}
	}

	section := normalizeAgentSessionRailSection(RailSection{
		Kind:        RailSectionKindProject,
		ProjectPath: aliased,
		Key:         "project:" + aliased,
	})
	if section.ProjectPath != canonical {
		t.Fatalf("ProjectPath = %q, want %q", section.ProjectPath, canonical)
	}
	wantKey := RailSectionKeyForProject(canonical)
	if section.Key != wantKey {
		t.Fatalf("Key = %q, want %q", section.Key, wantKey)
	}
	if !isValidAgentSessionRailSection(section) {
		t.Fatalf("normalized section should be valid: %#v", section)
	}
}

func TestNormalizeAgentSessionRailSectionRepairsMismatchedKey(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	canonical := NormalizeProjectPath(root)
	section := normalizeAgentSessionRailSection(RailSection{
		Kind:        RailSectionKindProject,
		ProjectPath: canonical,
		Key:         "project:/unrelated/path",
	})
	if section.Key != RailSectionKeyForProject(canonical) {
		t.Fatalf("Key = %q, want derived from path", section.Key)
	}
}

func TestNormalizeRailSectionKeyAliasesCompareEqual(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	canonical := NormalizeProjectPath(root)
	if canonical == root {
		t.Skip("temp dir path is already canonical; no symlink alias to assert")
	}
	if NormalizeRailSectionKey("project:"+root) != NormalizeRailSectionKey("project:"+canonical) {
		t.Fatalf(
			"NormalizeRailSectionKey(%q) != NormalizeRailSectionKey(%q)",
			root,
			canonical,
		)
	}
}

func TestNormalizeAgentSessionRailSectionClearsConversationProjectBinding(t *testing.T) {
	t.Parallel()

	section := normalizeAgentSessionRailSection(RailSection{
		Kind:        RailSectionKindConversations,
		ProjectPath: t.TempDir(),
		Key:         "project:/tmp/x",
	})
	if section.ProjectPath != "" || section.Key != RailSectionKeyConversations {
		t.Fatalf("conversations section = %#v", section)
	}
}

func TestClassifyRailSectionUsesCanonicalProjectKey(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "pkg"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	section := ClassifyRailSection(filepath.Join(root, "pkg"), nil, []string{root})
	want := RailSectionKeyForProject(root)
	if section.Key != want {
		t.Fatalf("ClassifyRailSection key = %q, want %q", section.Key, want)
	}
}

func TestRailSectionKeyForProjectUsesWindowsCaseInsensitiveIdentity(t *testing.T) {
	t.Parallel()

	if runtime.GOOS != "windows" {
		t.Skip("Windows filesystem identity is platform-specific")
	}
	left := `C:\Users\Demo\Repo`
	right := `c:\users\demo\repo`
	if RailSectionKeyForProject(left) != RailSectionKeyForProject(right) {
		t.Fatalf("Windows project keys differ: %q vs %q", RailSectionKeyForProject(left), RailSectionKeyForProject(right))
	}
}

func TestWindowsRailPreservesPOSIXProjectNamespace(t *testing.T) {
	t.Parallel()

	const projectPath = "/workspace/Snake"
	if got := normalizeProjectPathForPlatform(projectPath, "windows"); got != projectPath {
		t.Fatalf("NormalizeProjectPath = %q, want %q", got, projectPath)
	}
	if got := railIdentityPathForPlatform(projectPath, "windows"); got != projectPath {
		t.Fatalf("rail identity = %q, want case-sensitive %q", got, projectPath)
	}
	if !isProjectPathWithinForPlatform(projectPath, projectPath+"/src", "windows") {
		t.Fatalf("POSIX child should remain within %q on Windows", projectPath)
	}
	if isProjectPathWithinForPlatform(projectPath, "/workspace/snake/src", "windows") {
		t.Fatalf("POSIX project identity should remain case-sensitive on Windows")
	}
}

func TestRailSectionKeyForProjectPreservesPOSIXIdentityOnWindows(t *testing.T) {
	t.Parallel()

	if runtime.GOOS != "windows" {
		t.Skip("Windows path normalization is platform-specific")
	}
	const projectPath = "/workspace/Snake"
	if got, want := RailSectionKeyForProject(projectPath), "project:"+projectPath; got != want {
		t.Fatalf("RailSectionKeyForProject = %q, want %q", got, want)
	}
}

func TestIsProjectPathWithinUsesWindowsCaseInsensitiveIdentity(t *testing.T) {
	t.Parallel()

	if runtime.GOOS != "windows" {
		t.Skip("Windows filesystem identity is platform-specific")
	}
	root := filepath.Join(t.TempDir(), "Project")
	child := filepath.Join(root, "Packages", "App")
	if err := os.MkdirAll(child, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if !IsProjectPathWithin(strings.ToUpper(root), strings.ToLower(child)) {
		t.Fatalf("Windows path identity should recognize %q as within %q", child, root)
	}
}
