package agentruntime

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func textPrompt(text string) []PromptContentBlock {
	return []PromptContentBlock{{Type: "text", Text: text}}
}

func TestNormalizeRuntimePromptContentPreservesURLOnlyImage(t *testing.T) {
	signedURL := "https://bucket.example/image.webp?token=secret"
	content := normalizeRuntimePromptContent([]PromptContentBlock{{Type: "image", MimeType: " image/webp ", URL: " " + signedURL + " ", Name: " image.webp "}})
	if len(content) != 1 || content[0].URL != signedURL || content[0].Data != "" {
		t.Fatalf("content = %#v, want normalized URL-only image", content)
	}
}

func TestValidateRuntimePromptContentImagesRejectsUnsafeOrAmbiguousURL(t *testing.T) {
	for _, block := range []PromptContentBlock{
		{Type: "image", MimeType: "image/png", URL: "http://bucket.example/image.png"},
		{Type: "image", MimeType: "image/png", URL: "https://user:pass@bucket.example/image.png"},
		{Type: "image", MimeType: "image/png", URL: "https://bucket.example/image.png", Data: "aW1hZ2U="},
	} {
		if err := validateRuntimePromptContentImages([]PromptContentBlock{block}); err != ErrPromptImageUnsupported {
			t.Fatalf("validateRuntimePromptContentImages(%#v) = %v, want ErrPromptImageUnsupported", block, err)
		}
	}
}

func TestUserPromptActivityPayloadRedactsImageSources(t *testing.T) {
	signedURL := "https://bucket.example/image.png?token=bearer-secret"
	payload := userPromptActivityPayload([]PromptContentBlock{{Type: "image", MimeType: "image/png", URL: signedURL, Data: "base64-secret", AttachmentID: "attachment-1", Name: "screen.png"}}, "", nil)
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	serialized := string(encoded)
	if strings.Contains(serialized, signedURL) || strings.Contains(serialized, "base64-secret") {
		t.Fatalf("activity payload leaked image source: %s", serialized)
	}
	if !strings.Contains(serialized, "attachment-1") || !strings.Contains(serialized, "screen.png") {
		t.Fatalf("activity payload lost safe metadata: %s", serialized)
	}
}

func TestNormalizeRuntimePromptContentAcceptsAttachmentOnlyImage(t *testing.T) {
	t.Parallel()

	content := normalizeRuntimePromptContent([]PromptContentBlock{{
		Type:         "image",
		MimeType:     " image/png ",
		AttachmentID: " attachment-1 ",
		Name:         " screenshot.png ",
	}})

	if len(content) != 1 {
		t.Fatalf("content length = %d, want 1", len(content))
	}
	if content[0].Type != "image" ||
		content[0].MimeType != "image/png" ||
		content[0].AttachmentID != "attachment-1" ||
		content[0].Name != "screenshot.png" {
		t.Fatalf("content[0] = %#v, want normalized attachment-backed image", content[0])
	}
	if content[0].Data != "" {
		t.Fatalf("content[0].Data = %q, want empty", content[0].Data)
	}
}

func TestUserPromptActivityPayloadExtraFromExecMetadataAddsClientSubmitIdentity(t *testing.T) {
	t.Parallel()

	ctx := context.WithValue(context.Background(), execMetadataContextKey{}, map[string]any{
		"clientSubmitId": "submit-1",
	})
	extra := userPromptActivityPayloadExtraFromExecMetadata(ctx, map[string]any{
		"steered": true,
	})

	if extra["clientSubmitId"] != "submit-1" ||
		extra["messageId"] != "client-submit:user:submit-1" ||
		extra["steered"] != true {
		t.Fatalf("extra = %#v, want client submit identity and existing fields", extra)
	}
}

func TestUserPromptActivityPayloadExtraFromExecMetadataPreservesExplicitMessageID(t *testing.T) {
	t.Parallel()

	ctx := context.WithValue(context.Background(), execMetadataContextKey{}, map[string]any{
		"clientSubmitId": "submit-1",
	})
	extra := userPromptActivityPayloadExtraFromExecMetadata(ctx, map[string]any{
		"messageId": "explicit-message-1",
	})

	if extra["messageId"] != "explicit-message-1" || extra["clientSubmitId"] != "submit-1" {
		t.Fatalf("extra = %#v, want explicit messageId preserved", extra)
	}
}
