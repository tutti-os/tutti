//go:build !windows

package agentstatus

func officialScriptInvocation(scriptShell string, scriptPath string, env []string) (string, []string, []string) {
	return joinShellCommand([]string{scriptShell, scriptPath}), []string{scriptShell, scriptPath}, env
}
