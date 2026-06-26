package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	agentproviderbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

type ExternalImportScanInput struct {
	Providers []string
}

type ExternalImportInput struct {
	Projects []ExternalImportProjectSelection
}

type ExternalImportProjectSelection struct {
	Path       string
	Providers  []string
	SessionIDs []string
}

type ExternalImportScanResult struct {
	Providers       []ExternalImportProvider
	Projects        []ExternalImportProject
	Sessions        []ExternalImportSession
	ScannedSessions int
	ScannedMessages int
	SkippedSessions int
	Errors          []ExternalImportError
}

type ExternalImportProvider struct {
	Provider     string
	Root         string
	Available    bool
	SessionCount int
	MessageCount int
	Error        string
}

type ExternalImportProject struct {
	Path                string
	Label               string
	Providers           []string
	SessionCount        int
	MessageCount        int
	LastUpdatedAtUnixMS int64
}

type ExternalImportSession struct {
	ID                  string
	ProjectPath         string
	Provider            string
	SourcePath          string
	Title               string
	MessageCount        int
	LastUpdatedAtUnixMS int64
}

type ExternalImportError struct {
	Provider   string
	SourcePath string
	Message    string
}

type ExternalImportResult struct {
	ImportedProjects int
	ImportedSessions int
	ImportedMessages int
	SkippedSessions  int
	Errors           []ExternalImportError
	// ProjectPaths lists the selected project paths that matched at least one
	// valid imported session. Callers use it to avoid registering user projects
	// that would surface with no sessions underneath them.
	ProjectPaths []string
}

type externalImportedSession struct {
	Provider          string
	ProviderSessionID string
	SourcePath        string
	Cwd               string
	Title             string
	// SummaryTitle holds an authoritative, provider-supplied conversation title
	// (e.g. Claude `custom-title`/`summary` transcript lines or the Codex
	// app-server `threads.title`). When present it wins over message-derived
	// titles.
	SummaryTitle    string
	StartedAtUnixMS int64
	UpdatedAtUnixMS int64
	Messages        []externalImportedMessage
}

type externalImportedMessage struct {
	RawID             string
	MessageIDSeed     string
	Role              string
	Kind              string
	Status            string
	Text              string
	Payload           map[string]any
	OccurredAtUnixMS  int64
	StartedAtUnixMS   int64
	CompletedAtUnixMS int64
}

type externalScanData struct {
	result   ExternalImportScanResult
	sessions []externalImportedSession
}

func (*Service) ScanExternalImports(ctx context.Context, input ExternalImportScanInput) (ExternalImportScanResult, error) {
	data := scanExternalAgentSessions(ctx, normalizeExternalImportProviders(input.Providers))
	return data.result, nil
}

func (s *Service) ImportExternalSessions(ctx context.Context, workspaceID string, input ExternalImportInput) (ExternalImportResult, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" || len(input.Projects) == 0 {
		return ExternalImportResult{}, ErrInvalidArgument
	}
	if s == nil || s.ExternalImportStore == nil {
		return ExternalImportResult{}, errors.New("external agent import store is unavailable")
	}
	selections := normalizeExternalImportSelections(input.Projects)
	if len(selections) == 0 {
		return ExternalImportResult{}, ErrInvalidArgument
	}
	data := scanExternalAgentSessions(ctx, providersFromExternalImportSelections(selections))
	result := ExternalImportResult{
		SkippedSessions: data.result.SkippedSessions,
		Errors:          append([]ExternalImportError(nil), data.result.Errors...),
	}
	importedProjectPaths := map[string]struct{}{}
	validProjectPaths := map[string]int64{}
	for _, session := range data.sessions {
		if ctx.Err() != nil {
			return result, ctx.Err()
		}
		projectPath, selected := matchingExternalImportProject(session, selections)
		if !selected {
			continue
		}
		if session.UpdatedAtUnixMS > validProjectPaths[projectPath] {
			validProjectPaths[projectPath] = session.UpdatedAtUnixMS
		}
		importedMessages, imported, err := s.importExternalSession(ctx, workspaceID, session)
		if err != nil {
			result.Errors = append(result.Errors, ExternalImportError{
				Provider:   session.Provider,
				SourcePath: session.SourcePath,
				Message:    err.Error(),
			})
			continue
		}
		if imported {
			result.ImportedSessions++
		}
		if importedMessages > 0 {
			result.ImportedMessages += importedMessages
			importedProjectPaths[projectPath] = struct{}{}
		}
	}
	result.ImportedProjects = len(importedProjectPaths)
	result.ProjectPaths = sortedProjectPathsByLatest(validProjectPaths)
	return result, nil
}

func normalizeExternalImportProviders(input []string) []string {
	if len(input) == 0 {
		return []string{agentproviderbiz.Codex, agentproviderbiz.ClaudeCode}
	}
	seen := map[string]struct{}{}
	out := make([]string, 0, len(input))
	for _, provider := range input {
		normalized := agentproviderbiz.Normalize(provider)
		switch normalized {
		case agentproviderbiz.Codex, agentproviderbiz.ClaudeCode:
		default:
			continue
		}
		if _, ok := seen[normalized]; ok {
			continue
		}
		seen[normalized] = struct{}{}
		out = append(out, normalized)
	}
	return out
}

func normalizeExternalImportSelections(input []ExternalImportProjectSelection) []ExternalImportProjectSelection {
	out := make([]ExternalImportProjectSelection, 0, len(input))
	for _, selection := range input {
		path, ok := canonicalExistingDir(selection.Path)
		if !ok {
			continue
		}
		out = append(out, ExternalImportProjectSelection{
			Path:       path,
			Providers:  normalizeExternalImportProviders(selection.Providers),
			SessionIDs: normalizeExternalImportSessionIDs(selection.SessionIDs),
		})
	}
	return out
}

func normalizeExternalImportSessionIDs(input []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(input))
	for _, id := range input {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out
}

func providersFromExternalImportSelections(selections []ExternalImportProjectSelection) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, 2)
	for _, selection := range selections {
		for _, provider := range normalizeExternalImportProviders(selection.Providers) {
			if _, ok := seen[provider]; ok {
				continue
			}
			seen[provider] = struct{}{}
			out = append(out, provider)
		}
	}
	return out
}

func scanExternalAgentSessions(ctx context.Context, providers []string) externalScanData {
	data := externalScanData{}
	projects := map[string]*ExternalImportProject{}
	cutoffUnixMS := time.Now().Add(-30 * 24 * time.Hour).UnixMilli()
	for _, provider := range normalizeExternalImportProviders(providers) {
		if ctx.Err() != nil {
			break
		}
		sessions, summary, errors := scanExternalProviderSessions(provider, cutoffUnixMS)
		data.result.Providers = append(data.result.Providers, summary)
		data.result.Errors = append(data.result.Errors, errors...)
		for _, session := range sessions {
			project, ok := projectFromExternalSession(session)
			if !ok {
				data.result.SkippedSessions++
				continue
			}
			data.sessions = append(data.sessions, session)
			data.result.ScannedSessions++
			data.result.ScannedMessages += len(session.Messages)
			data.result.Sessions = append(data.result.Sessions, externalImportSessionSummary(session, project.Path))
			upsertExternalImportProject(projects, project, session.Provider)
		}
	}
	for _, project := range projects {
		sort.Strings(project.Providers)
		data.result.Projects = append(data.result.Projects, *project)
	}
	sort.SliceStable(data.result.Projects, func(left, right int) bool {
		if data.result.Projects[left].LastUpdatedAtUnixMS == data.result.Projects[right].LastUpdatedAtUnixMS {
			return data.result.Projects[left].Path < data.result.Projects[right].Path
		}
		return data.result.Projects[left].LastUpdatedAtUnixMS > data.result.Projects[right].LastUpdatedAtUnixMS
	})
	sort.SliceStable(data.result.Sessions, func(left, right int) bool {
		if data.result.Sessions[left].LastUpdatedAtUnixMS == data.result.Sessions[right].LastUpdatedAtUnixMS {
			return data.result.Sessions[left].ID < data.result.Sessions[right].ID
		}
		return data.result.Sessions[left].LastUpdatedAtUnixMS > data.result.Sessions[right].LastUpdatedAtUnixMS
	})
	return data
}

func scanExternalProviderSessions(provider string, cutoffUnixMS int64) ([]externalImportedSession, ExternalImportProvider, []ExternalImportError) {
	root := externalProviderRoot(provider)
	summary := ExternalImportProvider{Provider: provider, Root: root}
	if root == "" {
		return nil, summary, nil
	}
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		return nil, summary, nil
	}
	summary.Available = true
	files, err := externalProviderJSONLFiles(provider, root)
	if err != nil {
		summary.Error = err.Error()
		return nil, summary, []ExternalImportError{{Provider: provider, Message: err.Error()}}
	}
	// Codex stores the generated conversation title in its app-server SQLite
	// state DB rather than in the rollout transcript, so resolve it up front and
	// let it override the message-derived title.
	var codexTitles map[string]string
	if provider == agentproviderbiz.Codex {
		codexTitles = codexThreadTitles(root)
	}
	sessions := make([]externalImportedSession, 0, len(files))
	errors := make([]ExternalImportError, 0)
	for _, file := range files {
		session, ok, err := parseExternalProviderJSONL(provider, file)
		if err != nil {
			errors = append(errors, ExternalImportError{Provider: provider, SourcePath: file, Message: err.Error()})
			continue
		}
		if !ok {
			continue
		}
		if session.UpdatedAtUnixMS < cutoffUnixMS {
			continue
		}
		if title := strings.TrimSpace(codexTitles[session.ProviderSessionID]); title != "" {
			session.Title = truncateExternalTitle(title)
		}
		sessions = append(sessions, session)
		summary.SessionCount++
		summary.MessageCount += len(session.Messages)
	}
	return sessions, summary, errors
}

func externalProviderRoot(provider string) string {
	home, _ := os.UserHomeDir()
	switch provider {
	case agentproviderbiz.Codex:
		if root := strings.TrimSpace(os.Getenv("CODEX_HOME")); root != "" {
			return root
		}
		if home != "" {
			return filepath.Join(home, ".codex")
		}
	case agentproviderbiz.ClaudeCode:
		if root := strings.TrimSpace(os.Getenv("CLAUDE_CONFIG_DIR")); root != "" {
			return root
		}
		if home != "" {
			return filepath.Join(home, ".claude")
		}
	}
	return ""
}

func externalProviderJSONLFiles(provider string, root string) ([]string, error) {
	var roots []string
	switch provider {
	case agentproviderbiz.Codex:
		roots = []string{filepath.Join(root, "sessions"), filepath.Join(root, "archived_sessions")}
	case agentproviderbiz.ClaudeCode:
		roots = []string{filepath.Join(root, "projects")}
	default:
		return nil, nil
	}
	files := make([]string, 0)
	for _, scanRoot := range roots {
		if info, err := os.Stat(scanRoot); err != nil || !info.IsDir() {
			continue
		}
		err := filepath.WalkDir(scanRoot, func(path string, entry os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if entry.IsDir() {
				if provider == agentproviderbiz.ClaudeCode && strings.HasPrefix(entry.Name(), "agent-") {
					return filepath.SkipDir
				}
				return nil
			}
			if strings.EqualFold(filepath.Ext(path), ".jsonl") {
				files = append(files, path)
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	sort.Strings(files)
	return files, nil
}

func parseExternalProviderJSONL(provider string, path string) (externalImportedSession, bool, error) {
	file, err := os.Open(path)
	if err != nil {
		return externalImportedSession{}, false, err
	}
	defer file.Close()
	switch provider {
	case agentproviderbiz.Codex:
		return parseCodexJSONL(path, file)
	case agentproviderbiz.ClaudeCode:
		return parseClaudeCodeJSONL(path, file)
	default:
		return externalImportedSession{}, false, nil
	}
}

func (s *Service) importExternalSession(ctx context.Context, workspaceID string, session externalImportedSession) (int, bool, error) {
	agentSessionID := externalImportedSessionID(session.Provider, session.ProviderSessionID)
	existingIDs, sessionExists, err := s.existingExternalImportMessageIDs(ctx, workspaceID, agentSessionID)
	if err != nil {
		return 0, false, err
	}
	updates := make([]agentactivitybiz.MessageUpdate, 0, len(session.Messages))
	for i, message := range session.Messages {
		messageID := externalImportedMessageIDForMessage(session.Provider, session.ProviderSessionID, message, i)
		if _, ok := existingIDs[messageID]; ok {
			continue
		}
		updates = append(updates, agentactivitybiz.MessageUpdate{
			MessageID:         messageID,
			TurnID:            externalImportedTurnID(session.Provider, session.ProviderSessionID, i),
			Role:              message.Role,
			Kind:              message.Kind,
			Status:            message.Status,
			Payload:           externalImportedMessagePayload(message),
			OccurredAtUnixMS:  message.OccurredAtUnixMS,
			StartedAtUnixMS:   message.StartedAtUnixMS,
			CompletedAtUnixMS: message.CompletedAtUnixMS,
		})
	}
	if _, err := s.ExternalImportStore.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID:       workspaceID,
		AgentSessionID:    agentSessionID,
		Origin:            WorkspaceAgentSessionOriginImported,
		Provider:          session.Provider,
		ProviderSessionID: session.ProviderSessionID,
		RuntimeContext: map[string]any{
			"visible":            true,
			"imported":           true,
			"externalSourcePath": session.SourcePath,
		},
		Cwd:              session.Cwd,
		Title:            session.Title,
		Status:           "completed",
		CurrentPhase:     "completed",
		OccurredAtUnixMS: session.UpdatedAtUnixMS,
		StartedAtUnixMS:  session.StartedAtUnixMS,
		EndedAtUnixMS:    session.UpdatedAtUnixMS,
	}); err != nil {
		return 0, false, err
	}
	if len(updates) == 0 && sessionExists {
		return 0, false, nil
	}
	importedMessages := 0
	for start := 0; start < len(updates); start += 200 {
		end := start + 200
		if end > len(updates) {
			end = len(updates)
		}
		report, err := s.ExternalImportStore.ReportSessionMessages(ctx, agentactivitybiz.SessionMessageReport{
			WorkspaceID:    workspaceID,
			AgentSessionID: agentSessionID,
			Origin:         WorkspaceAgentSessionOriginImported,
			Provider:       session.Provider,
			Messages:       updates[start:end],
		})
		if err != nil {
			return importedMessages, true, err
		}
		importedMessages += report.AcceptedCount
	}
	return importedMessages, true, nil
}

func (s *Service) existingExternalImportMessageIDs(ctx context.Context, workspaceID string, agentSessionID string) (map[string]struct{}, bool, error) {
	ids := map[string]struct{}{}
	if s == nil || s.ExternalImportStore == nil {
		return ids, false, nil
	}
	if _, ok, err := s.ExternalImportStore.GetSession(ctx, workspaceID, agentSessionID); err != nil || !ok {
		return ids, ok, err
	}
	var after uint64
	for {
		page, ok, err := s.ExternalImportStore.ListSessionMessages(ctx, agentactivitybiz.ListSessionMessagesInput{
			WorkspaceID:    workspaceID,
			AgentSessionID: agentSessionID,
			AfterVersion:   after,
			Limit:          1000,
			Order:          agentactivitybiz.MessageOrderAsc,
		})
		if err != nil || !ok {
			return ids, true, err
		}
		if len(page.Messages) == 0 {
			return ids, true, nil
		}
		for _, message := range page.Messages {
			ids[strings.TrimSpace(message.MessageID)] = struct{}{}
			if message.Version > after {
				after = message.Version
			}
		}
		if !page.HasMore {
			return ids, true, nil
		}
	}
}

func externalImportedSessionID(provider string, providerSessionID string) string {
	return "imported-" + agentproviderbiz.Normalize(provider) + "-" + externalStableHash(providerSessionID)[:24]
}

func externalImportedMessageID(provider string, providerSessionID string, rawID string, index int) string {
	return "imported-" + externalStableHash(provider + "\x00" + providerSessionID + "\x00" + rawID + "\x00" + strconv.Itoa(index))[:32]
}

func externalImportedMessageIDForMessage(provider string, providerSessionID string, message externalImportedMessage, index int) string {
	if seed := strings.TrimSpace(message.MessageIDSeed); seed != "" {
		return "imported-" + externalStableHash(provider + "\x00" + providerSessionID + "\x00" + seed)[:32]
	}
	return externalImportedMessageID(provider, providerSessionID, message.RawID, index)
}

func externalImportedTurnID(provider string, providerSessionID string, index int) string {
	return "imported-turn-" + externalStableHash(provider + "\x00" + providerSessionID + "\x00" + strconv.Itoa(index/2))[:24]
}

func externalImportedMessagePayload(message externalImportedMessage) map[string]any {
	payload := clonePayload(message.Payload)
	if payload == nil {
		payload = map[string]any{}
	}
	if strings.TrimSpace(message.Kind) == "text" {
		payload["text"] = message.Text
	}
	return payload
}

func externalStableHash(input string) string {
	sum := sha256.Sum256([]byte(input))
	return hex.EncodeToString(sum[:])
}

func externalSessionTitle(messages []externalImportedMessage) string {
	for _, message := range messages {
		if message.Role == "user" {
			return truncateExternalTitle(message.Text)
		}
	}
	return truncateExternalTitle(messages[0].Text)
}

func truncateExternalTitle(input string) string {
	input = strings.Join(strings.Fields(input), " ")
	const maxTitleRunes = 80
	runes := []rune(input)
	if len(runes) <= maxTitleRunes {
		return input
	}
	return strings.TrimSpace(string(runes[:maxTitleRunes]))
}

func firstExternalMessageUnixMS(messages []externalImportedMessage) int64 {
	for _, message := range messages {
		if message.OccurredAtUnixMS > 0 {
			return message.OccurredAtUnixMS
		}
	}
	return time.Now().UnixMilli()
}

func lastExternalMessageUnixMS(messages []externalImportedMessage) int64 {
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].OccurredAtUnixMS > 0 {
			return messages[i].OccurredAtUnixMS
		}
	}
	return firstExternalMessageUnixMS(messages)
}

func normalizeExternalMessageRole(role string) string {
	switch strings.TrimSpace(strings.ToLower(role)) {
	case "user", "assistant", "tool":
		return strings.TrimSpace(strings.ToLower(role))
	default:
		return ""
	}
}

func normalizeExternalMessageKind(kind string) string {
	switch strings.TrimSpace(strings.ToLower(kind)) {
	case "tool_call":
		return "tool_call"
	case "reasoning":
		return "reasoning"
	default:
		return "text"
	}
}

func normalizeExternalMessageStatus(status string) string {
	switch strings.TrimSpace(strings.ToLower(status)) {
	case "running", "completed", "failed", "canceled", "waiting":
		return strings.TrimSpace(strings.ToLower(status))
	default:
		return "completed"
	}
}

func externalToolText(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return ""
	}
	return "[Tool: " + name + "]"
}

func externalContentText(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case []any:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			if text := externalContentText(item); text != "" {
				parts = append(parts, text)
			}
		}
		return strings.TrimSpace(strings.Join(parts, "\n"))
	case map[string]any:
		blockType := stringField(typed, "type")
		switch blockType {
		case "text", "input_text", "output_text":
			return strings.TrimSpace(stringField(typed, "text"))
		case "tool_use", "function_call":
			return externalToolText(firstNonEmptyString(stringField(typed, "name"), stringField(typed, "id")))
		case "tool_result":
			return firstNonEmptyString(externalContentText(typed["content"]), stringField(typed, "text"))
		default:
			return firstNonEmptyString(
				stringField(typed, "text"),
				externalContentText(typed["content"]),
				externalContentText(typed["message"]),
			)
		}
	default:
		return ""
	}
}

func isPureExternalToolResult(value any) bool {
	items, ok := value.([]any)
	if !ok || len(items) == 0 {
		return false
	}
	for _, item := range items {
		block, ok := item.(map[string]any)
		if !ok || stringField(block, "type") != "tool_result" {
			return false
		}
	}
	return true
}

func unixMSFromAny(value any) int64 {
	switch typed := value.(type) {
	case string:
		typed = strings.TrimSpace(typed)
		if typed == "" {
			return 0
		}
		if parsed, err := time.Parse(time.RFC3339Nano, typed); err == nil {
			return parsed.UnixMilli()
		}
	case float64:
		if typed > 1_000_000_000_000 {
			return int64(typed)
		}
		return int64(typed * 1000)
	case int64:
		if typed > 1_000_000_000_000 {
			return typed
		}
		return typed * 1000
	case json.Number:
		if parsed, err := parsedJSONNumberUnixMS(typed); err == nil {
			return parsed
		}
	}
	return 0
}

func parsedJSONNumberUnixMS(number json.Number) (int64, error) {
	if value, err := number.Int64(); err == nil {
		if value > 1_000_000_000_000 {
			return value, nil
		}
		return value * 1000, nil
	}
	value, err := number.Float64()
	if err != nil {
		return 0, err
	}
	if value > 1_000_000_000_000 {
		return int64(value), nil
	}
	return int64(value * 1000), nil
}

func stringField(values map[string]any, key string) string {
	if values == nil {
		return ""
	}
	value, ok := values[key]
	if !ok {
		return ""
	}
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case fmt.Stringer:
		return strings.TrimSpace(typed.String())
	default:
		return ""
	}
}

func mapField(values map[string]any, key string) map[string]any {
	if values == nil {
		return nil
	}
	value, ok := values[key].(map[string]any)
	if !ok {
		return nil
	}
	return value
}
