// Frozen title helpers preserve the historical migration transform without
// making store-sqlite depend on the Host application layer. Live title
// derivation belongs exclusively to packages/agent/host.
package storesqlite

import (
	"strings"
	"unicode/utf8"

	canonical "github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

const maxMigratedSessionTitleRunes = 120

func normalizeMigratedSessionTitle(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}

	var output strings.Builder
	for index := 0; index < len(value); {
		labelStart, hrefStart, hrefEnd, ok := migratedTitleMarkdownLinkAt(value, index)
		if !ok {
			output.WriteByte(value[index])
			index++
			continue
		}
		output.WriteString(unescapeMigratedTitleMarkdownLabel(value[labelStart : hrefStart-2]))
		index = hrefEnd + 1
	}
	return strings.Join(strings.Fields(strings.TrimSpace(output.String())), " ")
}

func deriveMigratedSessionTitle(currentTitle string, visiblePrompt string) string {
	if strings.TrimSpace(currentTitle) != "" {
		return ""
	}
	title := normalizeMigratedSessionTitle(visiblePrompt)
	if title == "" {
		return ""
	}
	if utf8.RuneCountInString(title) <= maxMigratedSessionTitleRunes {
		return title
	}
	const suffix = "..."
	runes := []rune(title)
	suffixRunes := utf8.RuneCountInString(suffix)
	return strings.TrimSpace(string(runes[:maxMigratedSessionTitleRunes-suffixRunes])) + suffix
}

func isLegacyMigratedSessionTitlePlaceholder(value string, provider string, targetAliases ...string) bool {
	title := normalizeMigratedTitleIdentity(value)
	provider = normalizeMigratedTitleIdentity(provider)
	if title == "" || title == provider {
		return true
	}
	for _, candidate := range targetAliases {
		if title == normalizeMigratedTitleIdentity(candidate) {
			return true
		}
	}
	descriptor, ok := canonical.FindProviderIdentity(provider)
	if !ok {
		return false
	}
	for _, candidate := range append(
		[]string{descriptor.ID, descriptor.DisplayName},
		descriptor.Aliases...,
	) {
		if title == normalizeMigratedTitleIdentity(candidate) {
			return true
		}
	}
	return false
}

func normalizeMigratedTitleIdentity(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func migratedTitleMarkdownLinkAt(value string, start int) (labelStart, hrefStart, hrefEnd int, ok bool) {
	if start >= len(value) || value[start] != '[' {
		return 0, 0, 0, false
	}
	labelEnd := findMigratedTitleUnescaped(value, start+1, ']')
	if labelEnd < 0 || labelEnd+1 >= len(value) || value[labelEnd+1] != '(' {
		return 0, 0, 0, false
	}
	hrefEnd = findMigratedTitleBalancedHrefEnd(value, labelEnd+2)
	if hrefEnd < 0 {
		return 0, 0, 0, false
	}
	return start + 1, labelEnd + 2, hrefEnd, true
}

func findMigratedTitleUnescaped(value string, start int, target byte) int {
	escaped := false
	for index := start; index < len(value); index++ {
		if escaped {
			escaped = false
			continue
		}
		if value[index] == '\\' {
			escaped = true
			continue
		}
		if value[index] == target {
			return index
		}
	}
	return -1
}

func findMigratedTitleBalancedHrefEnd(value string, start int) int {
	depth := 0
	escaped := false
	for index := start; index < len(value); index++ {
		if escaped {
			escaped = false
			continue
		}
		switch value[index] {
		case '\\':
			escaped = true
		case '(':
			depth++
		case ')':
			if depth == 0 {
				return index
			}
			depth--
		}
	}
	return -1
}

func unescapeMigratedTitleMarkdownLabel(value string) string {
	var output strings.Builder
	escaped := false
	for index := 0; index < len(value); index++ {
		char := value[index]
		if escaped {
			if strings.ContainsRune(`\\[]()`, rune(char)) {
				output.WriteByte(char)
			} else {
				output.WriteByte('\\')
				output.WriteByte(char)
			}
			escaped = false
			continue
		}
		if char == '\\' {
			escaped = true
			continue
		}
		output.WriteByte(char)
	}
	if escaped {
		output.WriteByte('\\')
	}
	return output.String()
}
