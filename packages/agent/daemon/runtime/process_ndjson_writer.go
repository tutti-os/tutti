package agentruntime

import (
	"encoding/json"
	"sync"
)

// ProcessNDJSONWriter serializes writes to a process stdio connection.
type ProcessNDJSONWriter struct {
	conn   ProcessConnection
	sendMu sync.Mutex
}

// NewProcessNDJSONWriter constructs a locked writer for newline-delimited JSON-RPC frames.
func NewProcessNDJSONWriter(conn ProcessConnection) ProcessNDJSONWriter {
	return ProcessNDJSONWriter{conn: conn}
}

func (w *ProcessNDJSONWriter) SendJSON(payload any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return w.SendLine(append(data, '\n'))
}

func (w *ProcessNDJSONWriter) SendLine(data []byte) error {
	w.sendMu.Lock()
	defer w.sendMu.Unlock()
	return w.conn.Send(data)
}
