package devicepresence

import (
	"context"
	"sync"
	"testing"
	"time"

	authbridge "github.com/tutti-os/tutti/packages/auth/bridge-go"
)

type fixedAccount struct{ cookie string }

func (account fixedAccount) ReadSession() (*authbridge.Session, error) {
	return &authbridge.Session{Cookie: account.cookie, UserID: "user-1"}, nil
}

type recordingControl struct {
	mu         sync.Mutex
	registered int
	opened     int
	heartbeats int
	closed     int
	closedWake chan struct{}
}

func (control *recordingControl) RegisterCurrentDevice(context.Context, string, DeviceMetadata) error {
	control.mu.Lock()
	control.registered++
	control.mu.Unlock()
	return nil
}

func (control *recordingControl) OpenSession(context.Context, string, string, string) (Lease, error) {
	control.mu.Lock()
	control.opened++
	control.mu.Unlock()
	return Lease{PresenceLeaseID: "lease-1", HeartbeatIntervalSeconds: 30}, nil
}

func (control *recordingControl) Heartbeat(context.Context, string, string) error {
	control.mu.Lock()
	control.heartbeats++
	control.mu.Unlock()
	return nil
}

func (control *recordingControl) CloseSession(context.Context, string, string) error {
	control.mu.Lock()
	control.closed++
	control.mu.Unlock()
	select {
	case control.closedWake <- struct{}{}:
	default:
	}
	return nil
}

func TestServiceActivatesRenewsAndClosesExactLease(t *testing.T) {
	control := &recordingControl{closedWake: make(chan struct{}, 1)}
	service := NewService(fixedAccount{cookie: "sid=test"}, control, DeviceMetadata{DeviceID: "device-1"})
	service.HeartbeatEvery = 5 * time.Millisecond
	service.Start()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		control.mu.Lock()
		heartbeats := control.heartbeats
		control.mu.Unlock()
		if heartbeats >= 2 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	service.Stop(ctx)
	select {
	case <-control.closedWake:
	case <-time.After(time.Second):
		t.Fatal("service did not close its active lease")
	}
	control.mu.Lock()
	defer control.mu.Unlock()
	if control.registered != 1 || control.opened != 1 || control.heartbeats < 2 || control.closed != 1 {
		t.Fatalf("unexpected calls: register=%d open=%d heartbeat=%d close=%d", control.registered, control.opened, control.heartbeats, control.closed)
	}
}
