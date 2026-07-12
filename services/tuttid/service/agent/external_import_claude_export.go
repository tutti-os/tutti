package agent

import (
	"archive/zip"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	agentproviderbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

const (
	claudeExportConversationsEntry         = "conversations.json"
	maxClaudeExportArchiveBytes      int64 = 512 << 20
	maxClaudeExportEntryBytes              = 512 << 20
	maxClaudeExportConversationBytes       = 64 << 20
	maxClaudeExportArchiveEntries          = 10_000
	maxClaudeExportConversations           = 100_000
	maxClaudeExportMessages                = 100_000
)

type claudeExportConversation struct {
	ChatMessages []json.RawMessage `json:"chat_messages"`
	CreatedAt    string            `json:"created_at"`
	Name         string            `json:"name"`
	Summary      string            `json:"summary"`
	UpdatedAt    string            `json:"updated_at"`
	UUID         string            `json:"uuid"`
}

type claudeExportMessage struct {
	Attachments       []claudeExportAttachment `json:"attachments"`
	Content           []claudeExportContent    `json:"content"`
	CreatedAt         string                   `json:"created_at"`
	Files             []claudeExportFile       `json:"files"`
	ParentMessageUUID string                   `json:"parent_message_uuid"`
	Sender            string                   `json:"sender"`
	Text              string                   `json:"text"`
	UpdatedAt         string                   `json:"updated_at"`
	UUID              string                   `json:"uuid"`
}

type claudeExportContent struct {
	Text string `json:"text"`
	Type string `json:"type"`
}

type claudeExportAttachment struct {
	FileName string `json:"file_name"`
	FileSize int64  `json:"file_size"`
	FileType string `json:"file_type"`
}

type claudeExportFile struct {
	FileName string `json:"file_name"`
	FileUUID string `json:"file_uuid"`
}

type parsedClaudeExportMessage struct {
	Source             claudeExportMessage
	RawID              string
	ParentID           string
	Role               string
	Text               string
	FilesPayload       []map[string]any
	OccurredAtUnixMS   int64
	SourceMessageIndex int
}

func scanClaudeExportArchive(ctx context.Context, archivePath string, cutoffUnixMS int64) (externalScanData, error) {
	archivePath, entry, closeArchive, err := openClaudeExportConversations(archivePath)
	if err != nil {
		return externalScanData{}, err
	}
	defer closeArchive()

	home, ok := externalImportNoProjectBucketPath()
	if !ok {
		return externalScanData{}, fmt.Errorf("%w: user home directory is unavailable", ErrInvalidArgument)
	}
	entryReader, err := entry.Open()
	if err != nil {
		return externalScanData{}, invalidClaudeExportArchive("open conversations.json: %v", err)
	}
	defer entryReader.Close()

	data := externalScanData{}
	data.result.Providers = []ExternalImportProvider{{
		Provider:  agentproviderbiz.ClaudeCode,
		Root:      archivePath,
		Available: true,
	}}
	projects := map[string]*ExternalImportProject{}
	conversationIDs := map[string]struct{}{}
	messageIDs := map[string]struct{}{}
	conversationStream, err := newClaudeExportConversationStream(ctx, entryReader)
	if err != nil {
		return externalScanData{}, err
	}
	totalMessages := 0
	for index := 0; ; index++ {
		if err := ctx.Err(); err != nil {
			return externalScanData{}, err
		}
		raw, more, err := conversationStream.Next()
		if err != nil {
			return externalScanData{}, err
		}
		if !more {
			break
		}
		if index >= maxClaudeExportConversations {
			return externalScanData{}, invalidClaudeExportArchive("conversation count exceeds %d", maxClaudeExportConversations)
		}
		if err := validateClaudeExportConversationJSON(ctx, raw, index+1); err != nil {
			return externalScanData{}, err
		}
		var conversation claudeExportConversation
		if err := json.Unmarshal(raw, &conversation); err != nil {
			return externalScanData{}, invalidClaudeExportArchive("decode conversation %d: %v", index+1, err)
		}
		conversationID := strings.TrimSpace(conversation.UUID)
		if conversationID == "" {
			conversationID = "missing-" + externalStableHash(string(raw))
		}
		if _, exists := conversationIDs[conversationID]; exists {
			return externalScanData{}, invalidClaudeExportArchive("duplicate conversation id %q", conversationID)
		}
		conversationIDs[conversationID] = struct{}{}
		if totalMessages+len(conversation.ChatMessages) > maxClaudeExportMessages {
			return externalScanData{}, invalidClaudeExportArchive("message count exceeds %d", maxClaudeExportMessages)
		}
		totalMessages += len(conversation.ChatMessages)
		session, valid, err := parseClaudeExportConversation(
			ctx,
			archivePath,
			home,
			conversationID,
			conversation,
			messageIDs,
		)
		if err != nil {
			return externalScanData{}, err
		}
		if !valid {
			data.result.SkippedSessions++
			continue
		}
		if session.UpdatedAtUnixMS < cutoffUnixMS {
			continue
		}
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

	for _, project := range projects {
		sort.Strings(project.Providers)
		data.result.Projects = append(data.result.Projects, *project)
	}
	sort.SliceStable(data.result.Sessions, func(left, right int) bool {
		if data.result.Sessions[left].LastUpdatedAtUnixMS == data.result.Sessions[right].LastUpdatedAtUnixMS {
			return data.result.Sessions[left].ID < data.result.Sessions[right].ID
		}
		return data.result.Sessions[left].LastUpdatedAtUnixMS > data.result.Sessions[right].LastUpdatedAtUnixMS
	})
	data.result.Providers[0].SessionCount = data.result.ScannedSessions
	data.result.Providers[0].MessageCount = data.result.ScannedMessages
	return data, nil
}

func openClaudeExportConversations(rawPath string) (string, *zip.File, func(), error) {
	archivePath := strings.TrimSpace(rawPath)
	if archivePath == "" || !filepath.IsAbs(archivePath) || !strings.EqualFold(filepath.Ext(archivePath), ".zip") {
		return "", nil, func() {}, invalidClaudeExportArchive("archivePath must be an absolute ZIP path")
	}
	resolvedPath, err := filepath.EvalSymlinks(archivePath)
	if err != nil {
		return "", nil, func() {}, invalidClaudeExportArchive("resolve archive path: %v", err)
	}
	// Open the archive once and derive every subsequent check (size, directory
	// preflight, ZIP parsing) from this one descriptor, so a concurrently
	// replaced file cannot slip a different archive past the validation.
	archive, err := os.Open(resolvedPath)
	if err != nil {
		return "", nil, func() {}, invalidClaudeExportArchive("open archive: %v", err)
	}
	closeArchive := func() { _ = archive.Close() }
	info, err := archive.Stat()
	if err != nil {
		closeArchive()
		return "", nil, func() {}, invalidClaudeExportArchive("inspect archive: %v", err)
	}
	if !info.Mode().IsRegular() {
		closeArchive()
		return "", nil, func() {}, invalidClaudeExportArchive("archive is not a regular file")
	}
	if info.Size() <= 0 || info.Size() > maxClaudeExportArchiveBytes {
		closeArchive()
		return "", nil, func() {}, invalidClaudeExportArchive("archive size exceeds the supported limit")
	}
	if err := validateClaudeExportZipDirectory(archive, info.Size()); err != nil {
		closeArchive()
		return "", nil, func() {}, err
	}
	reader, err := zip.NewReader(archive, info.Size())
	if err != nil {
		closeArchive()
		return "", nil, func() {}, invalidClaudeExportArchive("open ZIP: %v", err)
	}
	if len(reader.File) > maxClaudeExportArchiveEntries {
		closeArchive()
		return "", nil, func() {}, invalidClaudeExportArchive("archive entry count exceeds %d", maxClaudeExportArchiveEntries)
	}
	var conversations *zip.File
	for _, file := range reader.File {
		name := filepath.ToSlash(file.Name)
		if name != claudeExportConversationsEntry {
			continue
		}
		if conversations != nil {
			closeArchive()
			return "", nil, func() {}, invalidClaudeExportArchive("archive contains duplicate conversations.json entries")
		}
		if file.FileInfo().IsDir() || file.Mode()&os.ModeSymlink != 0 || file.Flags&0x1 != 0 {
			closeArchive()
			return "", nil, func() {}, invalidClaudeExportArchive("conversations.json is not a readable regular ZIP entry")
		}
		if file.UncompressedSize64 == 0 || file.UncompressedSize64 > maxClaudeExportEntryBytes {
			closeArchive()
			return "", nil, func() {}, invalidClaudeExportArchive("conversations.json exceeds the supported size limit")
		}
		conversations = file
	}
	if conversations == nil {
		closeArchive()
		return "", nil, func() {}, invalidClaudeExportArchive("archive does not contain root conversations.json")
	}
	return filepath.Clean(resolvedPath), conversations, closeArchive, nil
}

func parseClaudeExportConversation(
	ctx context.Context,
	archivePath string,
	home string,
	conversationID string,
	conversation claudeExportConversation,
	messageIDs map[string]struct{},
) (externalImportedSession, bool, error) {
	resumeSupported := false
	session := externalImportedSession{
		Provider:        agentproviderbiz.ClaudeCode,
		SourcePath:      archivePath,
		Cwd:             home,
		SummaryTitle:    firstNonEmptyString(conversation.Name, conversation.Summary),
		NoProject:       true,
		ResumeSupported: &resumeSupported,
	}
	conversationCreatedAt := unixMSFromAny(conversation.CreatedAt)
	conversationUpdatedAt := unixMSFromAny(conversation.UpdatedAt)
	parsedMessages := make([]parsedClaudeExportMessage, 0, len(conversation.ChatMessages))
	for index, raw := range conversation.ChatMessages {
		if err := ctx.Err(); err != nil {
			return externalImportedSession{}, false, err
		}
		var source claudeExportMessage
		if err := json.Unmarshal(raw, &source); err != nil {
			return externalImportedSession{}, false, invalidClaudeExportArchive(
				"decode message %d in conversation %q: %v",
				index+1,
				conversationID,
				err,
			)
		}
		rawID := strings.TrimSpace(source.UUID)
		if rawID == "" {
			rawID = "missing-" + externalStableHash(conversationID+"\x00"+string(raw))
		}
		if _, exists := messageIDs[rawID]; exists {
			return externalImportedSession{}, false, invalidClaudeExportArchive("duplicate message id %q", rawID)
		}
		messageIDs[rawID] = struct{}{}
		role := claudeExportMessageRole(source.Sender)
		text := ""
		var filesPayload []map[string]any
		if role != "" {
			var visibleErr error
			text, filesPayload, visibleErr = claudeExportVisibleMessageText(ctx, source)
			if visibleErr != nil {
				return externalImportedSession{}, false, visibleErr
			}
		}
		occurredAt := firstNonZeroInt64(
			unixMSFromAny(source.CreatedAt),
			unixMSFromAny(source.UpdatedAt),
			conversationCreatedAt,
			conversationUpdatedAt,
			int64(index+1),
		)
		parsedMessages = append(parsedMessages, parsedClaudeExportMessage{
			Source:             source,
			RawID:              rawID,
			ParentID:           strings.TrimSpace(source.ParentMessageUUID),
			Role:               role,
			Text:               text,
			FilesPayload:       filesPayload,
			OccurredAtUnixMS:   occurredAt,
			SourceMessageIndex: index,
		})
	}
	parsedByID := make(map[string]*parsedClaudeExportMessage, len(parsedMessages))
	for index := range parsedMessages {
		parsedByID[parsedMessages[index].RawID] = &parsedMessages[index]
	}
	selectedBranch, err := selectClaudeExportBranch(parsedMessages, parsedByID)
	if err != nil {
		return externalImportedSession{}, false, invalidClaudeExportArchive(
			"invalid parent graph in conversation %q: %v",
			conversationID,
			err,
		)
	}
	branchLeafID := ""
	if len(selectedBranch) > 0 {
		branchLeafID = selectedBranch[len(selectedBranch)-1].RawID
	}
	branchIdentity := claudeExportBranchIdentity(selectedBranch, parsedMessages)
	session.ProviderSessionID = "claude-export:" + conversationID + ":branch:" + branchIdentity
	for _, parsed := range selectedBranch {
		if parsed.Role == "" || parsed.Text == "" {
			continue
		}
		payload := map[string]any{
			"externalSource":        "claude-data-export",
			"sourceBranchId":        branchIdentity,
			"sourceBranchLeafId":    branchLeafID,
			"sourceCreatedAt":       strings.TrimSpace(parsed.Source.CreatedAt),
			"sourceMessageId":       parsed.RawID,
			"sourceParentMessageId": parsed.ParentID,
		}
		if len(parsed.FilesPayload) > 0 {
			payload["files"] = parsed.FilesPayload
		}
		session.Messages = append(session.Messages, externalImportedMessage{
			RawID:             parsed.RawID,
			MessageIDSeed:     parsed.RawID,
			Role:              parsed.Role,
			Kind:              "text",
			Status:            "completed",
			Text:              parsed.Text,
			Payload:           payload,
			OccurredAtUnixMS:  parsed.OccurredAtUnixMS,
			StartedAtUnixMS:   parsed.OccurredAtUnixMS,
			CompletedAtUnixMS: parsed.OccurredAtUnixMS,
		})
	}
	if len(session.Messages) == 0 {
		return externalImportedSession{}, false, nil
	}
	session.StartedAtUnixMS = firstNonZeroInt64(conversationCreatedAt, firstExternalMessageUnixMS(session.Messages))
	session.UpdatedAtUnixMS = lastExternalMessageUnixMS(session.Messages)
	if conversationUpdatedAt > session.UpdatedAtUnixMS {
		session.UpdatedAtUnixMS = conversationUpdatedAt
	}
	session.Title = claudeExportConversationTitle(session.SummaryTitle, session.Messages)
	return session, true, nil
}

func claudeExportBranchIdentity(
	selectedBranch []*parsedClaudeExportMessage,
	messages []parsedClaudeExportMessage,
) string {
	childrenByParent := make(map[string]int, len(messages))
	for index := range messages {
		childrenByParent[messages[index].ParentID]++
	}
	decisions := make([]string, 0, 4)
	for _, message := range selectedBranch {
		if childrenByParent[message.ParentID] > 1 {
			decisions = append(decisions, message.RawID)
		}
	}
	if len(decisions) == 0 {
		return "main"
	}
	return "fork-" + externalStableHash(strings.Join(decisions, "\x00"))[:24]
}

func selectClaudeExportBranch(
	messages []parsedClaudeExportMessage,
	byID map[string]*parsedClaudeExportMessage,
) ([]*parsedClaudeExportMessage, error) {
	if len(messages) == 0 {
		return nil, nil
	}
	if err := validateClaudeExportParentGraph(messages, byID); err != nil {
		return nil, err
	}
	parentsWithChildren := make(map[string]struct{}, len(messages))
	for index := range messages {
		if _, ok := byID[messages[index].ParentID]; ok {
			parentsWithChildren[messages[index].ParentID] = struct{}{}
		}
	}
	leaves := make([]*parsedClaudeExportMessage, 0, len(messages))
	for index := range messages {
		if _, hasChildren := parentsWithChildren[messages[index].RawID]; !hasChildren {
			leaves = append(leaves, &messages[index])
		}
	}
	sort.SliceStable(leaves, func(left, right int) bool {
		if leaves[left].OccurredAtUnixMS != leaves[right].OccurredAtUnixMS {
			return leaves[left].OccurredAtUnixMS > leaves[right].OccurredAtUnixMS
		}
		if leaves[left].SourceMessageIndex != leaves[right].SourceMessageIndex {
			return leaves[left].SourceMessageIndex > leaves[right].SourceMessageIndex
		}
		return leaves[left].RawID > leaves[right].RawID
	})
	for _, leaf := range leaves {
		branch := claudeExportBranchToLeaf(leaf, byID)
		for _, message := range branch {
			if message.Role != "" && message.Text != "" {
				return branch, nil
			}
		}
	}
	return nil, nil
}

func validateClaudeExportParentGraph(
	messages []parsedClaudeExportMessage,
	byID map[string]*parsedClaudeExportMessage,
) error {
	state := make(map[string]uint8, len(messages))
	for index := range messages {
		current := &messages[index]
		path := make([]string, 0, 16)
		for current != nil && state[current.RawID] == 0 {
			state[current.RawID] = 1
			path = append(path, current.RawID)
			current = byID[current.ParentID]
		}
		if current != nil && state[current.RawID] == 1 {
			return fmt.Errorf("cycle at message %q", current.RawID)
		}
		for _, id := range path {
			state[id] = 2
		}
	}
	return nil
}

func claudeExportBranchToLeaf(
	leaf *parsedClaudeExportMessage,
	byID map[string]*parsedClaudeExportMessage,
) []*parsedClaudeExportMessage {
	reversed := make([]*parsedClaudeExportMessage, 0, 16)
	for current := leaf; current != nil; current = byID[current.ParentID] {
		reversed = append(reversed, current)
	}
	branch := make([]*parsedClaudeExportMessage, len(reversed))
	for index := range reversed {
		branch[len(reversed)-1-index] = reversed[index]
	}
	return branch
}

func claudeExportMessageRole(sender string) string {
	switch strings.TrimSpace(strings.ToLower(sender)) {
	case "human", "user":
		return "user"
	case "assistant":
		return "assistant"
	default:
		return ""
	}
}

func claudeExportVisibleMessageText(ctx context.Context, message claudeExportMessage) (string, []map[string]any, error) {
	parts := make([]string, 0, len(message.Content))
	for index, block := range message.Content {
		if index%256 == 0 {
			if err := ctx.Err(); err != nil {
				return "", nil, err
			}
		}
		if strings.TrimSpace(strings.ToLower(block.Type)) != "text" {
			continue
		}
		if text := strings.TrimSpace(block.Text); text != "" {
			parts = append(parts, text)
		}
	}
	// Older human-only exports may omit structured blocks. Never fall back to
	// assistant message.text: current Claude exports mix hidden thinking and
	// tool material into that convenience field.
	if len(message.Content) == 0 && claudeExportMessageRole(message.Sender) == "user" {
		if text := strings.TrimSpace(message.Text); text != "" {
			parts = append(parts, text)
		}
	}
	fileLines, filesPayload, err := claudeExportFileReferences(ctx, message)
	if err != nil {
		return "", nil, err
	}
	parts = append(parts, fileLines...)
	return strings.TrimSpace(strings.Join(parts, "\n\n")), filesPayload, nil
}

func claudeExportFileReferences(ctx context.Context, message claudeExportMessage) ([]string, []map[string]any, error) {
	lines := make([]string, 0, len(message.Attachments)+len(message.Files))
	payload := make([]map[string]any, 0, len(message.Attachments)+len(message.Files))
	seenNames := map[string]struct{}{}
	appendName := func(raw string) {
		name := claudeExportFileName(raw)
		if name == "" {
			return
		}
		if _, exists := seenNames[name]; exists {
			return
		}
		seenNames[name] = struct{}{}
		lines = append(lines, "📎 "+escapeClaudeExportMarkdown(name))
	}
	for index, attachment := range message.Attachments {
		if index%256 == 0 {
			if err := ctx.Err(); err != nil {
				return nil, nil, err
			}
		}
		name := claudeExportFileName(attachment.FileName)
		appendName(name)
		payload = append(payload, map[string]any{
			"available": false,
			"fileName":  name,
			"fileSize":  attachment.FileSize,
			"fileType":  strings.TrimSpace(attachment.FileType),
			"kind":      "legacy_attachment",
		})
	}
	for index, file := range message.Files {
		if index%256 == 0 {
			if err := ctx.Err(); err != nil {
				return nil, nil, err
			}
		}
		name := claudeExportFileName(file.FileName)
		appendName(name)
		payload = append(payload, map[string]any{
			"available": false,
			"fileName":  name,
			"fileUuid":  strings.TrimSpace(file.FileUUID),
			"kind":      "file_reference",
		})
	}
	return lines, payload, nil
}

func claudeExportFileName(raw string) string {
	name := strings.Join(strings.Fields(raw), " ")
	const maxFileNameRunes = 255
	runes := []rune(name)
	if len(runes) > maxFileNameRunes {
		name = string(runes[:maxFileNameRunes])
	}
	return strings.TrimSpace(name)
}

func escapeClaudeExportMarkdown(value string) string {
	return strings.NewReplacer(
		"\\", "\\\\",
		"`", "\\`",
		"*", "\\*",
		"_", "\\_",
		"[", "\\[",
		"]", "\\]",
		"<", "\\<",
		">", "\\>",
	).Replace(value)
}

func claudeExportConversationTitle(summaryTitle string, messages []externalImportedMessage) string {
	if title := strings.TrimSpace(summaryTitle); title != "" {
		return truncateExternalTitle(title)
	}
	for _, message := range messages {
		if message.Role == "user" && strings.TrimSpace(message.Text) != "" {
			return truncateExternalTitle(message.Text)
		}
	}
	return externalSessionTitle(messages)
}

func invalidClaudeExportArchive(format string, args ...any) error {
	return fmt.Errorf("%w: invalid Claude data export: %s", ErrInvalidArgument, fmt.Sprintf(format, args...))
}
