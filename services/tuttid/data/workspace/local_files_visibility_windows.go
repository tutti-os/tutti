//go:build windows

package workspace

import "golang.org/x/sys/windows"

func platformFileIsHidden(path string) bool {
	pathPointer, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return false
	}
	attributes, err := windows.GetFileAttributes(pathPointer)
	if err != nil {
		return false
	}
	const hiddenAttributes = windows.FILE_ATTRIBUTE_HIDDEN |
		windows.FILE_ATTRIBUTE_SYSTEM |
		windows.FILE_ATTRIBUTE_TEMPORARY
	return attributes&hiddenAttributes != 0
}
