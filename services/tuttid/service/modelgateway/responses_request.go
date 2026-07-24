package modelgateway

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"
)

type responsesRequest struct {
	Model              string                     `json:"model"`
	Instructions       json.RawMessage            `json:"instructions"`
	Input              json.RawMessage            `json:"input"`
	Tools              []json.RawMessage          `json:"tools"`
	ToolChoice         json.RawMessage            `json:"tool_choice"`
	ParallelToolCalls  *bool                      `json:"parallel_tool_calls"`
	Reasoning          *responsesReasoningRequest `json:"reasoning"`
	MaxOutputTokens    *int64                     `json:"max_output_tokens"`
	Temperature        *float64                   `json:"temperature"`
	TopP               *float64                   `json:"top_p"`
	Stream             bool                       `json:"stream"`
	Store              *bool                      `json:"store"`
	Include            []string                   `json:"include"`
	ServiceTier        string                     `json:"service_tier"`
	PromptCacheKey     string                     `json:"prompt_cache_key"`
	Text               json.RawMessage            `json:"text"`
	ClientMetadata     map[string]string          `json:"client_metadata"`
	Metadata           map[string]string          `json:"metadata"`
	PreviousResponseID string                     `json:"previous_response_id"`
	User               string                     `json:"user"`
}

type responsesReasoningRequest struct {
	Effort  string `json:"effort"`
	Summary string `json:"summary"`
	Context string `json:"context"`
}

var supportedRequestFields = map[string]struct{}{
	"model": {}, "instructions": {}, "input": {}, "tools": {},
	"tool_choice": {}, "parallel_tool_calls": {}, "reasoning": {},
	"max_output_tokens": {}, "temperature": {}, "top_p": {}, "stream": {},
	"store": {}, "include": {}, "service_tier": {}, "prompt_cache_key": {},
	"text": {}, "client_metadata": {}, "metadata": {},
	"previous_response_id": {}, "user": {},
}

func decodeResponsesRequest(reader io.Reader, maxBytes int64) (responsesRequest, error) {
	limited := io.LimitReader(reader, maxBytes+1)
	body, err := io.ReadAll(limited)
	if err != nil {
		return responsesRequest{}, &invalidRequestError{
			Code: "invalid_json", Message: "Could not read request body",
		}
	}
	if int64(len(body)) > maxBytes {
		return responsesRequest{}, &invalidRequestError{
			Code: "request_too_large", Message: "Request body exceeds the Model Gateway limit",
		}
	}
	var fields map[string]json.RawMessage
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := decoder.Decode(&fields); err != nil {
		return responsesRequest{}, &invalidRequestError{
			Code: "invalid_json", Message: "Request body must be valid JSON",
		}
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return responsesRequest{}, &invalidRequestError{
			Code: "invalid_json", Message: "Request body must contain one JSON object",
		}
	}
	var unsupported []string
	for field := range fields {
		if _, ok := supportedRequestFields[field]; !ok {
			unsupported = append(unsupported, field)
		}
	}
	if len(unsupported) > 0 {
		sort.Strings(unsupported)
		return responsesRequest{}, &invalidRequestError{
			Param: unsupported[0],
			Code:  "unsupported_parameter",
			Message: fmt.Sprintf(
				"Unsupported Responses parameter %q", unsupported[0],
			),
		}
	}
	var request responsesRequest
	if err := json.Unmarshal(body, &request); err != nil {
		return responsesRequest{}, &invalidRequestError{
			Code: "invalid_json", Message: "Request body does not match the Responses request schema",
		}
	}
	request.Model = strings.TrimSpace(request.Model)
	if request.Model == "" {
		return responsesRequest{}, &invalidRequestError{
			Param: "model", Code: "missing_required_parameter", Message: "model is required",
		}
	}
	if strings.TrimSpace(request.PreviousResponseID) != "" {
		return responsesRequest{}, &invalidRequestError{
			Param:   "previous_response_id",
			Code:    "unsupported_parameter",
			Message: "previous_response_id is not supported by the stateless local Model Gateway",
		}
	}
	for _, include := range request.Include {
		if include != "reasoning.encrypted_content" {
			return responsesRequest{}, &invalidRequestError{
				Param: "include",
				Code:  "unsupported_value",
				Message: fmt.Sprintf(
					"Unsupported Responses include value %q", include,
				),
			}
		}
	}
	if request.Reasoning != nil {
		switch request.Reasoning.Context {
		case "", "auto", "current_turn", "all_turns":
		default:
			return responsesRequest{}, &invalidRequestError{
				Param: "reasoning.context", Code: "unsupported_value",
				Message: fmt.Sprintf("Unsupported reasoning.context %q", request.Reasoning.Context),
			}
		}
	}
	return request, nil
}

type chatRequest struct {
	Model             string            `json:"model"`
	Messages          []map[string]any  `json:"messages"`
	Tools             []map[string]any  `json:"tools,omitempty"`
	ToolChoice        any               `json:"tool_choice,omitempty"`
	ParallelToolCalls *bool             `json:"parallel_tool_calls,omitempty"`
	ReasoningEffort   string            `json:"reasoning_effort,omitempty"`
	MaxTokens         *int64            `json:"max_completion_tokens,omitempty"`
	Temperature       *float64          `json:"temperature,omitempty"`
	TopP              *float64          `json:"top_p,omitempty"`
	Stream            bool              `json:"stream"`
	StreamOptions     map[string]bool   `json:"stream_options,omitempty"`
	Store             *bool             `json:"store,omitempty"`
	ServiceTier       string            `json:"service_tier,omitempty"`
	PromptCacheKey    string            `json:"prompt_cache_key,omitempty"`
	Verbosity         string            `json:"verbosity,omitempty"`
	ResponseFormat    map[string]any    `json:"response_format,omitempty"`
	Metadata          map[string]string `json:"metadata,omitempty"`
	User              string            `json:"user,omitempty"`
	filteredToolTypes []string
}

type responseToolIdentity struct {
	Name      string
	Namespace string
}

type responseToolMap map[string]responseToolIdentity

func convertResponsesRequest(request responsesRequest) (chatRequest, responseToolMap, error) {
	tools, toolNamespaces, filteredToolTypes, err := convertResponseTools(request.Tools)
	if err != nil {
		return chatRequest{}, nil, err
	}
	messages, err := convertResponseInput(request.Instructions, request.Input, toolNamespaces)
	if err != nil {
		return chatRequest{}, nil, err
	}
	messages = collapseSystemMessagesToHead(messages)
	toolChoice, err := convertResponseToolChoice(request.ToolChoice, toolNamespaces, len(tools))
	if err != nil {
		return chatRequest{}, nil, err
	}
	verbosity, responseFormat, err := convertResponseTextControls(request.Text)
	if err != nil {
		return chatRequest{}, nil, err
	}
	metadata := request.Metadata
	if len(request.ClientMetadata) > 0 {
		if metadata == nil {
			metadata = make(map[string]string, len(request.ClientMetadata))
		}
		for key, value := range request.ClientMetadata {
			if _, exists := metadata[key]; !exists {
				metadata[key] = value
			}
		}
	}
	result := chatRequest{
		Model:             request.Model,
		Messages:          messages,
		Tools:             tools,
		ToolChoice:        toolChoice,
		ParallelToolCalls: request.ParallelToolCalls,
		MaxTokens:         request.MaxOutputTokens,
		Temperature:       request.Temperature,
		TopP:              request.TopP,
		Stream:            request.Stream,
		Store:             request.Store,
		ServiceTier:       strings.TrimSpace(request.ServiceTier),
		PromptCacheKey:    strings.TrimSpace(request.PromptCacheKey),
		Verbosity:         verbosity,
		ResponseFormat:    responseFormat,
		Metadata:          metadata,
		User:              strings.TrimSpace(request.User),
		filteredToolTypes: filteredToolTypes,
	}
	if len(tools) == 0 {
		result.ToolChoice = nil
		result.ParallelToolCalls = nil
	}
	if request.Stream {
		result.StreamOptions = map[string]bool{"include_usage": true}
	}
	if request.Reasoning != nil {
		result.ReasoningEffort = strings.TrimSpace(request.Reasoning.Effort)
	}
	return result, toolNamespaces, nil
}

type responseInputItem struct {
	Type      string          `json:"type"`
	Role      string          `json:"role"`
	Content   json.RawMessage `json:"content"`
	Name      string          `json:"name"`
	Namespace string          `json:"namespace"`
	Arguments string          `json:"arguments"`
	CallID    string          `json:"call_id"`
	Output    json.RawMessage `json:"output"`
	Summary   []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"summary"`
	EncryptedContent string `json:"encrypted_content"`
}

type pendingAssistantMessage struct {
	content          []map[string]any
	reasoningContent strings.Builder
	toolCalls        []map[string]any
}

func convertResponseInput(
	instructions json.RawMessage,
	input json.RawMessage,
	toolMap responseToolMap,
) ([]map[string]any, error) {
	messages := make([]map[string]any, 0)
	if len(bytes.TrimSpace(instructions)) > 0 && !bytes.Equal(bytes.TrimSpace(instructions), []byte("null")) {
		instructionMessages, err := convertInstructions(instructions)
		if err != nil {
			return nil, err
		}
		messages = append(messages, instructionMessages...)
	}
	if len(bytes.TrimSpace(input)) == 0 || bytes.Equal(bytes.TrimSpace(input), []byte("null")) {
		return messages, nil
	}
	var text string
	if err := json.Unmarshal(input, &text); err == nil {
		return append(messages, map[string]any{"role": "user", "content": text}), nil
	}
	var items []json.RawMessage
	if err := json.Unmarshal(input, &items); err != nil {
		return nil, invalidParam("input", "input must be a string or an array of Responses input items")
	}
	var assistant *pendingAssistantMessage
	flushAssistant := func() {
		if assistant == nil {
			return
		}
		message := map[string]any{"role": "assistant"}
		if len(assistant.content) > 0 {
			message["content"] = chatContentFromResponseParts(assistant.content)
		} else {
			message["content"] = nil
		}
		if assistant.reasoningContent.Len() > 0 {
			message["reasoning_content"] = assistant.reasoningContent.String()
		}
		if len(assistant.toolCalls) > 0 {
			message["tool_calls"] = assistant.toolCalls
		}
		messages = append(messages, message)
		assistant = nil
	}
	ensureAssistant := func() *pendingAssistantMessage {
		if assistant == nil {
			assistant = &pendingAssistantMessage{}
		}
		return assistant
	}
	for index, encoded := range items {
		var item responseInputItem
		if err := json.Unmarshal(encoded, &item); err != nil {
			return nil, invalidParam(fmt.Sprintf("input[%d]", index), "invalid Responses input item")
		}
		item.Type = strings.TrimSpace(item.Type)
		if item.Type == "" && strings.TrimSpace(item.Role) != "" {
			item.Type = "message"
		}
		switch item.Type {
		case "message":
			role := strings.TrimSpace(item.Role)
			chatRole := chatRoleForResponseMessage(role)
			content, err := convertMessageContent(chatRole, item.Content)
			if err != nil {
				return nil, withParam(err, fmt.Sprintf("input[%d].content", index))
			}
			if chatRole == "assistant" {
				current := ensureAssistant()
				current.content = append(current.content, content...)
				continue
			}
			flushAssistant()
			message := map[string]any{"role": chatRole}
			message["content"] = chatContentFromResponseParts(content)
			messages = append(messages, message)
		case "reasoning":
			readable := reasoningItemText(item)
			if readable == "" && strings.TrimSpace(item.EncryptedContent) != "" {
				return nil, invalidParam(
					fmt.Sprintf("input[%d].encrypted_content", index),
					"encrypted reasoning cannot be translated to Chat Completions",
				)
			}
			ensureAssistant().reasoningContent.WriteString(readable)
		case "function_call":
			if strings.TrimSpace(item.CallID) == "" || strings.TrimSpace(item.Name) == "" {
				return nil, invalidParam(fmt.Sprintf("input[%d]", index), "function_call requires call_id and name")
			}
			current := ensureAssistant()
			current.toolCalls = append(current.toolCalls, map[string]any{
				"id":   item.CallID,
				"type": "function",
				"function": map[string]any{
					"name":      chatNameForResponseTool(item.Namespace, item.Name, toolMap),
					"arguments": item.Arguments,
				},
			})
		case "function_call_output":
			if strings.TrimSpace(item.CallID) == "" {
				return nil, invalidParam(fmt.Sprintf("input[%d].call_id", index), "function_call_output requires call_id")
			}
			output, err := functionOutputText(item.Output)
			if err != nil {
				return nil, withParam(err, fmt.Sprintf("input[%d].output", index))
			}
			flushAssistant()
			messages = append(messages, map[string]any{
				"role": "tool", "tool_call_id": item.CallID, "content": output,
			})
		case "web_search_call", "computer_call", "file_search_call", "code_interpreter_call",
			"local_shell_call", "custom_tool_call", "custom_tool_call_output":
			return nil, invalidParam(
				fmt.Sprintf("input[%d].type", index),
				fmt.Sprintf("Responses input item type %q is not supported", item.Type),
			)
		default:
			return nil, invalidParam(
				fmt.Sprintf("input[%d].type", index),
				fmt.Sprintf("Responses input item type %q is not supported", item.Type),
			)
		}
	}
	flushAssistant()
	return messages, nil
}

func convertInstructions(encoded json.RawMessage) ([]map[string]any, error) {
	var text string
	if err := json.Unmarshal(encoded, &text); err == nil {
		if text == "" {
			return nil, nil
		}
		return []map[string]any{{"role": "system", "content": text}}, nil
	}
	var items []json.RawMessage
	if err := json.Unmarshal(encoded, &items); err != nil {
		return nil, invalidParam("instructions", "instructions must be a string or message array")
	}
	messages := make([]map[string]any, 0, len(items))
	for index, itemEncoded := range items {
		var item responseInputItem
		if err := json.Unmarshal(itemEncoded, &item); err != nil {
			return nil, invalidParam(fmt.Sprintf("instructions[%d]", index), "invalid instruction message")
		}
		if item.Type != "" && item.Type != "message" {
			return nil, invalidParam(fmt.Sprintf("instructions[%d].type", index), "instructions only support message items")
		}
		role := strings.TrimSpace(item.Role)
		if role != "system" && role != "developer" {
			return nil, invalidParam(fmt.Sprintf("instructions[%d].role", index), "instruction role must be system or developer")
		}
		content, err := convertMessageContent(role, item.Content)
		if err != nil {
			return nil, withParam(err, fmt.Sprintf("instructions[%d].content", index))
		}
		message := map[string]any{"role": chatRoleForResponseMessage(role)}
		message["content"] = chatContentFromResponseParts(content)
		messages = append(messages, message)
	}
	return messages, nil
}

func chatRoleForResponseMessage(role string) string {
	switch role {
	case "system", "developer":
		return "system"
	case "assistant":
		return "assistant"
	case "tool":
		return "tool"
	case "user", "latest_reminder":
		return "user"
	default:
		return "user"
	}
}

func collapseSystemMessagesToHead(messages []map[string]any) []map[string]any {
	systemChunks := make([]string, 0)
	rest := make([]map[string]any, 0, len(messages))
	for _, message := range messages {
		if message["role"] == "system" {
			if content, ok := message["content"].(string); ok {
				if strings.TrimSpace(content) != "" {
					systemChunks = append(systemChunks, content)
				}
				continue
			}
		}
		rest = append(rest, message)
	}
	result := make([]map[string]any, 0, len(rest)+1)
	if len(systemChunks) > 0 {
		result = append(result, map[string]any{
			"role":    "system",
			"content": strings.Join(systemChunks, "\n\n"),
		})
	}
	return append(result, rest...)
}

func chatContentFromResponseParts(parts []map[string]any) any {
	textParts := make([]string, 0, len(parts))
	for _, part := range parts {
		if part["type"] != "text" {
			return parts
		}
		text, _ := part["text"].(string)
		if text != "" {
			textParts = append(textParts, text)
		}
	}
	return strings.Join(textParts, "\n")
}

func convertMessageContent(role string, encoded json.RawMessage) ([]map[string]any, error) {
	var text string
	if err := json.Unmarshal(encoded, &text); err == nil {
		return []map[string]any{{"type": "text", "text": text}}, nil
	}
	var parts []struct {
		Type     string `json:"type"`
		Text     string `json:"text"`
		ImageURL string `json:"image_url"`
		Detail   string `json:"detail"`
	}
	if err := json.Unmarshal(encoded, &parts); err != nil {
		return nil, invalidParam("", "message content must be a string or content-part array")
	}
	result := make([]map[string]any, 0, len(parts))
	for index, part := range parts {
		switch part.Type {
		case "input_text":
			result = append(result, map[string]any{"type": "text", "text": part.Text})
		case "output_text":
			if role != "assistant" {
				return nil, invalidParam(fmt.Sprintf("[%d].type", index), "output_text is only valid for assistant messages")
			}
			result = append(result, map[string]any{"type": "text", "text": part.Text})
		case "input_image":
			if role != "user" {
				return nil, invalidParam(fmt.Sprintf("[%d].type", index), "input_image is only valid for user messages")
			}
			image := map[string]any{"url": part.ImageURL}
			if strings.TrimSpace(part.Detail) != "" {
				image["detail"] = part.Detail
			}
			result = append(result, map[string]any{"type": "image_url", "image_url": image})
		default:
			return nil, invalidParam(fmt.Sprintf("[%d].type", index), fmt.Sprintf("content part type %q is not supported", part.Type))
		}
	}
	return result, nil
}

func reasoningItemText(item responseInputItem) string {
	var result strings.Builder
	for _, summary := range item.Summary {
		result.WriteString(summary.Text)
	}
	var content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(item.Content, &content) == nil {
		for _, part := range content {
			result.WriteString(part.Text)
		}
	}
	return result.String()
}

func functionOutputText(encoded json.RawMessage) (string, error) {
	var text string
	if err := json.Unmarshal(encoded, &text); err == nil {
		return text, nil
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(encoded, &parts); err == nil {
		var result strings.Builder
		for index, part := range parts {
			switch part.Type {
			case "input_text", "output_text":
				result.WriteString(part.Text)
			default:
				return "", invalidParam(fmt.Sprintf("[%d].type", index), fmt.Sprintf("function output content type %q is not supported", part.Type))
			}
		}
		return result.String(), nil
	}
	if len(bytes.TrimSpace(encoded)) == 0 || bytes.Equal(bytes.TrimSpace(encoded), []byte("null")) {
		return "", nil
	}
	var value any
	if err := json.Unmarshal(encoded, &value); err != nil {
		return "", invalidParam("", "function output must be text or structured text content")
	}
	normalized, err := json.Marshal(value)
	if err != nil {
		return "", invalidParam("", "function output cannot be encoded")
	}
	return string(normalized), nil
}

func convertResponseTools(tools []json.RawMessage) ([]map[string]any, responseToolMap, []string, error) {
	if len(tools) == 0 {
		return nil, nil, nil, nil
	}
	result := make([]map[string]any, 0, len(tools))
	toolMap := make(responseToolMap)
	filteredTypes := make(map[string]struct{})
	seenNames := make(map[string]struct{})
	seenIdentities := make(map[string]struct{})
	for index, encoded := range tools {
		var header struct {
			Type string `json:"type"`
			Name string `json:"name"`
		}
		if err := json.Unmarshal(encoded, &header); err != nil || header.Type != "function" {
			continue
		}
		name := strings.TrimSpace(header.Name)
		if name == "" {
			continue
		}
		if _, exists := seenNames[name]; exists {
			return nil, nil, nil, invalidParam(
				fmt.Sprintf("tools[%d].name", index),
				fmt.Sprintf("function tool name %q is duplicated", name),
			)
		}
		seenNames[name] = struct{}{}
	}
	for index, encoded := range tools {
		var tool struct {
			Type        string            `json:"type"`
			Name        string            `json:"name"`
			Description string            `json:"description"`
			Parameters  json.RawMessage   `json:"parameters"`
			Strict      *bool             `json:"strict"`
			Tools       []json.RawMessage `json:"tools"`
		}
		if err := json.Unmarshal(encoded, &tool); err != nil {
			return nil, nil, nil, invalidParam(fmt.Sprintf("tools[%d]", index), "invalid tool")
		}
		switch tool.Type {
		case "function":
			function, err := convertFunctionTool(
				tool.Name,
				tool.Description,
				tool.Parameters,
				tool.Strict,
				fmt.Sprintf("tools[%d]", index),
			)
			if err != nil {
				return nil, nil, nil, err
			}
			name := function["name"].(string)
			seenIdentities["\x00"+name] = struct{}{}
			toolMap[name] = responseToolIdentity{Name: name}
			result = append(result, map[string]any{"type": "function", "function": function})
		case "namespace":
			namespace := strings.TrimSpace(tool.Name)
			if namespace == "" {
				return nil, nil, nil, invalidParam(fmt.Sprintf("tools[%d].name", index), "tool namespace name is required")
			}
			if len(tool.Tools) == 0 {
				return nil, nil, nil, invalidParam(fmt.Sprintf("tools[%d].tools", index), "tool namespace must contain at least one function")
			}
			for nestedIndex, nestedEncoded := range tool.Tools {
				var nested struct {
					Type        string          `json:"type"`
					Name        string          `json:"name"`
					Description string          `json:"description"`
					Parameters  json.RawMessage `json:"parameters"`
					Strict      *bool           `json:"strict"`
				}
				param := fmt.Sprintf("tools[%d].tools[%d]", index, nestedIndex)
				if err := json.Unmarshal(nestedEncoded, &nested); err != nil {
					return nil, nil, nil, invalidParam(param, "invalid namespaced tool")
				}
				if nested.Type != "function" {
					filteredTypes[normalizedFilteredToolType(nested.Type)] = struct{}{}
					continue
				}
				function, err := convertFunctionTool(
					nested.Name,
					namespacedToolDescription(tool.Description, nested.Description),
					nested.Parameters,
					nested.Strict,
					param,
				)
				if err != nil {
					return nil, nil, nil, err
				}
				responseName := function["name"].(string)
				identityKey := namespace + "\x00" + responseName
				if _, exists := seenIdentities[identityKey]; exists {
					return nil, nil, nil, invalidParam(
						param+".name",
						fmt.Sprintf("function tool name %q is duplicated within namespace %q", responseName, namespace),
					)
				}
				seenIdentities[identityKey] = struct{}{}
				chatName := flattenedChatToolName(namespace, responseName, seenNames)
				function["name"] = chatName
				seenNames[chatName] = struct{}{}
				toolMap[chatName] = responseToolIdentity{Name: responseName, Namespace: namespace}
				result = append(result, map[string]any{"type": "function", "function": function})
			}
		default:
			// A Responses tool entry is an availability declaration, not a
			// call. Intersect declarations with the set this Chat adapter can
			// represent so newly advertised hosted tools do not break ordinary
			// turns. Explicit choices and call/output history are validated
			// separately and remain fail-closed.
			filteredTypes[normalizedFilteredToolType(tool.Type)] = struct{}{}
		}
	}
	filtered := make([]string, 0, len(filteredTypes))
	for toolType := range filteredTypes {
		filtered = append(filtered, toolType)
	}
	sort.Strings(filtered)
	return result, toolMap, filtered, nil
}

func chatNameForResponseTool(namespace string, name string, toolMap responseToolMap) string {
	namespace = strings.TrimSpace(namespace)
	name = strings.TrimSpace(name)
	for chatName, identity := range toolMap {
		if identity.Name == name && identity.Namespace == namespace {
			return chatName
		}
	}
	return name
}

func convertFunctionTool(
	name string,
	description string,
	encodedParameters json.RawMessage,
	strict *bool,
	param string,
) (map[string]any, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, invalidParam(param+".name", "function tool name is required")
	}
	function := map[string]any{"name": name}
	if description != "" {
		function["description"] = description
	}
	if len(bytes.TrimSpace(encodedParameters)) > 0 &&
		!bytes.Equal(bytes.TrimSpace(encodedParameters), []byte("null")) {
		var parameters any
		if err := json.Unmarshal(encodedParameters, &parameters); err != nil {
			return nil, invalidParam(param+".parameters", "function parameters must be valid JSON")
		}
		function["parameters"] = parameters
	}
	if strict != nil {
		function["strict"] = *strict
	}
	return function, nil
}

func convertResponseToolChoice(encoded json.RawMessage, toolMap responseToolMap, toolCount int) (any, error) {
	trimmed := bytes.TrimSpace(encoded)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil, nil
	}
	var value string
	if err := json.Unmarshal(trimmed, &value); err == nil {
		switch value {
		case "auto", "none":
			return value, nil
		case "required":
			if toolCount == 0 {
				return nil, invalidParam("tool_choice", "required tool_choice has no translatable tools")
			}
			return value, nil
		default:
			return nil, invalidParam("tool_choice", fmt.Sprintf("unsupported tool_choice %q", value))
		}
	}
	var choice struct {
		Type      string `json:"type"`
		Name      string `json:"name"`
		Namespace string `json:"namespace"`
	}
	if err := json.Unmarshal(trimmed, &choice); err != nil {
		return nil, invalidParam("tool_choice", "named tool_choice must be a valid object")
	}
	if choice.Type != "function" {
		return nil, invalidParam(
			"tool_choice",
			fmt.Sprintf("tool_choice type %q cannot be translated to Chat Completions", choice.Type),
		)
	}
	if strings.TrimSpace(choice.Name) == "" {
		return nil, invalidParam("tool_choice", "named function tool_choice requires a name")
	}
	chatName, found := responseToolChatName(choice.Namespace, choice.Name, toolMap)
	if !found {
		return nil, invalidParam("tool_choice", fmt.Sprintf("selected function tool %q is not registered", choice.Name))
	}
	return map[string]any{
		"type": "function",
		"function": map[string]any{
			"name": chatName,
		},
	}, nil
}

func responseToolChatName(namespace string, name string, toolMap responseToolMap) (string, bool) {
	namespace = strings.TrimSpace(namespace)
	name = strings.TrimSpace(name)
	for chatName, identity := range toolMap {
		if identity.Name == name && identity.Namespace == namespace {
			return chatName, true
		}
	}
	return "", false
}
