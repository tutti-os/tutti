package agentruntime

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

// Locks the generated TypeScript vocabulary to the provider registry so drift
// fails even when capabilities.ts only re-exports the generated catalog.
func TestCapabilityVocabularyMatchesTypeScript(t *testing.T) {
	t.Parallel()
	tsPath := filepath.Join("..", "..", "activity-core", "src", "generated", "agentCapabilityKeys.ts")
	raw, err := os.ReadFile(tsPath)
	if err != nil {
		t.Fatalf("read %s: %v", tsPath, err)
	}
	block := regexp.MustCompile(`(?s)AGENT_CAPABILITY_KEYS = \[(.*?)\]`).FindSubmatch(raw)
	if block == nil {
		t.Fatalf("AGENT_CAPABILITY_KEYS not found in %s", tsPath)
	}
	matches := regexp.MustCompile(`"([a-zA-Z]+)"`).FindAllStringSubmatch(string(block[1]), -1)
	got := make([]string, 0, len(matches))
	for _, match := range matches {
		got = append(got, match[1])
	}
	want := providerregistry.KnownCapabilities()
	sort.Strings(got)
	sort.Strings(want)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("capability vocabulary drift:\n  ts = %v\n  go = %v", got, want)
	}
}
