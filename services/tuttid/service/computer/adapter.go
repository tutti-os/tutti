package computer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

type windowRecord struct {
	PID        int    `json:"pid"`
	WindowID   int    `json:"window_id"`
	ZIndex     int    `json:"z_index"`
	AppName    string `json:"app_name"`
	Title      string `json:"title"`
	IsOnScreen bool   `json:"is_on_screen"`
}

type windowStatePayload struct {
	ScreenshotFilePath string `json:"screenshot_file_path"`
}

var accessibilityWindowLinePattern = regexp.MustCompile(`^- (.+) \(pid (\d+)\)(?: "(.*)"| \(no title\)) \[window_id: (\d+)\]$`)

// adaptToolCall implements Tutti's explicitly supported stable aliases over
// cua-driver. Native discovery/invocation uses the separate policy-enforced
// Service methods and never falls through this switch.
func (s *computerSession) adaptToolCall(ctx context.Context, tool string, args map[string]any) (ToolResult, error) {
	switch tool {
	case "screenshot":
		return s.adaptScreenshot(ctx, args)
	case "left_click":
		return s.adaptWindowTargetedTool(ctx, "click", args)
	case "double_click":
		return s.adaptWindowTargetedTool(ctx, "click", withToolArg(args, "count", 2))
	case "right_click":
		return s.adaptWindowTargetedTool(ctx, "click", withToolArg(args, "button", "right"))
	case "click", "scroll":
		return s.adaptWindowTargetedTool(ctx, tool, args)
	case "press_key":
		return s.adaptPressKey(ctx, args)
	case "type_text":
		return s.adaptPIDRequiredTool(ctx, tool, args)
	case "move_cursor":
		return s.callTool(ctx, tool, args)
	default:
		return ToolResult{}, fmt.Errorf("unsupported stable computer tool %q", tool)
	}
}

func (s *computerSession) adaptScreenshot(ctx context.Context, args map[string]any) (ToolResult, error) {
	file, err := os.CreateTemp("", "tutti-computer-*.png")
	if err != nil {
		return ToolResult{}, err
	}
	path := file.Name()
	_ = file.Close()

	target, targetErr := s.resolveWindowTarget(ctx, args)
	if targetErr != nil {
		_ = os.Remove(path)
		return ToolResult{}, targetErr
	}
	raw, err := s.callTool(ctx, "get_window_state", map[string]any{
		"pid":                 target.PID,
		"window_id":           target.WindowID,
		"capture_mode":        "vision",
		"screenshot_out_file": path,
	})
	if err != nil {
		_ = os.Remove(path)
		return ToolResult{}, err
	}
	if _, statErr := os.Stat(path); statErr != nil {
		_ = os.Remove(path)
		return ToolResult{}, fmt.Errorf("screenshot file missing after capture: %w (tool output: %s)", statErr, truncateForError(raw.Text))
	}

	structured := cloneStructuredContent(raw.StructuredContent)
	structured["screenshot_file_path"] = path
	return ToolResult{Text: fmt.Sprintf("Screenshot saved to %s", path), StructuredContent: structured}, nil
}

func (s *computerSession) adaptWindowTargetedTool(ctx context.Context, tool string, args map[string]any) (ToolResult, error) {
	out := cloneToolArgs(args)
	delete(out, "scope")
	target, err := s.resolveWindowTarget(ctx, args)
	if err != nil {
		return ToolResult{}, err
	}
	out["pid"] = target.PID
	out["window_id"] = target.WindowID
	return s.callTool(ctx, tool, out)
}

func (s *computerSession) adaptPressKey(ctx context.Context, args map[string]any) (ToolResult, error) {
	keySpec, ok := stringArg(args, "key")
	if !ok || strings.TrimSpace(keySpec) == "" {
		return ToolResult{}, fmt.Errorf("missing required string field: key")
	}

	target, err := s.resolveWindowTarget(ctx, args)
	if err != nil {
		return ToolResult{}, err
	}

	parts := splitKeySpec(keySpec)
	if len(parts) > 1 {
		return s.callTool(ctx, "hotkey", map[string]any{
			"pid":       target.PID,
			"window_id": target.WindowID,
			"keys":      parts,
		})
	}

	return s.callTool(ctx, "press_key", map[string]any{
		"pid":       target.PID,
		"window_id": target.WindowID,
		"key":       parts[0],
	})
}

func (s *computerSession) adaptPIDRequiredTool(ctx context.Context, tool string, args map[string]any) (ToolResult, error) {
	target, err := s.resolveWindowTarget(ctx, args)
	if err != nil {
		return ToolResult{}, err
	}

	out := map[string]any{"pid": target.PID, "window_id": target.WindowID}
	for key, value := range args {
		switch key {
		case "x", "y", "scope", "pid", "window_id":
			continue
		case "amount":
			if amount, ok := numericArg(args, "amount"); ok {
				out["amount"] = int(amount)
			}
		default:
			out[key] = value
		}
	}
	if tool == "scroll" {
		if _, ok := out["amount"]; !ok {
			out["amount"] = 3
		}
	}
	return s.callTool(ctx, tool, out)
}

func (s *computerSession) resolveFrontmostWindow(ctx context.Context) (windowRecord, error) {
	raw, listErr := s.callTool(ctx, "list_windows", map[string]any{"on_screen_only": true})
	var structuredErr error
	if listErr == nil {
		payload, decodeErr := structuredPayload[struct {
			Windows []windowRecord `json:"windows"`
		}](raw.StructuredContent)
		if decodeErr == nil {
			window, selectErr := selectAutomationWindow(payload.Windows)
			if selectErr == nil {
				return window, nil
			}
			structuredErr = selectErr
		} else {
			structuredErr = decodeErr
		}
	}

	legacy, legacyErr := s.callTool(ctx, "get_accessibility_tree", nil)
	if legacyErr != nil {
		return windowRecord{}, errors.Join(listErr, structuredErr, legacyErr)
	}
	windows, err := parseAccessibilityTreeWindows(legacy.Text)
	if err != nil {
		return windowRecord{}, err
	}

	return selectAutomationWindow(windows)
}

func (s *computerSession) resolveWindowTarget(ctx context.Context, args map[string]any) (windowRecord, error) {
	pid, hasPID := integerArg(args, "pid")
	windowID, hasWindowID := integerArg(args, "window_id")
	if hasPID != hasWindowID {
		return windowRecord{}, fmt.Errorf("pid and window_id must be provided together")
	}
	if hasPID {
		return windowRecord{PID: pid, WindowID: windowID}, nil
	}
	return s.resolveFrontmostWindow(ctx)
}

func selectAutomationWindow(windows []windowRecord) (windowRecord, error) {
	candidates := make([]windowRecord, 0, len(windows))
	desktopPID, _ := strconv.Atoi(strings.TrimSpace(os.Getenv("TUTTI_DESKTOP_PARENT_PID")))
	for _, window := range windows {
		if !window.IsOnScreen && window.ZIndex != 0 {
			continue
		}
		name := strings.ToLower(strings.TrimSpace(window.AppName))
		if name == "cua driver" || strings.Contains(name, "tutti") || desktopPID > 0 && window.PID == desktopPID {
			continue
		}
		if window.PID <= 0 || window.WindowID <= 0 {
			continue
		}
		candidates = append(candidates, window)
	}
	if len(candidates) == 0 {
		return windowRecord{}, fmt.Errorf("no eligible visible windows found")
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		return candidates[i].ZIndex > candidates[j].ZIndex
	})
	return candidates[0], nil
}

func parseAccessibilityTreeWindows(text string) ([]windowRecord, error) {
	lines := strings.Split(text, "\n")
	windows := make([]windowRecord, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		matches := accessibilityWindowLinePattern.FindStringSubmatch(line)
		if len(matches) != 5 {
			continue
		}
		pid, err := strconv.Atoi(matches[2])
		if err != nil {
			continue
		}
		windowID, err := strconv.Atoi(matches[4])
		if err != nil {
			continue
		}
		windows = append(windows, windowRecord{
			AppName:  matches[1],
			PID:      pid,
			WindowID: windowID,
			Title:    matches[3],
		})
	}
	if len(windows) == 0 {
		return nil, fmt.Errorf("no visible windows found in accessibility tree")
	}

	sort.SliceStable(windows, func(i, j int) bool {
		return windowAutomationPriority(windows[i]) > windowAutomationPriority(windows[j])
	})
	return windows, nil
}

func windowAutomationPriority(window windowRecord) int {
	name := strings.ToLower(strings.TrimSpace(window.AppName))
	switch {
	case name == "cua driver":
		return 0
	case strings.Contains(name, "tutti"):
		return 10
	case strings.TrimSpace(window.Title) == "":
		return 20
	default:
		return 100
	}
}

func decodeStructuredPayload[T any](text string) (T, error) {
	var zero T
	text = strings.TrimSpace(text)
	if text == "" {
		return zero, fmt.Errorf("empty structured tool result")
	}
	if err := json.Unmarshal([]byte(text), &zero); err == nil {
		return zero, nil
	}

	start := strings.Index(text, "{")
	end := strings.LastIndex(text, "}")
	if start >= 0 && end > start {
		if err := json.Unmarshal([]byte(text[start:end+1]), &zero); err == nil {
			return zero, nil
		}
	}
	return zero, fmt.Errorf("decode structured tool result: %s", truncateForError(text))
}

func splitKeySpec(spec string) []string {
	parts := strings.Split(spec, "+")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(strings.ToLower(part))
		switch part {
		case "command":
			part = "cmd"
		case "control":
			part = "ctrl"
		case "option", "alt":
			part = "option"
		}
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

func stringArg(args map[string]any, key string) (string, bool) {
	value, ok := args[key]
	if !ok || value == nil {
		return "", false
	}
	switch typed := value.(type) {
	case string:
		return typed, true
	default:
		return fmt.Sprint(typed), true
	}
}

func numericArg(args map[string]any, key string) (float64, bool) {
	value, ok := args[key]
	if !ok || value == nil {
		return 0, false
	}
	switch typed := value.(type) {
	case float64:
		return typed, true
	case float32:
		return float64(typed), true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case json.Number:
		parsed, err := typed.Float64()
		return parsed, err == nil
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		return parsed, err == nil
	default:
		return 0, false
	}
}

func integerArg(args map[string]any, key string) (int, bool) {
	value, ok := numericArg(args, key)
	if !ok || value != float64(int(value)) {
		return 0, false
	}
	return int(value), true
}

func withToolArg(args map[string]any, key string, value any) map[string]any {
	out := cloneToolArgs(args)
	out[key] = value
	return out
}

func cloneToolArgs(args map[string]any) map[string]any {
	out := make(map[string]any, len(args))
	for key, value := range args {
		out[key] = value
	}
	return out
}

func cloneStructuredContent(content map[string]any) map[string]any {
	out := make(map[string]any, len(content)+2)
	for key, value := range content {
		out[key] = value
	}
	return out
}

func structuredPayload[T any](content map[string]any) (T, error) {
	var zero T
	if len(content) == 0 {
		return zero, fmt.Errorf("structured tool result is empty")
	}
	data, err := json.Marshal(content)
	if err != nil {
		return zero, fmt.Errorf("encode structured tool result: %w", err)
	}
	if err := json.Unmarshal(data, &zero); err != nil {
		return zero, fmt.Errorf("decode structured tool result: %w", err)
	}
	return zero, nil
}

func truncateForError(text string) string {
	text = strings.TrimSpace(text)
	if len(text) <= 240 {
		return text
	}
	return text[:240] + "..."
}
