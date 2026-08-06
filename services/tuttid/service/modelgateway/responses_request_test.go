package modelgateway

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestConvertResponsesRequestDropsOversizedChatMetadataValues(t *testing.T) {
	t.Parallel()

	exactLimit := strings.Repeat("a", maxChatMetadataValueBytes)
	overLimit := exactLimit + "a"
	request := responsesRequest{
		Model: "model-a",
		Input: json.RawMessage(`"hello"`),
		Metadata: map[string]string{
			"responses_exact_limit":               exactLimit,
			"responses_over_limit":                overLimit,
			"responses_over_limit_shadows_client": overLimit,
			"shared":                              "responses",
		},
		ClientMetadata: map[string]string{
			"client_exact_limit":                  exactLimit,
			"client_over_limit":                   overLimit,
			"responses_over_limit_shadows_client": "client",
			"shared":                              "client",
		},
	}

	converted, _, err := convertResponsesRequest(request)
	if err != nil {
		t.Fatalf("convertResponsesRequest() error = %v", err)
	}
	if len(converted.Metadata) != 3 {
		t.Fatalf("metadata = %#v, want three compatible values", converted.Metadata)
	}
	if converted.Metadata["responses_exact_limit"] != exactLimit {
		t.Fatal("Responses metadata at the Chat limit was dropped")
	}
	if converted.Metadata["client_exact_limit"] != exactLimit {
		t.Fatal("client metadata at the Chat limit was dropped")
	}
	if converted.Metadata["shared"] != "responses" {
		t.Fatalf("shared metadata = %q, want Responses value", converted.Metadata["shared"])
	}
	if _, exists := converted.Metadata["responses_over_limit"]; exists {
		t.Fatal("oversized Responses metadata was forwarded")
	}
	if _, exists := converted.Metadata["client_over_limit"]; exists {
		t.Fatal("oversized client metadata was forwarded")
	}
	if _, exists := converted.Metadata["responses_over_limit_shadows_client"]; exists {
		t.Fatal("lower-priority client metadata replaced dropped Responses metadata")
	}
}
