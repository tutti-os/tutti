//go:build !windows

package workspace

func platformFileIsHidden(string) bool {
	return false
}
