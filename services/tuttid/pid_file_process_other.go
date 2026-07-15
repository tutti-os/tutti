//go:build !darwin && !linux && !windows

package main

import (
	"os/exec"
	"strconv"
	"strings"
)

func processExecutablePath(pid int) (string, error) {
	output, err := exec.Command("ps", "-p", strconv.Itoa(pid), "-o", "comm=").Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(output)), nil
}
