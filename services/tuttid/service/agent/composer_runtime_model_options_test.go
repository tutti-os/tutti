package agent

import (
	"testing"

	"github.com/tutti-os/tutti/packages/agent/daemon/modelcatalog"
)

func TestComposerModelOptionsFromCanonicalCatalogDeduplicatesModelIDs(t *testing.T) {
	t.Parallel()

	options := composerModelOptionsFromCanonicalCatalog([]modelcatalog.ModelOption{
		{ID: "gpt-5.6-sol", DisplayName: "GPT-5.6-Sol"},
		{ID: "gpt-5.6-sol", DisplayName: "Duplicate"},
	})
	if len(options) != 1 || options[0].Label != "GPT-5.6-Sol" {
		t.Fatalf("composer model options = %#v, want first canonical model only", options)
	}
}
