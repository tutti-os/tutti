package agentruntime

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"reflect"
	"strings"

	replay "github.com/tutti-os/tutti/packages/agent/session-replay"
)

func processCassetteReplayAdapterSupported(
	descriptor replay.ProviderReplayDescriptor,
) bool {
	switch descriptor.Tape.Codec {
	case replay.ProviderTapeCodecJSONRPC:
		return descriptor.Tape.RequestMatcher == replay.ProviderRequestMatcherJSONRPC &&
			descriptor.Tape.InputObserver == replay.ProviderInputObserverACPJSON
	case replay.ProviderTapeCodecClaudeSidecarV7:
		return descriptor.Tape.RequestMatcher == replay.ProviderRequestMatcherClaudeSidecarV7 &&
			descriptor.Tape.InputObserver == replay.ProviderInputObserverClaudeSidecarV7
	default:
		return false
	}
}

func processCassetteJSONMatch(
	descriptor replay.ProviderReplayDescriptor,
	expected []byte,
	actual []byte,
	recordedCWD string,
	replayCWD string,
	replayHome string,
	knownIdentityValues map[string]string,
) (map[string]any, map[string]string, bool) {
	expectedValues, ok := decodeProcessCassetteJSONValues(expected)
	if !ok {
		return nil, nil, false
	}
	actualValues, ok := decodeProcessCassetteJSONValues(actual)
	if !ok || len(expectedValues) != len(actualValues) {
		return nil, nil, false
	}
	projectProcessCassetteRuntimeGeneratedFields(expectedValues, descriptor)
	projectProcessCassetteRuntimeGeneratedFields(actualValues, descriptor)
	projectProcessCassetteVolatileClientInfo(expectedValues)
	projectProcessCassetteVolatileClientInfo(actualValues)
	projectProcessCassetteEnvironment(expectedValues, descriptor)
	projectProcessCassetteEnvironment(actualValues, descriptor)
	responseIDs := map[string]any{}
	identityValues := map[string]string{}
	for index := range expectedValues {
		expectedValues[index] = mapProcessCassettePathFields(
			expectedValues[index],
			recordedCWD,
			replayCWD,
		)
		expectedValues[index] = mapProcessCassettePathFields(
			expectedValues[index],
			portableProcessCassetteHomeToken,
			replayHome,
		)
		expectedMessage, expectedIsMessage := expectedValues[index].(map[string]any)
		actualMessage, actualIsMessage := actualValues[index].(map[string]any)
		if expectedIsMessage && actualIsMessage &&
			processCassetteMessagesAreRequests(
				descriptor,
				expectedMessage,
				actualMessage,
			) {
			expectedID, expectedHasID := expectedMessage["id"]
			actualID, actualHasID := actualMessage["id"]
			if expectedHasID != actualHasID {
				return nil, nil, false
			}
			if expectedHasID {
				responseIDs[processCassetteJSONRPCID(expectedID)] = actualID
				expectedMessage["id"] = actualID
			}
		}
		if !alignProcessCassetteGeneratedIdentityValues(
			expectedValues[index],
			actualValues[index],
			descriptor,
			knownIdentityValues,
			identityValues,
		) {
			return nil, nil, false
		}
		if !reflect.DeepEqual(expectedValues[index], actualValues[index]) {
			return nil, nil, false
		}
	}
	return responseIDs, identityValues, true
}

func processCassetteMessagesAreRequests(
	descriptor replay.ProviderReplayDescriptor,
	expected map[string]any,
	actual map[string]any,
) bool {
	switch descriptor.Tape.RequestMatcher {
	case replay.ProviderRequestMatcherJSONRPC:
		return expected["method"] != nil && actual["method"] != nil
	case replay.ProviderRequestMatcherClaudeSidecarV7:
		return expected["type"] != nil && actual["type"] != nil
	default:
		return false
	}
}

func alignProcessCassetteGeneratedIdentityValues(
	expected any,
	actual any,
	descriptor replay.ProviderReplayDescriptor,
	known map[string]string,
	learned map[string]string,
) bool {
	switch expectedValue := expected.(type) {
	case map[string]any:
		actualValue, ok := actual.(map[string]any)
		if !ok {
			return false
		}
		for key, child := range expectedValue {
			actualChild, exists := actualValue[key]
			if !exists {
				return false
			}
			if descriptor.IsMatchedIdentityField(key) {
				expectedID, expectedOK := child.(string)
				actualID, actualOK := actualChild.(string)
				if expectedOK != actualOK {
					return false
				}
				if expectedOK && expectedID != "" && actualID != "" {
					if mapped := firstNonEmptyString(
						learned[expectedID],
						known[expectedID],
					); mapped != "" && mapped != actualID {
						return false
					}
					learned[expectedID] = actualID
					expectedValue[key] = actualID
					continue
				}
			}
			if !alignProcessCassetteGeneratedIdentityValues(
				child,
				actualChild,
				descriptor,
				known,
				learned,
			) {
				return false
			}
		}
		return true
	case []any:
		actualValue, ok := actual.([]any)
		if !ok || len(expectedValue) != len(actualValue) {
			return false
		}
		for index := range expectedValue {
			if !alignProcessCassetteGeneratedIdentityValues(
				expectedValue[index],
				actualValue[index],
				descriptor,
				known,
				learned,
			) {
				return false
			}
		}
		return true
	default:
		return true
	}
}

func mapProcessCassetteGeneratedIdentityValues(
	value any,
	descriptor replay.ProviderReplayDescriptor,
	identityValues map[string]string,
) any {
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			if descriptor.IsGeneratedIdentityField(key) {
				if recorded, ok := child.(string); ok {
					if mapped := identityValues[recorded]; mapped != "" {
						typed[key] = mapped
						continue
					}
				}
			}
			typed[key] = mapProcessCassetteGeneratedIdentityValues(
				child,
				descriptor,
				identityValues,
			)
		}
		return typed
	case []any:
		for index := range typed {
			typed[index] = mapProcessCassetteGeneratedIdentityValues(
				typed[index],
				descriptor,
				identityValues,
			)
		}
		return typed
	default:
		return value
	}
}

func processCassetteJSONRPCRequest(
	chunk processCassetteChunk,
) (method string, responseID string, ok bool) {
	if chunk.Kind != "outbound" {
		return "", "", false
	}
	data, err := base64.StdEncoding.DecodeString(chunk.Data)
	if err != nil {
		return "", "", false
	}
	return processCassetteJSONRPCRequestBytes(data)
}

func processCassetteJSONRPCRequestBytes(
	data []byte,
) (method string, responseID string, ok bool) {
	values, ok := decodeProcessCassetteJSONValues(data)
	if !ok || len(values) != 1 {
		return "", "", false
	}
	request, ok := values[0].(map[string]any)
	if !ok {
		return "", "", false
	}
	method, ok = request["method"].(string)
	if !ok || strings.TrimSpace(method) == "" {
		return "", "", false
	}
	if id, exists := request["id"]; exists {
		responseID = processCassetteJSONRPCID(id)
	}
	return method, responseID, true
}

func processCassetteJSONRPCID(value any) string {
	raw, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return string(raw)
}

func suppressSkippedProcessCassetteResponses(
	data []byte,
	skipped map[string]struct{},
) []byte {
	if len(data) == 0 || len(skipped) == 0 {
		return data
	}
	values, ok := decodeProcessCassetteJSONValues(data)
	if !ok {
		return data
	}
	filtered := make([]any, 0, len(values))
	for _, value := range values {
		message, isObject := value.(map[string]any)
		if !isObject || message["method"] != nil {
			filtered = append(filtered, value)
			continue
		}
		id := processCassetteJSONRPCID(message["id"])
		_, isSkipped := skipped[id]
		_, hasResult := message["result"]
		_, hasError := message["error"]
		if !isSkipped || (!hasResult && !hasError) {
			filtered = append(filtered, value)
			continue
		}
		delete(skipped, id)
	}
	if len(filtered) == len(values) {
		return data
	}
	var output bytes.Buffer
	encoder := json.NewEncoder(&output)
	for _, value := range filtered {
		if err := encoder.Encode(value); err != nil {
			return data
		}
	}
	return output.Bytes()
}

func mapProcessCassetteResponseIDs(data []byte, responseIDs map[string]any) []byte {
	if len(data) == 0 || len(responseIDs) == 0 {
		return data
	}
	values, ok := decodeProcessCassetteJSONValues(data)
	if !ok {
		return data
	}
	changed := false
	for _, value := range values {
		message, isObject := value.(map[string]any)
		if !isObject || message["method"] != nil {
			continue
		}
		_, hasResult := message["result"]
		_, hasError := message["error"]
		typeName, _ := message["type"].(string)
		isSidecarResponse := typeName == "ok" || typeName == "error"
		if !hasResult && !hasError && !isSidecarResponse {
			continue
		}
		recordedID := processCassetteJSONRPCID(message["id"])
		replayID, exists := responseIDs[recordedID]
		if !exists {
			continue
		}
		message["id"] = replayID
		changed = true
	}
	if !changed {
		return data
	}
	var output bytes.Buffer
	encoder := json.NewEncoder(&output)
	for _, value := range values {
		if err := encoder.Encode(value); err != nil {
			return data
		}
	}
	return output.Bytes()
}

func decodeProcessCassetteJSONValues(data []byte) ([]any, bool) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var values []any
	for {
		var value any
		if err := decoder.Decode(&value); err != nil {
			return values, errors.Is(err, io.EOF) && len(values) > 0
		}
		values = append(values, value)
	}
}

func mapProcessCassettePathFields(value any, oldValue string, newValue string) any {
	switch typed := value.(type) {
	case []any:
		for index := range typed {
			typed[index] = mapProcessCassettePathFields(
				typed[index],
				oldValue,
				newValue,
			)
		}
		return typed
	case map[string]any:
		for key, child := range typed {
			if isProcessCassettePathField(key) {
				if path, ok := child.(string); ok {
					if mapped, changed := mapProcessCassettePath(path, oldValue, newValue); changed {
						typed[key] = mapped
						continue
					}
				}
				if values, ok := child.([]any); ok {
					typed[key] = mapProcessCassettePathValues(values, oldValue, newValue)
					continue
				}
			}
			typed[key] = mapProcessCassettePathFields(child, oldValue, newValue)
		}
		return typed
	default:
		return value
	}
}

func mapProcessCassettePathValues(values []any, oldValue, newValue string) []any {
	for index, value := range values {
		if path, ok := value.(string); ok {
			if mapped, changed := mapProcessCassettePath(path, oldValue, newValue); changed {
				values[index] = mapped
			}
		}
	}
	return values
}

func mapProcessCassettePath(path, oldValue, newValue string) (string, bool) {
	if path == oldValue {
		return newValue, true
	}
	for _, separator := range []string{"/", `\`} {
		prefix := strings.TrimRight(oldValue, `/\`) + separator
		if strings.HasPrefix(path, prefix) {
			return strings.TrimRight(newValue, `/\`) + separator + strings.TrimPrefix(path, prefix), true
		}
	}
	return path, false
}

func isProcessCassettePathField(key string) bool {
	return replay.IsProviderPathField(key)
}

func processCassetteOutboundMismatch(
	chunk processCassetteChunk,
	expected []byte,
	actual []byte,
) error {
	return fmt.Errorf(
		"process cassette outbound mismatch at connection %s chunk %d: expected %s, actual %s",
		chunk.ConnectionID,
		chunk.ChunkSeq,
		summarizeProcessCassetteBytes(expected),
		summarizeProcessCassetteBytes(actual),
	)
}

func summarizeProcessCassetteBytes(data []byte) string {
	const limit = 512
	value := strings.TrimSpace(string(data))
	if len(value) > limit {
		value = value[:limit] + "…"
	}
	return fmt.Sprintf("%q", value)
}

func processCassetteConnectionKey(agentSessionID, provider string, launchOrdinal uint64) string {
	return fmt.Sprintf(
		"%s\x00%s\x00%d",
		normalizeProcessCassetteIdentity(agentSessionID),
		normalizeProcessCassetteIdentity(provider),
		launchOrdinal,
	)
}

func isOptionalReplayProbeConnection(
	descriptor replay.ProviderReplayDescriptor,
	record ProcessCassetteConnectionRecord,
	chunks []processCassetteChunk,
) bool {
	if record.LaunchOrdinal <= 1 {
		return false
	}
	hasProbe := false
	for _, chunk := range chunks {
		if chunk.Kind != "outbound" {
			continue
		}
		method, _, ok := processCassetteJSONRPCRequest(chunk)
		if !ok {
			return false
		}
		switch {
		case method == "initialize", method == "initialized":
		case descriptor.IsOptionalProbeMethod(method):
			hasProbe = true
		default:
			return false
		}
	}
	return hasProbe
}

func mapProcessCassetteFrameJSON(
	data []byte,
	recordedCWD string,
	replayCWD string,
	replayHome string,
	descriptor replay.ProviderReplayDescriptor,
	identityValues map[string]string,
) []byte {
	if len(data) == 0 {
		return data
	}
	values, ok := decodeProcessCassetteJSONValues(data)
	if !ok {
		return data
	}
	var output bytes.Buffer
	encoder := json.NewEncoder(&output)
	for _, value := range values {
		value = mapProcessCassettePathFields(value, recordedCWD, replayCWD)
		value = mapProcessCassettePathFields(
			value,
			portableProcessCassetteHomeToken,
			replayHome,
		)
		value = mapProcessCassetteGeneratedIdentityValues(
			value,
			descriptor,
			identityValues,
		)
		if err := encoder.Encode(value); err != nil {
			return data
		}
	}
	return output.Bytes()
}

func processCassetteReplayHome(
	spec ProcessSpec,
	descriptor replay.ProviderReplayDescriptor,
) string {
	if roots := processCassettePersonalRoots(spec, descriptor); len(roots) > 0 {
		return roots[0]
	}
	home, _ := os.UserHomeDir()
	return strings.TrimSpace(home)
}
