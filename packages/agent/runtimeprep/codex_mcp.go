package runtimeprep

import (
	"sort"
	"strconv"
	"strings"
)

func codexConfigWithConnectorMCP(content string, bindings []MCPServerBinding) (string, bool) {
	var connector *MCPServerBinding
	for index := range bindings {
		if strings.TrimSpace(bindings[index].Name) == "connector" && strings.TrimSpace(bindings[index].Type) == "http" && strings.TrimSpace(bindings[index].URL) != "" {
			copy := bindings[index]
			connector = &copy
			break
		}
	}
	normalized := strings.ReplaceAll(content, "\r\n", "\n")
	lines := strings.Split(normalized, "\n")
	filtered := make([]string, 0, len(lines))
	for index := 0; index < len(lines); {
		if strings.TrimSpace(lines[index]) != "[mcp_servers.connector]" {
			filtered = append(filtered, lines[index])
			index++
			continue
		}
		index++
		for index < len(lines) {
			trimmed := strings.TrimSpace(lines[index])
			if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
				break
			}
			index++
		}
	}
	base := strings.TrimRight(strings.Join(filtered, "\n"), "\n")
	if connector != nil {
		var block strings.Builder
		block.WriteString("[mcp_servers.connector]\nurl = ")
		block.WriteString(strconv.Quote(strings.TrimSpace(connector.URL)))
		block.WriteByte('\n')
		if len(connector.Headers) > 0 {
			names := make([]string, 0, len(connector.Headers))
			for name := range connector.Headers {
				names = append(names, name)
			}
			sort.Strings(names)
			block.WriteString("http_headers = { ")
			for index, name := range names {
				if index > 0 {
					block.WriteString(", ")
				}
				block.WriteString(strconv.Quote(name))
				block.WriteString(" = ")
				block.WriteString(strconv.Quote(connector.Headers[name]))
			}
			block.WriteString(" }\n")
		}
		if base != "" {
			base += "\n\n"
		}
		base += block.String()
	}
	return base, base != content
}
