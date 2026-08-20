package runtimeprep

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func resolveCLICommand(stateDir string) string {
	stateDir = strings.TrimSpace(stateDir)
	if stateDir == "" {
		return "tutti"
	}
	entries, err := os.ReadDir(filepath.Join(stateDir, "bin"))
	if err != nil {
		return "tutti"
	}

	candidates := make([]string, 0)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		base := strings.TrimSuffix(name, ".cmd")
		// Connector-native CLI shims share the state bin directory, but they
		// are not aliases for the Tutti daemon CLI used in generated policy.
		if (base == "tutti" || strings.HasPrefix(base, "tutti-")) && !strings.HasPrefix(base, "tutti-connector-") {
			candidates = append(candidates, base)
		}
	}
	if len(candidates) == 0 {
		return "tutti"
	}
	sort.SliceStable(candidates, func(left, right int) bool {
		if candidates[left] == "tutti" {
			return false
		}
		if candidates[right] == "tutti" {
			return true
		}
		return candidates[left] < candidates[right]
	})
	return candidates[0]
}
