package workspace

import (
	"fmt"
	"path/filepath"
	"strings"
)

func validateAppBootstrapFile(adapter AppShellAdapter, packageDir string, bootstrap string) error {
	adapter = resolveAppShellAdapter(adapter)
	bootstrap = strings.TrimSpace(bootstrap)
	bootstrapPath := filepath.Join(packageDir, filepath.FromSlash(bootstrap))
	if err := adapter.ValidateScript(bootstrapPath); err != nil {
		return fmt.Errorf("validate runtime bootstrap %q: %w", bootstrap, err)
	}
	return nil
}
