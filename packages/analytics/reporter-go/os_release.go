package reporter

import (
	"strconv"
	"strings"
)

func osReleaseVersion(content string) string {
	for line := range strings.SplitSeq(content, "\n") {
		key, value, found := strings.Cut(line, "=")
		if !found || strings.TrimSpace(key) != "VERSION_ID" {
			continue
		}
		value = strings.TrimSpace(value)
		if len(value) >= 2 && value[0] == '\'' && value[len(value)-1] == '\'' {
			value = value[1 : len(value)-1]
		} else if unquoted, err := strconv.Unquote(value); err == nil {
			value = unquoted
		}
		return strings.TrimSpace(value)
	}
	return ""
}
