package workspacefiles

import "testing"

func TestScoreSearchCandidatesRanksBasenameBeforePath(t *testing.T) {
	entries := ScoreSearchCandidates("/workspace", "dock", []SearchCandidate{
		{Kind: EntryKindFile, RelativePath: "src/components/fileTransferDockController.ts"},
		{Kind: EntryKindFile, RelativePath: "dock.ts"},
		{Kind: EntryKindFile, RelativePath: "docs/workspace.md"},
	}, 10)

	if len(entries) < 2 {
		t.Fatalf("entries length = %d, want at least 2", len(entries))
	}
	if entries[0].Path != "/workspace/dock.ts" {
		t.Fatalf("top entry = %q, want /workspace/dock.ts", entries[0].Path)
	}
	if entries[0].MatchTarget != SearchMatchTargetBasename {
		t.Fatalf("top entry matchTarget = %q, want %q", entries[0].MatchTarget, SearchMatchTargetBasename)
	}
	if len(entries[0].MatchIndices) == 0 {
		t.Fatal("expected basename match indices")
	}
}

func TestScoreSearchCandidatesSupportsMultiTokenBasenameQuery(t *testing.T) {
	entries := ScoreSearchCandidates("/workspace", "dock cont", []SearchCandidate{
		{Kind: EntryKindFile, RelativePath: "src/components/fileTransferDockController.ts"},
		{Kind: EntryKindFile, RelativePath: "src/components/DockPanel.tsx"},
	}, 10)

	if len(entries) == 0 {
		t.Fatal("expected a fuzzy path match")
	}
	if entries[0].Path != "/workspace/src/components/fileTransferDockController.ts" {
		t.Fatalf("top entry = %q", entries[0].Path)
	}
}

func TestScoreSearchCandidatesRanksExactBasenameBeforeParentPathMatch(t *testing.T) {
	entries := ScoreSearchCandidates("/workspace", "New Project", []SearchCandidate{
		{Kind: EntryKindDirectory, RelativePath: "Documents/New project/OpenCovibe/messages"},
		{Kind: EntryKindDirectory, RelativePath: "Documents/New project"},
	}, 10)

	if len(entries) != 2 {
		t.Fatalf("entries = %#v, want basename and parent-path matches", entries)
	}
	if entries[0].Path != "/workspace/Documents/New project" {
		t.Fatalf("entry = %#v, want New project directory only", entries[0])
	}
	if entries[0].MatchTarget != SearchMatchTargetBasename {
		t.Fatalf("matchTarget = %q, want %q", entries[0].MatchTarget, SearchMatchTargetBasename)
	}
}

func TestScoreSearchCandidatesTreatsDotQueryAsLiteralFilenameFragment(t *testing.T) {
	entries := ScoreSearchCandidates("/workspace", ".dmg", []SearchCandidate{
		{Kind: EntryKindFile, RelativePath: ".agents/skills/baoyu-slide-deck/scripts/merge-to-pdf.ts"},
		{Kind: EntryKindFile, RelativePath: ".dmg/readme.md"},
		{Kind: EntryKindFile, RelativePath: "Downloads/googlechrome.dmg"},
	}, 10)

	if len(entries) != 1 {
		t.Fatalf("entries length = %d, want 1: %#v", len(entries), entries)
	}
	if entries[0].Path != "/workspace/Downloads/googlechrome.dmg" {
		t.Fatalf("entry = %#v, want Downloads/googlechrome.dmg", entries[0])
	}
	if entries[0].MatchTarget != SearchMatchTargetBasename {
		t.Fatalf("matchTarget = %q, want %q", entries[0].MatchTarget, SearchMatchTargetBasename)
	}
}

func TestScoreSearchCandidatesRejectsEscapingHomeRelativePath(t *testing.T) {
	entries := ScoreSearchCandidates("/workspace", "~//../secret", []SearchCandidate{
		{Kind: EntryKindFile, RelativePath: "secret"},
	}, 10)

	if len(entries) != 0 {
		t.Fatalf("entries = %#v, want no matches outside logical root", entries)
	}
}

func TestScoreSearchCandidatesDoesNotFuzzyMatchDotLiteralInsideExtension(t *testing.T) {
	entries := ScoreSearchCandidates("/workspace", ".pos", []SearchCandidate{
		{Kind: EntryKindFile, RelativePath: ".cache/codex/resources_en_US.properties"},
		{Kind: EntryKindFile, RelativePath: "models/sample.pos"},
	}, 10)

	if len(entries) != 1 {
		t.Fatalf("entries length = %d, want 1: %#v", len(entries), entries)
	}
	if entries[0].Path != "/workspace/models/sample.pos" {
		t.Fatalf("entry = %#v, want models/sample.pos", entries[0])
	}
}

func TestScoreSearchCandidatesDoesNotFuzzyMatchMissingDotLiteralInMultiTokenQuery(t *testing.T) {
	entries := ScoreSearchCandidates("/workspace", ".dmg pdf", []SearchCandidate{
		{Kind: EntryKindFile, RelativePath: ".agents/skills/baoyu-slide-deck/scripts/merge-to-pdf.ts"},
		{Kind: EntryKindFile, RelativePath: "Downloads/googlechrome.dmg"},
		{Kind: EntryKindFile, RelativePath: "Downloads/pdf-tools.dmg"},
	}, 10)

	if len(entries) != 0 {
		t.Fatalf("entries = %#v, want no false-positive matches", entries)
	}
}

func TestScoreSearchCandidatesRequiresDotLiteralForMultiTokenQuery(t *testing.T) {
	entries := ScoreSearchCandidates("/workspace", "pdf .dmg", []SearchCandidate{
		{Kind: EntryKindFile, RelativePath: ".agents/skills/baoyu-slide-deck/scripts/merge-to-pdf.ts"},
		{Kind: EntryKindFile, RelativePath: "Downloads/googlechrome.dmg"},
		{Kind: EntryKindFile, RelativePath: "Downloads/pdf-tools.dmg"},
	}, 10)

	if len(entries) != 1 {
		t.Fatalf("entries length = %d, want 1: %#v", len(entries), entries)
	}
	if entries[0].Path != "/workspace/Downloads/pdf-tools.dmg" {
		t.Fatalf("entry = %#v, want Downloads/pdf-tools.dmg", entries[0])
	}
}

func TestScoreSearchCandidatesSupportsWordThenDotLiteralQuery(t *testing.T) {
	entries := ScoreSearchCandidates("/workspace", "chrome .dmg", []SearchCandidate{
		{Kind: EntryKindFile, RelativePath: ".agents/skills/baoyu-slide-deck/scripts/merge-to-pdf.ts"},
		{Kind: EntryKindFile, RelativePath: "Downloads/googlechrome.dmg"},
	}, 10)

	if len(entries) != 1 {
		t.Fatalf("entries length = %d, want 1: %#v", len(entries), entries)
	}
	if entries[0].Path != "/workspace/Downloads/googlechrome.dmg" {
		t.Fatalf("entry = %#v, want Downloads/googlechrome.dmg", entries[0])
	}
}

func TestSearchQueryTargetsHiddenOrNoiseDoesNotTreatPathExtensionAsDirectoryIntent(t *testing.T) {
	if SearchQueryTargetsHiddenOrNoise("Downloads/.dmg") {
		t.Fatal("Downloads/.dmg should target a filename extension, not hidden directories")
	}
	if !SearchQueryTargetsHiddenOrNoise(".hidden/file") {
		t.Fatal(".hidden/file should target a hidden directory")
	}
	if !SearchQueryTargetsHiddenOrNoise("src/.hidden/") {
		t.Fatal("src/.hidden/ should target a hidden directory")
	}
}

func TestScoreSearchCandidatesMatchesSlashQueryAgainstRelativePath(t *testing.T) {
	entries := ScoreSearchCandidates("/workspace", "tsh/", []SearchCandidate{
		{Kind: EntryKindFile, RelativePath: ".agents/skills/lark-shared/SKILL.md"},
		{Kind: EntryKindFile, RelativePath: "tools/tsh/runtime.md"},
		{Kind: EntryKindFile, RelativePath: "notes/ts-helper/readme.md"},
	}, 10)

	if len(entries) != 1 || entries[0].Path != "/workspace/tools/tsh/runtime.md" {
		t.Fatalf("entries = %#v, want tools/tsh/runtime.md", entries)
	}
}

func TestScoreSearchCandidatesPenalizesHiddenAndNoisePaths(t *testing.T) {
	entries := ScoreSearchCandidates("/workspace", "skill", []SearchCandidate{
		{Kind: EntryKindFile, RelativePath: ".agents/skills/skill.md"},
		{Kind: EntryKindFile, RelativePath: "docs/skill.md"},
	}, 10)

	if len(entries) < 2 {
		t.Fatalf("entries length = %d, want at least 2", len(entries))
	}
	if entries[0].Path != "/workspace/docs/skill.md" {
		t.Fatalf("top entry = %q, want /workspace/docs/skill.md", entries[0].Path)
	}
}

func TestScoreSearchCandidatesDoesNotMatchHiddenParentPath(t *testing.T) {
	entries := ScoreSearchCandidates("/workspace", ".agents skill", []SearchCandidate{
		{Kind: EntryKindFile, RelativePath: ".agents/skills/skill.md"},
		{Kind: EntryKindFile, RelativePath: "docs/skill.md"},
	}, 10)

	if len(entries) != 0 {
		t.Fatalf("entries = %#v, want no parent-path matches", entries)
	}
}

func TestScoreSearchCandidatesMatchesExplicitHiddenPathIntentQuery(t *testing.T) {
	entries := ScoreSearchCandidates("/workspace", ".git/conf", []SearchCandidate{
		{Kind: EntryKindFile, RelativePath: ".git/config"},
		{Kind: EntryKindFile, RelativePath: "configs/git.conf"},
	}, 10)

	if len(entries) == 0 || entries[0].Path != "/workspace/.git/config" {
		t.Fatalf("entries = %#v, want explicit hidden path first", entries)
	}
}

func TestScoreSearchCandidatesKeepsDirectBasenameHitAheadOfHiddenFallback(t *testing.T) {
	entries := ScoreSearchCandidates("/workspace", "tsh", []SearchCandidate{
		{Kind: EntryKindFile, RelativePath: ".agents/tsh/hooks/README.md"},
		{Kind: EntryKindFile, RelativePath: "notes/about-tsh.md"},
		{Kind: EntryKindFile, RelativePath: "tsh.md"},
	}, 10)

	if len(entries) < 2 {
		t.Fatalf("entries length = %d, want at least 2", len(entries))
	}
	if entries[0].Path != "/workspace/tsh.md" {
		t.Fatalf("top entry = %q, want /workspace/tsh.md", entries[0].Path)
	}
}

func TestScoreSearchCandidatesPrefersDirectoryForTrailingSlashQuery(t *testing.T) {
	entries := ScoreSearchCandidates("/workspace", "src/", []SearchCandidate{
		{Kind: EntryKindFile, RelativePath: "src.md"},
		{Kind: EntryKindDirectory, RelativePath: "src"},
	}, 10)

	if len(entries) != 1 {
		t.Fatalf("entries = %#v, want only the directory match", entries)
	}
	if entries[0].Kind != EntryKindDirectory || entries[0].Path != "/workspace/src" {
		t.Fatalf("top entry = %#v, want directory /workspace/src", entries[0])
	}
}

func TestScoreSearchCandidatesRejectsRelativePathTraversal(t *testing.T) {
	entries := ScoreSearchCandidates("/workspace", "../secret", []SearchCandidate{
		{Kind: EntryKindFile, RelativePath: "secret"},
	}, 10)

	if len(entries) != 0 {
		t.Fatalf("entries = %#v, want no matches outside logical root", entries)
	}
}

func TestScoreSearchCandidatesMatchesPathSegmentOrder(t *testing.T) {
	entries := ScoreSearchCandidates("/workspace", "docs/work", []SearchCandidate{
		{Kind: EntryKindFile, RelativePath: "docs/workspace.md"},
		{Kind: EntryKindFile, RelativePath: "workspace/docs.md"},
		{Kind: EntryKindFile, RelativePath: "notes/workspace-docs.md"},
	}, 10)

	if len(entries) == 0 || entries[0].Path != "/workspace/docs/workspace.md" {
		t.Fatalf("entries = %#v, want docs/workspace.md", entries)
	}
}

func TestScoreSearchCandidatesRanksExactBasenameBeforeStemAndFuzzyMatches(t *testing.T) {
	entries := ScoreSearchCandidates("/Users/Sun", "user", []SearchCandidate{
		{Kind: EntryKindFile, RelativePath: "project/renderer.js"},
		{Kind: EntryKindFile, RelativePath: "docs/USER.md"},
		{Kind: EntryKindDirectory, RelativePath: "user"},
		{Kind: EntryKindFile, RelativePath: "src/user.go"},
		{Kind: EntryKindFile, RelativePath: "src/user_test.go"},
	}, 10)

	if len(entries) != 4 {
		t.Fatalf("entries = %#v, want four name matches", entries)
	}
	if entries[0].Path != "/Users/Sun/user" {
		t.Fatalf("top entry = %#v, want exact folder /Users/Sun/user", entries[0])
	}
	if entries[1].Path != "/Users/Sun/docs/USER.md" {
		t.Fatalf("second entry = %#v, want exact stem USER.md", entries[1])
	}
}

func TestScoreSearchCandidatesRanksExactFileBeforeFuzzyDirectory(t *testing.T) {
	entries := ScoreSearchCandidates("/workspace", "load_log", []SearchCandidate{
		{Kind: EntryKindDirectory, RelativePath: "downloaded_catalog_data"},
		{Kind: EntryKindFile, RelativePath: "load_log"},
	}, 10)

	if len(entries) != 2 {
		t.Fatalf("entries = %#v, want exact and fuzzy matches", entries)
	}
	if entries[0].Path != "/workspace/load_log" || entries[0].Kind != EntryKindFile {
		t.Fatalf("top entry = %#v, want exact file /workspace/load_log", entries[0])
	}
}

func TestScoreSearchCandidatesNormalizesLogicalAbsolutePathQuery(t *testing.T) {
	entries := ScoreSearchCandidates("/Users/Sun", "/Users/Sun/src/user", []SearchCandidate{
		{Kind: EntryKindDirectory, RelativePath: "src/user"},
		{Kind: EntryKindDirectory, RelativePath: "archive/src/user"},
		{Kind: EntryKindFile, RelativePath: "src/user.go"},
	}, 10)

	if len(entries) == 0 || entries[0].Path != "/Users/Sun/src/user" {
		t.Fatalf("entries = %#v, want exact absolute-path target first", entries)
	}
}

func TestScoreSearchCandidatesRejectsAbsolutePathOutsideLogicalRoot(t *testing.T) {
	entries := ScoreSearchCandidates("/Users/Sun", "/Users/Other/src/user", []SearchCandidate{
		{Kind: EntryKindDirectory, RelativePath: "src/user"},
	}, 10)

	if len(entries) != 0 {
		t.Fatalf("entries = %#v, want no matches outside logical root", entries)
	}
}

func TestScoreSearchCandidatesLimitsAndFiltersInvalidCandidates(t *testing.T) {
	entries := ScoreSearchCandidates("/workspace", "file", []SearchCandidate{
		{Kind: EntryKindFile, RelativePath: "src/file-one.ts"},
		{Kind: EntryKindDirectory, RelativePath: "src/file-two"},
		{Kind: EntryKindUnknown, RelativePath: "src/file-three"},
		{Kind: EntryKindFile, RelativePath: "../file-four"},
	}, 1)

	if len(entries) != 1 {
		t.Fatalf("entries length = %d, want 1", len(entries))
	}
	if entries[0].Kind != EntryKindDirectory && entries[0].Kind != EntryKindFile {
		t.Fatalf("unexpected kind %q", entries[0].Kind)
	}
}

func TestSubsequenceMatchUsesUnicodeCodePointsAndByteOffsets(t *testing.T) {
	if _, _, _, _, ok := subsequenceMatch("义市字", "中"); ok {
		t.Fatal("subsequenceMatch() matched UTF-8 bytes across unrelated code points")
	}

	start, span, gaps, indices, ok := subsequenceMatch("甲中文", "中")
	if !ok {
		t.Fatal("subsequenceMatch() did not match an exact Unicode code point")
	}
	if start != 3 || span != 3 || gaps != 0 {
		t.Fatalf("match metrics = (%d, %d, %d), want UTF-8 byte offsets (3, 3, 0)", start, span, gaps)
	}
	wantIndices := []int{3, 4, 5}
	if len(indices) != len(wantIndices) {
		t.Fatalf("indices = %#v, want %#v", indices, wantIndices)
	}
	for index := range wantIndices {
		if indices[index] != wantIndices[index] {
			t.Fatalf("indices = %#v, want %#v", indices, wantIndices)
		}
	}
}

func TestNormalizeSearchKinds(t *testing.T) {
	got, err := NormalizeSearchKinds([]EntryKind{EntryKindFile, EntryKindFile})
	if err != nil {
		t.Fatalf("NormalizeSearchKinds() error = %v", err)
	}
	if len(got) != 1 || got[0] != EntryKindFile {
		t.Fatalf("NormalizeSearchKinds() = %#v", got)
	}

	got, err = NormalizeSearchKinds(nil)
	if err != nil {
		t.Fatalf("NormalizeSearchKinds(nil) error = %v", err)
	}
	if len(got) != 2 || got[0] != EntryKindFile || got[1] != EntryKindDirectory {
		t.Fatalf("NormalizeSearchKinds(nil) = %#v", got)
	}

	_, err = NormalizeSearchKinds([]EntryKind{EntryKindUnknown})
	if err == nil {
		t.Fatal("NormalizeSearchKinds(unknown) error = nil, want error")
	}
}
