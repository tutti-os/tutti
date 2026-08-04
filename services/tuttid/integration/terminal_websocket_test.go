package integration_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
)

type terminalWebSocketTestFrame struct {
	Code *int   `json:"code"`
	Data string `json:"data"`
	Seq  *int64 `json:"seq"`
	Type string `json:"type"`
}

func TestTuttidBlackBoxWorkspaceTerminalWebSocketStreamsInputAndOutput(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")

	daemon := startTestDaemon(t)

	createdWorkspace := mustRequestJSON[tuttigenerated.WorkspaceResponse](
		t,
		daemon,
		http.MethodPost,
		"/v1/workspaces",
		tuttigenerated.CreateWorkspaceRequest{
			Name: "Workspace Terminal",
		},
		http.StatusCreated,
	)

	createdTerminal := mustRequestJSON[tuttigenerated.WorkspaceTerminalResponse](
		t,
		daemon,
		http.MethodPost,
		"/v1/workspaces/"+createdWorkspace.Workspace.Id+"/terminals",
		tuttigenerated.CreateWorkspaceTerminalRequest{},
		http.StatusCreated,
	)

	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()

	streamURL := "ws" +
		strings.TrimPrefix(daemon.baseURL, "http") +
		"/v1/workspaces/" + createdWorkspace.Workspace.Id +
		"/terminals/" + createdTerminal.Terminal.Id +
		"/ws?access_token=" + daemon.accessToken

	conn, _, err := websocket.Dial(ctx, streamURL, nil)
	if err != nil {
		t.Fatalf("websocket Dial() error = %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "test done")

	resizePayload, err := json.Marshal(map[string]any{
		"type": "resize",
		"cols": 120,
		"rows": 40,
	})
	if err != nil {
		t.Fatalf("Marshal resize payload error = %v", err)
	}
	if err := conn.Write(ctx, websocket.MessageText, resizePayload); err != nil {
		t.Fatalf("websocket resize Write() error = %v", err)
	}

	inputPayload, err := json.Marshal(map[string]string{
		"type": "input",
		"data": terminalWebSocketEchoCommand("websocket-terminal-test"),
	})
	if err != nil {
		t.Fatalf("Marshal input payload error = %v", err)
	}
	if err := conn.Write(ctx, websocket.MessageText, inputPayload); err != nil {
		t.Fatalf("websocket Write() error = %v", err)
	}

	for {
		frame := readTerminalWebSocketTestFrame(t, ctx, conn)
		if frame.Type != "output" || !strings.Contains(frame.Data, "websocket-terminal-test") {
			continue
		}
		if frame.Seq == nil || *frame.Seq <= 0 {
			t.Fatalf("output seq = %v, want positive sequence", frame.Seq)
		}
		resized := mustRequestJSON[tuttigenerated.WorkspaceTerminalResponse](
			t,
			daemon,
			http.MethodGet,
			"/v1/workspaces/"+createdWorkspace.Workspace.Id+"/terminals/"+createdTerminal.Terminal.Id,
			nil,
			http.StatusOK,
		)
		if resized.Terminal.Cols != 120 || resized.Terminal.Rows != 40 {
			t.Fatalf("websocket resize = %dx%d, want 120x40", resized.Terminal.Cols, resized.Terminal.Rows)
		}
		return
	}
}

func TestTuttidBlackBoxWorkspaceTerminalWebSocketExitFrameCarriesExitCode(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")

	daemon := startTestDaemon(t)

	createdWorkspace := mustRequestJSON[tuttigenerated.WorkspaceResponse](
		t,
		daemon,
		http.MethodPost,
		"/v1/workspaces",
		tuttigenerated.CreateWorkspaceRequest{
			Name: "Workspace Terminal Exit",
		},
		http.StatusCreated,
	)

	createdTerminal := mustRequestJSON[tuttigenerated.WorkspaceTerminalResponse](
		t,
		daemon,
		http.MethodPost,
		"/v1/workspaces/"+createdWorkspace.Workspace.Id+"/terminals",
		tuttigenerated.CreateWorkspaceTerminalRequest{},
		http.StatusCreated,
	)

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	streamURL := "ws" +
		strings.TrimPrefix(daemon.baseURL, "http") +
		"/v1/workspaces/" + createdWorkspace.Workspace.Id +
		"/terminals/" + createdTerminal.Terminal.Id +
		"/ws?access_token=" + daemon.accessToken

	conn, _, err := websocket.Dial(ctx, streamURL, nil)
	if err != nil {
		t.Fatalf("websocket Dial() error = %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "test done")

	resizePayload, err := json.Marshal(map[string]any{
		"type": "resize",
		"cols": 120,
		"rows": 40,
	})
	if err != nil {
		t.Fatalf("Marshal resize payload error = %v", err)
	}
	if err := conn.Write(ctx, websocket.MessageText, resizePayload); err != nil {
		t.Fatalf("websocket resize Write() error = %v", err)
	}

	readyMarker := "tutti-terminal-exit-ready"
	readyPayload, err := json.Marshal(map[string]string{
		"type": "input",
		"data": terminalWebSocketEchoCommand(readyMarker),
	})
	if err != nil {
		t.Fatalf("Marshal ready payload error = %v", err)
	}
	if err := conn.Write(ctx, websocket.MessageText, readyPayload); err != nil {
		t.Fatalf("websocket ready Write() error = %v", err)
	}

	for {
		frame := readTerminalWebSocketTestFrame(t, ctx, conn)
		if frame.Type == "output" && strings.Contains(frame.Data, readyMarker) {
			break
		}
	}
	if runtime.GOOS == "windows" {
		mustRequestJSON[tuttigenerated.WorkspaceTerminalResponse](
			t,
			daemon,
			http.MethodDelete,
			"/v1/workspaces/"+createdWorkspace.Workspace.Id+"/terminals/"+createdTerminal.Terminal.Id,
			nil,
			http.StatusOK,
		)
		for {
			frame := readTerminalWebSocketTestFrame(t, ctx, conn)
			if frame.Type == "exit" {
				return
			}
		}
	}
	exitPayload, err := json.Marshal(map[string]string{
		"type": "input",
		"data": terminalWebSocketExitCommand(9),
	})
	if err != nil {
		t.Fatalf("Marshal exit payload error = %v", err)
	}
	if err := conn.Write(ctx, websocket.MessageText, exitPayload); err != nil {
		t.Fatalf("websocket exit Write() error = %v", err)
	}

	for {
		frame := readTerminalWebSocketTestFrame(t, ctx, conn)
		if frame.Type != "exit" {
			continue
		}
		if frame.Code == nil || *frame.Code != 9 {
			t.Fatalf("exit code = %v, want 9", frame.Code)
		}
		return
	}
}

func terminalWebSocketEchoCommand(value string) string {
	if runtime.GOOS == "windows" {
		return "echo " + value + "\r"
	}
	return "printf '" + value + "\\n'\r"
}

func terminalWebSocketExitCommand(code int) string {
	return fmt.Sprintf("exit %d\r", code)
}

func readTerminalWebSocketTestFrame(t *testing.T, ctx context.Context, conn *websocket.Conn) terminalWebSocketTestFrame {
	t.Helper()

	_, payload, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("websocket Read() error = %v", err)
	}
	var frame terminalWebSocketTestFrame
	if err := json.Unmarshal(payload, &frame); err != nil {
		t.Fatalf("Unmarshal websocket frame error = %v; payload: %s", err, string(payload))
	}
	return frame
}
