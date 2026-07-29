package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
)

// The ChatGPT export archive/JSON guards mirror the Claude export validators
// exactly (same limits and same defenses against multi-disk/ZIP64/directory
// smuggling and pathological JSON), but keep ChatGPT-branded error wording and
// stay independent so neither importer can regress the other.
const (
	chatgptZipEndOfCentralDirectorySignature       = 0x06054b50
	maxChatGPTZipCommentBytes                      = 65_535
	maxChatGPTZipDirectoryBytes              int64 = 4 << 20
	maxChatGPTExportConversationBytes        int64 = 64 << 20
	maxChatGPTExportJSONDepth                      = 64
	maxChatGPTExportJSONContainerItems             = 10_000
	maxChatGPTExportJSONTokens                     = 1_000_000
	maxChatGPTExportJSONStringBytes                = 8 << 20
)

type chatgptExportJSONFrame struct {
	delimiter  json.Delim
	items      int
	expectsKey bool
}

type chatgptExportConversationStream struct {
	ctx                   context.Context
	reader                *bufio.Reader
	limited               *io.LimitedReader
	entryByteLimit        int64
	conversationByteLimit int64
	bytesRead             int64
	elementsRead          int
	finished              bool
}

var errChatGPTExportEntryByteLimit = errors.New("chatgpt export entry byte limit exceeded")

func newChatGPTExportConversationStream(
	ctx context.Context,
	reader io.Reader,
) (*chatgptExportConversationStream, error) {
	return newChatGPTExportConversationStreamWithLimits(
		ctx,
		reader,
		maxChatGPTExportEntryBytes,
		maxChatGPTExportConversationBytes,
	)
}

func newChatGPTExportConversationStreamWithLimits(
	ctx context.Context,
	reader io.Reader,
	entryByteLimit int64,
	conversationByteLimit int64,
) (*chatgptExportConversationStream, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if entryByteLimit <= 0 || conversationByteLimit <= 0 || conversationByteLimit > entryByteLimit {
		return nil, invalidChatGPTExportArchive("invalid parser byte limits")
	}
	limited := &io.LimitedReader{R: reader, N: entryByteLimit + 1}
	stream := &chatgptExportConversationStream{
		ctx:                   ctx,
		reader:                bufio.NewReader(limited),
		limited:               limited,
		entryByteLimit:        entryByteLimit,
		conversationByteLimit: conversationByteLimit,
	}
	first, err := stream.readNonWhitespaceByte()
	if err != nil {
		return nil, wrapChatGPTExportStreamReadError("read conversations.json opening array", err)
	}
	if first != '[' {
		return nil, invalidChatGPTExportArchive("conversations.json must contain an array")
	}
	return stream, nil
}

func (stream *chatgptExportConversationStream) Next() (json.RawMessage, bool, error) {
	if stream == nil || stream.finished {
		return nil, false, nil
	}
	if err := stream.ctx.Err(); err != nil {
		return nil, false, err
	}
	next, err := stream.readNonWhitespaceByte()
	if err != nil {
		return nil, false, wrapChatGPTExportStreamReadError("read conversations.json array", err)
	}
	if stream.elementsRead > 0 {
		if next == ']' {
			if err := stream.finish(); err != nil {
				return nil, false, err
			}
			return nil, false, nil
		}
		if next != ',' {
			return nil, false, invalidChatGPTExportArchive("conversations.json entries must be comma-separated")
		}
		next, err = stream.readNonWhitespaceByte()
		if err != nil {
			return nil, false, wrapChatGPTExportStreamReadError("read next conversations.json entry", err)
		}
		if next == ']' {
			return nil, false, invalidChatGPTExportArchive("conversations.json has a trailing comma")
		}
	} else if next == ']' {
		if err := stream.finish(); err != nil {
			return nil, false, err
		}
		return nil, false, nil
	}
	if next != '{' {
		return nil, false, invalidChatGPTExportArchive(
			"conversation %d must contain an object",
			stream.elementsRead+1,
		)
	}
	raw, err := stream.readConversationObject(next, stream.elementsRead+1)
	if err != nil {
		return nil, false, err
	}
	stream.elementsRead++
	return raw, true, nil
}

func (stream *chatgptExportConversationStream) readConversationObject(
	first byte,
	conversationNumber int,
) (json.RawMessage, error) {
	raw := make([]byte, 0, 4096)
	raw = append(raw, first)
	stack := []byte{'{'}
	inString := false
	escaped := false
	for len(stack) > 0 {
		next, err := stream.readByte()
		if err != nil {
			return nil, wrapChatGPTExportStreamReadError(
				"read conversation object",
				err,
			)
		}
		if int64(len(raw)) >= stream.conversationByteLimit {
			return nil, invalidChatGPTExportArchive(
				"conversation %d exceeds the size limit",
				conversationNumber,
			)
		}
		raw = append(raw, next)
		if inString {
			if escaped {
				escaped = false
				continue
			}
			switch next {
			case '\\':
				escaped = true
			case '"':
				inString = false
			}
			continue
		}
		switch next {
		case '"':
			inString = true
		case '{', '[':
			if len(stack) >= maxChatGPTExportJSONDepth {
				return nil, chatgptExportConversationComplexityError(conversationNumber, "JSON nesting depth")
			}
			stack = append(stack, next)
		case '}', ']':
			expected := byte('{')
			if next == ']' {
				expected = '['
			}
			if stack[len(stack)-1] != expected {
				return nil, invalidChatGPTExportArchive(
					"conversation %d has mismatched JSON delimiters",
					conversationNumber,
				)
			}
			stack = stack[:len(stack)-1]
		}
	}
	return json.RawMessage(raw), nil
}

func (stream *chatgptExportConversationStream) finish() error {
	for {
		next, err := stream.readByte()
		if errors.Is(err, io.EOF) {
			stream.finished = true
			return nil
		}
		if err != nil {
			return wrapChatGPTExportStreamReadError("finish conversations.json", err)
		}
		if !isChatGPTExportJSONWhitespace(next) {
			return invalidChatGPTExportArchive("conversations.json has trailing data")
		}
	}
}

func (stream *chatgptExportConversationStream) readNonWhitespaceByte() (byte, error) {
	for {
		next, err := stream.readByte()
		if err != nil {
			return 0, err
		}
		if !isChatGPTExportJSONWhitespace(next) {
			return next, nil
		}
	}
}

func (stream *chatgptExportConversationStream) readByte() (byte, error) {
	if stream.bytesRead%64_000 == 0 {
		if err := stream.ctx.Err(); err != nil {
			return 0, err
		}
	}
	next, err := stream.reader.ReadByte()
	if err != nil {
		return 0, err
	}
	stream.bytesRead++
	if stream.bytesRead > stream.entryByteLimit || stream.limited.N == 0 {
		return 0, errChatGPTExportEntryByteLimit
	}
	return next, nil
}

func wrapChatGPTExportStreamReadError(action string, err error) error {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	if errors.Is(err, errChatGPTExportEntryByteLimit) {
		return invalidChatGPTExportArchive("conversations.json exceeds the supported size limit")
	}
	return invalidChatGPTExportArchive("%s: %v", action, err)
}

func isChatGPTExportJSONWhitespace(value byte) bool {
	return value == ' ' || value == '\t' || value == '\r' || value == '\n'
}

func validateChatGPTExportZipDirectory(archive io.ReaderAt, archiveSize int64) error {
	tailSize := archiveSize
	const endRecordBytes = int64(22)
	if maximum := endRecordBytes + maxChatGPTZipCommentBytes; tailSize > maximum {
		tailSize = maximum
	}
	tail := make([]byte, tailSize)
	if _, err := archive.ReadAt(tail, archiveSize-tailSize); err != nil && !errors.Is(err, io.EOF) {
		return invalidChatGPTExportArchive("read ZIP directory: %v", err)
	}
	endOffset := -1
	for offset := len(tail) - int(endRecordBytes); offset >= 0; offset-- {
		if binary.LittleEndian.Uint32(tail[offset:]) != chatgptZipEndOfCentralDirectorySignature {
			continue
		}
		commentLength := int(binary.LittleEndian.Uint16(tail[offset+20:]))
		if offset+int(endRecordBytes)+commentLength == len(tail) {
			endOffset = offset
			break
		}
	}
	if endOffset < 0 {
		return invalidChatGPTExportArchive("ZIP end-of-directory record is missing")
	}
	record := tail[endOffset:]
	if binary.LittleEndian.Uint16(record[4:]) != 0 || binary.LittleEndian.Uint16(record[6:]) != 0 {
		return invalidChatGPTExportArchive("multi-disk ZIP archives are not supported")
	}
	entriesOnDisk := binary.LittleEndian.Uint16(record[8:])
	totalEntries := binary.LittleEndian.Uint16(record[10:])
	directorySize := binary.LittleEndian.Uint32(record[12:])
	directoryOffset := binary.LittleEndian.Uint32(record[16:])
	if entriesOnDisk == ^uint16(0) || totalEntries == ^uint16(0) ||
		directorySize == ^uint32(0) || directoryOffset == ^uint32(0) {
		return invalidChatGPTExportArchive("ZIP64 directory metadata is not supported")
	}
	if entriesOnDisk != totalEntries {
		return invalidChatGPTExportArchive("ZIP directory entry counts do not match")
	}
	if totalEntries > maxChatGPTExportArchiveEntries {
		return invalidChatGPTExportArchive("archive entry count exceeds %d", maxChatGPTExportArchiveEntries)
	}
	if int64(directorySize) > maxChatGPTZipDirectoryBytes || int64(directorySize) > archiveSize {
		return invalidChatGPTExportArchive("ZIP directory exceeds the supported size limit")
	}
	// archive/zip parses central-directory headers from directoryOffset until
	// they stop parsing, not until the declared count, so a record that
	// underreports its size could smuggle a much larger directory past the
	// limits above. Require the declared span to end exactly at the
	// end-of-directory record.
	endRecordStart := archiveSize - tailSize + int64(endOffset)
	if int64(directoryOffset)+int64(directorySize) != endRecordStart {
		return invalidChatGPTExportArchive("ZIP directory span does not match the end-of-directory record")
	}
	return nil
}

func validateChatGPTExportConversationJSON(ctx context.Context, raw []byte, conversationNumber int) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	frames := make([]chatgptExportJSONFrame, 0, 8)
	rootValues := 0
	for tokenCount := 0; ; {
		if tokenCount%1024 == 0 {
			if err := ctx.Err(); err != nil {
				return err
			}
		}
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return invalidChatGPTExportArchive("decode conversation %d structure: %v", conversationNumber, err)
		}
		// Count only successfully decoded tokens so a conversation with
		// exactly maxChatGPTExportJSONTokens tokens stays within the limit.
		tokenCount++
		if tokenCount > maxChatGPTExportJSONTokens {
			return chatgptExportConversationComplexityError(conversationNumber, "JSON token count")
		}
		switch value := token.(type) {
		case json.Delim:
			switch value {
			case '{', '[':
				if err := consumeChatGPTExportJSONValue(frames, &rootValues, conversationNumber); err != nil {
					return err
				}
				if len(frames) >= maxChatGPTExportJSONDepth {
					return chatgptExportConversationComplexityError(conversationNumber, "JSON nesting depth")
				}
				frames = append(frames, chatgptExportJSONFrame{delimiter: value, expectsKey: value == '{'})
			case '}', ']':
				if len(frames) == 0 || (value == '}' && frames[len(frames)-1].delimiter != '{') ||
					(value == ']' && frames[len(frames)-1].delimiter != '[') {
					return invalidChatGPTExportArchive("conversation %d has mismatched JSON delimiters", conversationNumber)
				}
				frames = frames[:len(frames)-1]
			}
		case string:
			if len(value) > maxChatGPTExportJSONStringBytes {
				return chatgptExportConversationComplexityError(conversationNumber, "JSON string size")
			}
			if len(frames) > 0 && frames[len(frames)-1].delimiter == '{' && frames[len(frames)-1].expectsKey {
				frame := &frames[len(frames)-1]
				frame.items++
				if frame.items > maxChatGPTExportJSONContainerItems {
					return chatgptExportConversationComplexityError(conversationNumber, "JSON object field count")
				}
				frame.expectsKey = false
				continue
			}
			if err := consumeChatGPTExportJSONValue(frames, &rootValues, conversationNumber); err != nil {
				return err
			}
		default:
			if err := consumeChatGPTExportJSONValue(frames, &rootValues, conversationNumber); err != nil {
				return err
			}
		}
	}
	if len(frames) != 0 || rootValues != 1 {
		return invalidChatGPTExportArchive("conversation %d is not one complete JSON value", conversationNumber)
	}
	return nil
}

func consumeChatGPTExportJSONValue(
	frames []chatgptExportJSONFrame,
	rootValues *int,
	conversationNumber int,
) error {
	if len(frames) == 0 {
		(*rootValues)++
		if *rootValues > 1 {
			return invalidChatGPTExportArchive("conversation %d contains trailing JSON data", conversationNumber)
		}
		return nil
	}
	frame := &frames[len(frames)-1]
	if frame.delimiter == '{' {
		if frame.expectsKey {
			return invalidChatGPTExportArchive("conversation %d has an invalid JSON object value", conversationNumber)
		}
		frame.expectsKey = true
		return nil
	}
	frame.items++
	if frame.items > maxChatGPTExportJSONContainerItems {
		return chatgptExportConversationComplexityError(conversationNumber, "JSON array item count")
	}
	return nil
}

func chatgptExportConversationComplexityError(conversationNumber int, limit string) error {
	return invalidChatGPTExportArchive(
		"conversation %d exceeds the supported %s limit",
		conversationNumber,
		limit,
	)
}
