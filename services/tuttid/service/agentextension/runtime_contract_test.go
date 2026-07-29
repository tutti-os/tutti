package agentextension

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestValidateDiscoveryProfileSearchPaths(t *testing.T) {
	tests := []struct {
		name       string
		searchPath string
		wantError  bool
	}{
		{name: "user relative path", searchPath: `{"scope":"user","path":".kimi-code/bin"}`},
		{name: "absolute path", searchPath: `{"scope":"user","path":"/tmp/bin"}`, wantError: true},
		{name: "parent traversal", searchPath: `{"scope":"user","path":"../bin"}`, wantError: true},
		{name: "unsupported scope", searchPath: `{"scope":"system","path":"usr/local/bin"}`, wantError: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			payload := `{"schemaVersion":"tutti.agent.discovery.v1","candidates":[{"binaryNames":["agent"],"searchPaths":[` + test.searchPath + `],"version":{"args":["--version"],"constraint":">=1.0.0 <2.0.0"},"launchArgs":["acp"],"probe":{"kind":"acp-initialize","timeoutMs":5000}}]}`
			var profile DiscoveryProfile
			if err := json.NewDecoder(strings.NewReader(payload)).Decode(&profile); err != nil {
				t.Fatal(err)
			}
			err := validateDiscoveryProfile(profile)
			if test.wantError && err == nil {
				t.Fatal("validateDiscoveryProfile() error = nil")
			}
			if !test.wantError && err != nil {
				t.Fatalf("validateDiscoveryProfile() error = %v", err)
			}
		})
	}
}
