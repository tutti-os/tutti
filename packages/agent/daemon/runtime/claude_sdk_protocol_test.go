package agentruntime

import "testing"

func TestClaudeSDKSidecarProtocolNormalizesCurrentVersion(t *testing.T) {
	request := claudeSDKSidecarRequest{Type: "exec"}
	if err := request.normalize(); err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if request.Version != claudeSDKSidecarProtocolVersion {
		t.Fatalf("version = %d, want %d", request.Version, claudeSDKSidecarProtocolVersion)
	}
}

func TestClaudeSDKSidecarProtocolRejectsUnknownVersion(t *testing.T) {
	request := claudeSDKSidecarRequest{Version: 2, Type: "exec"}
	if err := request.normalize(); err == nil {
		t.Fatal("normalize accepted unknown protocol version")
	}
	if err := (claudeSDKSidecarEvent{Version: 2, Type: "ok"}).validate(); err == nil {
		t.Fatal("validate accepted unknown protocol version")
	}
}
