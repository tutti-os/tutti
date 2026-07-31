package main

import (
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
)

func TestTuttidDoesNotImportLegacyAgentActivityFacade(t *testing.T) {
	const legacyImportPath = "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"

	var violations []string
	err := filepath.WalkDir(".", func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			if path != "." && (entry.Name() == "vendor" || strings.HasPrefix(entry.Name(), ".")) {
				return filepath.SkipDir
			}
			return nil
		}
		if filepath.Ext(path) != ".go" {
			return nil
		}

		parsed, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly)
		if err != nil {
			return err
		}
		for _, imported := range parsed.Imports {
			importPath, err := strconv.Unquote(imported.Path.Value)
			if err != nil {
				return err
			}
			if importPath == legacyImportPath {
				violations = append(violations, filepath.ToSlash(path))
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("scan tuttId Go imports: %v", err)
	}
	if len(violations) == 0 {
		return
	}

	sort.Strings(violations)
	t.Fatalf(
		"tuttId still imports the retired Agent Activity facade; import packages/agent/store-sqlite directly:\n%s",
		strings.Join(violations, "\n"),
	)
}
