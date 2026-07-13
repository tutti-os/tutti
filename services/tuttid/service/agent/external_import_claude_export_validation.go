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

const (
	claudeZipEndOfCentralDirectorySignature       = 0x06054b50
	maxClaudeZipCommentBytes                      = 65_535
	maxClaudeZipDirectoryBytes              int64 = 4 << 20
	maxClaudeExportJSONDepth                      = 64
	maxClaudeExportJSONContainerItems             = 10_000
	maxClaudeExportJSONTokens                     = 1_000_000
	maxClaudeExportJSONStringBytes                = 8 << 20
)

type claudeExportJSONFrame struct {
	delimiter  json.Delim
	items      int
	expectsKey bool
}

type claudeExportConversationStream struct {
	ctx                   context.Context
	reader                *bufio.Reader
	limited               *io.LimitedReader
	entryByteLimit        int64
	conversationByteLimit int64
	bytesRead             int64
	elementsRead          int
	finished              bool
}

var errClaudeExportEntryByteLimit = errors.New("claude export entry byte limit exceeded")

func newClaudeExportConversationStream(
	ctx context.Context,
	reader io.Reader,
) (*claudeExportConversationStream, error) {
	return newClaudeExportConversationStreamWithLimits(
		ctx,
		reader,
		maxClaudeExportEntryBytes,
		maxClaudeExportConversationBytes,
	)
}

func newClaudeExportConversationStreamWithLimits(
	ctx context.Context,
	reader io.Reader,
	entryByteLimit int64,
	conversationByteLimit int64,
) (*claudeExportConversationStream, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if entryByteLimit <= 0 || conversationByteLimit <= 0 || conversationByteLimit > entryByteLimit {
		return nil, invalidClaudeExportArchive("invalid parser byte limits")
	}
	limited := &io.LimitedReader{R: reader, N: entryByteLimit + 1}
	stream := &claudeExportConversationStream{
		ctx:                   ctx,
		reader:                bufio.NewReader(limited),
		limited:               limited,
		entryByteLimit:        entryByteLimit,
		conversationByteLimit: conversationByteLimit,
	}
	first, err := stream.readNonWhitespaceByte()
	if err != nil {
		return nil, wrapClaudeExportStreamReadError("read conversations.json opening array", err)
	}
	if first != '[' {
		return nil, invalidClaudeExportArchive("conversations.json must contain an array")
	}
	return stream, nil
}

func (stream *claudeExportConversationStream) Next() (json.RawMessage, bool, error) {
	if stream == nil || stream.finished {
		return nil, false, nil
	}
	if err := stream.ctx.Err(); err != nil {
		return nil, false, err
	}
	next, err := stream.readNonWhitespaceByte()
	if err != nil {
		return nil, false, wrapClaudeExportStreamReadError("read conversations.json array", err)
	}
	if stream.elementsRead > 0 {
		if next == ']' {
			if err := stream.finish(); err != nil {
				return nil, false, err
			}
			return nil, false, nil
		}
		if next != ',' {
			return nil, false, invalidClaudeExportArchive("conversations.json entries must be comma-separated")
		}
		next, err = stream.readNonWhitespaceByte()
		if err != nil {
			return nil, false, wrapClaudeExportStreamReadError("read next conversations.json entry", err)
		}
		if next == ']' {
			return nil, false, invalidClaudeExportArchive("conversations.json has a trailing comma")
		}
	} else if next == ']' {
		if err := stream.finish(); err != nil {
			return nil, false, err
		}
		return nil, false, nil
	}
	if next != '{' {
		return nil, false, invalidClaudeExportArchive(
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

func (stream *claudeExportConversationStream) readConversationObject(
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
			return nil, wrapClaudeExportStreamReadError(
				"read conversation object",
				err,
			)
		}
		if int64(len(raw)) >= stream.conversationByteLimit {
			return nil, invalidClaudeExportArchive(
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
			if len(stack) >= maxClaudeExportJSONDepth {
				return nil, claudeExportConversationComplexityError(conversationNumber, "JSON nesting depth")
			}
			stack = append(stack, next)
		case '}', ']':
			expected := byte('{')
			if next == ']' {
				expected = '['
			}
			if stack[len(stack)-1] != expected {
				return nil, invalidClaudeExportArchive(
					"conversation %d has mismatched JSON delimiters",
					conversationNumber,
				)
			}
			stack = stack[:len(stack)-1]
		}
	}
	return json.RawMessage(raw), nil
}

func (stream *claudeExportConversationStream) finish() error {
	for {
		next, err := stream.readByte()
		if errors.Is(err, io.EOF) {
			stream.finished = true
			return nil
		}
		if err != nil {
			return wrapClaudeExportStreamReadError("finish conversations.json", err)
		}
		if !isClaudeExportJSONWhitespace(next) {
			return invalidClaudeExportArchive("conversations.json has trailing data")
		}
	}
}

func (stream *claudeExportConversationStream) readNonWhitespaceByte() (byte, error) {
	for {
		next, err := stream.readByte()
		if err != nil {
			return 0, err
		}
		if !isClaudeExportJSONWhitespace(next) {
			return next, nil
		}
	}
}

func (stream *claudeExportConversationStream) readByte() (byte, error) {
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
		return 0, errClaudeExportEntryByteLimit
	}
	return next, nil
}

func wrapClaudeExportStreamReadError(action string, err error) error {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	if errors.Is(err, errClaudeExportEntryByteLimit) {
		return invalidClaudeExportArchive("conversations.json exceeds the supported size limit")
	}
	return invalidClaudeExportArchive("%s: %v", action, err)
}

func isClaudeExportJSONWhitespace(value byte) bool {
	return value == ' ' || value == '\t' || value == '\r' || value == '\n'
}

func validateClaudeExportZipDirectory(archive io.ReaderAt, archiveSize int64) error {
	tailSize := archiveSize
	const endRecordBytes = int64(22)
	if maximum := endRecordBytes + maxClaudeZipCommentBytes; tailSize > maximum {
		tailSize = maximum
	}
	tail := make([]byte, tailSize)
	if _, err := archive.ReadAt(tail, archiveSize-tailSize); err != nil && !errors.Is(err, io.EOF) {
		return invalidClaudeExportArchive("read ZIP directory: %v", err)
	}
	endOffset := -1
	for offset := len(tail) - int(endRecordBytes); offset >= 0; offset-- {
		if binary.LittleEndian.Uint32(tail[offset:]) != claudeZipEndOfCentralDirectorySignature {
			continue
		}
		commentLength := int(binary.LittleEndian.Uint16(tail[offset+20:]))
		if offset+int(endRecordBytes)+commentLength == len(tail) {
			endOffset = offset
			break
		}
	}
	if endOffset < 0 {
		return invalidClaudeExportArchive("ZIP end-of-directory record is missing")
	}
	record := tail[endOffset:]
	if binary.LittleEndian.Uint16(record[4:]) != 0 || binary.LittleEndian.Uint16(record[6:]) != 0 {
		return invalidClaudeExportArchive("multi-disk ZIP archives are not supported")
	}
	entriesOnDisk := binary.LittleEndian.Uint16(record[8:])
	totalEntries := binary.LittleEndian.Uint16(record[10:])
	directorySize := binary.LittleEndian.Uint32(record[12:])
	directoryOffset := binary.LittleEndian.Uint32(record[16:])
	if entriesOnDisk == ^uint16(0) || totalEntries == ^uint16(0) ||
		directorySize == ^uint32(0) || directoryOffset == ^uint32(0) {
		return invalidClaudeExportArchive("ZIP64 directory metadata is not supported")
	}
	if entriesOnDisk != totalEntries {
		return invalidClaudeExportArchive("ZIP directory entry counts do not match")
	}
	if totalEntries > maxClaudeExportArchiveEntries {
		return invalidClaudeExportArchive("archive entry count exceeds %d", maxClaudeExportArchiveEntries)
	}
	if int64(directorySize) > maxClaudeZipDirectoryBytes || int64(directorySize) > archiveSize {
		return invalidClaudeExportArchive("ZIP directory exceeds the supported size limit")
	}
	// archive/zip parses central-directory headers from directoryOffset until
	// they stop parsing, not until the declared count, so a record that
	// underreports its size could smuggle a much larger directory past the
	// limits above. Require the declared span to end exactly at the
	// end-of-directory record.
	endRecordStart := archiveSize - tailSize + int64(endOffset)
	if int64(directoryOffset)+int64(directorySize) != endRecordStart {
		return invalidClaudeExportArchive("ZIP directory span does not match the end-of-directory record")
	}
	return nil
}

func validateClaudeExportConversationJSON(ctx context.Context, raw []byte, conversationNumber int) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	frames := make([]claudeExportJSONFrame, 0, 8)
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
			return invalidClaudeExportArchive("decode conversation %d structure: %v", conversationNumber, err)
		}
		// Count only successfully decoded tokens so a conversation with
		// exactly maxClaudeExportJSONTokens tokens stays within the limit.
		tokenCount++
		if tokenCount > maxClaudeExportJSONTokens {
			return claudeExportConversationComplexityError(conversationNumber, "JSON token count")
		}
		switch value := token.(type) {
		case json.Delim:
			switch value {
			case '{', '[':
				if err := consumeClaudeExportJSONValue(frames, &rootValues, conversationNumber); err != nil {
					return err
				}
				if len(frames) >= maxClaudeExportJSONDepth {
					return claudeExportConversationComplexityError(conversationNumber, "JSON nesting depth")
				}
				frames = append(frames, claudeExportJSONFrame{delimiter: value, expectsKey: value == '{'})
			case '}', ']':
				if len(frames) == 0 || (value == '}' && frames[len(frames)-1].delimiter != '{') ||
					(value == ']' && frames[len(frames)-1].delimiter != '[') {
					return invalidClaudeExportArchive("conversation %d has mismatched JSON delimiters", conversationNumber)
				}
				frames = frames[:len(frames)-1]
			}
		case string:
			if len(value) > maxClaudeExportJSONStringBytes {
				return claudeExportConversationComplexityError(conversationNumber, "JSON string size")
			}
			if len(frames) > 0 && frames[len(frames)-1].delimiter == '{' && frames[len(frames)-1].expectsKey {
				frame := &frames[len(frames)-1]
				frame.items++
				if frame.items > maxClaudeExportJSONContainerItems {
					return claudeExportConversationComplexityError(conversationNumber, "JSON object field count")
				}
				frame.expectsKey = false
				continue
			}
			if err := consumeClaudeExportJSONValue(frames, &rootValues, conversationNumber); err != nil {
				return err
			}
		default:
			if err := consumeClaudeExportJSONValue(frames, &rootValues, conversationNumber); err != nil {
				return err
			}
		}
	}
	if len(frames) != 0 || rootValues != 1 {
		return invalidClaudeExportArchive("conversation %d is not one complete JSON value", conversationNumber)
	}
	return nil
}

func consumeClaudeExportJSONValue(
	frames []claudeExportJSONFrame,
	rootValues *int,
	conversationNumber int,
) error {
	if len(frames) == 0 {
		(*rootValues)++
		if *rootValues > 1 {
			return invalidClaudeExportArchive("conversation %d contains trailing JSON data", conversationNumber)
		}
		return nil
	}
	frame := &frames[len(frames)-1]
	if frame.delimiter == '{' {
		if frame.expectsKey {
			return invalidClaudeExportArchive("conversation %d has an invalid JSON object value", conversationNumber)
		}
		frame.expectsKey = true
		return nil
	}
	frame.items++
	if frame.items > maxClaudeExportJSONContainerItems {
		return claudeExportConversationComplexityError(conversationNumber, "JSON array item count")
	}
	return nil
}

func claudeExportConversationComplexityError(conversationNumber int, limit string) error {
	return invalidClaudeExportArchive(
		"conversation %d exceeds the supported %s limit",
		conversationNumber,
		limit,
	)
}
