//go:build !windows

package computer

import "context"

type noopComputerDaemon struct{}

func newPlatformComputerDaemon() computerDaemon { return noopComputerDaemon{} }

func (noopComputerDaemon) Ensure(context.Context, []string) error { return nil }

func (noopComputerDaemon) Close() error { return nil }
