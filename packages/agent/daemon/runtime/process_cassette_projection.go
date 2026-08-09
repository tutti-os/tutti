package agentruntime

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	replay "github.com/tutti-os/tutti/packages/agent/session-replay"
)

const (
	portableProcessCassetteAccountEmail     = "replay-user@example.invalid"
	portableProcessCassetteHomeToken        = replay.PortableReplayHomeToken
	portableProcessCassetteCLIVersionToken  = "<runtime-cli-version>"
	portableProcessCassetteClientTitleToken = "<runtime-client-title>"
)

type processCassetteProjection struct {
	descriptor     replay.ProviderReplayDescriptor
	cwd            processCassetteCWD
	personalRoots  []string
	requestMethods map[string]string
	stdout         []*pendingProcessCassetteChunk
}

func newProcessCassetteProjection(
	spec ProcessSpec,
	cwd processCassetteCWD,
) (*processCassetteProjection, error) {
	descriptor, ok := replay.FindProviderReplayByProvider(spec.Provider)
	if !ok {
		return nil, fmt.Errorf(
			"provider %q has no replay adapter",
			spec.Provider,
		)
	}
	if !processCassetteProjectionSupported(descriptor) {
		return nil, fmt.Errorf(
			"provider %q has unsupported replay projection adapter",
			spec.Provider,
		)
	}
	return &processCassetteProjection{
		descriptor:     descriptor,
		cwd:            cwd,
		personalRoots:  processCassettePersonalRoots(spec, descriptor),
		requestMethods: map[string]string{},
	}, nil
}

func processCassetteProjectionSupported(
	descriptor replay.ProviderReplayDescriptor,
) bool {
	switch descriptor.Tape.Codec {
	case replay.ProviderTapeCodecJSONRPC:
		return descriptor.Tape.ProjectionCodec ==
			replay.ProviderProjectionCodecJSONRPCPortable
	case replay.ProviderTapeCodecClaudeSidecarV7:
		return descriptor.Tape.ProjectionCodec ==
			replay.ProviderProjectionCodecClaudeSidecarV7Portable
	default:
		return false
	}
}

func (p *processCassetteProjection) project(
	pending *pendingProcessCassetteChunk,
) error {
	switch pending.chunk.Kind {
	case "outbound":
		return p.projectOutbound(pending)
	case "stdout":
		return p.projectStdout(pending)
	default:
		pending.ready = true
		return nil
	}
}

func (p *processCassetteProjection) projectOutbound(
	pending *pendingProcessCassetteChunk,
) error {
	data, err := base64.StdEncoding.DecodeString(pending.chunk.Data)
	if err != nil {
		return fmt.Errorf("decode process cassette outbound projection: %w", err)
	}
	values, ok := decodeProcessCassetteJSONValues(data)
	if !ok {
		pending.ready = true
		return nil
	}
	for _, value := range values {
		message, isMessage := value.(map[string]any)
		if !isMessage {
			continue
		}
		method, _ := message["method"].(string)
		method = strings.TrimSpace(method)
		if p.descriptor.MethodCarriesCredentials(method) {
			return fmt.Errorf(
				"process cassette recording rejects credential-bearing method %q",
				method,
			)
		}
		if id, exists := message["id"]; exists && method != "" {
			p.requestMethods[processCassetteJSONRPCID(id)] = method
		}
	}
	projected, changed, err := p.projectValues(data, values, false)
	if err != nil {
		return err
	}
	if !changed {
		projected = data
	}
	pending.chunk.Data = base64.StdEncoding.EncodeToString(projected)
	pending.ready = true
	return nil
}

func (p *processCassetteProjection) projectStdout(
	pending *pendingProcessCassetteChunk,
) error {
	data, err := base64.StdEncoding.DecodeString(pending.chunk.Data)
	if err != nil {
		return fmt.Errorf("decode process cassette stdout projection: %w", err)
	}
	p.stdout = append(p.stdout, pending)
	if len(data) == 0 || data[len(data)-1] != '\n' {
		return nil
	}
	return p.flushStdout(false)
}

func (p *processCassetteProjection) finish() error {
	return p.flushStdout(true)
}

func (p *processCassetteProjection) flushStdout(final bool) error {
	if len(p.stdout) == 0 {
		return nil
	}
	var raw bytes.Buffer
	chunkEnds := make([]int, len(p.stdout))
	for index, pending := range p.stdout {
		data, err := base64.StdEncoding.DecodeString(pending.chunk.Data)
		if err != nil {
			return fmt.Errorf("decode buffered process cassette stdout: %w", err)
		}
		_, _ = raw.Write(data)
		chunkEnds[index] = raw.Len()
	}
	if !final && (raw.Len() == 0 || raw.Bytes()[raw.Len()-1] != '\n') {
		return nil
	}

	outputs := make([][]byte, len(p.stdout))
	start := 0
	for start < raw.Len() {
		next := bytes.IndexByte(raw.Bytes()[start:], '\n')
		end := raw.Len()
		if next >= 0 {
			end = start + next + 1
		} else if !final {
			break
		}
		line := raw.Bytes()[start:end]
		projected, err := p.projectInboundLine(line)
		if err != nil {
			return err
		}
		if bytes.Equal(projected, line) {
			appendOriginalProcessCassetteRange(outputs, raw.Bytes(), chunkEnds, start, end)
		} else {
			completionChunk := processCassetteCompletionChunk(chunkEnds, end)
			outputs[completionChunk] = append(outputs[completionChunk], projected...)
		}
		start = end
	}
	if start != raw.Len() {
		return errors.New("process cassette stdout projection left an incomplete protocol message")
	}
	for index, pending := range p.stdout {
		pending.chunk.Data = base64.StdEncoding.EncodeToString(outputs[index])
		pending.ready = true
	}
	p.stdout = nil
	return nil
}

func appendOriginalProcessCassetteRange(
	outputs [][]byte,
	raw []byte,
	chunkEnds []int,
	start int,
	end int,
) {
	chunkStart := 0
	for index, chunkEnd := range chunkEnds {
		partStart := max(start, chunkStart)
		partEnd := min(end, chunkEnd)
		if partStart < partEnd {
			outputs[index] = append(outputs[index], raw[partStart:partEnd]...)
		}
		chunkStart = chunkEnd
		if chunkStart >= end {
			return
		}
	}
}

func processCassetteCompletionChunk(chunkEnds []int, messageEnd int) int {
	for index, end := range chunkEnds {
		if messageEnd <= end {
			return index
		}
	}
	return len(chunkEnds) - 1
}

func (p *processCassetteProjection) projectInboundLine(data []byte) ([]byte, error) {
	values, ok := decodeProcessCassetteJSONValues(data)
	if !ok {
		return append([]byte(nil), data...), nil
	}
	accountProjected := false
	for _, value := range values {
		message, isMessage := value.(map[string]any)
		if !isMessage {
			continue
		}
		if method, _ := message["method"].(string); strings.TrimSpace(method) != "" {
			if p.descriptor.MethodCarriesCredentials(method) {
				return nil, fmt.Errorf(
					"process cassette recording rejects credential-bearing method %q",
					method,
				)
			}
			continue
		}
		id := processCassetteJSONRPCID(message["id"])
		method := p.requestMethods[id]
		if method == p.descriptor.Tape.AccountReadMethod {
			accountProjected = projectProcessCassetteAccountReadResponse(message) || accountProjected
		}
		if _, hasResult := message["result"]; hasResult {
			delete(p.requestMethods, id)
		}
		if _, hasError := message["error"]; hasError {
			delete(p.requestMethods, id)
		}
	}
	projected, changed, err := p.projectValues(
		data,
		values,
		accountProjected,
	)
	if err != nil {
		return nil, err
	}
	if !accountProjected && !changed {
		return append([]byte(nil), data...), nil
	}
	return projected, nil
}

func projectProcessCassetteAccountReadResponse(message map[string]any) bool {
	result, _ := message["result"].(map[string]any)
	account, _ := result["account"].(map[string]any)
	email, _ := account["email"].(string)
	if strings.TrimSpace(email) != "" {
		account["email"] = portableProcessCassetteAccountEmail
		return true
	}
	return false
}

func (p *processCassetteProjection) projectValues(
	original []byte,
	values []any,
	force bool,
) ([]byte, bool, error) {
	before, err := json.Marshal(values)
	if err != nil {
		return nil, false, fmt.Errorf("encode process cassette projection baseline: %w", err)
	}
	projectProcessCassetteRuntimeGeneratedFields(values, p.descriptor)
	projectProcessCassetteEnvironment(values, p.descriptor)
	if p.cwd.recorded != "" {
		for index, value := range values {
			values[index] = mapProcessCassettePathFields(
				value,
				p.cwd.recorded,
				p.cwd.token,
			)
		}
	}
	for _, personalRoot := range p.personalRoots {
		for index, value := range values {
			values[index] = mapProcessCassettePathFields(
				value,
				personalRoot,
				portableProcessCassetteHomeToken,
			)
		}
	}
	for _, value := range values {
		if err := replay.AuditProjectedProcessCassetteValue("$", "", value); err != nil {
			return nil, false, err
		}
	}
	after, err := json.Marshal(values)
	if err != nil {
		return nil, false, fmt.Errorf("encode process cassette projection result: %w", err)
	}
	changed := force || !bytes.Equal(before, after)
	if !changed {
		return append([]byte(nil), original...), false, nil
	}
	var output bytes.Buffer
	encoder := json.NewEncoder(&output)
	for _, value := range values {
		if err := encoder.Encode(value); err != nil {
			return nil, false, fmt.Errorf("encode process cassette projection: %w", err)
		}
	}
	return output.Bytes(), true, nil
}

func projectProcessCassetteEnvironment(
	values []any,
	descriptor replay.ProviderReplayDescriptor,
) {
	if !descriptor.Tape.ExcludeEnvironment {
		return
	}
	for _, value := range values {
		message, ok := value.(map[string]any)
		if !ok || strings.TrimSpace(payloadString(message, "type")) != "start" {
			continue
		}
		payload, _ := message["payload"].(map[string]any)
		delete(payload, "env")
	}
}

func projectProcessCassetteRuntimeGeneratedFields(
	values []any,
	descriptor replay.ProviderReplayDescriptor,
) {
	for _, value := range values {
		message, ok := value.(map[string]any)
		if !ok {
			continue
		}
		method := strings.TrimSpace(payloadString(message, "method"))
		params, _ := message["params"].(map[string]any)
		for _, field := range descriptor.Tape.GeneratedRequestFields {
			if method != field.Method {
				continue
			}
			current := strings.TrimSpace(payloadString(params, field.Parameter))
			if strings.HasPrefix(current, field.ValuePrefix) &&
				current != field.PortableValue {
				params[field.Parameter] = field.PortableValue
			}
		}
	}
}

// projectProcessCassetteVolatileClientInfo normalizes product-owned initialize
// clientInfo fields for request matching. The served CLI version and host title
// may drift across cassette lifetime and consumer product; name remains the
// protocol client identity and part of the semantic match.
func projectProcessCassetteVolatileClientInfo(values []any) {
	for _, value := range values {
		message, ok := value.(map[string]any)
		if !ok {
			continue
		}
		if strings.TrimSpace(payloadString(message, "method")) != "initialize" {
			continue
		}
		params, _ := message["params"].(map[string]any)
		if params == nil {
			continue
		}
		clientInfo, _ := params["clientInfo"].(map[string]any)
		if clientInfo == nil {
			continue
		}
		if _, ok := clientInfo["version"]; ok {
			clientInfo["version"] = portableProcessCassetteCLIVersionToken
		}
		if _, ok := clientInfo["title"]; ok {
			clientInfo["title"] = portableProcessCassetteClientTitleToken
		}
	}
}

func processCassettePersonalRoots(
	spec ProcessSpec,
	descriptor replay.ProviderReplayDescriptor,
) []string {
	providerRoots := make([]string, 0, 1)
	personalRoots := make([]string, 0, 2)
	for _, env := range spec.Env {
		name, value, found := strings.Cut(env, "=")
		if !found {
			continue
		}
		if descriptor.IsHomeEnvVar(name) {
			if value = strings.TrimSpace(value); value != "" {
				providerRoots = appendUniqueProcessCassetteRoot(providerRoots, value)
			}
			continue
		}
		switch strings.ToUpper(strings.TrimSpace(name)) {
		case "HOME", "USERPROFILE":
			if value = strings.TrimSpace(value); value != "" {
				personalRoots = appendUniqueProcessCassetteRoot(personalRoots, value)
			}
		}
	}
	for _, candidate := range []string{spec.CWD, spec.ProtocolCWD} {
		candidate = strings.TrimSpace(candidate)
		parts := strings.Split(filepath.ToSlash(candidate), "/")
		if len(parts) >= 3 &&
			(parts[1] == "Users" || parts[1] == "home") &&
			parts[2] != "" {
			personalRoots = appendUniqueProcessCassetteRoot(
				personalRoots,
				string(filepath.Separator)+filepath.Join(parts[1], parts[2]),
			)
		}
	}
	for _, root := range personalRoots {
		providerRoots = appendUniqueProcessCassetteRoot(providerRoots, root)
	}
	return providerRoots
}

func appendUniqueProcessCassetteRoot(roots []string, root string) []string {
	root = strings.TrimRight(strings.TrimSpace(root), `/\`)
	if root == "" {
		return roots
	}
	for _, existing := range roots {
		if existing == root {
			return roots
		}
	}
	return append(roots, root)
}
