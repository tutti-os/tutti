package runtimeprep

import "strings"

// Consume a complete multiline TOML assignment so replacing one session
// setting cannot leave continuation lines from the previous value behind.
func codexConfigAssignmentEndLine(lines []string, startIndex int) int {
	if startIndex < 0 || startIndex >= len(lines) {
		return startIndex
	}
	_, value, ok := strings.Cut(lines[startIndex], "=")
	if !ok {
		return startIndex
	}
	trimmedValue := strings.TrimSpace(value)
	for _, delimiter := range []string{`"""`, `'''`} {
		if !strings.HasPrefix(trimmedValue, delimiter) {
			continue
		}
		if strings.Contains(strings.TrimPrefix(trimmedValue, delimiter), delimiter) {
			return startIndex
		}
		for index := startIndex + 1; index < len(lines); index++ {
			if strings.Contains(lines[index], delimiter) {
				return index
			}
		}
		return startIndex
	}
	depth := tomlSquareBracketDelta(value) + tomlCurlyBracketDelta(value)
	if depth <= 0 {
		return startIndex
	}
	for index := startIndex + 1; index < len(lines); index++ {
		depth += tomlSquareBracketDelta(lines[index]) + tomlCurlyBracketDelta(lines[index])
		if depth <= 0 {
			return index
		}
	}
	return startIndex
}

func tomlCurlyBracketDelta(line string) int {
	return tomlBracketDelta(line, '{', '}')
}

func tomlSquareBracketDelta(line string) int {
	return tomlBracketDelta(line, '[', ']')
}

func tomlBracketDelta(line string, open rune, close rune) int {
	depth := 0
	escaped := false
	quote := rune(0)
	for _, char := range line {
		switch quote {
		case '"':
			if escaped {
				escaped = false
				continue
			}
			if char == '\\' {
				escaped = true
				continue
			}
			if char == '"' {
				quote = 0
			}
			continue
		case '\'':
			if char == '\'' {
				quote = 0
			}
			continue
		}
		switch char {
		case '#':
			return depth
		case '"', '\'':
			quote = char
		case open:
			depth++
		case close:
			depth--
		}
	}
	return depth
}
