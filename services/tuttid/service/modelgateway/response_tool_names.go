package modelgateway

import (
	"crypto/sha256"
	"fmt"
	"strings"
)

func normalizedFilteredToolType(toolType string) string {
	toolType = strings.TrimSpace(toolType)
	if toolType == "" {
		return "<missing>"
	}
	if len(toolType) <= 64 {
		valid := true
		for index, character := range toolType {
			if (character >= 'a' && character <= 'z') ||
				(index > 0 && character >= '0' && character <= '9') ||
				(index > 0 && character == '_') {
				continue
			}
			valid = false
			break
		}
		if valid {
			return toolType
		}
	}
	hash := fmt.Sprintf("%x", sha256.Sum256([]byte(toolType)))[:12]
	return "<invalid:" + hash + ">"
}

func namespacedToolDescription(namespaceDescription string, toolDescription string) string {
	namespaceDescription = strings.TrimSpace(namespaceDescription)
	toolDescription = strings.TrimSpace(toolDescription)
	switch {
	case namespaceDescription == "":
		return toolDescription
	case toolDescription == "":
		return namespaceDescription
	default:
		return namespaceDescription + "\n\n" + toolDescription
	}
}

func flattenedChatToolName(namespace string, name string, used map[string]struct{}) string {
	base := sanitizeChatToolName(namespace) + "__" + sanitizeChatToolName(name)
	if len(base) <= 64 {
		if _, exists := used[base]; !exists {
			return base
		}
	}
	hash := fmt.Sprintf("%x", sha256.Sum256([]byte(namespace+"\x00"+name)))[:16]
	suffix := sanitizeChatToolName(name)
	maxSuffix := 64 - len("tutti_"+hash+"_")
	if len(suffix) > maxSuffix {
		suffix = suffix[:maxSuffix]
	}
	candidate := "tutti_" + hash + "_" + suffix
	if _, exists := used[candidate]; !exists {
		return candidate
	}
	for sequence := 2; ; sequence++ {
		numbered := fmt.Sprintf("tutti_%s_%d", hash, sequence)
		if _, exists := used[numbered]; !exists {
			return numbered
		}
	}
}

func sanitizeChatToolName(value string) string {
	var result strings.Builder
	for _, character := range strings.TrimSpace(value) {
		switch {
		case character >= 'a' && character <= 'z',
			character >= 'A' && character <= 'Z',
			character >= '0' && character <= '9',
			character == '_',
			character == '-':
			result.WriteRune(character)
		default:
			result.WriteByte('_')
		}
	}
	if result.Len() == 0 {
		return "tool"
	}
	return result.String()
}
