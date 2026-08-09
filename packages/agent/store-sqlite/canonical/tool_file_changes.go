package canonical

import (
	"regexp"
	"strconv"
	"strings"
)

var toolUnifiedDiffHunkPattern = regexp.MustCompile(`^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$`)

// NormalizeToolFileChanges is the shared fileChanges contract used by tool
// payloads and Agent Session Replay final-state compare. Invalid unified-diff
// bodies on added or modified files become newString; only real unified diffs
// keep diff / unifiedDiff. Callers should run both recorded and live graphs
// through this before equality checks so older cassettes stay portable.
func NormalizeToolFileChanges(value any) map[string]any {
	return normalizeToolFileChanges(value)
}

func normalizeToolFileChanges(value any) map[string]any {
	body := toolMap(value)
	if body == nil {
		return nil
	}
	filesByPath := make(map[string]map[string]any)
	order := make([]string, 0)
	for _, raw := range toolFileChangeMaps(body["files"]) {
		file := normalizeToolFileChange(raw)
		if file == nil {
			continue
		}
		path := toolString(file["path"])
		if current, exists := filesByPath[path]; exists {
			filesByPath[path] = mergeToolFileChangeValues(current, file)
			continue
		}
		order = append(order, path)
		filesByPath[path] = file
	}
	files := make([]any, 0, len(order))
	for _, path := range order {
		if file := filesByPath[path]; file != nil {
			files = append(files, file)
		}
	}
	if len(files) == 0 {
		return nil
	}
	result := map[string]any{"files": files}
	if coverage := toolString(body["coverage"]); coverage != "" {
		result["coverage"] = coverage
	}
	return result
}

func toolFileChangeMaps(value any) []map[string]any {
	result := make([]map[string]any, 0)
	switch typed := value.(type) {
	case []any:
		for _, raw := range typed {
			if file := toolMap(raw); file != nil {
				result = append(result, file)
			}
		}
	case []map[string]any:
		for _, raw := range typed {
			if file := toolMap(raw); file != nil {
				result = append(result, file)
			}
		}
	}
	return result
}

func normalizeToolFileChange(value map[string]any) map[string]any {
	if value == nil {
		return nil
	}
	path := firstToolString(value["path"], value["filePath"], value["file_path"], value["relativePath"])
	if path == "" {
		return nil
	}
	validDiff, hasValidDiff, rawDiff, hasRawDiff := selectToolFileDiff(value["diff"], value["patch"], value["unifiedDiff"], value["unified_diff"])
	diff := validDiff
	hasDiff := hasValidDiff
	oldString, hasOld := firstPresentToolString(value["oldString"], value["old_string"], value["oldText"])
	newString, hasNew := firstPresentToolString(value["newString"], value["new_string"], value["newText"])
	content, hasContent := firstPresentToolString(value["content"])
	change := firstToolChange(value["change"], value["status"], value["kind"], value["type"])
	if change == "" && hasContent {
		change = "added"
	}
	// Prefer newString over content for non-deleted bodies so obsolete cassette
	// shapes (bare content, or invalid diff folded below) match live projection.
	if change != "deleted" && !hasNew && hasContent {
		newString, hasNew = content, true
		hasContent = false
	}
	if !hasValidDiff && hasRawDiff {
		switch {
		case change == "added" && !hasNew:
			newString, hasNew = rawDiff, true
		case change == "deleted" && !hasOld:
			oldString, hasOld = rawDiff, true
		case !hasOld && !hasNew && !hasContent:
			// modified / unspecified: fold invalid diff bodies into newString,
			// not content — live rematerialization already uses newString.
			newString, hasNew = rawDiff, true
		}
	}
	if change == "" {
		switch {
		case hasOld && !hasNew:
			change = "deleted"
		case hasNew && !hasOld:
			change = "added"
		case hasOld || hasNew || hasDiff:
			change = "modified"
		case hasContent:
			change = "modified"
		}
	}
	if change == "" {
		return nil
	}
	file := map[string]any{"path": path, "change": change}
	if hasOld {
		file["oldString"] = oldString
	}
	if hasNew {
		file["newString"] = newString
	}
	if hasDiff {
		file["diff"] = diff
		file["unifiedDiff"] = diff
	}
	if hasContent {
		file["content"] = content
	}
	return file
}

func looksLikeUnifiedDiff(value string) bool {
	normalized := strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(value, "\r\n", "\n"), "\r", "\n"))
	if normalized == "" {
		return false
	}
	lines := strings.Split(normalized, "\n")
	isApplyPatch := strings.Contains(normalized, "*** Begin Patch") &&
		(strings.Contains(normalized, "*** Add File:") || strings.Contains(normalized, "*** Delete File:") || strings.Contains(normalized, "*** Update File:"))
	hasHunk := false
	hunkHasChange := false
	oldCount := 0
	newCount := 0
	expectedOld := 0
	expectedNew := 0
	hunkActive := false
	hunkHasCounts := false
	finishHunk := func() bool {
		if !hunkActive {
			return true
		}
		if !hunkHasCounts {
			return isApplyPatch && hunkHasChange
		}
		return oldCount == expectedOld && newCount == expectedNew && hunkHasChange
	}
	for _, line := range lines {
		if match := toolUnifiedDiffHunkPattern.FindStringSubmatch(line); match != nil {
			if !finishHunk() {
				return false
			}
			hasHunk = true
			hunkActive = true
			hunkHasCounts = true
			oldCount = 0
			newCount = 0
			hunkHasChange = false
			expectedOld = toolUnifiedDiffHunkCount(match[2])
			expectedNew = toolUnifiedDiffHunkCount(match[4])
			continue
		}
		if line == "@@" && isApplyPatch {
			if !finishHunk() {
				return false
			}
			hasHunk = true
			hunkActive = true
			hunkHasCounts = false
			hunkHasChange = false
			continue
		}
		if hunkActive && strings.HasPrefix(line, "diff --git ") {
			if !finishHunk() {
				return false
			}
			hunkActive = false
			continue
		}
		if !hunkActive && (strings.HasPrefix(line, "diff --git ") || strings.HasPrefix(line, "index ") ||
			strings.HasPrefix(line, "--- ") || strings.HasPrefix(line, "+++ ") ||
			strings.HasPrefix(line, "new file mode ") || strings.HasPrefix(line, "deleted file mode ") ||
			strings.HasPrefix(line, "old mode ") || strings.HasPrefix(line, "new mode ") ||
			strings.HasPrefix(line, "similarity index ") || strings.HasPrefix(line, "rename from ") ||
			strings.HasPrefix(line, "rename to ") || strings.HasPrefix(line, "*** ")) {
			continue
		}
		if hunkActive && isApplyPatch && strings.HasPrefix(line, "*** ") {
			continue
		}
		if line == "\\ No newline at end of file" {
			continue
		}
		if !hasHunk {
			continue
		}
		if !hunkHasCounts && isApplyPatch {
			switch {
			case strings.HasPrefix(line, "+"), strings.HasPrefix(line, "-"):
				hunkHasChange = true
			case strings.HasPrefix(line, " "):
			default:
				return false
			}
			continue
		}
		switch {
		case strings.HasPrefix(line, "+"):
			newCount++
			hunkHasChange = true
		case strings.HasPrefix(line, "-"):
			oldCount++
			hunkHasChange = true
		case strings.HasPrefix(line, " "):
			oldCount++
			newCount++
		default:
			return false
		}
	}
	return hasHunk && finishHunk()
}

func toolUnifiedDiffHunkCount(value string) int {
	if value == "" {
		return 1
	}
	count, err := strconv.Atoi(value)
	if err != nil {
		return -1
	}
	return count
}

func selectToolFileDiff(values ...any) (valid string, hasValid bool, raw string, hasRaw bool) {
	for _, value := range values {
		text, ok := value.(string)
		if !ok {
			continue
		}
		if !hasRaw {
			raw, hasRaw = text, true
		}
		if !hasValid && looksLikeUnifiedDiff(text) {
			valid, hasValid = text, true
		}
	}
	return
}

func firstToolChange(values ...any) string {
	for _, value := range values {
		if change := normalizeToolChangeValue(value); change != "" {
			return change
		}
	}
	return ""
}

func normalizeToolChangeValue(value any) string {
	if text, ok := value.(string); ok {
		return normalizeToolChange(text)
	}
	if nested, ok := value.(map[string]any); ok {
		for _, key := range []string{"type", "change", "status", "kind"} {
			if change := normalizeToolChangeValue(nested[key]); change != "" {
				return change
			}
		}
	}
	return ""
}

func mergeToolFileChangeValues(existing map[string]any, next map[string]any) map[string]any {
	if existing == nil {
		return cloneToolMap(next)
	}
	if next == nil {
		return cloneToolMap(existing)
	}
	previousKind := normalizeToolChangeValue(existing["change"])
	nextKind := normalizeToolChangeValue(next["change"])
	if previousKind == "added" && nextKind == "deleted" {
		return nil
	}

	merged := cloneToolMap(existing)
	for key, value := range next {
		if key == "path" || key == "change" || key == "oldString" {
			continue
		}
		merged[key] = cloneToolValue(value)
	}
	if _, exists := merged["oldString"]; !exists {
		if value, present := next["oldString"]; present {
			merged["oldString"] = cloneToolValue(value)
		}
	}
	switch {
	case previousKind == "added" && nextKind == "modified":
		merged["change"] = "added"
	case previousKind == "deleted" && nextKind == "added":
		merged["change"] = "modified"
	case previousKind == "modified" && nextKind == "deleted":
		merged["change"] = "deleted"
	case nextKind != "":
		merged["change"] = nextKind
	case previousKind != "":
		merged["change"] = previousKind
	}
	return merged
}
