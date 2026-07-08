package agentruntime

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

// turnProtocolFixture mirrors the sidecar turn.* event shape shared between
// this Go dispatch test and the sidecar's own turn-protocol.test.ts, so both
// sides are pinned against the same JSON fixtures instead of two hand-written
// tables that can drift apart.
type turnProtocolFixture struct {
	Description   string `json:"description"`
	TrackedTurnID string `json:"trackedTurnId"`
	TerminalEvent struct {
		Type    string         `json:"type"`
		Payload map[string]any `json:"payload"`
	} `json:"terminalEvent"`
	ExpectDispatch string `json:"expectDispatch"`
}

// TestClaudeSDKTurnProtocolGoldenFixtures drives the real production
// dispatchClaudeSDKEvent with each fixture and observes the same outcome a
// caller would: whether a tracked Exec waiter settles, whether an unrelated
// live waiter is left untouched (the Rkyo8B protection), or whether the event
// reaches the session-level publish sink.
func TestClaudeSDKTurnProtocolGoldenFixtures(t *testing.T) {
	t.Parallel()

	fixtureDir := filepath.Join("..", "..", "claude-sdk-sidecar", "fixtures", "turn-protocol")
	entries, err := os.ReadDir(fixtureDir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		t.Run(entry.Name(), func(t *testing.T) {
			t.Parallel()
			raw, err := os.ReadFile(filepath.Join(fixtureDir, entry.Name()))
			if err != nil {
				t.Fatalf("ReadFile: %v", err)
			}
			var fixture turnProtocolFixture
			if err := json.Unmarshal(raw, &fixture); err != nil {
				t.Fatalf("Unmarshal: %v", err)
			}
			runTurnProtocolFixture(t, fixture)
		})
	}
}

func runTurnProtocolFixture(t *testing.T, fixture turnProtocolFixture) {
	t.Helper()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := &recordingClaudeSDKConnection{}
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)

	var trackedWaiter *claudeSDKTurnWaiter
	if fixture.TrackedTurnID != "" {
		trackedWaiter = adapter.registerClaudeSDKTurn(adapterSession, fixture.TrackedTurnID, nil)
	}

	var published []activityshared.Event
	publishedCh := make(chan struct{}, 1)
	adapter.SetSessionEventSink(func(_ string, events []activityshared.Event) {
		published = append(published, events...)
		select {
		case publishedCh <- struct{}{}:
		default:
		}
	})

	adapter.dispatchClaudeSDKEvent(session.AgentSessionID, adapterSession, claudeSDKSidecarEvent{
		Type:    fixture.TerminalEvent.Type,
		Payload: fixture.TerminalEvent.Payload,
	})

	switch fixture.ExpectDispatch {
	case "complete_waiter":
		if trackedWaiter == nil {
			t.Fatal("fixture expects complete_waiter but registered no tracked waiter")
		}
		select {
		case <-trackedWaiter.done:
		case <-time.After(time.Second):
			t.Fatalf("%s: tracked waiter did not settle", fixture.Description)
		}
	case "drop_terminal":
		if trackedWaiter != nil {
			select {
			case result := <-trackedWaiter.done:
				t.Fatalf("%s: unrelated live waiter was incorrectly settled: %#v", fixture.Description, result)
			default:
			}
		}
		select {
		case <-publishedCh:
			t.Fatalf("%s: dropped terminal must not publish a session event", fixture.Description)
		default:
		}
	case "publish":
		select {
		case <-publishedCh:
		case <-time.After(time.Second):
			t.Fatalf("%s: expected event to reach the session publish sink", fixture.Description)
		}
		if len(published) == 0 {
			t.Fatalf("%s: publish sink received no events", fixture.Description)
		}
	default:
		t.Fatalf("unknown expectDispatch %q in fixture", fixture.ExpectDispatch)
	}
}
