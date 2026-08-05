//go:build !windows

package agentstatus

func joinLoginShellCommand(parts []string) string {
	return joinShellCommand(parts)
}
