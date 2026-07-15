//go:build darwin

package main

import (
	"bytes"
	"errors"

	"golang.org/x/sys/unix"
)

func processExecutablePath(pid int) (string, error) {
	info, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil {
		return "", err
	}
	name := info.Proc.P_comm[:]
	if end := bytes.IndexByte(name, 0); end >= 0 {
		name = name[:end]
	}
	if len(name) == 0 {
		return "", errors.New("process executable name is empty")
	}
	return string(name), nil
}
