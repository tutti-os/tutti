package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func hasTimelineItemInReports(reports []agentsessionstore.ReportActivityInput, itemType string, status string, text string) bool {
	for _, report := range reports {
		if hasTimelineItem(report, itemType, status, text) {
			return true
		}
	}
	return false
}

func sdkBackgroundAgentsFromEvents(t *testing.T, events []activityshared.Event) map[string]any {
	t.Helper()
	for i := len(events) - 1; i >= 0; i-- {
		event := events[i]
		if event.Type != activityshared.EventSessionUpdated {
			continue
		}
		runtimeContext := payloadMap(event.Payload.Metadata, "runtimeContext")
		backgroundAgents := payloadMap(runtimeContext, "backgroundAgents")
		if len(backgroundAgents) > 0 {
			return backgroundAgents
		}
	}
	t.Fatalf("events = %#v, missing runtimeContext.backgroundAgents", events)
	return nil
}

func sdkBackgroundAgentStatusByParent(t *testing.T, backgroundAgents map[string]any, parentToolUseID string) string {
	t.Helper()
	items, ok := backgroundAgents["items"].([]any)
	if !ok {
		t.Fatalf("backgroundAgents items = %#v, want []any", backgroundAgents["items"])
	}
	for _, item := range items {
		record := payloadMap(map[string]any{"item": item}, "item")
		if record["parentToolUseId"] == parentToolUseID {
			return fmt.Sprint(record["status"])
		}
	}
	t.Fatalf("backgroundAgents = %#v, missing parentToolUseId %q", backgroundAgents, parentToolUseID)
	return ""
}

func hasClaudeSDKModelConfigOptions(runtimeContext map[string]any) bool {
	options, ok := runtimeContext["configOptions"].([]map[string]any)
	if !ok {
		return false
	}
	for _, option := range options {
		if option["id"] != "model" {
			continue
		}
		models, ok := option["options"].([]map[string]string)
		if !ok {
			return false
		}
		var sawDefault bool
		var sawHaiku bool
		for _, model := range models {
			if model["value"] == "default" {
				sawDefault = true
			}
			if model["value"] == "haiku" {
				sawHaiku = true
			}
		}
		return sawDefault && sawHaiku
	}
	return false
}

func hasClaudeSDKSpeedConfigOptions(runtimeContext map[string]any, currentValue string) bool {
	options, ok := runtimeContext["configOptions"].([]map[string]any)
	if !ok {
		return false
	}
	for _, option := range options {
		if option["id"] != "fast" || option["currentValue"] != currentValue {
			continue
		}
		speeds, ok := option["options"].([]map[string]string)
		if !ok {
			return false
		}
		var sawStandard bool
		var sawFast bool
		for _, speed := range speeds {
			if speed["value"] == "standard" {
				sawStandard = true
			}
			if speed["value"] == "fast" {
				sawFast = true
			}
		}
		return sawStandard && sawFast
	}
	return false
}

func hasClaudeSDKEffortConfigOptions(runtimeContext map[string]any, currentValue string) bool {
	options, ok := runtimeContext["configOptions"].([]map[string]any)
	if !ok {
		return false
	}
	for _, option := range options {
		if option["id"] != "effort" || option["currentValue"] != currentValue {
			continue
		}
		efforts, ok := option["options"].([]map[string]string)
		if !ok {
			return false
		}
		var sawLow bool
		var sawXHigh bool
		for _, effort := range efforts {
			if effort["value"] == "low" {
				sawLow = true
			}
			if effort["value"] == "xhigh" {
				sawXHigh = true
			}
		}
		return sawLow && sawXHigh
	}
	return false
}

type recordingClaudeSDKTransport struct {
	conn *scriptedClaudeSDKConnection
	spec ProcessSpec
}

func (t *recordingClaudeSDKTransport) Start(_ context.Context, spec ProcessSpec) (ProcessConnection, error) {
	t.spec = spec
	return t.conn, nil
}

type recordingClaudeSDKConnection struct {
	mu   sync.Mutex
	sent []claudeSDKSidecarRequest
}

func (c *recordingClaudeSDKConnection) Send(data []byte) error {
	var request claudeSDKSidecarRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return err
	}
	c.mu.Lock()
	c.sent = append(c.sent, request)
	c.mu.Unlock()
	return nil
}

func (*recordingClaudeSDKConnection) Recv() (ProcessFrame, error) {
	return ProcessFrame{}, errors.New("recording claude sdk connection does not receive")
}

func (*recordingClaudeSDKConnection) Close() error {
	return nil
}

func (c *recordingClaudeSDKConnection) sentRequests() []claudeSDKSidecarRequest {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]claudeSDKSidecarRequest(nil), c.sent...)
}

type ackClaudeSDKConnection struct {
	mu     sync.Mutex
	sent   []claudeSDKSidecarRequest
	frames []ProcessFrame
}

func (c *ackClaudeSDKConnection) Send(data []byte) error {
	var request claudeSDKSidecarRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return err
	}
	response, err := json.Marshal(claudeSDKSidecarEvent{Version: claudeSDKSidecarProtocolVersion, ID: request.ID, Type: "ok"})
	if err != nil {
		return err
	}
	c.mu.Lock()
	c.sent = append(c.sent, request)
	c.frames = append(c.frames, ProcessFrame{Stdout: append(response, '\n')})
	c.mu.Unlock()
	return nil
}

func (c *ackClaudeSDKConnection) Recv() (ProcessFrame, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.frames) == 0 {
		return ProcessFrame{}, errors.New("ack claude sdk connection has no frames")
	}
	frame := versionClaudeSDKTestFrame(c.frames[0])
	c.frames = c.frames[1:]
	return frame, nil
}

func (*ackClaudeSDKConnection) Close() error {
	return nil
}

func (c *ackClaudeSDKConnection) sentRequests() []claudeSDKSidecarRequest {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]claudeSDKSidecarRequest(nil), c.sent...)
}

type scriptedClaudeSDKConnection struct {
	mu     sync.Mutex
	sent   []claudeSDKSidecarRequest
	frames []ProcessFrame
}

func (c *scriptedClaudeSDKConnection) Send(data []byte) error {
	var request claudeSDKSidecarRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return err
	}
	c.mu.Lock()
	c.sent = append(c.sent, request)
	if request.Type == "close" {
		response, err := json.Marshal(claudeSDKSidecarEvent{
			Version: claudeSDKSidecarProtocolVersion,
			ID:      request.ID,
			Type:    "ok",
		})
		if err != nil {
			c.mu.Unlock()
			return err
		}
		c.frames = append(c.frames, ProcessFrame{Stdout: append(response, '\n')})
	}
	c.mu.Unlock()
	return nil
}

func (c *scriptedClaudeSDKConnection) Recv() (ProcessFrame, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.frames) == 0 {
		return ProcessFrame{}, errors.New("scripted claude sdk connection has no frames")
	}
	frame := versionClaudeSDKTestFrame(c.frames[0])
	c.frames = c.frames[1:]
	return frame, nil
}

func (*scriptedClaudeSDKConnection) Close() error {
	return nil
}

func (c *scriptedClaudeSDKConnection) sentRequests() []claudeSDKSidecarRequest {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]claudeSDKSidecarRequest(nil), c.sent...)
}

type blockingClaudeSDKConnection struct {
	mu     sync.Mutex
	sent   []claudeSDKSidecarRequest
	frames chan ProcessFrame
	closed chan struct{}
	once   sync.Once
}

func newBlockingClaudeSDKConnection() *blockingClaudeSDKConnection {
	return &blockingClaudeSDKConnection{
		frames: make(chan ProcessFrame, 16),
		closed: make(chan struct{}),
	}
}

func (c *blockingClaudeSDKConnection) Send(data []byte) error {
	var request claudeSDKSidecarRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return err
	}
	c.mu.Lock()
	c.sent = append(c.sent, request)
	c.mu.Unlock()
	return nil
}

func (c *blockingClaudeSDKConnection) Recv() (ProcessFrame, error) {
	select {
	case frame := <-c.frames:
		return versionClaudeSDKTestFrame(frame), nil
	case <-c.closed:
		return ProcessFrame{}, io.EOF
	}
}

func (c *blockingClaudeSDKConnection) Close() error {
	c.once.Do(func() {
		close(c.closed)
	})
	return nil
}

func (c *blockingClaudeSDKConnection) sentRequests() []claudeSDKSidecarRequest {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]claudeSDKSidecarRequest(nil), c.sent...)
}

func (c *blockingClaudeSDKConnection) pushEvent(event claudeSDKSidecarEvent) {
	if event.Version == 0 {
		event.Version = claudeSDKSidecarProtocolVersion
	}
	data, err := json.Marshal(event)
	if err != nil {
		panic(err)
	}
	c.frames <- ProcessFrame{Stdout: append(data, '\n')}
}

func versionClaudeSDKTestFrame(frame ProcessFrame) ProcessFrame {
	if len(frame.Stdout) == 0 {
		return frame
	}
	lines := strings.Split(strings.TrimSpace(string(frame.Stdout)), "\n")
	versioned := make([]string, 0, len(lines))
	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var event map[string]any
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			return frame
		}
		if _, ok := event["version"]; !ok {
			event["version"] = claudeSDKSidecarProtocolVersion
		}
		encoded, err := json.Marshal(event)
		if err != nil {
			return frame
		}
		versioned = append(versioned, string(encoded))
	}
	frame.Stdout = []byte(strings.Join(versioned, "\n") + "\n")
	return frame
}

func waitForClaudeSDKSentRequest(t *testing.T, conn *blockingClaudeSDKConnection, requestType string) claudeSDKSidecarRequest {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		for _, request := range conn.sentRequests() {
			if request.Type == requestType {
				return request
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s request; sent=%#v", requestType, conn.sentRequests())
	return claudeSDKSidecarRequest{}
}
