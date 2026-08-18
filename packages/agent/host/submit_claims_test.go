package agenthost

import "testing"

func TestSubmissionMetadataUsesTypedClientSubmitIDWithoutMutatingCallerMap(t *testing.T) {
	legacy := map[string]any{"clientSubmitId": "caller-controlled", "trace": "trace-1"}
	got := submissionMetadata(legacy, " canonical-submit-1 ")
	if got["clientSubmitId"] != "canonical-submit-1" || got["trace"] != "trace-1" {
		t.Fatalf("submission metadata = %#v", got)
	}
	if legacy["clientSubmitId"] != "caller-controlled" {
		t.Fatalf("caller metadata was mutated = %#v", legacy)
	}
}

func TestSubmissionMetadataPreservesLegacyIdentityWhenTypedValueIsEmpty(t *testing.T) {
	legacy := map[string]any{"clientSubmitId": "legacy-submit-1"}
	if got := submissionMetadata(legacy, " "); got["clientSubmitId"] != "legacy-submit-1" {
		t.Fatalf("submission metadata = %#v", got)
	}
}

func TestSubmitClaimMetadataPersistsOnlyValidatedUIMode(t *testing.T) {
	for _, testCase := range []struct {
		name     string
		metadata map[string]any
		want     string
	}{
		{name: "agent", metadata: map[string]any{"uiMode": "agent", "clientSubmitId": "secret", "trace": "private"}, want: `{"uiMode":"agent"}`},
		{name: "os", metadata: map[string]any{"uiMode": "os"}, want: `{"uiMode":"os"}`},
		{name: "invalid", metadata: map[string]any{"uiMode": "unknown"}, want: `{}`},
		{name: "missing", metadata: nil, want: `{}`},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			got, err := submitClaimMetadataJSON(testCase.metadata)
			if err != nil || got != testCase.want {
				t.Fatalf("submitClaimMetadataJSON()=%q err=%v, want %q", got, err, testCase.want)
			}
		})
	}
}
