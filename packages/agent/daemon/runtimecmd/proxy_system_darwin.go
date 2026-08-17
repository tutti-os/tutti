//go:build darwin

package runtimecmd

import (
	"context"
	"os/exec"
	"time"
)

func readSystemProxyEnv() map[string]string {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "scutil", "--proxy").Output()
	if err != nil {
		return nil
	}
	return parseScutilProxy(string(out))
}
