package agentruntime

import (
	"encoding/json"
	"errors"
	"strings"
)

var ErrPromptImageUnsupported = errors.New("agent prompt image input is unsupported")

func normalizeRuntimePromptContent(content []PromptContentBlock) []PromptContentBlock {
	out := make([]PromptContentBlock, 0, len(content))
	for _, block := range content {
		switch strings.TrimSpace(block.Type) {
		case "text":
			text := strings.TrimSpace(block.Text)
			if text == "" {
				continue
			}
			out = append(out, PromptContentBlock{Type: "text", Text: text})
		case "image":
			mimeType := strings.TrimSpace(block.MimeType)
			if !runtimePromptImageMimeTypeSupported(mimeType) || strings.TrimSpace(block.Data) == "" {
				continue
			}
			out = append(out, PromptContentBlock{
				Type:         "image",
				MimeType:     mimeType,
				Data:         strings.TrimSpace(block.Data),
				AttachmentID: strings.TrimSpace(block.AttachmentID),
				Name:         strings.TrimSpace(block.Name),
			})
		}
	}
	return out
}

func normalizeRuntimePromptContentForValidation(content []PromptContentBlock) []PromptContentBlock {
	out := make([]PromptContentBlock, 0, len(content))
	for _, block := range content {
		switch strings.TrimSpace(block.Type) {
		case "text":
			text := strings.TrimSpace(block.Text)
			if text == "" {
				continue
			}
			out = append(out, PromptContentBlock{Type: "text", Text: text})
		case "image":
			mimeType := strings.TrimSpace(block.MimeType)
			if !runtimePromptImageMimeTypeSupported(mimeType) ||
				(strings.TrimSpace(block.Data) == "" && strings.TrimSpace(block.AttachmentID) == "") {
				continue
			}
			out = append(out, PromptContentBlock{
				Type:         "image",
				MimeType:     mimeType,
				Data:         strings.TrimSpace(block.Data),
				AttachmentID: strings.TrimSpace(block.AttachmentID),
				Name:         strings.TrimSpace(block.Name),
			})
		}
	}
	return out
}

func runtimePromptImageMimeTypeSupported(mimeType string) bool {
	switch strings.TrimSpace(mimeType) {
	case "image/png", "image/jpeg", "image/webp":
		return true
	default:
		return false
	}
}

func promptDisplayText(content []PromptContentBlock) string {
	textParts := make([]string, 0, len(content))
	imageCount := 0
	for _, block := range content {
		if block.Type == "text" && strings.TrimSpace(block.Text) != "" {
			textParts = append(textParts, strings.TrimSpace(block.Text))
		}
		if block.Type == "image" {
			imageCount++
		}
	}
	if len(textParts) > 0 {
		return strings.Join(textParts, "\n")
	}
	if imageCount == 1 {
		return "[Image]"
	}
	if imageCount > 1 {
		return "[Images]"
	}
	return ""
}

func explicitAndVisiblePromptText(content []PromptContentBlock, displayPrompt string) (string, string) {
	explicitDisplayPrompt := strings.TrimSpace(displayPrompt)
	if explicitDisplayPrompt != "" {
		return explicitDisplayPrompt, explicitDisplayPrompt
	}
	return "", promptDisplayText(content)
}

func userPromptActivityPayload(content []PromptContentBlock, displayPrompt string, extra map[string]any) map[string]any {
	payload := map[string]any{
		"content": promptContentForActivity(content),
	}
	for key, value := range extra {
		payload[key] = value
	}
	if explicitDisplayPrompt := strings.TrimSpace(displayPrompt); explicitDisplayPrompt != "" {
		payload["displayPrompt"] = explicitDisplayPrompt
	}
	return payload
}

func promptContentForACP(content []PromptContentBlock) []map[string]any {
	out := make([]map[string]any, 0, len(content))
	for _, block := range content {
		switch block.Type {
		case "text":
			out = append(out, map[string]any{
				"type": "text",
				"text": block.Text,
			})
		case "image":
			out = append(out, map[string]any{
				"type":     "image",
				"mimeType": block.MimeType,
				"data":     block.Data,
			})
		}
	}
	return out
}

func promptContentForActivity(content []PromptContentBlock) []map[string]any {
	out := make([]map[string]any, 0, len(content))
	for _, block := range content {
		switch block.Type {
		case "text":
			out = append(out, map[string]any{
				"type": "text",
				"text": block.Text,
			})
		case "image":
			item := map[string]any{
				"type":         "image",
				"mimeType":     block.MimeType,
				"attachmentId": block.AttachmentID,
			}
			if strings.TrimSpace(block.Name) != "" {
				item["name"] = strings.TrimSpace(block.Name)
			}
			out = append(out, item)
		}
	}
	return out
}

func promptContentHasImage(content []PromptContentBlock) bool {
	for _, block := range content {
		if block.Type == "image" {
			return true
		}
	}
	return false
}

func acpPromptImageSupported(raw json.RawMessage) bool {
	var result map[string]any
	if len(raw) == 0 || json.Unmarshal(raw, &result) != nil {
		return false
	}
	return truthyNested(result, "promptCapabilities", "image") ||
		truthyNested(result, "agentCapabilities", "promptImage") ||
		truthyNested(result, "agentCapabilities", "image")
}
