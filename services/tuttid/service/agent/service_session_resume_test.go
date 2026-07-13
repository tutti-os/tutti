package agent

import "testing"

func TestExternalImportResumeSupportedDefaultsLegacyButFailsClosedForMalformedMarker(t *testing.T) {
	if !externalImportResumeSupported(nil) {
		t.Fatal("legacy import without marker should remain resumable")
	}
	if externalImportResumeSupported(map[string]any{"externalImportResumeSupported": "false"}) {
		t.Fatal("malformed daemon-owned resume marker should fail closed")
	}
}
