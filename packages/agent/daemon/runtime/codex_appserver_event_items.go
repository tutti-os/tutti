package agentruntime

import (
	"log/slog"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func appServerCompactionNoticeEvent(session Session, turnID string, messageID string, completed bool) activityshared.Event {
	title := appServerCompactingContextTitle
	if completed {
		title = appServerContextCompactedTitle
	}
	return appServerSystemNoticeEvent(session, turnID, "system_notice", title, "", map[string]any{
		"messageId": messageID,
	})
}

func (*CodexAppServerAdapter) appServerItemEvents(
	session Session,
	turnID string,
	item map[string]any,
	completed bool,
	normalizer *acpTurnNormalizer,
) []activityshared.Event {
	if len(item) == 0 || normalizer == nil {
		return nil
	}
	itemType := asString(item["type"])
	// Review/compaction items stream both item/started and item/completed.
	// Gate each review banner to a single lifecycle event so the GUI shows it
	// once; compaction emits on both so the GUI can show live progress.
	if notice, ok := appServerNoticeItems[itemType]; ok {
		if notice.emitOnCompleted != completed {
			return nil
		}
		return []activityshared.Event{appServerSystemNoticeEvent(session, turnID, "system_notice", notice.message, "")}
	}
	if itemType == "contextCompaction" {
		// appServerSlashCompact emits the "Compacting context." banner eagerly
		// (before this notification can even arrive) and tracks its messageId
		// on the normalizer up front so the transcript row exists even if Codex
		// app-server never streams item/started at all. When that's already
		// the case, reuse the pending messageId instead of deriving a new one
		// from the item id: otherwise item/started would append a second,
		// unrelated banner row rather than confirming the one already shown.
		messageID := normalizer.pendingCompactionMessageID
		alreadyStarted := messageID != ""
		if messageID == "" {
			messageID = "compaction:" + firstNonEmpty(asString(item["id"]), turnID)
		}
		normalizer.TrackCompactionNotice(messageID, completed)
		if !completed && alreadyStarted {
			return nil
		}
		return []activityshared.Event{appServerCompactionNoticeEvent(session, turnID, messageID, completed)}
	}
	switch itemType {
	case "agentMessage":
		if !completed {
			return nil
		}
		normalizer.ApplyAssistantFinalText(asStringRaw(item["text"]))
		return normalizer.Finish(session, turnID, messageStreamStateCompleted)
	case "plan":
		if !completed {
			return nil
		}
		// Render the proposed plan as a dedicated card instead of merging it
		// into the assistant bubble: close any streaming text first, then
		// emit a standalone message tagged messageKind=plan for the GUI.
		events := normalizer.Finish(session, turnID, messageStreamStateCompleted)
		planMessageID := "plan:" + firstNonEmpty(asString(item["id"]), newID())
		events = append(events, newTurnActivityEventWithID(
			session,
			planMessageID,
			EventMessage,
			turnID,
			messageStreamStateCompleted,
			RoleAssistant,
			asStringRaw(item["text"]),
			map[string]any{
				"messageId":   planMessageID,
				"contentMode": messageContentModeSnapshot,
				"streamState": messageStreamStateCompleted,
				"messageKind": "plan",
			},
		))
		return events
	case "reasoning":
		if !completed {
			return nil
		}
		// Surface review/inline reasoning as a finalized thinking row. The
		// normalizer dedupes against any reasoning that already streamed as
		// textDelta chunks, so this is safe for both delivery modes.
		return normalizer.FinalizeThinkingItem(session, turnID, appServerReasoningText(item))
	case "userMessage", "hookPrompt":
		return nil
	default:
		update, ok := appServerItemToolCallUpdate(item, completed)
		if !ok {
			return nil
		}
		events, _ := normalizer.ToolCallEvents(session, turnID, update)
		return events
	}
}

// appServerItemToolCallUpdate converts an app-server thread item into the
// ACP-style tool_call update shape consumed by the shared normalizer.
func appServerItemToolCallUpdate(item map[string]any, completed bool) (map[string]any, bool) {
	itemID := asString(item["id"])
	status := asString(item["status"])
	if status == "" {
		if completed {
			status = "completed"
		} else {
			status = "in_progress"
		}
	}
	update := map[string]any{
		"sessionUpdate": "tool_call",
		"toolCallId":    itemID,
		"status":        appServerItemStatus(status),
	}
	if completed {
		update["sessionUpdate"] = "tool_call_update"
	}
	switch asString(item["type"]) {
	case "commandExecution":
		command := asStringRaw(item["command"])
		update["title"] = firstNonEmpty(command, "Run command")
		update["kind"] = "execute"
		update["rawInput"] = map[string]any{
			"command": command,
			"cwd":     asString(item["cwd"]),
		}
		if completed {
			output := map[string]any{}
			if stdout := asStringRaw(item["aggregatedOutput"]); stdout != "" {
				output["stdout"] = stdout
			}
			if exitCode, ok := acpIntFromValue(item["exitCode"]); ok {
				output["exitCode"] = exitCode
			}
			if len(output) > 0 {
				update["rawOutput"] = output
			}
		}
	case "fileChange":
		update["title"] = "Edit"
		update["kind"] = "edit"
		changes, _ := item["changes"].([]any)
		locations := make([]any, 0, len(changes))
		for _, change := range changes {
			if path := asString(payloadObject(change)["path"]); path != "" {
				locations = append(locations, map[string]any{"path": path})
			}
		}
		if len(locations) > 0 {
			update["locations"] = locations
		}
		rawInput := map[string]any{"changes": item["changes"]}
		if cwd := asString(item["cwd"]); cwd != "" {
			rawInput["cwd"] = cwd
		}
		update["rawInput"] = rawInput
	case "mcpToolCall":
		server := asString(item["server"])
		tool := asString(item["tool"])
		update["title"] = strings.TrimPrefix(server+"."+tool, ".")
		update["kind"] = "other"
		if arguments := item["arguments"]; arguments != nil {
			update["rawInput"] = map[string]any{"arguments": arguments}
		}
		if completed {
			output := map[string]any{}
			if result := item["result"]; result != nil {
				output["result"] = result
			}
			if errText := asStringRaw(item["error"]); errText != "" {
				output["error"] = errText
				update["status"] = messageStreamStateFailed
			}
			if len(output) > 0 {
				update["rawOutput"] = output
			}
		}
	case "webSearch":
		// Per the Codex app-server schema, a webSearch item is {id, query, action?}
		// and for a `search` action the real query lives in action.query or the
		// action.queries[] array; the top-level `query` is often empty. Read the
		// action first and fall back to the top-level field so the query is not
		// silently dropped (which previously rendered an empty web-search row).
		action := payloadObject(item["action"])
		queries := appServerSearchQueries(action["queries"])
		query := firstNonEmpty(
			firstAppServerQuery(queries),
			asString(action["query"]),
			asString(item["query"]),
		)
		url := asString(action["url"])
		actionType := firstNonEmpty(asString(action["type"]), "search")

		rawInput := map[string]any{}
		if query != "" {
			rawInput["query"] = query
		}
		if len(queries) > 0 {
			rawInput["search_query"] = queries
		}
		actionOut := map[string]any{"type": actionType}
		if query != "" {
			actionOut["query"] = query
		}
		if len(queries) > 0 {
			actionOut["queries"] = queries
		}
		if url != "" {
			actionOut["url"] = url
		}
		rawInput["action"] = actionOut

		switch {
		case query != "":
			update["title"] = "Searching for: " + query
		case url != "":
			update["title"] = "Visiting: " + url
		default:
			update["title"] = "WebSearch"
		}
		update["kind"] = "fetch"
		update["rawInput"] = rawInput

		if query == "" && url == "" && len(queries) == 0 {
			// Confirmed via exported logs: the Codex app-server streams web-search
			// items as {query:"", action:{type:"other"}} for some models (e.g.
			// gpt-5.x) — it never sends the query or results, so there is nothing
			// for the daemon or GUI to render. Keep this at debug level (it can fire
			// once per search) to aid future diagnosis without flooding info logs.
			slog.Debug(
				"agent session app-server web search has no query/results from provider",
				"itemId", itemID,
				"status", status,
				"rawItem", appServerItemJSON(item),
			)
		}
	case "dynamicToolCall":
		update["title"] = firstNonEmpty(asString(item["tool"]), "Tool")
		update["kind"] = "other"
		if arguments := item["arguments"]; arguments != nil {
			update["rawInput"] = map[string]any{"arguments": arguments}
		}
		if success, ok := item["success"].(bool); ok && completed && !success {
			update["status"] = messageStreamStateFailed
		}
	case "collabAgentToolCall":
		tool := firstNonEmpty(asString(item["tool"]), "agent")
		update["title"] = tool
		if appServerAgentControlToolName(tool) != "" {
			update["kind"] = "other"
		} else {
			update["kind"] = "execute"
		}
		rawInput := map[string]any{
			"task":      asStringRaw(item["prompt"]),
			"agentName": tool,
		}
		// The GUI seeds placeholder lanes from the spawn card's declared
		// children before any child rows arrive; lane attachment itself rides
		// the ownerCallId recorded on each child row (ADR 0007).
		if receivers := appServerReceiverThreadIDs(item["receiverThreadIds"]); len(receivers) > 0 {
			ids := make([]any, 0, len(receivers))
			for _, id := range receivers {
				ids = append(ids, id)
			}
			rawInput["receiverThreadIds"] = ids
		}
		update["rawInput"] = rawInput
		if completed {
			output := appServerCollabAgentRawOutput(item)
			if len(output) > 0 {
				update["rawOutput"] = output
			} else if update["status"] == messageStreamStateFailed {
				slog.Debug(
					"agent session app-server collab agent failed without output",
					"itemId", itemID,
					"tool", tool,
					"status", status,
					"rawItem", appServerItemJSON(item),
				)
			}
		}
	case "imageGeneration":
		update["title"] = "Generate image"
		update["kind"] = "other"
		if completed {
			output := map[string]any{}
			if savedPath := asString(item["savedPath"]); savedPath != "" {
				output["savedPath"] = savedPath
			}
			if result := asStringRaw(item["result"]); result != "" {
				output["result"] = result
			}
			if len(output) > 0 {
				update["rawOutput"] = output
			}
		}
	case "imageView":
		update["title"] = "View image"
		update["kind"] = "read"
		if path := asString(item["path"]); path != "" {
			update["locations"] = []any{map[string]any{"path": path}}
		}
	default:
		return nil, false
	}
	return update, true
}

func appServerAgentControlToolName(tool string) string {
	switch normalizeAgentToolToken(tool) {
	case "closeagent":
		return "CloseAgent"
	case "wait":
		return "Wait"
	default:
		return ""
	}
}

func appServerCollabAgentRawOutput(item map[string]any) map[string]any {
	output := map[string]any{}
	if message := firstNonEmpty(
		appServerOutputText(item["error"]),
		appServerOutputText(item["message"]),
	); message != "" {
		output["message"] = message
	}
	if result := item["result"]; result != nil {
		output["result"] = clonePayloadValue(result)
	}
	if text := firstNonEmpty(
		appServerOutputText(item["output"]),
		appServerOutputText(item["stdout"]),
	); text != "" {
		output["output"] = text
	}
	if stderr := appServerOutputText(item["stderr"]); stderr != "" {
		output["stderr"] = stderr
	}
	return output
}

func appServerOutputText(value any) string {
	if text := asStringRaw(value); strings.TrimSpace(text) != "" {
		return text
	}
	record := payloadObject(value)
	return firstNonEmpty(
		asStringRaw(record["message"]),
		asStringRaw(record["text"]),
		asStringRaw(record["output"]),
		asStringRaw(record["result"]),
	)
}

type appServerNotificationRoute struct {
	ownerThreadID string
	// ownerCallID is the spawn collabAgentToolCall item id that created the
	// owning child thread (registry parentItemID). Stamped on every routed
	// child event so the GUI attaches lanes by recorded edge, not inference
	// (ADR 0007).
	ownerCallID string
	turnID      string
	normalizer  *acpTurnNormalizer
	events      []activityshared.Event
	drop        bool
}
