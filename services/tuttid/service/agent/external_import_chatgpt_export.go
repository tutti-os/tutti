package agent

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// chatgptExportProvider is the import-only provider identity recorded for
// ChatGPT data-export history. It is deliberately NOT a runnable
// providerregistry agent: ChatGPT conversations have no local CLI runtime to
// resume, so the identity exists only to label and distinguish imported
// history (mirroring how Claude data-export imports are non-resumable), never
// to route a live session.
const chatgptExportProvider = "chatgpt"

const (
	chatgptExportConversationsEntry             = "conversations.json"
	chatgptExportConversationBundlePrefix       = "Conversations__"
	maxChatGPTExportArchiveBytes          int64 = 512 << 20
	maxChatGPTExportEntryBytes                  = 512 << 20
	maxChatGPTExportArchiveEntries              = 10_000
	maxChatGPTExportConversations               = 100_000
	maxChatGPTExportMessages                    = 100_000
)

type chatgptExportConversation struct {
	Title          string                       `json:"title"`
	CreateTime     float64                      `json:"create_time"`
	UpdateTime     float64                      `json:"update_time"`
	Mapping        map[string]chatgptExportNode `json:"mapping"`
	CurrentNode    string                       `json:"current_node"`
	ConversationID string                       `json:"conversation_id"`
	ID             string                       `json:"id"`
}

type chatgptExportNode struct {
	ID       string                `json:"id"`
	Message  *chatgptExportMessage `json:"message"`
	Parent   string                `json:"parent"`
	Children []string              `json:"children"`
}

type chatgptExportMessage struct {
	ID         string                   `json:"id"`
	Author     chatgptExportAuthor      `json:"author"`
	CreateTime float64                  `json:"create_time"`
	Content    chatgptExportContent     `json:"content"`
	Metadata   chatgptExportMessageMeta `json:"metadata"`
}

type chatgptExportAuthor struct {
	Role string `json:"role"`
}

type chatgptExportMessageMeta struct {
	IsVisuallyHidden bool `json:"is_visually_hidden_from_conversation"`
}

type chatgptExportContent struct {
	ContentType string            `json:"content_type"`
	Parts       []json.RawMessage `json:"parts"`
}

// chatgptExportContentPart models the object form of a multimodal content part
// (e.g. an image asset pointer). String parts are decoded separately.
type chatgptExportContentPart struct {
	ContentType  string `json:"content_type"`
	AssetPointer string `json:"asset_pointer"`
	Name         string `json:"name"`
}

// chatgptExportLinearNode is one node on the deterministic linear branch walked
// from current_node back to the root.
type chatgptExportLinearNode struct {
	NodeID          string
	Message         *chatgptExportMessage
	ParentMessageID string
}

// chatgptExportArchiveHandle keeps nested bundle bytes alive while inner ZIP
// entries are streamed.
type chatgptExportArchiveHandle struct {
	close     func()
	entries   []*zip.File
	keepAlive [][]byte
}

func scanChatGPTExportArchive(ctx context.Context, archivePath string, cutoffUnixMS int64) (externalScanData, error) {
	handle, err := openChatGPTExportConversationEntries(archivePath)
	if err != nil {
		return externalScanData{}, err
	}
	defer handle.close()

	home, ok := externalImportNoProjectBucketPath()
	if !ok {
		return externalScanData{}, fmt.Errorf("%w: user home directory is unavailable", ErrInvalidArgument)
	}

	data := externalScanData{}
	// Never surface the local archive path anywhere it can reach a user; the
	// provider root and per-session SourcePath are intentionally left empty so
	// import-error summaries cannot leak the on-disk archive location.
	data.result.Providers = []ExternalImportProvider{{
		Provider:  chatgptExportProvider,
		Available: true,
	}}
	projects := map[string]*ExternalImportProject{}
	conversationIDs := map[string]struct{}{}
	totalMessages := 0
	conversationIndex := 0
	for _, entry := range handle.entries {
		if err := ctx.Err(); err != nil {
			return externalScanData{}, err
		}
		entryReader, err := entry.Open()
		if err != nil {
			return externalScanData{}, invalidChatGPTExportArchive("open conversations payload: %v", err)
		}
		conversationStream, err := newChatGPTExportConversationStream(ctx, entryReader)
		if err != nil {
			_ = entryReader.Close()
			return externalScanData{}, err
		}
		for {
			if err := ctx.Err(); err != nil {
				_ = entryReader.Close()
				return externalScanData{}, err
			}
			raw, more, err := conversationStream.Next()
			if err != nil {
				_ = entryReader.Close()
				return externalScanData{}, err
			}
			if !more {
				break
			}
			if conversationIndex >= maxChatGPTExportConversations {
				_ = entryReader.Close()
				return externalScanData{}, invalidChatGPTExportArchive("conversation count exceeds %d", maxChatGPTExportConversations)
			}
			if err := validateChatGPTExportConversationJSON(ctx, raw, conversationIndex+1); err != nil {
				_ = entryReader.Close()
				return externalScanData{}, err
			}
			var conversation chatgptExportConversation
			if err := json.Unmarshal(raw, &conversation); err != nil {
				_ = entryReader.Close()
				return externalScanData{}, invalidChatGPTExportArchive("decode conversation %d: %v", conversationIndex+1, err)
			}
			conversationID := chatgptExportConversationID(conversation, raw)
			if _, exists := conversationIDs[conversationID]; exists {
				_ = entryReader.Close()
				return externalScanData{}, invalidChatGPTExportArchive("duplicate conversation id %q", conversationID)
			}
			conversationIDs[conversationID] = struct{}{}
			if totalMessages+len(conversation.Mapping) > maxChatGPTExportMessages {
				_ = entryReader.Close()
				return externalScanData{}, invalidChatGPTExportArchive("message count exceeds %d", maxChatGPTExportMessages)
			}
			totalMessages += len(conversation.Mapping)
			session, valid, err := parseChatGPTExportConversation(ctx, home, conversationID, conversation)
			if err != nil {
				_ = entryReader.Close()
				return externalScanData{}, err
			}
			if !valid {
				data.result.SkippedSessions++
				conversationIndex++
				continue
			}
			if session.UpdatedAtUnixMS < cutoffUnixMS {
				conversationIndex++
				continue
			}
			project, ok := projectFromExternalSession(session)
			if !ok {
				data.result.SkippedSessions++
				conversationIndex++
				continue
			}
			data.sessions = append(data.sessions, session)
			data.result.ScannedSessions++
			data.result.ScannedMessages += len(session.Messages)
			data.result.Sessions = append(data.result.Sessions, externalImportSessionSummary(session, project.Path))
			upsertExternalImportProject(projects, project, session.Provider)
			conversationIndex++
		}
		if err := entryReader.Close(); err != nil {
			return externalScanData{}, invalidChatGPTExportArchive("close conversations payload: %v", err)
		}
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

func openChatGPTExportConversationEntries(rawPath string) (*chatgptExportArchiveHandle, error) {
	archivePath := strings.TrimSpace(rawPath)
	if archivePath == "" || !filepath.IsAbs(archivePath) || !strings.EqualFold(filepath.Ext(archivePath), ".zip") {
		return nil, invalidChatGPTExportArchive("archivePath must be an absolute ZIP path")
	}
	resolvedPath, err := filepath.EvalSymlinks(archivePath)
	if err != nil {
		return nil, invalidChatGPTExportArchive("resolve archive path: %v", err)
	}
	archive, err := os.Open(resolvedPath)
	if err != nil {
		return nil, invalidChatGPTExportArchive("open archive: %v", err)
	}
	closeArchive := func() { _ = archive.Close() }
	info, err := archive.Stat()
	if err != nil {
		closeArchive()
		return nil, invalidChatGPTExportArchive("inspect archive: %v", err)
	}
	if !info.Mode().IsRegular() {
		closeArchive()
		return nil, invalidChatGPTExportArchive("archive is not a regular file")
	}
	if info.Size() <= 0 || info.Size() > maxChatGPTExportArchiveBytes {
		closeArchive()
		return nil, invalidChatGPTExportArchive("archive size exceeds the supported limit")
	}
	if err := validateChatGPTExportZipDirectory(archive, info.Size()); err != nil {
		closeArchive()
		return nil, err
	}
	reader, err := zip.NewReader(archive, info.Size())
	if err != nil {
		closeArchive()
		return nil, invalidChatGPTExportArchive("open ZIP: %v", err)
	}
	if len(reader.File) > maxChatGPTExportArchiveEntries {
		closeArchive()
		return nil, invalidChatGPTExportArchive("archive entry count exceeds %d", maxChatGPTExportArchiveEntries)
	}

	handle := &chatgptExportArchiveHandle{
		close: closeArchive,
	}
	if legacy, err := chatgptExportLegacyConversationEntry(reader.File); err != nil {
		closeArchive()
		return nil, err
	} else if legacy != nil {
		handle.entries = []*zip.File{legacy}
		return handle, nil
	}

	bundleEntry, err := chatgptExportConversationBundleEntry(reader.File)
	if err != nil {
		closeArchive()
		return nil, err
	}
	if bundleEntry == nil {
		closeArchive()
		return nil, invalidChatGPTExportArchive("archive does not contain a supported ChatGPT conversations payload")
	}
	entries, bundleBytes, err := chatgptExportConversationEntriesFromBundle(bundleEntry)
	if err != nil {
		closeArchive()
		return nil, err
	}
	handle.entries = entries
	handle.keepAlive = append(handle.keepAlive, bundleBytes)
	return handle, nil
}

func chatgptExportLegacyConversationEntry(files []*zip.File) (*zip.File, error) {
	var conversations *zip.File
	for _, file := range files {
		name := filepath.ToSlash(file.Name)
		if name != chatgptExportConversationsEntry {
			continue
		}
		if conversations != nil {
			return nil, invalidChatGPTExportArchive("archive contains duplicate conversations.json entries")
		}
		if err := validateChatGPTExportConversationZipEntry(file, "conversations.json"); err != nil {
			return nil, err
		}
		conversations = file
	}
	return conversations, nil
}

func chatgptExportConversationBundleEntry(files []*zip.File) (*zip.File, error) {
	var bundle *zip.File
	for _, file := range files {
		if !chatgptExportIsConversationBundle(file.Name) {
			continue
		}
		if bundle != nil {
			return nil, invalidChatGPTExportArchive("archive contains multiple ChatGPT conversation bundles")
		}
		if err := validateChatGPTExportConversationZipEntry(file, "conversation bundle"); err != nil {
			return nil, err
		}
		bundle = file
	}
	return bundle, nil
}

func chatgptExportIsConversationBundle(name string) bool {
	base := filepath.Base(filepath.ToSlash(name))
	if !strings.HasPrefix(base, chatgptExportConversationBundlePrefix) {
		return false
	}
	if !strings.HasSuffix(strings.ToLower(base), ".zip") {
		return false
	}
	return strings.Contains(base, "-chatgpt-")
}

func chatgptExportConversationEntriesFromBundle(bundleEntry *zip.File) ([]*zip.File, []byte, error) {
	reader, err := bundleEntry.Open()
	if err != nil {
		return nil, nil, invalidChatGPTExportArchive("open conversation bundle: %v", err)
	}
	defer reader.Close()
	limited := io.LimitReader(reader, maxChatGPTExportEntryBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return nil, nil, invalidChatGPTExportArchive("read conversation bundle: %v", err)
	}
	if int64(len(data)) > maxChatGPTExportEntryBytes {
		return nil, nil, invalidChatGPTExportArchive("conversation bundle exceeds the supported size limit")
	}
	if len(data) == 0 {
		return nil, nil, invalidChatGPTExportArchive("conversation bundle is empty")
	}
	innerReader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, nil, invalidChatGPTExportArchive("open conversation bundle ZIP: %v", err)
	}
	if len(innerReader.File) > maxChatGPTExportArchiveEntries {
		return nil, nil, invalidChatGPTExportArchive("conversation bundle entry count exceeds %d", maxChatGPTExportArchiveEntries)
	}
	entries := make([]*zip.File, 0, len(innerReader.File))
	for _, file := range innerReader.File {
		if !chatgptExportIsConversationPayloadEntry(file.Name) {
			continue
		}
		label := filepath.Base(filepath.ToSlash(file.Name))
		if err := validateChatGPTExportConversationZipEntry(file, label); err != nil {
			return nil, nil, err
		}
		entries = append(entries, file)
	}
	if len(entries) == 0 {
		return nil, nil, invalidChatGPTExportArchive("conversation bundle does not contain conversations payload entries")
	}
	sort.SliceStable(entries, func(left, right int) bool {
		leftOrder := chatgptExportConversationPayloadOrder(entries[left].Name)
		rightOrder := chatgptExportConversationPayloadOrder(entries[right].Name)
		if leftOrder != rightOrder {
			return leftOrder < rightOrder
		}
		return filepath.ToSlash(entries[left].Name) < filepath.ToSlash(entries[right].Name)
	})
	return entries, data, nil
}

func chatgptExportIsConversationPayloadEntry(name string) bool {
	base := filepath.Base(filepath.ToSlash(name))
	if base == chatgptExportConversationsEntry {
		return true
	}
	if !strings.HasPrefix(base, "conversations-") || !strings.HasSuffix(base, ".json") {
		return false
	}
	suffix := strings.TrimSuffix(strings.TrimPrefix(base, "conversations-"), ".json")
	if suffix == "" {
		return false
	}
	for _, r := range suffix {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func chatgptExportConversationPayloadOrder(name string) int {
	base := filepath.Base(filepath.ToSlash(name))
	if base == chatgptExportConversationsEntry {
		return -1
	}
	suffix := strings.TrimSuffix(strings.TrimPrefix(base, "conversations-"), ".json")
	order, err := strconv.Atoi(suffix)
	if err != nil {
		return 1_000_000
	}
	return order
}

func validateChatGPTExportConversationZipEntry(file *zip.File, label string) error {
	if file.FileInfo().IsDir() || file.Mode()&os.ModeSymlink != 0 || file.Flags&0x1 != 0 {
		return invalidChatGPTExportArchive("%s is not a readable regular ZIP entry", label)
	}
	if file.UncompressedSize64 == 0 || file.UncompressedSize64 > maxChatGPTExportEntryBytes {
		return invalidChatGPTExportArchive("%s exceeds the supported size limit", label)
	}
	return nil
}

func parseChatGPTExportConversation(
	ctx context.Context,
	home string,
	conversationID string,
	conversation chatgptExportConversation,
) (externalImportedSession, bool, error) {
	resumeSupported := false
	session := externalImportedSession{
		Provider: chatgptExportProvider,
		// SourcePath intentionally left empty: the ChatGPT import never records
		// or surfaces the local archive path (see the redaction note above).
		SourcePath:      "",
		Cwd:             home,
		SummaryTitle:    strings.TrimSpace(conversation.Title),
		NoProject:       true,
		ResumeSupported: &resumeSupported,
	}
	branch, leafID, err := chatgptExportLinearBranch(conversation)
	if err != nil {
		return externalImportedSession{}, false, invalidChatGPTExportArchive(
			"invalid mapping graph in conversation %q: %v",
			conversationID,
			err,
		)
	}
	branchNodeIDs := make([]string, len(branch))
	for index, node := range branch {
		branchNodeIDs[index] = node.NodeID
	}
	branchIdentity := chatgptExportBranchIdentity(conversation.Mapping, branchNodeIDs)
	session.ProviderSessionID = "chatgpt-export:" + conversationID + ":branch:" + branchIdentity

	conversationCreatedAt := chatgptExportUnixMS(conversation.CreateTime)
	conversationUpdatedAt := chatgptExportUnixMS(conversation.UpdateTime)
	seenMessageSeeds := map[string]struct{}{}
	for index, node := range branch {
		if err := ctx.Err(); err != nil {
			return externalImportedSession{}, false, err
		}
		message := node.Message
		if message == nil || message.Metadata.IsVisuallyHidden {
			continue
		}
		role := chatgptExportMessageRole(message.Author.Role)
		if role == "" {
			continue
		}
		text, filesPayload, textErr := chatgptExportVisibleMessageText(ctx, message)
		if textErr != nil {
			return externalImportedSession{}, false, textErr
		}
		if text == "" {
			continue
		}
		seed := strings.TrimSpace(message.ID)
		if seed == "" {
			seed = node.NodeID
		}
		if seed == "" {
			seed = "missing-" + externalStableHash(conversationID+"\x00"+strings.Repeat("x", index))
		}
		if _, exists := seenMessageSeeds[seed]; exists {
			continue
		}
		seenMessageSeeds[seed] = struct{}{}
		occurredAt := firstNonZeroInt64(
			chatgptExportUnixMS(message.CreateTime),
			conversationCreatedAt,
			conversationUpdatedAt,
			int64(index+1),
		)
		payload := map[string]any{
			"externalSource":        "chatgpt-data-export",
			"sourceBranchId":        branchIdentity,
			"sourceBranchLeafId":    leafID,
			"sourceMessageId":       strings.TrimSpace(message.ID),
			"sourceParentMessageId": node.ParentMessageID,
			"sourceNodeId":          node.NodeID,
		}
		if len(filesPayload) > 0 {
			payload["files"] = filesPayload
		}
		session.Messages = append(session.Messages, externalImportedMessage{
			RawID:             seed,
			MessageIDSeed:     seed,
			Role:              role,
			Kind:              "text",
			Status:            "completed",
			Text:              text,
			Payload:           payload,
			OccurredAtUnixMS:  occurredAt,
			StartedAtUnixMS:   occurredAt,
			CompletedAtUnixMS: occurredAt,
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
	session.Title = chatgptExportConversationTitle(session.SummaryTitle, session.Messages)
	return session, true, nil
}

// chatgptExportLinearBranch walks from current_node back to the root and
// returns the messages in root-to-leaf order. Abandoned edit/regenerate
// branches are dropped: current_node is ChatGPT's authoritative "active leaf",
// so following it reproduces exactly the thread the user last saw.
func chatgptExportLinearBranch(conversation chatgptExportConversation) ([]chatgptExportLinearNode, string, error) {
	mapping := conversation.Mapping
	if len(mapping) == 0 {
		return nil, "", nil
	}
	leaf := strings.TrimSpace(conversation.CurrentNode)
	if _, ok := mapping[leaf]; !ok {
		leaf = chatgptExportFallbackLeaf(mapping)
	}
	if leaf == "" {
		return nil, "", nil
	}
	visited := make(map[string]struct{}, len(mapping))
	reversed := make([]string, 0, len(mapping))
	for id := leaf; id != ""; {
		node, ok := mapping[id]
		if !ok {
			break
		}
		if _, seen := visited[id]; seen {
			return nil, "", fmt.Errorf("cycle at node %q", id)
		}
		visited[id] = struct{}{}
		reversed = append(reversed, id)
		if len(reversed) > maxChatGPTExportMessages {
			return nil, "", fmt.Errorf("branch depth exceeds %d", maxChatGPTExportMessages)
		}
		id = strings.TrimSpace(node.Parent)
	}
	nodes := make([]chatgptExportLinearNode, 0, len(reversed))
	for i := len(reversed) - 1; i >= 0; i-- {
		id := reversed[i]
		node := mapping[id]
		parentMessageID := ""
		if parent, ok := mapping[strings.TrimSpace(node.Parent)]; ok && parent.Message != nil {
			parentMessageID = strings.TrimSpace(parent.Message.ID)
		}
		nodes = append(nodes, chatgptExportLinearNode{
			NodeID:          id,
			Message:         node.Message,
			ParentMessageID: parentMessageID,
		})
	}
	return nodes, leaf, nil
}

// chatgptExportFallbackLeaf deterministically picks a leaf when current_node is
// absent or dangling: the childless node whose message is newest wins, with a
// node-id tiebreak so re-imports stay idempotent.
func chatgptExportFallbackLeaf(mapping map[string]chatgptExportNode) string {
	best := ""
	bestTime := float64(-1)
	for id, node := range mapping {
		if len(node.Children) != 0 {
			continue
		}
		occurredAt := float64(0)
		if node.Message != nil {
			occurredAt = node.Message.CreateTime
		}
		if occurredAt > bestTime || (occurredAt == bestTime && id > best) {
			bestTime = occurredAt
			best = id
		}
	}
	return best
}

// chatgptExportBranchIdentity mirrors the Claude export importer: linear
// conversation growth keeps a stable "main" identity, while regenerated/retry
// branches get a deterministic fork hash from the chosen child at each fork.
func chatgptExportBranchIdentity(mapping map[string]chatgptExportNode, branchNodeIDs []string) string {
	decisions := make([]string, 0, 4)
	for _, nodeID := range branchNodeIDs {
		node, ok := mapping[nodeID]
		if !ok {
			continue
		}
		parentID := strings.TrimSpace(node.Parent)
		if parentID == "" {
			continue
		}
		parent, ok := mapping[parentID]
		if !ok || len(parent.Children) <= 1 {
			continue
		}
		decisions = append(decisions, nodeID)
	}
	if len(decisions) == 0 {
		return "main"
	}
	return "fork-" + externalStableHash(strings.Join(decisions, "\x00"))[:24]
}

func chatgptExportMessageRole(role string) string {
	switch strings.TrimSpace(strings.ToLower(role)) {
	case "user":
		return "user"
	case "assistant":
		return "assistant"
	default:
		return ""
	}
}

func chatgptExportVisibleMessageText(ctx context.Context, message *chatgptExportMessage) (string, []map[string]any, error) {
	contentType := strings.TrimSpace(strings.ToLower(message.Content.ContentType))
	if contentType != "text" && contentType != "multimodal_text" {
		// Unsupported content type (code/tool/execution output/etc.): skip its
		// content instead of failing the conversation.
		return "", nil, nil
	}
	parts := make([]string, 0, len(message.Content.Parts))
	var filesPayload []map[string]any
	for index, raw := range message.Content.Parts {
		if index%256 == 0 {
			if err := ctx.Err(); err != nil {
				return "", nil, err
			}
		}
		var text string
		if err := json.Unmarshal(raw, &text); err == nil {
			if trimmed := strings.TrimSpace(text); trimmed != "" {
				parts = append(parts, trimmed)
			}
			continue
		}
		var part chatgptExportContentPart
		if err := json.Unmarshal(raw, &part); err != nil {
			continue
		}
		name := chatgptExportAssetName(part)
		if name == "" {
			continue
		}
		parts = append(parts, "📎 "+escapeChatGPTExportMarkdown(name))
		filesPayload = append(filesPayload, map[string]any{
			"available":   false,
			"fileName":    name,
			"contentType": strings.TrimSpace(part.ContentType),
			"kind":        "asset_reference",
		})
	}
	return strings.TrimSpace(strings.Join(parts, "\n\n")), filesPayload, nil
}

func chatgptExportAssetName(part chatgptExportContentPart) string {
	if name := chatgptExportFileName(part.Name); name != "" {
		return name
	}
	pointer := strings.TrimSpace(part.AssetPointer)
	if pointer != "" {
		segment := pointer
		if index := strings.LastIndexAny(segment, "/:"); index >= 0 {
			segment = segment[index+1:]
		}
		if name := chatgptExportFileName(segment); name != "" {
			return name
		}
	}
	if strings.Contains(strings.ToLower(part.ContentType), "image") {
		return "image"
	}
	return ""
}

func chatgptExportFileName(raw string) string {
	name := strings.Join(strings.Fields(raw), " ")
	const maxFileNameRunes = 255
	runes := []rune(name)
	if len(runes) > maxFileNameRunes {
		name = string(runes[:maxFileNameRunes])
	}
	return strings.TrimSpace(name)
}

func escapeChatGPTExportMarkdown(value string) string {
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

func chatgptExportConversationID(conversation chatgptExportConversation, raw []byte) string {
	if id := strings.TrimSpace(conversation.ConversationID); id != "" {
		return id
	}
	if id := strings.TrimSpace(conversation.ID); id != "" {
		return id
	}
	return "missing-" + externalStableHash(string(raw))
}

func chatgptExportConversationTitle(summaryTitle string, messages []externalImportedMessage) string {
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

func chatgptExportUnixMS(seconds float64) int64 {
	if seconds <= 0 {
		return 0
	}
	return int64(seconds * 1000)
}

func invalidChatGPTExportArchive(format string, args ...any) error {
	return fmt.Errorf("%w: invalid ChatGPT data export: %s", ErrInvalidArgument, fmt.Sprintf(format, args...))
}
