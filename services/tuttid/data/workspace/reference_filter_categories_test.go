package workspace

import (
	"strings"
	"testing"
)

func TestCategoryOfFileName(t *testing.T) {
	cases := map[string]string{
		"photo.PNG":      "image",
		"report.pdf":     "document",
		"data.csv":       "spreadsheet",
		"main.go":        "code",
		"clip.mp4":       "media",
		"bundle.tar.gz":  "archive",
		"README":         "other", // 无扩展名
		"archive.":       "other", // 末尾点
		".gitignore":     "other", // 仅前导点(dotIndex==0)
		"unknown.xyz":    "other", // 未收录扩展名
		"NOTES.MARKDOWN": "document",
	}
	for name, want := range cases {
		if got := categoryOfFileName(name); got != want {
			t.Errorf("categoryOfFileName(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestMatchesReferenceFilterCategories(t *testing.T) {
	// 空 ids = 全通过。
	if !matchesReferenceFilterCategories("x.png", false, nil) {
		t.Error("empty filters should pass any file")
	}
	// 目录始终通过(保留下钻)。
	if !matchesReferenceFilterCategories("folder", true, []string{"image"}) {
		t.Error("directory should always pass")
	}
	// 文件按分类匹配。
	if !matchesReferenceFilterCategories("a.png", false, []string{"document", "image"}) {
		t.Error("png should match image filter")
	}
	if matchesReferenceFilterCategories("a.png", false, []string{"document"}) {
		t.Error("png should not match document-only filter")
	}
}

func TestReferenceFilterDisplayNameClause(t *testing.T) {
	// 无 ids → 空片段。
	if clause, args := referenceFilterDisplayNameClause("o.name", nil); clause != "" || args != nil {
		t.Errorf("empty filters should yield empty clause, got %q args=%v", clause, args)
	}

	// 单分类:每个扩展名一个 LIKE,OR 连接,参数为 %.ext。
	clause, args := referenceFilterDisplayNameClause("o.name", []string{"spreadsheet"})
	if !strings.HasPrefix(clause, "(") || !strings.Contains(clause, "LOWER(o.name) LIKE ?") {
		t.Errorf("unexpected clause: %q", clause)
	}
	if len(args) != 5 { // xls/xlsx/csv/tsv/numbers
		t.Errorf("spreadsheet expected 5 args, got %d (%v)", len(args), args)
	}
	for _, a := range args {
		s, ok := a.(string)
		if !ok || !strings.HasPrefix(s, "%.") {
			t.Errorf("arg should be %%.ext, got %v", a)
		}
	}

	// "other" → NOT(任一已知扩展名),参数为全部已知扩展名。
	otherClause, otherArgs := referenceFilterDisplayNameClause("o.name", []string{"other"})
	if !strings.Contains(otherClause, "NOT (") {
		t.Errorf("other clause should negate known extensions, got %q", otherClause)
	}
	if len(otherArgs) != len(allKnownReferenceFilterExtensions()) {
		t.Errorf("other args = %d, want %d", len(otherArgs), len(allKnownReferenceFilterExtensions()))
	}

	// 多分类(含 other)→ OR 连接多个子句。
	multi, _ := referenceFilterDisplayNameClause("o.name", []string{"image", "other"})
	if strings.Count(multi, " OR ") < 1 || !strings.Contains(multi, "NOT (") {
		t.Errorf("multi clause should OR image with other-negation, got %q", multi)
	}
}
