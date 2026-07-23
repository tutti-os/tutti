package agentruntime

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"
)

var ErrPromptImageUnsupported = errors.New("agent prompt image input is unsupported")

const clientSubmitUserMessageIDPrefix = "client-submit:user:"

const maxProviderPromptImageBytes int64 = 20 << 20

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
			data := strings.TrimSpace(block.Data)
			imageURL := strings.TrimSpace(block.URL)
			attachmentID := strings.TrimSpace(block.AttachmentID)
			if !runtimePromptImageMimeTypeSupported(mimeType) ||
				(data == "" && imageURL == "" && attachmentID == "") ||
				(data != "" && imageURL != "") ||
				(imageURL != "" && !runtimePromptImageURLSafe(imageURL)) {
				continue
			}
			out = append(out, PromptContentBlock{
				Type:         "image",
				MimeType:     mimeType,
				Data:         data,
				URL:          imageURL,
				AttachmentID: attachmentID,
				Name:         strings.TrimSpace(block.Name),
			})
		case "skill", "mention":
			name := strings.TrimSpace(block.Name)
			path := strings.TrimSpace(block.Path)
			if name == "" || path == "" {
				continue
			}
			out = append(out, PromptContentBlock{
				Type: strings.TrimSpace(block.Type),
				Name: name,
				Path: path,
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
			data := strings.TrimSpace(block.Data)
			imageURL := strings.TrimSpace(block.URL)
			attachmentID := strings.TrimSpace(block.AttachmentID)
			path := strings.TrimSpace(block.Path)
			if !runtimePromptImageMimeTypeSupported(mimeType) ||
				(data == "" && imageURL == "" && attachmentID == "" && path == "") ||
				(data != "" && imageURL != "") ||
				(imageURL != "" && !runtimePromptImageURLSafe(imageURL)) {
				continue
			}
			out = append(out, PromptContentBlock{
				Type:         "image",
				MimeType:     mimeType,
				Data:         data,
				URL:          imageURL,
				AttachmentID: attachmentID,
				Name:         strings.TrimSpace(block.Name),
				Path:         path,
			})
		case "skill", "mention":
			name := strings.TrimSpace(block.Name)
			path := strings.TrimSpace(block.Path)
			if name == "" || path == "" {
				continue
			}
			out = append(out, PromptContentBlock{
				Type: strings.TrimSpace(block.Type),
				Name: name,
				Path: path,
			})
		}
	}
	return out
}

func validatePromptContentImagesForPreflight(content []PromptContentBlock) error {
	return validatePromptContentImages(content, true)
}

func validateRuntimePromptContentImages(content []PromptContentBlock) error {
	return validatePromptContentImages(content, false)
}

func validatePromptContentImages(content []PromptContentBlock, allowPathOnly bool) error {
	for _, block := range content {
		if strings.TrimSpace(block.Type) != "image" {
			continue
		}
		data := strings.TrimSpace(block.Data)
		imageURL := strings.TrimSpace(block.URL)
		attachmentID := strings.TrimSpace(block.AttachmentID)
		path := strings.TrimSpace(block.Path)
		hasSource := data != "" || imageURL != "" || attachmentID != "" || (allowPathOnly && path != "")
		if !runtimePromptImageMimeTypeSupported(block.MimeType) ||
			!hasSource ||
			(data != "" && imageURL != "") ||
			(imageURL != "" && !runtimePromptImageURLSafe(imageURL)) {
			return ErrPromptImageUnsupported
		}
	}
	return nil
}

func runtimePromptImageURLSafe(value string) bool {
	parsed, err := url.ParseRequestURI(strings.TrimSpace(value))
	return err == nil && parsed.Scheme == "https" && parsed.Host != "" && parsed.User == nil && parsed.Opaque == ""
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

func userPromptActivityPayloadExtraFromExecMetadata(ctx context.Context, extra map[string]any) map[string]any {
	return userPromptActivityPayloadExtraFromMetadata(execMetadataFromContext(ctx), extra)
}

func userPromptActivityPayloadExtraFromMetadata(metadata map[string]any, extra map[string]any) map[string]any {
	clientSubmitID := metadataString(metadata, "clientSubmitId")
	if clientSubmitID == "" {
		return clonePayload(extra)
	}
	payload := clonePayload(extra)
	if payload == nil {
		payload = map[string]any{}
	}
	payload["clientSubmitId"] = clientSubmitID
	if submittedAtUnixMS := metadataInt64(metadata, "clientSubmittedAtUnixMs"); submittedAtUnixMS > 0 {
		payload["clientSubmittedAtUnixMs"] = submittedAtUnixMS
	}
	if strings.TrimSpace(payloadString(payload, "messageId")) == "" {
		payload["messageId"] = userPromptActivityMessageIDFromClientSubmitID(clientSubmitID)
	}
	return payload
}

func userPromptActivityMessageIDFromClientSubmitID(clientSubmitID string) string {
	normalized := strings.TrimSpace(clientSubmitID)
	if normalized == "" {
		return ""
	}
	return clientSubmitUserMessageIDPrefix + normalized
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

// materializeProviderPromptImagesWithClient converts remote HTTPS image references at
// the provider boundary, immediately before Codex app-server or ACP receives
// the prompt. Current Codex and Claude transports reject remote image URLs and
// require inline image data. AgentGUI and durable activity state intentionally
// keep the uploaded URL; when a provider gains native URL support, only its
// final adapter needs to stop calling this compatibility conversion.
func materializeProviderPromptImagesWithClient(ctx context.Context, content []PromptContentBlock, client *http.Client) ([]PromptContentBlock, error) {
	requestClient := *client
	existingRedirectCheck := client.CheckRedirect
	requestClient.CheckRedirect = func(request *http.Request, via []*http.Request) error {
		if !runtimePromptImageURLSafe(request.URL.String()) {
			return ErrPromptImageUnsupported
		}
		if existingRedirectCheck != nil {
			return existingRedirectCheck(request, via)
		}
		return nil
	}
	out := append([]PromptContentBlock(nil), content...)
	for index := range out {
		block := out[index]
		imageURL := strings.TrimSpace(block.URL)
		if block.Type != "image" || imageURL == "" {
			continue
		}
		if !runtimePromptImageURLSafe(imageURL) {
			return nil, ErrPromptImageUnsupported
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, imageURL, nil)
		if err != nil {
			return nil, fmt.Errorf("prepare remote prompt image: %w", err)
		}
		response, err := requestClient.Do(request)
		if err != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return nil, ctxErr
			}
			return nil, errors.New("download remote prompt image: request failed")
		}
		data, readErr := readProviderPromptImage(response, block.MimeType)
		if closeErr := response.Body.Close(); readErr == nil && closeErr != nil {
			readErr = closeErr
		}
		if readErr != nil {
			return nil, readErr
		}
		block.Data = base64.StdEncoding.EncodeToString(data)
		block.URL = ""
		out[index] = block
	}
	return out, nil
}

func readProviderPromptImage(response *http.Response, expectedMimeType string) ([]byte, error) {
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return nil, fmt.Errorf("download remote prompt image: unexpected HTTP status %d", response.StatusCode)
	}
	if response.ContentLength > maxProviderPromptImageBytes {
		return nil, fmt.Errorf("download remote prompt image: image exceeds %d bytes", maxProviderPromptImageBytes)
	}
	if contentType := strings.TrimSpace(response.Header.Get("Content-Type")); contentType != "" {
		mediaType, _, err := mime.ParseMediaType(contentType)
		if err != nil || mediaType != strings.TrimSpace(expectedMimeType) {
			return nil, ErrPromptImageUnsupported
		}
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxProviderPromptImageBytes+1))
	if err != nil {
		return nil, fmt.Errorf("download remote prompt image: %w", err)
	}
	if len(data) == 0 || int64(len(data)) > maxProviderPromptImageBytes {
		return nil, fmt.Errorf("download remote prompt image: invalid image size %d", len(data))
	}
	return data, nil
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
			if imageURL := strings.TrimSpace(block.URL); imageURL != "" {
				item["url"] = imageURL
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
