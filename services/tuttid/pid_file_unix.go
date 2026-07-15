//go:build !windows

package main

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

func lockPIDFile(file *os.File) error {
	err := unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB)
	if errors.Is(err, unix.EWOULDBLOCK) || errors.Is(err, unix.EAGAIN) {
		return errPIDFileLocked
	}
	return err
}

func unlockPIDFile(file *os.File) error {
	return unix.Flock(int(file.Fd()), unix.LOCK_UN)
}
