//go:build !darwin && !windows

package runtimecmd

func readSystemProxyEnv() map[string]string { return nil }
