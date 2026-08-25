//go:build !windows

package workspace

func workspaceFilePhysicalPathCandidate(value string) string {
	return value
}
