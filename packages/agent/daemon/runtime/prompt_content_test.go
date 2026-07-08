package agentruntime

import (
	"context"
	"testing"
)

func textPrompt(text string) []PromptContentBlock {
	return []PromptContentBlock{{Type: "text", Text: text}}
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
