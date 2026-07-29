package providerstatus

import "testing"

func TestCodexAuthJSONHasAPICredential(t *testing.T) {
	for _, test := range []struct {
		name    string
		content string
		want    bool
	}{
		{name: "api key", content: `{"OPENAI_API_KEY":"sk-test"}`, want: true},
		{name: "oauth tokens only", content: `{"tokens":{"access_token":"token"}}`},
		{name: "empty key", content: `{"OPENAI_API_KEY":""}`},
		{name: "invalid JSON", content: `{"OPENAI_API_KEY":`},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := CodexAuthJSONHasAPICredential([]byte(test.content)); got != test.want {
				t.Fatalf("CodexAuthJSONHasAPICredential() = %v, want %v", got, test.want)
			}
		})
	}
}

func TestCodexConfigTOMLHasAPICredential(t *testing.T) {
	for _, test := range []struct {
		name    string
		content string
		want    bool
	}{
		{name: "top-level key", content: `api_key = "sk-test"`, want: true},
		{
			name:    "provider key",
			content: "[model_providers.custom]\napi_key = 'sk-test'",
			want:    true,
		},
		{name: "empty key", content: `api_key = ""`},
		{name: "commented key", content: `# api_key = "sk-test"`},
		{name: "endpoint only", content: `base_url = "https://example.test"`},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := CodexConfigTOMLHasAPICredential([]byte(test.content)); got != test.want {
				t.Fatalf("CodexConfigTOMLHasAPICredential() = %v, want %v", got, test.want)
			}
		})
	}
}

func TestClaudeSettingsHasAPICredential(t *testing.T) {
	for _, test := range []struct {
		name    string
		content string
		want    bool
	}{
		{name: "API key", content: `{"env":{"ANTHROPIC_API_KEY":"key"}}`, want: true},
		{name: "auth token", content: `{"env":{"ANTHROPIC_AUTH_TOKEN":"token"}}`, want: true},
		{name: "API key helper", content: `{"apiKeyHelper":"/usr/local/bin/get-key"}`, want: true},
		{name: "endpoint only", content: `{"env":{"ANTHROPIC_BASE_URL":"https://example.test"}}`},
		{name: "invalid JSON", content: `{"env":`},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := ClaudeSettingsHasAPICredential([]byte(test.content)); got != test.want {
				t.Fatalf("ClaudeSettingsHasAPICredential() = %v, want %v", got, test.want)
			}
		})
	}
}
