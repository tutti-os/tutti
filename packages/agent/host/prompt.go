package agenthost

import (
	"encoding/base64"
	"net/url"
	"strings"
)

const maxPromptImageBlocks = 8

func normalizePromptContent(content []PromptContentBlock) ([]PromptContentBlock, string, error) {
	normalized := make([]PromptContentBlock, 0, len(content))
	textParts := make([]string, 0, len(content))
	imageCount := 0
	hasInput := false
	for _, block := range content {
		switch strings.TrimSpace(block.Type) {
		case "text":
			text := strings.TrimSpace(block.Text)
			if text == "" {
				continue
			}
			hasInput = true
			textParts = append(textParts, text)
			normalized = append(normalized, PromptContentBlock{Type: "text", Text: text})
		case "image":
			imageCount++
			if imageCount > maxPromptImageBlocks || !supportedPromptImageMimeType(block.MimeType) {
				return nil, "", ErrInvalidArgument
			}
			data, imageURL := strings.TrimSpace(block.Data), strings.TrimSpace(block.URL)
			attachmentID, path := strings.TrimSpace(block.AttachmentID), strings.TrimSpace(block.Path)
			if data != "" && imageURL != "" || data == "" && imageURL == "" && attachmentID == "" && path == "" {
				return nil, "", ErrInvalidArgument
			}
			if data != "" {
				if _, err := base64.StdEncoding.DecodeString(data); err != nil {
					return nil, "", ErrInvalidArgument
				}
			}
			if imageURL != "" && !safePromptImageURL(imageURL) {
				return nil, "", ErrInvalidArgument
			}
			hasInput = true
			normalized = append(normalized, PromptContentBlock{
				Type: "image", MimeType: strings.TrimSpace(block.MimeType), Data: data,
				URL: imageURL, AttachmentID: attachmentID, Name: strings.TrimSpace(block.Name), Path: path,
			})
		case "skill", "mention":
			name, path := strings.TrimSpace(block.Name), strings.TrimSpace(block.Path)
			if name == "" || path == "" {
				return nil, "", ErrInvalidArgument
			}
			normalized = append(normalized, PromptContentBlock{Type: strings.TrimSpace(block.Type), Name: name, Path: path})
		default:
			return nil, "", ErrInvalidArgument
		}
	}
	if !hasInput {
		return nil, "", ErrInvalidArgument
	}
	return normalized, strings.Join(textParts, "\n"), nil
}

func safePromptImageURL(value string) bool {
	parsed, err := url.ParseRequestURI(strings.TrimSpace(value))
	return err == nil && parsed.Scheme == "https" && parsed.Host != "" && parsed.User == nil && parsed.Opaque == ""
}

func supportedPromptImageMimeType(value string) bool {
	switch strings.TrimSpace(value) {
	case "image/png", "image/jpeg", "image/webp":
		return true
	default:
		return false
	}
}

func cloneMap(input map[string]any) map[string]any {
	if len(input) == 0 {
		return nil
	}
	out := make(map[string]any, len(input))
	for key, value := range input {
		if key = strings.TrimSpace(key); key != "" {
			out[key] = value
		}
	}
	return out
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}
