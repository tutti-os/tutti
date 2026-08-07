package computer

import "context"

type computerDaemon interface {
	Ensure(context.Context, []string) error
	Close() error
}

func newComputerDaemon() computerDaemon {
	return newPlatformComputerDaemon()
}
