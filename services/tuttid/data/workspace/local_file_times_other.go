//go:build !darwin && !linux

package workspace

import "os"

func localFileTimeMetadata(os.FileInfo) (*int64, *int64) {
	return nil, nil
}
