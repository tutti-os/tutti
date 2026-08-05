package agent

import (
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	agenthost "github.com/tutti-os/tutti/packages/agent/host"
)

const (
	legacyBrowserUsePromptPrefix  = "Use the injected browser-use skill and only the tutti browser CLI. Do not use any other browser skill, CDP scripts, or direct browser automation."
	legacyComputerUsePromptPrefix = "Use the injected computer-use skill and only the tutti computer CLI. Do not use any other computer-use skill, accessibility script, or direct desktop automation."
)

// codexNativeTurnCapability is a narrow product-policy translation. It runs
// only after the service has selected Codex, and hands the Host a semantic
// request rather than a plugin path. The runtime owns the final current-thread
// check and the official App Server mention.
func codexNativeTurnCapability(provider string, content []PromptContentBlock) ([]PromptContentBlock, *agenthost.TurnCapabilityInvocation) {
	if !providerregistry.SupportsNativePluginTurn(provider) || len(content) == 0 {
		return content, nil
	}
	for index, block := range content {
		if strings.TrimSpace(block.Type) != "text" {
			continue
		}
		semantic, task, ok := parseCodexNativeCapabilityInvocation(block.Text)
		if !ok {
			return content, nil
		}
		translated := append([]PromptContentBlock(nil), content...)
		translated[index].Text = task
		return translated, &agenthost.TurnCapabilityInvocation{Semantic: semantic}
	}
	return content, nil
}

func parseCodexNativeCapabilityInvocation(text string) (semantic, task string, ok bool) {
	if semantic, task, ok = parseCodexNativeCapabilitySlash(text); ok {
		return semantic, task, true
	}
	return parseLegacyTuttiCapabilityPrompt(text)
}

func parseCodexNativeCapabilitySlash(text string) (semantic, task string, ok bool) {
	text = strings.TrimSpace(text)
	if !strings.HasPrefix(text, "/") {
		return "", "", false
	}
	separator := strings.IndexAny(text, " \t\r\n")
	if separator < 0 {
		return "", "", false
	}
	semantic = strings.TrimPrefix(text[:separator], "/")
	task = strings.TrimSpace(text[separator:])
	if task == "" {
		return "", "", false
	}
	switch semantic {
	case "browser", "computer", "sites":
		return semantic, task, true
	default:
		return "", "", false
	}
}

func parseLegacyTuttiCapabilityPrompt(text string) (semantic, task string, ok bool) {
	text = strings.TrimSpace(text)
	for _, candidate := range []struct {
		prefix   string
		semantic string
	}{
		{prefix: legacyBrowserUsePromptPrefix, semantic: "browser"},
		{prefix: legacyComputerUsePromptPrefix, semantic: "computer"},
	} {
		if !strings.HasPrefix(text, candidate.prefix) {
			continue
		}
		task = strings.TrimSpace(strings.TrimPrefix(text, candidate.prefix))
		if task == "" {
			return "", "", false
		}
		return candidate.semantic, task, true
	}
	return "", "", false
}
