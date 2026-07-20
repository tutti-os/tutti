package agentextension

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

var ErrInvalidCatalogSource = errors.New("invalid agent extension catalog source")

type CatalogEntry struct {
	Key      string
	TargetID string
	Name     string
	IconURL  string
}

// ListCatalog returns offline presentation metadata for every configured
// extension source. It never fetches release indexes or activates a source;
// active Agent Targets remain authoritative for runtime identity.
func (m *Manager) ListCatalog(_ context.Context) ([]CatalogEntry, error) {
	entries := make([]CatalogEntry, 0, len(m.Sources))
	for _, source := range m.Sources {
		key := strings.TrimSpace(source.Key)
		name := strings.TrimSpace(source.CatalogName)
		iconURL := strings.TrimSpace(source.CatalogIconURL)
		if !safeKey.MatchString(key) || name == "" || !strings.HasPrefix(iconURL, "data:image/svg+xml;base64,") {
			return nil, fmt.Errorf("%w: %q", ErrInvalidCatalogSource, key)
		}
		entries = append(entries, CatalogEntry{
			Key:      key,
			TargetID: targetID(key),
			Name:     name,
			IconURL:  iconURL,
		})
	}
	return entries, nil
}
