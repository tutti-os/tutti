package modelgateway

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
)

type sseEvent struct {
	Event string
	Data  []byte
}

type sseDecoder struct {
	reader *bufio.Reader
}

func newSSEDecoder(reader io.Reader) *sseDecoder {
	return &sseDecoder{reader: bufio.NewReader(reader)}
}

func (d *sseDecoder) Next() (sseEvent, error) {
	var event sseEvent
	var data bytes.Buffer
	for {
		line, err := d.reader.ReadString('\n')
		if err != nil && len(line) == 0 {
			if errors.Is(err, io.EOF) && (event.Event != "" || data.Len() > 0) {
				event.Data = bytes.TrimSuffix(data.Bytes(), []byte("\n"))
				return event, nil
			}
			return sseEvent{}, err
		}
		line = strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
		if line == "" {
			if event.Event == "" && data.Len() == 0 {
				if err != nil {
					return sseEvent{}, err
				}
				continue
			}
			event.Data = bytes.TrimSuffix(data.Bytes(), []byte("\n"))
			return event, nil
		}
		if strings.HasPrefix(line, ":") {
			if err != nil {
				return sseEvent{}, err
			}
			continue
		}
		field, value, found := strings.Cut(line, ":")
		if found {
			value = strings.TrimPrefix(value, " ")
		}
		switch field {
		case "event":
			event.Event = value
		case "data":
			data.WriteString(value)
			data.WriteByte('\n')
		}
		if err != nil {
			event.Data = bytes.TrimSuffix(data.Bytes(), []byte("\n"))
			return event, nil
		}
	}
}

type responsesSSEWriter struct {
	writer   http.ResponseWriter
	flusher  http.Flusher
	sequence int64
}

func newResponsesSSEWriter(writer http.ResponseWriter) (*responsesSSEWriter, bool) {
	flusher, ok := writer.(http.Flusher)
	return &responsesSSEWriter{writer: writer, flusher: flusher}, ok
}

func (w *responsesSSEWriter) Event(eventType string, payload map[string]any) error {
	w.sequence++
	payload["type"] = eventType
	payload["sequence_number"] = w.sequence
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if _, err := w.writer.Write([]byte("event: " + eventType + "\ndata: ")); err != nil {
		return err
	}
	if _, err := w.writer.Write(encoded); err != nil {
		return err
	}
	if _, err := w.writer.Write([]byte("\n\n")); err != nil {
		return err
	}
	w.flusher.Flush()
	return nil
}
