package agentruntime

import (
	"context"
	"testing"
)

func textPrompt(text string) []PromptContentBlock {
	return []PromptContentBlock{{Type: "text", Text: text}}
}

func TestUserPromptActivityPayloadExtraFromExecMetadataAddsClientSubmitID(t *testing.T) {
	t.Parallel()

	ctx := context.WithValue(context.Background(), execMetadataContextKey{}, map[string]any{
		"clientSubmitId": "submit-1",
	})
	extra := userPromptActivityPayloadExtraFromExecMetadata(ctx, map[string]any{
		"steered": true,
	})

	if extra["clientSubmitId"] != "submit-1" || extra["steered"] != true {
		t.Fatalf("extra = %#v, want clientSubmitId and existing fields", extra)
	}
}
