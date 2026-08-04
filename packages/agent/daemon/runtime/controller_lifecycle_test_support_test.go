package agentruntime

import (
	"context"
	"testing"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

type recordingStartAdapter struct {
	provider       string
	started        Session
	cancelCalls    int
	closeCalls     int
	closeErr       error
	cancelEntered  chan<- struct{}
	cancelReleased <-chan struct{}
}

func (a *recordingStartAdapter) Provider() string { return a.provider }

func (a *recordingStartAdapter) Start(_ context.Context, session Session) ([]activityshared.Event, error) {
	a.started = session
	return []activityshared.Event{
		newSessionActivityEvent(session, EventSessionStarted, SessionStatusReady, nil),
	}, nil
}

func (*recordingStartAdapter) Resume(context.Context, Session) error {
	return nil
}

func (a *recordingStartAdapter) Close(context.Context, Session) error {
	a.closeCalls++
	return a.closeErr
}

func (*recordingStartAdapter) Exec(context.Context, Session, []PromptContentBlock, string, string, EventSink, CommandSnapshotSink) ([]activityshared.Event, error) {
	return nil, nil
}

func (a *recordingStartAdapter) Cancel(context.Context, Session, string) ([]activityshared.Event, error) {
	a.cancelCalls++
	if a.cancelEntered != nil {
		select {
		case a.cancelEntered <- struct{}{}:
		default:
		}
	}
	if a.cancelReleased != nil {
		<-a.cancelReleased
	}
	return nil, nil
}

func waitForSessionStatus(t *testing.T, controller *Controller, roomID, agentSessionID, status string) Session {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		session, ok := controller.get(roomID, agentSessionID)
		if ok && session.Status == status {
			return session
		}
		time.Sleep(10 * time.Millisecond)
	}
	session, _ := controller.get(roomID, agentSessionID)
	t.Fatalf("session status = %q, want %q", session.Status, status)
	return Session{}
}
