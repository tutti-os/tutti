package agentruntime

import (
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

// fileChangesFromActivityEvent projects provider tool payloads into the one
// canonical shape persisted on WorkspaceAgentTurn. Provider-specific metadata
// is intentionally consumed here and must not leak into AgentGUI inference.
func fileChangesFromActivityEvent(event activityshared.Event) map[string]any {
	return canonicalFileChangesFromToolPayload(event.Payload.Metadata)
}

func canonicalFileChangesFromToolPayload(payload map[string]any) map[string]any {
	if len(payload) == 0 {
		return nil
	}
	if fileChanges := payloadMap(payload, "fileChanges"); len(fileChanges) > 0 {
		return clonePayload(fileChanges)
	}
	input := payloadMap(payload, "input")
	output := payloadMap(payload, "output")
	hint := toolFileChangeKind(payload)
	for _, candidate := range []map[string]any{
		fileChangesFromChangeEntries(output["changes"], hint),
		fileChangesFromChangeEntries(input["changes"], hint),
		fileChangesFromChangeEntries(payload["changes"], hint),
		fileChangesFromMetadataFiles(output, input, payload),
		fileChangesFromContentDiff(output["content"], hint),
		fileChangesFromContentDiff(input["content"], hint),
		fileChangesFromContentDiff(payload["content"], hint),
		fileChangesFromPatchText(input, output, payload),
		fileChangesFromDirectToolPayload(payload, input, output, hint),
	} {
		if candidate != nil {
			return candidate
		}
	}
	return nil
}

func fileChangesFromChangeEntries(value any, hint string) map[string]any {
	entries := fileChangeEntryMaps(value)
	if len(entries) == 0 {
		return nil
	}
	files := make([]any, 0, len(entries))
	for _, entry := range entries {
		if file := canonicalToolFileChange(entry, hint); file != nil {
			files = append(files, file)
		}
	}
	return canonicalFileChanges(files)
}

func fileChangeEntryMaps(value any) []map[string]any {
	if entries := payloadArray(value); len(entries) > 0 {
		return entries
	}
	byPath := payloadObject(value)
	if len(byPath) == 0 {
		return nil
	}
	entries := make([]map[string]any, 0, len(byPath))
	for path, raw := range byPath {
		entry := clonePayload(payloadObject(raw))
		if entry == nil {
			continue
		}
		if strings.TrimSpace(asString(entry["path"])) == "" {
			entry["path"] = path
		}
		entries = append(entries, entry)
	}
	return entries
}

func fileChangesFromMetadataFiles(maps ...map[string]any) map[string]any {
	for _, body := range maps {
		metadata := payloadMap(body, "metadata")
		files := payloadArray(metadata["files"])
		if len(files) == 0 {
			files = payloadArray(body["files"])
		}
		if len(files) == 0 {
			continue
		}
		changes := make([]any, 0, len(files))
		for _, item := range files {
			if file := canonicalToolFileChange(item, ""); file != nil {
				changes = append(changes, file)
			}
		}
		if fileChanges := canonicalFileChanges(changes); fileChanges != nil {
			return fileChanges
		}
	}
	return nil
}

func fileChangesFromContentDiff(value any, hint string) map[string]any {
	items := payloadArray(value)
	if len(items) == 0 {
		return nil
	}
	files := make([]any, 0, len(items))
	for _, item := range items {
		itemType := strings.ToLower(strings.TrimSpace(asString(item["type"])))
		if itemType != "" && itemType != "diff" && itemType != "file_change" {
			continue
		}
		if file := canonicalToolFileChange(item, hint); file != nil {
			files = append(files, file)
		}
	}
	return canonicalFileChanges(files)
}

func canonicalToolFileChange(value map[string]any, hint string) map[string]any {
	path := strings.TrimSpace(firstNonEmpty(
		asString(value["path"]),
		asString(value["filePath"]),
		asString(value["file_path"]),
		asString(value["relativePath"]),
	))
	if path == "" {
		return nil
	}
	diff := firstNonEmpty(
		asStringRaw(value["diff"]),
		asStringRaw(value["patch"]),
		asStringRaw(value["unifiedDiff"]),
		asStringRaw(value["unified_diff"]),
	)
	oldString, hasOld := firstPresentToolFileString(
		value["oldString"], value["old_string"], value["oldText"],
	)
	newString, hasNew := firstPresentToolFileString(
		value["newString"], value["new_string"], value["newText"], value["content"],
	)
	change := firstNonEmpty(
		normalizeToolFileChangeKind(value["change"]),
		normalizeToolFileChangeKind(value["status"]),
		normalizeToolFileChangeKind(value["kind"]),
		normalizeToolFileChangeKind(value["type"]),
		hint,
	)
	if change == "" {
		change = inferToolFileChangeKind(hasOld, oldString, hasNew, newString, diff)
	}
	if change == "" {
		return nil
	}
	file := map[string]any{"path": path, "change": change}
	if diff != "" {
		file["diff"] = diff
		file["unifiedDiff"] = diff
	}
	if hasOld {
		file["oldString"] = oldString
	}
	if hasNew {
		file["newString"] = newString
	}
	return file
}

func fileChangesFromPatchText(maps ...map[string]any) map[string]any {
	for _, body := range maps {
		patchText := strings.TrimSpace(firstNonEmpty(
			asStringRaw(body["patchText"]),
			asStringRaw(body["patch_text"]),
			asStringRaw(body["patch"]),
		))
		if patchText == "" {
			continue
		}
		if fileChanges := fileChangesFromCodexPatchText(patchText); fileChanges != nil {
			return fileChanges
		}
	}
	return nil
}

func fileChangesFromDirectToolPayload(payload map[string]any, input map[string]any, output map[string]any, hint string) map[string]any {
	path := strings.TrimSpace(firstNonEmpty(
		asString(output["filePath"]),
		asString(output["file_path"]),
		asString(input["filePath"]),
		asString(input["file_path"]),
		asString(input["path"]),
		asString(output["path"]),
		acpFirstLocationPath(acpLocationList(payload["locations"])),
	))
	if path == "" {
		return nil
	}
	file := map[string]any{"path": path}
	if oldString, ok := firstPresentToolFileString(output["oldString"], output["old_string"], input["oldString"], input["old_string"]); ok {
		file["oldString"] = oldString
	}
	if newString, ok := firstPresentToolFileString(output["newString"], output["new_string"], input["newString"], input["new_string"], input["content"]); ok {
		file["newString"] = newString
	}
	return fileChangesFromChangeEntries([]any{file}, hint)
}

func fileChangesFromCodexPatchText(patchText string) map[string]any {
	lines := strings.Split(strings.ReplaceAll(patchText, "\r\n", "\n"), "\n")
	files := make([]any, 0)
	for index := 0; index < len(lines); {
		line := strings.TrimSpace(lines[index])
		switch {
		case strings.HasPrefix(line, "*** Add File: "):
			path := strings.TrimSpace(strings.TrimPrefix(line, "*** Add File: "))
			index++
			contentLines := make([]string, 0)
			for index < len(lines) && !strings.HasPrefix(strings.TrimSpace(lines[index]), "*** ") {
				if strings.HasPrefix(lines[index], "+") {
					contentLines = append(contentLines, strings.TrimPrefix(lines[index], "+"))
				}
				index++
			}
			if path != "" {
				files = append(files, map[string]any{"path": path, "change": "added", "oldString": "", "newString": strings.Join(contentLines, "\n")})
			}
		case strings.HasPrefix(line, "*** Delete File: "):
			path := strings.TrimSpace(strings.TrimPrefix(line, "*** Delete File: "))
			if path != "" {
				files = append(files, map[string]any{"path": path, "change": "deleted", "oldString": "", "newString": ""})
			}
			index++
		case strings.HasPrefix(line, "*** Update File: "):
			path := strings.TrimSpace(strings.TrimPrefix(line, "*** Update File: "))
			index++
			hunkLines := make([]string, 0)
			oldLines := make([]string, 0)
			newLines := make([]string, 0)
			for index < len(lines) && !strings.HasPrefix(strings.TrimSpace(lines[index]), "*** ") {
				patchLine := lines[index]
				hunkLines = append(hunkLines, patchLine)
				switch {
				case strings.HasPrefix(patchLine, "-"):
					oldLines = append(oldLines, strings.TrimPrefix(patchLine, "-"))
				case strings.HasPrefix(patchLine, "+"):
					newLines = append(newLines, strings.TrimPrefix(patchLine, "+"))
				case strings.HasPrefix(patchLine, " "):
					text := strings.TrimPrefix(patchLine, " ")
					oldLines = append(oldLines, text)
					newLines = append(newLines, text)
				}
				index++
			}
			if path != "" {
				diff := strings.Join(hunkLines, "\n")
				files = append(files, map[string]any{"path": path, "change": "modified", "diff": diff, "unifiedDiff": diff, "oldString": strings.Join(oldLines, "\n"), "newString": strings.Join(newLines, "\n")})
			}
		default:
			index++
		}
	}
	return canonicalFileChanges(files)
}

func canonicalFileChanges(files []any) map[string]any {
	if len(files) == 0 {
		return nil
	}
	return map[string]any{"files": files}
}

func firstPresentToolFileString(values ...any) (string, bool) {
	for _, value := range values {
		if text, ok := value.(string); ok {
			return text, true
		}
	}
	return "", false
}

func toolFileChangeKind(payload map[string]any) string {
	input := payloadMap(payload, "input")
	for _, value := range []any{
		payload["fileChangeKind"],
		payload["activityKind"],
		payload["kind"],
		payloadMap(payload, "acp")["kind"],
		input["fileChangeKind"],
		input["kind"],
	} {
		if kind := normalizeToolFileChangeKind(value); kind != "" {
			return kind
		}
	}
	return ""
}

func normalizeToolFileChangeKind(value any) string {
	if nested := payloadObject(value); len(nested) > 0 {
		value = nested["type"]
	}
	switch strings.ToLower(strings.TrimSpace(asString(value))) {
	case "add", "added", "create", "created", "new", "write_file":
		return "added"
	case "delete", "deleted", "remove", "removed", "delete_file":
		return "deleted"
	case "modify", "modified", "update", "updated", "edit", "edited", "change", "changed", "edit_file":
		return "modified"
	default:
		return ""
	}
}

func inferToolFileChangeKind(hasOld bool, oldString string, hasNew bool, newString string, diff string) string {
	if hasOld && !hasNew {
		return "deleted"
	}
	if hasNew && !hasOld || oldString == "" && newString != "" {
		return "added"
	}
	if hasOld || hasNew || strings.TrimSpace(diff) != "" {
		return "modified"
	}
	return ""
}

func mergeCanonicalFileChanges(current map[string]any, incoming map[string]any) map[string]any {
	files := payloadArray(current["files"])
	order := make([]string, 0, len(files))
	byPath := make(map[string]map[string]any, len(files))
	for _, file := range files {
		path := strings.TrimSpace(asString(file["path"]))
		if path == "" {
			continue
		}
		order = append(order, path)
		byPath[path] = file
	}
	for _, next := range payloadArray(incoming["files"]) {
		path := strings.TrimSpace(asString(next["path"]))
		if path == "" {
			continue
		}
		existing := byPath[path]
		if existing == nil {
			order = append(order, path)
			byPath[path] = next
			continue
		}
		byPath[path] = mergeCanonicalFileChange(existing, next)
	}
	merged := make([]any, 0, len(order))
	for _, path := range order {
		if file := byPath[path]; file != nil {
			merged = append(merged, file)
		}
	}
	return map[string]any{"files": merged}
}

func mergeCanonicalFileChange(existing map[string]any, next map[string]any) map[string]any {
	merged := clonePayload(existing)
	for key, value := range next {
		if key != "path" && key != "change" && key != "oldString" {
			merged[key] = clonePayloadValue(value)
		}
	}
	if _, ok := merged["oldString"]; !ok {
		if value, present := next["oldString"]; present {
			merged["oldString"] = value
		}
	}
	previousKind := normalizeToolFileChangeKind(existing["change"])
	nextKind := normalizeToolFileChangeKind(next["change"])
	switch {
	case previousKind == "added" && nextKind == "modified":
		merged["change"] = "added"
	case previousKind == "deleted" && nextKind == "added":
		merged["change"] = "modified"
	case nextKind != "":
		merged["change"] = nextKind
	}
	return merged
}
