//go:build darwin && !ios

package networkchange

import (
	"context"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

type systemSource struct{}

func (systemSource) Sample(ctx context.Context) (Fingerprint, error) {
	return sampleLocalNetwork(ctx)
}

// Watch uses macOS's native routing socket as a trigger. The monitor still
// samples through net.Interfaces after debounce; route-socket payloads are
// never parsed, persisted, or exposed.
func (systemSource) Watch(ctx context.Context) (<-chan struct{}, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	fd, err := unix.Socket(unix.AF_ROUTE, unix.SOCK_RAW, unix.AF_UNSPEC)
	if err != nil {
		return nil, ErrWatcherUnavailable
	}
	events := make(chan struct{}, 1)
	var closeOnce sync.Once
	closeFD := func() { closeOnce.Do(func() { _ = unix.Close(fd) }) }
	go func() {
		defer close(events)
		defer closeFD()
		buffer := make([]byte, 16*1024)
		for {
			count, readErr := unix.Read(fd, buffer)
			if readErr != nil || count == 0 {
				return
			}
			select {
			case events <- struct{}{}:
			default:
			}
		}
	}()
	go func() {
		<-ctx.Done()
		closeFD()
	}()
	return events, nil
}

const defaultSafetyRecheck = 30 * time.Second
