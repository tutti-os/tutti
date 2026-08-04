//go:build !windows

package runtimecmd

import "os"

func executableNameCandidates(command string, _ []string) []string {
	return []string{command}
}

func isExecutableFile(path string) bool {
	stat, err := os.Stat(path)
	return err == nil && !stat.IsDir() && stat.Mode().Perm()&0o111 != 0
}
