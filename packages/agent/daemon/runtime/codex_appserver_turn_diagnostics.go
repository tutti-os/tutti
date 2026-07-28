package agentruntime

import (
	"strings"
	"sync"
	"time"
)

type codexAppServerTurnTraceSink interface {
	Log(event string, fields map[string]any)
}

type codexAppServerToolTiming struct {
	startedAt time.Time
	itemType  string
}

// codexAppServerTurnDiagnostics writes bounded lifecycle records to the
// exported app-server diagnostics trace. It intentionally excludes tool
// arguments, commands, paths, output, queries, URLs, and error text.
type codexAppServerTurnDiagnostics struct {
	mu             sync.Mutex
	trace          codexAppServerTurnTraceSink
	now            func() time.Time
	startedAt      time.Time
	turnID         string
	providerTurnID string
	finished       bool
	tools          map[string]codexAppServerToolTiming
	completedTools map[string]struct{}
	startedCount   int
	completedCount int
	failedCount    int
	maxDuration    time.Duration
	maxItemType    string
}

func newCodexAppServerTurnDiagnostics(
	trace codexAppServerTurnTraceSink,
	turnID string,
) *codexAppServerTurnDiagnostics {
	now := time.Now
	diagnostics := &codexAppServerTurnDiagnostics{
		now:            now,
		turnID:         strings.TrimSpace(turnID),
		tools:          make(map[string]codexAppServerToolTiming),
		completedTools: make(map[string]struct{}),
	}
	diagnostics.Start(trace)
	return diagnostics
}

func (d *codexAppServerTurnDiagnostics) Start(trace codexAppServerTurnTraceSink) {
	if d == nil || trace == nil {
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.trace != nil {
		return
	}
	d.trace = trace
	d.startedAt = d.now()
}

func (d *codexAppServerTurnDiagnostics) ObserveNotification(method string, params map[string]any) {
	if d == nil {
		return
	}
	switch method {
	case appServerNotifyItemStarted:
		d.toolStarted(payloadObject(params["item"]), asString(params["threadId"]), asString(params["turnId"]))
	case appServerNotifyItemCompleted:
		d.toolCompleted(payloadObject(params["item"]), asString(params["threadId"]), asString(params["turnId"]))
	}
}

func (d *codexAppServerTurnDiagnostics) toolStarted(item map[string]any, providerThreadID, providerTurnID string) {
	itemID, itemType, safeFields, ok := codexAppServerToolDiagnosticFields(item)
	if !ok {
		return
	}
	toolKey := codexAppServerToolDiagnosticKey(providerThreadID, itemID)
	now := d.now()
	d.mu.Lock()
	if d.trace == nil || d.finished {
		d.mu.Unlock()
		return
	}
	if _, exists := d.tools[toolKey]; exists {
		d.mu.Unlock()
		return
	}
	if _, completed := d.completedTools[toolKey]; completed {
		d.mu.Unlock()
		return
	}
	d.tools[toolKey] = codexAppServerToolTiming{startedAt: now, itemType: itemType}
	d.startedCount++
	fields := d.toolFieldsLocked(itemID, itemType, providerThreadID, providerTurnID, safeFields)
	trace := d.trace
	d.mu.Unlock()
	trace.Log("turn.tool.started", fields)
}

func (d *codexAppServerTurnDiagnostics) toolCompleted(item map[string]any, providerThreadID, providerTurnID string) {
	itemID, itemType, safeFields, ok := codexAppServerToolDiagnosticFields(item)
	if !ok {
		return
	}
	toolKey := codexAppServerToolDiagnosticKey(providerThreadID, itemID)
	now := d.now()
	d.mu.Lock()
	if d.trace == nil || d.finished {
		d.mu.Unlock()
		return
	}
	if _, completed := d.completedTools[toolKey]; completed {
		d.mu.Unlock()
		return
	}
	d.completedTools[toolKey] = struct{}{}
	d.completedCount++
	fields := d.toolFieldsLocked(itemID, itemType, providerThreadID, providerTurnID, safeFields)
	if timing, started := d.tools[toolKey]; started {
		duration := now.Sub(timing.startedAt)
		if duration < 0 {
			duration = 0
		}
		fields["duration_ms"] = duration.Milliseconds()
		fields["start_observed"] = true
		delete(d.tools, toolKey)
		if duration > d.maxDuration {
			d.maxDuration = duration
			d.maxItemType = timing.itemType
		}
	} else {
		fields["start_observed"] = false
	}
	outcome, failed := codexAppServerToolDiagnosticOutcome(item)
	fields["outcome"] = outcome
	if failed {
		d.failedCount++
	}
	trace := d.trace
	d.mu.Unlock()
	trace.Log("turn.tool.completed", fields)
}

func (d *codexAppServerTurnDiagnostics) Finish(outcome, providerTurnID string) {
	if d == nil {
		return
	}
	now := d.now()
	d.mu.Lock()
	if d.trace == nil || d.finished {
		d.mu.Unlock()
		return
	}
	d.finished = true
	if providerTurnID = strings.TrimSpace(providerTurnID); providerTurnID != "" {
		d.providerTurnID = providerTurnID
	}
	fields := d.baseFieldsLocked()
	duration := now.Sub(d.startedAt)
	if duration < 0 {
		duration = 0
	}
	fields["duration_ms"] = duration.Milliseconds()
	fields["outcome"] = firstNonEmpty(strings.TrimSpace(outcome), "unknown")
	fields["tool_started_count"] = d.startedCount
	fields["tool_completed_count"] = d.completedCount
	fields["tool_failed_count"] = d.failedCount
	fields["open_tool_count"] = len(d.tools)
	if d.maxDuration > 0 {
		fields["max_tool_duration_ms"] = d.maxDuration.Milliseconds()
		fields["max_tool_item_type"] = d.maxItemType
	}
	var longestOpen time.Duration
	var longestOpenType string
	for _, timing := range d.tools {
		openFor := now.Sub(timing.startedAt)
		if openFor > longestOpen {
			longestOpen = openFor
			longestOpenType = timing.itemType
		}
	}
	if longestOpen > 0 {
		fields["longest_open_tool_ms"] = longestOpen.Milliseconds()
		fields["longest_open_item_type"] = longestOpenType
	}
	trace := d.trace
	d.mu.Unlock()
	trace.Log("turn.completed", fields)
}

func (d *codexAppServerTurnDiagnostics) baseFieldsLocked() map[string]any {
	return map[string]any{
		"turn_id":          d.turnID,
		"provider_turn_id": d.providerTurnID,
	}
}

func (d *codexAppServerTurnDiagnostics) toolFieldsLocked(
	itemID string,
	itemType string,
	providerThreadID string,
	providerTurnID string,
	safeFields map[string]any,
) map[string]any {
	fields := d.baseFieldsLocked()
	fields["item_id"] = itemID
	fields["item_type"] = itemType
	if providerThreadID = strings.TrimSpace(providerThreadID); providerThreadID != "" {
		fields["item_provider_thread_id"] = providerThreadID
	}
	if providerTurnID = strings.TrimSpace(providerTurnID); providerTurnID != "" {
		fields["item_provider_turn_id"] = providerTurnID
	}
	for key, value := range safeFields {
		fields[key] = value
	}
	return fields
}

func codexAppServerToolDiagnosticKey(providerThreadID, itemID string) string {
	return strings.TrimSpace(providerThreadID) + "\x00" + strings.TrimSpace(itemID)
}

func codexAppServerToolDiagnosticFields(item map[string]any) (string, string, map[string]any, bool) {
	itemID := strings.TrimSpace(asString(item["id"]))
	itemType := strings.TrimSpace(asString(item["type"]))
	if itemID == "" {
		return "", "", nil, false
	}
	fields := map[string]any{}
	switch itemType {
	case "commandExecution":
		if output := asStringRaw(item["aggregatedOutput"]); output != "" {
			fields["output_bytes"] = len(output)
		}
		if exitCode, ok := acpIntFromValue(item["exitCode"]); ok {
			fields["exit_code"] = exitCode
		}
	case "fileChange":
		if changes, ok := item["changes"].([]any); ok {
			fields["change_count"] = len(changes)
		}
	case "mcpToolCall":
		fields["tool_server"] = asString(item["server"])
		fields["tool_name"] = asString(item["tool"])
		fields["has_error"] = strings.TrimSpace(asStringRaw(item["error"])) != ""
	case "webSearch":
		action := payloadObject(item["action"])
		fields["action_type"] = firstNonEmpty(asString(action["type"]), "search")
		fields["query_count"] = len(appServerSearchQueries(action["queries"]))
		fields["has_url"] = strings.TrimSpace(asString(action["url"])) != ""
	case "dynamicToolCall", "collabAgentToolCall":
		fields["tool_name"] = asString(item["tool"])
	case "imageGeneration":
		fields["has_saved_path"] = strings.TrimSpace(asString(item["savedPath"])) != ""
	case "imageView":
	default:
		return "", "", nil, false
	}
	return itemID, itemType, fields, true
}

func codexAppServerToolDiagnosticOutcome(item map[string]any) (string, bool) {
	status := firstNonEmpty(strings.TrimSpace(asString(item["status"])), "completed")
	failed := status == "failed" || status == "declined" || status == "canceled" || status == "cancelled"
	switch asString(item["type"]) {
	case "commandExecution":
		if exitCode, ok := acpIntFromValue(item["exitCode"]); ok && exitCode != 0 {
			failed = true
		}
	case "mcpToolCall":
		failed = failed || strings.TrimSpace(asStringRaw(item["error"])) != ""
	case "dynamicToolCall":
		if success, ok := item["success"].(bool); ok && !success {
			failed = true
		}
	}
	if failed {
		return "failed", true
	}
	return status, false
}
