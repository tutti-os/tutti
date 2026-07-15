package workspacefiles

import (
	"sort"
	"strings"
)

func orderedTokenMatch(target string, tokens []string) (int, int, []int, bool) {
	if len(tokens) == 0 {
		return 0, 0, nil, false
	}
	cursor := 0
	first := -1
	last := -1
	indices := make([]int, 0, len(target))
	for _, token := range tokens {
		index := strings.Index(target[cursor:], token)
		if index < 0 {
			return 0, 0, nil, false
		}
		position := cursor + index
		if first < 0 {
			first = position
		}
		last = position + len(token)
		for tokenIndex := 0; tokenIndex < len(token); tokenIndex++ {
			indices = append(indices, position+tokenIndex)
		}
		cursor = last
	}
	return first, last - first, indices, true
}

func subsequenceMatch(target string, query string) (int, int, int, []int, bool) {
	if query == "" {
		return 0, 0, 0, nil, false
	}
	first := -1
	last := -1
	previous := -1
	gaps := 0
	queryIndex := 0
	indices := make([]int, 0, len(query))
	for targetIndex := 0; targetIndex < len(target) && queryIndex < len(query); targetIndex++ {
		if target[targetIndex] != query[queryIndex] {
			continue
		}
		if first < 0 {
			first = targetIndex
		}
		if previous >= 0 {
			gaps += targetIndex - previous - 1
		}
		previous = targetIndex
		last = targetIndex
		indices = append(indices, targetIndex)
		queryIndex++
	}
	if queryIndex != len(query) {
		return 0, 0, 0, nil, false
	}
	return first, (last - first) + 1, gaps, indices, true
}

func pathIndicesForSegment(segments []string, segmentIndex int, segmentIndices []int) []int {
	offset := 0
	for index := 0; index < segmentIndex; index++ {
		offset += len(segments[index]) + 1
	}

	result := make([]int, 0, len(segmentIndices))
	for _, matchIndex := range segmentIndices {
		result = append(result, offset+matchIndex)
	}
	return result
}

func compactSortedIndices(indices []int) []int {
	if len(indices) == 0 {
		return []int{}
	}

	sort.Ints(indices)
	result := indices[:0]
	for _, index := range indices {
		if len(result) > 0 && result[len(result)-1] == index {
			continue
		}
		result = append(result, index)
	}
	return append([]int(nil), result...)
}
