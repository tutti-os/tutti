//go:build !windows

package agentruntime

func replaceSystemSkillRootWithStableTarget(systemRoot string, target string) error {
	return replaceSystemSkillRootWithSymlink(systemRoot, target)
}
