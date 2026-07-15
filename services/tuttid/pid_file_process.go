package main

import "strings"

type processExecutablePathLookup func(int) (string, error)

func isLiveTuttidProcess(pid int, lookup processExecutablePathLookup) bool {
	if pid <= 0 {
		return false
	}
	executablePath, err := lookup(pid)
	return err == nil && isTuttidExecutablePath(executablePath)
}

func isTuttidExecutablePath(executablePath string) bool {
	normalized := strings.TrimSpace(executablePath)
	normalized = strings.TrimSuffix(normalized, " (deleted)")
	if separator := strings.LastIndexAny(normalized, `/\\`); separator >= 0 {
		normalized = normalized[separator+1:]
	}
	normalized = strings.TrimSuffix(strings.ToLower(normalized), ".exe")
	return normalized == "tuttid"
}
