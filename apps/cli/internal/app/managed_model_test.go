package app

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseManagedModelExchangeInput(t *testing.T) {
	previous := managedModelInputReader
	managedModelInputReader = func() io.Reader {
		return strings.NewReader(`{"contextToken":"context-1","grantCode":"code-1","nonce":"nonce-1","state":"state-1"}`)
	}
	t.Cleanup(func() { managedModelInputReader = previous })

	commandID, input, err := parseManagedModelInput([]string{"grant", "exchange", "--input-json", "-"})
	if err != nil {
		t.Fatalf("parseManagedModelInput: %v", err)
	}
	if commandID != managedModelExchangeCommandID {
		t.Fatalf("commandID = %q", commandID)
	}
	if input["grantCode"] != "code-1" || input["contextToken"] != "context-1" {
		t.Fatalf("input = %#v", input)
	}
}

func TestManagedModelProtocolFixtureParsesExchangeInput(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "packages", "appcli", "core", "testdata", "managed-model", "protocol.v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Commands map[string]struct {
			Input json.RawMessage `json:"input"`
		} `json:"commands"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	previous := managedModelInputReader
	managedModelInputReader = func() io.Reader {
		return strings.NewReader(string(fixture.Commands[managedModelExchangeCommandID].Input))
	}
	t.Cleanup(func() { managedModelInputReader = previous })
	commandID, input, err := parseManagedModelInput([]string{"grant", "exchange", "--input-json", "-"})
	if err != nil || commandID != managedModelExchangeCommandID || input["grantCode"] != "grant-test" {
		t.Fatalf("parse fixture commandID=%q input=%#v err=%v", commandID, input, err)
	}
}

func TestParseManagedModelInputRejectsUnknownFields(t *testing.T) {
	previous := managedModelInputReader
	managedModelInputReader = func() io.Reader {
		return strings.NewReader(`{"grantRef":"grant-1","extra":"no"}`)
	}
	t.Cleanup(func() { managedModelInputReader = previous })

	_, _, err := parseManagedModelInput([]string{"models", "--input-json", "-"})
	if err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("err = %v", err)
	}
}

func TestParseManagedModelCredentialRejectsUnsupportedModelPlanID(t *testing.T) {
	previous := managedModelInputReader
	managedModelInputReader = func() io.Reader {
		return strings.NewReader(`{"capability":"chat","grantRef":"grant-1","model":"gpt","modelPlanId":"plan-1","provider":"openai"}`)
	}
	t.Cleanup(func() { managedModelInputReader = previous })

	_, _, err := parseManagedModelInput([]string{"credential", "--input-json", "-"})
	if err == nil || !strings.Contains(err.Error(), `unknown field "modelPlanId"`) {
		t.Fatalf("err = %v", err)
	}
}
