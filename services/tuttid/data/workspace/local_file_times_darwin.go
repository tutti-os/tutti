package workspace

import (
	"os"
	"syscall"
)

func localFileTimeMetadata(info os.FileInfo) (*int64, *int64) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return nil, nil
	}

	createdTimeMs := timespecUnixMilli(stat.Birthtimespec.Sec, stat.Birthtimespec.Nsec)
	lastOpenedMs := timespecUnixMilli(stat.Atimespec.Sec, stat.Atimespec.Nsec)
	return &createdTimeMs, &lastOpenedMs
}

func timespecUnixMilli(seconds int64, nanoseconds int64) int64 {
	return seconds*1000 + nanoseconds/1_000_000
}
