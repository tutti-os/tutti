package agentstatus

import (
	"context"
	_ "embed"
	"os"
)

// claudeAgentACPPatchScript is the idempotent codemod that teaches the
// claude-agent-acp bridge to advertise a `fast` config option backed by the
// Claude Agent SDK's `Settings.fastMode`. It is embedded so the installer can
// apply it self-contained, and is also runnable directly via
// `pnpm patch:claude-agent-acp`.
//
//go:embed assets/patch-claude-agent-acp.mjs
var claudeAgentACPPatchScript []byte

// runClaudeAgentACPPatch writes the embedded codemod to a temp file and runs it
// with node. Mirrors runOfficialScriptInstaller's temp-file pattern.
func (s Service) runClaudeAgentACPPatch(ctx context.Context) (InstallCommandResult, error) {
	scriptFile, err := os.CreateTemp("", "tutti-patch-claude-agent-acp-*.mjs")
	if err != nil {
		return InstallCommandResult{ExitCode: 1}, err
	}
	scriptPath := scriptFile.Name()
	defer func() {
		_ = os.Remove(scriptPath)
	}()
	if _, err := scriptFile.Write(claudeAgentACPPatchScript); err != nil {
		_ = scriptFile.Close()
		return InstallCommandResult{ExitCode: 1}, err
	}
	if err := scriptFile.Close(); err != nil {
		return InstallCommandResult{ExitCode: 1}, err
	}
	return s.installCommand(ctx, InstallCommandInput{
		Command: joinShellCommand([]string{"node", scriptPath}),
		Env:     s.commandResolver().Env(nil),
	})
}

// applyInstallerPostStep runs the optional post-install step for a successful
// install. It is best-effort: a failure is surfaced in the returned result's
// Stderr but never downgrades the install's success (the bridge is installed;
// the patch only enables the orthogonal `fast` control).
func (s Service) applyInstallerPostStep(
	ctx context.Context,
	step InstallerPostStep,
	result InstallCommandResult,
) InstallCommandResult {
	if step != InstallerPostStepPatchClaudeAgentACP {
		return result
	}
	patchResult, err := s.runClaudeAgentACPPatch(ctx)
	if err == nil && patchResult.ExitCode == 0 {
		return result
	}
	detail := patchResult.Stderr
	if detail == "" {
		detail = patchResult.Stdout
	}
	if err != nil {
		detail = appendDetail(detail, err.Error())
	}
	result.Stderr = appendDetail(
		result.Stderr,
		"claude-agent-acp fast-mode patch did not apply: "+detail,
	)
	return result
}

func appendDetail(existing string, detail string) string {
	if existing == "" {
		return detail
	}
	if detail == "" {
		return existing
	}
	return existing + "\n" + detail
}
