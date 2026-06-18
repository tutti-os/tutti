package workspace

import (
	"sort"
	"strings"
)

// 全局统一「文件类型筛选分类」的 Go 镜像。筛选与搜索在底层是同一能力:
// 搜索请求里的 filters 即分类 id 数组,本地文件搜索 / 议题产出搜索按此在服务端真正过滤。
//
// 这是 TS 单一来源的逐字镜像:
//   packages/workspace/file-reference/src/core/referenceFilterCategories.ts
// 两处扩展名清单必须保持一致 —— 改一处务必改另一处。
//
// 分类 id:image / document / spreadsheet / code / media / archive / other。
// "other" = 无扩展名或未被任何分类收录的扩展名(兜底),没有自己的扩展名清单。

var referenceFilterCategoryExtensions = map[string][]string{
	"image":       {"png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "heic"},
	"document":    {"pdf", "doc", "docx", "txt", "md", "markdown", "rtf", "odt", "pages", "key", "ppt", "pptx"},
	"spreadsheet": {"xls", "xlsx", "csv", "tsv", "numbers"},
	"code": {
		"js", "jsx", "ts", "tsx", "py", "go", "java", "c", "h", "cpp", "cc",
		"rs", "rb", "php", "swift", "kt", "sh", "json", "yaml", "yml", "toml",
		"xml", "html", "css", "scss", "sql",
	},
	"media":   {"mp3", "wav", "flac", "aac", "ogg", "m4a", "mp4", "mov", "avi", "mkv", "webm"},
	"archive": {"zip", "tar", "gz", "tgz", "rar", "7z", "bz2"},
}

// extension → categoryId 的反查表。
var referenceFilterCategoryByExtension = func() map[string]string {
	out := make(map[string]string)
	for category, exts := range referenceFilterCategoryExtensions {
		for _, ext := range exts {
			out[ext] = category
		}
	}
	return out
}()

// categoryOfFileName 从文件名末段推断分类;无扩展名或未收录的扩展名归入 "other"。
func categoryOfFileName(name string) string {
	dotIndex := strings.LastIndex(name, ".")
	if dotIndex <= 0 || dotIndex == len(name)-1 {
		return "other"
	}
	ext := strings.ToLower(name[dotIndex+1:])
	if category, ok := referenceFilterCategoryByExtension[ext]; ok {
		return category
	}
	return "other"
}

// matchesReferenceFilterCategories 分类筛选判定:空 ids = 全通过;目录始终通过(保留下钻);
// 仅对文件按其分类匹配。供本地文件搜索(文件系统遍历)在服务端兜底过滤。
func matchesReferenceFilterCategories(name string, isDir bool, ids []string) bool {
	if len(ids) == 0 || isDir {
		return true
	}
	category := categoryOfFileName(name)
	for _, id := range ids {
		if id == category {
			return true
		}
	}
	return false
}

// referenceFilterDisplayNameClause 为「按 display_name 扩展名分类过滤」构造 SQL 布尔片段。
// 返回的片段形如 "(... OR ...)",args 为对应的 LIKE 参数;无有效分类时返回 ("", nil)。
// 各分类用 LOWER(col) LIKE '%.ext' 的 OR 组;"other" = NOT(任一已知扩展名),
// 多分类之间用 OR 连接。供议题产出搜索在 SQLite WHERE 内使用。
func referenceFilterDisplayNameClause(column string, ids []string) (string, []any) {
	seen := make(map[string]struct{})
	var orParts []string
	var args []any

	addExtLike := func(parts *[]string, exts []string) {
		for _, ext := range exts {
			*parts = append(*parts, "LOWER("+column+") LIKE ?")
			args = append(args, "%."+ext)
		}
	}

	for _, id := range ids {
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		if id == "other" {
			// "other" = 不匹配任何已知扩展名。
			var knownParts []string
			addExtLike(&knownParts, allKnownReferenceFilterExtensions())
			if len(knownParts) > 0 {
				orParts = append(orParts, "NOT ("+strings.Join(knownParts, " OR ")+")")
			}
			continue
		}
		exts, ok := referenceFilterCategoryExtensions[id]
		if !ok {
			continue
		}
		var catParts []string
		addExtLike(&catParts, exts)
		if len(catParts) > 0 {
			orParts = append(orParts, strings.Join(catParts, " OR "))
		}
	}

	if len(orParts) == 0 {
		return "", nil
	}
	return "(" + strings.Join(orParts, " OR ") + ")", args
}

// allKnownReferenceFilterExtensions 返回全部已收录扩展名(排序,稳定输出),供 "other" 取反。
func allKnownReferenceFilterExtensions() []string {
	var exts []string
	for ext := range referenceFilterCategoryByExtension {
		exts = append(exts, ext)
	}
	sort.Strings(exts)
	return exts
}
