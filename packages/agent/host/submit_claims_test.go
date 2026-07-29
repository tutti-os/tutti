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
