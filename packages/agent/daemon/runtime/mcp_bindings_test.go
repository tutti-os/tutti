package agentruntime

import "testing"

func TestClaudeSDKMCPServersProjectsSessionScopedHTTPBinding(t *testing.T) {
	servers := claudeSDKMCPServers([]MCPServerBinding{{
		Name: "connector", Type: "http", URL: "http://127.0.0.1:1234/mcp/connector",
		Headers: map[string]string{"Authorization": "Bearer test-token"},
	}})
	connector, ok := servers["connector"].(map[string]any)
	if !ok || connector["type"] != "http" || connector["url"] != "http://127.0.0.1:1234/mcp/connector" {
		t.Fatalf("Claude SDK MCP servers = %#v", servers)
	}
	headers, ok := connector["headers"].(map[string]string)
	if !ok || headers["Authorization"] != "Bearer test-token" {
		t.Fatalf("Claude SDK MCP headers = %#v", connector["headers"])
	}
}
