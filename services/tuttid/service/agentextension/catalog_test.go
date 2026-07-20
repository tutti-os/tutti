package agentextension

import (
	"context"
	"errors"
	"testing"

	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

func TestManagerListCatalogIncludesDisabledSourcesWithoutReconciliation(t *testing.T) {
	manager := Manager{Sources: []tuttitypes.AgentExtensionSource{{
		Key:            "gemini",
		CatalogName:    "Gemini CLI",
		CatalogIconURL: "data:image/svg+xml;base64,Z2VtaW5p",
		Enabled:        false,
	}}}

	entries, err := manager.ListCatalog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Key != "gemini" || entries[0].TargetID != "extension:gemini" || entries[0].Name != "Gemini CLI" || entries[0].IconURL == "" {
		t.Fatalf("catalog entries = %#v", entries)
	}
}

func TestManagerListCatalogRejectsIncompletePresentation(t *testing.T) {
	manager := Manager{Sources: []tuttitypes.AgentExtensionSource{{Key: "gemini", CatalogName: "Gemini CLI"}}}

	_, err := manager.ListCatalog(context.Background())
	if !errors.Is(err, ErrInvalidCatalogSource) {
		t.Fatalf("ListCatalog() error = %v, want %v", err, ErrInvalidCatalogSource)
	}
}
