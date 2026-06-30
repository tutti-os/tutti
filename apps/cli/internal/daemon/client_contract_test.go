package daemon

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestClientTransportModelTracksOpenAPIContract(t *testing.T) {
	spec := readOpenAPISpec(t)

	requiredFragments := []string{
		healthPath + ":",
		cliCapabilitiesPath + ":",
		cliCommandInvokePattern + ":",
		"operationId: listCliCapabilities",
		"operationId: invokeCliCommand",
		"CliCapabilitiesResponse:",
		"CliCapability:",
		"cliDescription:",
		"CliInvokeRequest:",
		"CliInvokeContext:",
		"agentSessionId:",
		"CliInvokeResponse:",
		"CliCommandOutput:",
		"CliCommandWarning:",
		"CliOutputMode:",
		"warnings:",
	}

	for _, fragment := range requiredFragments {
		if !strings.Contains(spec, fragment) {
			t.Fatalf("OpenAPI spec is missing %q", fragment)
		}
	}
}

func readOpenAPISpec(t *testing.T) string {
	t.Helper()

	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve caller")
	}
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(filename), "../../../.."))
	specPath := filepath.Join(repoRoot, "services/tuttid/api/openapi/tuttid.v1.yaml")
	content, err := os.ReadFile(specPath)
	if err != nil {
		t.Fatalf("read OpenAPI spec: %v", err)
	}
	return string(content)
}
