package agenthost

import (
	"testing"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func TestEditRetryReplacementInputPreservesSubmissionMetadata(t *testing.T) {
	input, err := editRetryReplacementInput(storesqlite.TurnSubmission{
		ContentJSON:           `[{"type":"text","text":"before"}]`,
		CapabilityRefsJSON:    `[]`,
		TuttiModeSnapshotJSON: `null`,
		MetadataJSON:          `{"uiMode":"agent"}`,
	}, "after")
	if err != nil {
		t.Fatalf("editRetryReplacementInput() error=%v", err)
	}
	if input.Metadata["uiMode"] != "agent" {
		t.Fatalf("metadata=%#v, want submission uiMode", input.Metadata)
	}
	claimMetadata, err := submitClaimMetadataJSON(input.Metadata)
	if err != nil || claimMetadata != `{"uiMode":"agent"}` {
		t.Fatalf("replacement claim metadata=%q err=%v", claimMetadata, err)
	}
}
