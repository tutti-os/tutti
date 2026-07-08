package agentruntime

import (
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func mergeACPStandardRawToolBody(normalized map[string]any, raw map[string]any) map[string]any {
	body := clonePayload(normalized)
	if body == nil {
		body = map[string]any{}
	}
	for key, value := range raw {
		if _, exists := body[key]; exists {
			continue
		}
		body[key] = clonePayloadValue(value)
	}
	if len(body) == 0 {
		return nil
	}
	return body
}

func fileChangesFromActivityEvent(event activityshared.Event) map[string]any {
	if fileChanges := payloadMap(event.Payload.Metadata, "fileChanges"); len(fileChanges) > 0 {
		return clonePayload(fileChanges)
	}
	return fileChangesFromACPToolPayload(event.Payload.Metadata)
}

func fileChangesFromACPToolPayload(payload map[string]any) map[string]any {
	if len(payload) == 0 {
		return nil
	}
	if fileChanges := payloadMap(payload, "fileChanges"); len(fileChanges) > 0 {
		return clonePayload(fileChanges)
	}
	input := payloadMap(payload, "input")
	output := payloadMap(payload, "output")
	if fileChanges := fileChangesFromACPMetadataFiles(output, input, payload); fileChanges != nil {
		return fileChanges
	}
	if fileChanges := fileChangesFromACPPatchText(input, output, payload); fileChanges != nil {
		return fileChanges
	}
	path := firstNonEmpty(
		asString(output["filePath"]),
		asString(output["file_path"]),
		asString(input["filePath"]),
		asString(input["file_path"]),
		asString(input["path"]),
		asString(output["path"]),
		acpFirstLocationPath(acpLocationList(payload["locations"])),
	)
	path = strings.TrimSpace(path)
	if path == "" {
		return nil
	}
	oldString, hasOld := firstPresentACPString(output["oldString"], input["oldString"])
	newString, hasNew := firstPresentACPString(output["newString"], input["newString"], input["content"])
	if !hasOld && !hasNew {
		return nil
	}
	file := map[string]any{
		"path": path,
	}
	if hasOld {
		file["oldString"] = oldString
	}
	if hasNew {
		file["newString"] = newString
	}
	if change := acpFileChangeKind(payload, hasOld, oldString, hasNew, newString); change != "" {
		file["change"] = change
	}
	return map[string]any{
		"files": []any{file},
	}
}

func fileChangesFromACPMetadataFiles(maps ...map[string]any) map[string]any {
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
			path := strings.TrimSpace(firstNonEmpty(
				asString(item["filePath"]),
				asString(item["file_path"]),
				asString(item["path"]),
				asString(item["relativePath"]),
			))
			diff := firstNonEmpty(
				asString(item["patch"]),
				asString(item["diff"]),
				asString(item["unifiedDiff"]),
			)
			if path == "" || strings.TrimSpace(diff) == "" {
				continue
			}
			file := map[string]any{
				"path":        path,
				"diff":        diff,
				"unifiedDiff": diff,
			}
			if change := acpMetadataFileChangeKind(item); change != "" {
				file["change"] = change
			}
			changes = append(changes, file)
		}
		if len(changes) > 0 {
			return map[string]any{
				"files": changes,
			}
		}
	}
	return nil
}

func acpMetadataFileChangeKind(file map[string]any) string {
	switch strings.ToLower(strings.TrimSpace(firstNonEmpty(
		asString(file["type"]),
		asString(file["change"]),
		asString(file["status"]),
	))) {
	case "add", "added", "create", "created":
		return "added"
	case "delete", "deleted", "remove", "removed":
		return "deleted"
	case "modify", "modified", "update", "updated", "edit", "edited":
		return "modified"
	default:
		return ""
	}
}

func fileChangesFromACPPatchText(maps ...map[string]any) map[string]any {
	for _, body := range maps {
		if len(body) == 0 {
			continue
		}
		patchText := strings.TrimSpace(firstNonEmpty(
			asString(body["patchText"]),
			asString(body["patch_text"]),
			asString(body["patch"]),
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
				files = append(files, map[string]any{
					"path":      path,
					"change":    "added",
					"oldString": "",
					"newString": strings.Join(contentLines, "\n"),
				})
			}
		case strings.HasPrefix(line, "*** Delete File: "):
			path := strings.TrimSpace(strings.TrimPrefix(line, "*** Delete File: "))
			if path != "" {
				files = append(files, map[string]any{
					"path":      path,
					"change":    "deleted",
					"oldString": "",
					"newString": "",
				})
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
				files = append(files, map[string]any{
					"path":        path,
					"change":      "modified",
					"diff":        strings.Join(hunkLines, "\n"),
					"oldString":   strings.Join(oldLines, "\n"),
					"newString":   strings.Join(newLines, "\n"),
					"unifiedDiff": strings.Join(hunkLines, "\n"),
				})
			}
		default:
			index++
		}
	}
	if len(files) == 0 {
		return nil
	}
	return map[string]any{
		"files": files,
	}
}

func firstPresentACPString(values ...any) (string, bool) {
	for _, value := range values {
		text, ok := value.(string)
		if ok {
			return text, true
		}
	}
	return "", false
}

func acpFileChangeKind(payload map[string]any, hasOld bool, oldString string, hasNew bool, newString string) string {
	toolName := strings.ToLower(strings.TrimSpace(asString(payload["toolName"])))
	if toolName == "write" {
		return "added"
	}
	if hasOld && !hasNew || hasOld && newString == "" {
		return "deleted"
	}
	if hasNew && !hasOld || oldString == "" && newString != "" {
		return "added"
	}
	return "modified"
}
