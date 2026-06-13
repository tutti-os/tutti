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

	lastOpenedMs := timespecUnixMilli(stat.Atim.Sec, stat.Atim.Nsec)
	return nil, &lastOpenedMs
}

func timespecUnixMilli(seconds int64, nanoseconds int64) int64 {
	return seconds*1000 + nanoseconds/1_000_000
}
