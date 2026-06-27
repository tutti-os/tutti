package workspacefiles

import (
	"fmt"
	"path"
	"sort"
	"strings"
)

const (
	DefaultSearchLimit = 30
	// 引用 picker 的搜索/筛选结果支持「拉到底部增长式分页」,单次 limit 可增长到此上限。
	MaxSearchLimit = 200

	DefaultRecentLimit = 30
	MaxRecentLimit     = 100

	searchDepthPenalty         = 120
	searchHiddenSegmentPenalty = 8000
	searchNoiseSegmentPenalty  = 16000
)

var searchNoiseSegments = map[string]struct{}{
	".agents":      {},
	".cache":       {},
	".codex":       {},
	".git":         {},
	".local":       {},
	".next":        {},
	".npm":         {},
	".pnpm-store":  {},
	".turbo":       {},
	"applications": {},
	"build":        {},
	"dist":         {},
	"library":      {},
	"node_modules": {},
}

type normalizedSearchTerm struct {
	normalized string
	compact    string
	tokens     []string
}

type normalizedSearchQuery struct {
	term          normalizedSearchTerm
	hasPathIntent bool
	pathTerms     []normalizedSearchTerm
	trailingSlash bool
}

type searchCandidateContext struct {
	basename       string
	depth          int
	hiddenSegments int
	kind           EntryKind
	noiseSegments  int
	relativePath   string
	segments       []string
	stem           string
}

type scoredSearchMatch struct {
	indices []int
	score   int
	target  SearchMatchTarget
}

type textMatchResult struct {
	indices []int
	score   int
}

func NormalizeSearchLimit(limit int) int {
	if limit <= 0 {
		return DefaultSearchLimit
	}
	if limit > MaxSearchLimit {
		return MaxSearchLimit
	}
	return limit
}

func NormalizeRecentLimit(limit int) int {
	if limit <= 0 {
		return DefaultRecentLimit
	}
	if limit > MaxRecentLimit {
		return MaxRecentLimit
	}
	return limit
}

// NormalizeSearchFilters trims、去重、丢弃空白的「文件类型筛选分类」id。
func NormalizeSearchFilters(filters []string) []string {
	if len(filters) == 0 {
		return nil
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(filters))
	for _, filter := range filters {
		filter = strings.TrimSpace(filter)
		if filter == "" || seen[filter] {
			continue
		}
		seen[filter] = true
		out = append(out, filter)
	}
	return out
}

// BuildListingEntries 从已过滤的 candidates 直接构造结果(不做关键词打分),供「仅按类型
// 筛选、无关键词」的枚举用:按名称、再按路径稳定排序,截断到 limit。category 过滤由调用方
// (data 层 walk)先行完成,本函数对传入 candidates 不再二次过滤。
func BuildListingEntries(root LogicalPath, candidates []SearchCandidate, limit int) []SearchEntry {
	limit = NormalizeSearchLimit(limit)
	entries := make([]SearchEntry, 0, len(candidates))
	for _, candidate := range candidates {
		relativePath := normalizeCandidateRelativePath(candidate.RelativePath)
		if relativePath == "" {
			continue
		}
		if candidate.Kind != EntryKindFile && candidate.Kind != EntryKindDirectory {
			continue
		}
		logicalPath := LogicalPath(path.Join(root.String(), relativePath))
		entries = append(entries, SearchEntry{
			Path:          logicalPath,
			Name:          path.Base(relativePath),
			Kind:          candidate.Kind,
			DirectoryPath: LogicalPathDir(logicalPath),
			MatchIndices:  []int{},
			MatchTarget:   SearchMatchTargetBasename,
			Score:         0,
		})
	}
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].Name != entries[j].Name {
			return entries[i].Name < entries[j].Name
		}
		return entries[i].Path < entries[j].Path
	})
	if len(entries) > limit {
		entries = entries[:limit]
	}
	return entries
}

func NormalizeSearchKinds(kinds []EntryKind) ([]EntryKind, error) {
	if len(kinds) == 0 {
		return []EntryKind{EntryKindFile, EntryKindDirectory}, nil
	}
	seen := map[EntryKind]bool{}
	result := make([]EntryKind, 0, len(kinds))
	for _, kind := range kinds {
		if kind != EntryKindFile && kind != EntryKindDirectory {
			return nil, fmt.Errorf("%w: %q", ErrInvalidEntryKind, kind)
		}
		if seen[kind] {
			continue
		}
		seen[kind] = true
		result = append(result, kind)
	}
	if len(result) == 0 {
		return []EntryKind{EntryKindFile, EntryKindDirectory}, nil
	}
	return result, nil
}

func ScoreSearchCandidates(root LogicalPath, query string, candidates []SearchCandidate, limit int) []SearchEntry {
	normalizedQuery := normalizeSearchQuery(query)
	if normalizedQuery.term.normalized == "" {
		return []SearchEntry{}
	}

	limit = NormalizeSearchLimit(limit)
	type scoredEntry struct {
		entry SearchEntry
		score int
	}
	scored := make([]scoredEntry, 0, len(candidates))
	for _, candidate := range candidates {
		relativePath := normalizeCandidateRelativePath(candidate.RelativePath)
		if relativePath == "" {
			continue
		}
		if candidate.Kind != EntryKindFile && candidate.Kind != EntryKindDirectory {
			continue
		}
		match, ok := scoreSearchCandidate(normalizedQuery, SearchCandidate{
			Kind:         candidate.Kind,
			RelativePath: relativePath,
		})
		if !ok {
			continue
		}
		logicalPath := LogicalPath(path.Join(root.String(), relativePath))
		scored = append(scored, scoredEntry{
			score: match.score,
			entry: SearchEntry{
				Path:          logicalPath,
				Name:          path.Base(relativePath),
				Kind:          candidate.Kind,
				DirectoryPath: LogicalPathDir(logicalPath),
				MatchIndices:  match.indices,
				MatchTarget:   match.target,
				Score:         match.score,
			},
		})
	}

	sort.SliceStable(scored, func(i, j int) bool {
		if scored[i].score != scored[j].score {
			return scored[i].score > scored[j].score
		}
		if scored[i].entry.Name != scored[j].entry.Name {
			return scored[i].entry.Name < scored[j].entry.Name
		}
		return scored[i].entry.Path < scored[j].entry.Path
	})
	if len(scored) > limit {
		scored = scored[:limit]
	}
	entries := make([]SearchEntry, len(scored))
	for index := range scored {
		entries[index] = scored[index].entry
	}
	return entries
}

func normalizeSearchQuery(query string) normalizedSearchQuery {
	normalizedPath := strings.ToLower(strings.TrimSpace(strings.ReplaceAll(query, "\\", "/")))
	term := normalizeSearchTerm(strings.ReplaceAll(normalizedPath, "/", " "))
	pathTerms := make([]normalizedSearchTerm, 0, strings.Count(normalizedPath, "/")+1)
	for _, part := range strings.Split(normalizedPath, "/") {
		termPart := normalizeSearchTerm(part)
		if termPart.normalized == "" {
			continue
		}
		pathTerms = append(pathTerms, termPart)
	}
	return normalizedSearchQuery{
		term:          term,
		hasPathIntent: strings.Contains(normalizedPath, "/"),
		pathTerms:     pathTerms,
		trailingSlash: strings.HasSuffix(normalizedPath, "/"),
	}
}

func scoreSearchCandidate(query normalizedSearchQuery, candidate SearchCandidate) (scoredSearchMatch, bool) {
	context := createSearchCandidateContext(candidate)

	var match scoredSearchMatch
	var ok bool
	match, ok = scoreFilenameCandidate(query.term, context)
	if !ok {
		return scoredSearchMatch{}, false
	}
	match.score = applySearchPenalties(query, context, match.score)
	match.indices = compactSortedIndices(match.indices)
	return match, true
}

func createSearchCandidateContext(candidate SearchCandidate) searchCandidateContext {
	normalizedPath := strings.ToLower(candidate.RelativePath)
	segments := strings.Split(normalizedPath, "/")
	hiddenSegments := 0
	noiseSegments := 0
	for _, segment := range segments {
		if strings.HasPrefix(segment, ".") {
			hiddenSegments++
		}
		if _, ok := searchNoiseSegments[segment]; ok {
			noiseSegments++
		}
	}

	basename := path.Base(normalizedPath)
	stem := trimSearchStem(basename)
	return searchCandidateContext{
		basename:       basename,
		depth:          strings.Count(normalizedPath, "/"),
		hiddenSegments: hiddenSegments,
		kind:           candidate.Kind,
		noiseSegments:  noiseSegments,
		relativePath:   normalizedPath,
		segments:       segments,
		stem:           stem,
	}
}

func trimSearchStem(value string) string {
	stem := strings.TrimSuffix(value, path.Ext(value))
	if stem == "" {
		return value
	}
	return stem
}

func scoreFilenameCandidate(term normalizedSearchTerm, candidate searchCandidateContext) (scoredSearchMatch, bool) {
	if isDotLiteralSearchTerm(term) {
		return scoreDotLiteralFilenameCandidate(term.tokens[0], candidate)
	}
	if !candidateContainsFilenameDotLiteralTokens(term, candidate) {
		return scoredSearchMatch{}, false
	}

	best := scoredSearchMatch{}
	bestOk := false

	if result, ok := scoreTextMatch(term, candidate.stem, 1000000, 930000, 60000); ok {
		best = scoredSearchMatch{
			indices: result.indices,
			score:   result.score,
			target:  SearchMatchTargetBasename,
		}
		bestOk = true
	}
	if candidate.basename != candidate.stem {
		if result, ok := scoreTextMatch(term, candidate.basename, 970000, 900000, 45000); ok && (!bestOk || result.score > best.score) {
			best = scoredSearchMatch{
				indices: result.indices,
				score:   result.score,
				target:  SearchMatchTargetBasename,
			}
			bestOk = true
		}
	}

	return best, bestOk
}

func scoreDotLiteralFilenameCandidate(literal string, candidate searchCandidateContext) (scoredSearchMatch, bool) {
	index := strings.Index(candidate.basename, literal)
	if index < 0 {
		return scoredSearchMatch{}, false
	}

	score := 980000 - (index * 1000) - len(candidate.basename)
	if strings.HasSuffix(candidate.basename, literal) {
		score += 30000
	}
	if candidate.basename == literal {
		score += 60000
	}
	if index == 0 {
		score += 15000
	}

	indices := make([]int, 0, len(literal))
	for offset := 0; offset < len(literal); offset++ {
		indices = append(indices, index+offset)
	}
	return scoredSearchMatch{
		indices: indices,
		score:   score,
		target:  SearchMatchTargetBasename,
	}, true
}

func scoreTextMatch(term normalizedSearchTerm, target string, orderedBase int, subsequenceBase int, prefixBonus int) (textMatchResult, bool) {
	if term.normalized == "" || target == "" {
		return textMatchResult{}, false
	}

	best := textMatchResult{}
	bestOk := false
	if start, span, indices, ok := orderedTokenMatch(target, term.tokens); ok {
		score := orderedBase - (start * 1200) - (span * 25) - len(target)
		if start == 0 {
			score += prefixBonus
		}
		if term.normalized == target || term.compact == target {
			score += prefixBonus / 2
		}
		if span == len(target) {
			score += prefixBonus / 3
		}
		best = textMatchResult{
			indices: indices,
			score:   score,
		}
		bestOk = true
	}
	if start, span, gaps, indices, ok := subsequenceMatch(target, term.compact); ok {
		score := subsequenceBase - (start * 1000) - (gaps * 160) - (span * 35) - len(target)
		if start == 0 {
			score += prefixBonus / 2
		}
		if !bestOk || score > best.score {
			best = textMatchResult{
				indices: indices,
				score:   score,
			}
			bestOk = true
		}
	}
	return best, bestOk
}

func applySearchPenalties(query normalizedSearchQuery, candidate searchCandidateContext, score int) int {
	hiddenPenalty := candidate.hiddenSegments * searchHiddenSegmentPenalty
	noisePenalty := candidate.noiseSegments * searchNoiseSegmentPenalty
	if searchQueryTargetsHiddenOrNoise(query) {
		hiddenPenalty /= 4
		noisePenalty /= 4
	}
	score -= candidate.depth * searchDepthPenalty
	score -= hiddenPenalty
	score -= noisePenalty
	return score
}

func searchQueryTargetsHiddenOrNoise(query normalizedSearchQuery) bool {
	return searchQueryTargetsHiddenOrNoiseDirectory(query)
}

func searchQueryTargetsHiddenOrNoiseDirectory(query normalizedSearchQuery) bool {
	for _, token := range query.term.tokens {
		if _, ok := searchNoiseSegments[token]; ok {
			return true
		}
	}
	if query.hasPathIntent {
		for index, pathTerm := range query.pathTerms {
			if !searchPathTermTargetsHiddenOrNoiseDirectory(pathTerm, index, query) {
				continue
			}
			for _, token := range pathTerm.tokens {
				if isDotLiteralToken(token) {
					return true
				}
			}
		}
	}
	return false
}

func searchPathTermTargetsHiddenOrNoiseDirectory(term normalizedSearchTerm, index int, query normalizedSearchQuery) bool {
	if term.normalized == "" {
		return false
	}
	if index < len(query.pathTerms)-1 {
		return true
	}
	return query.trailingSlash
}

func SearchQueryTargetsHiddenOrNoise(query string) bool {
	return searchQueryTargetsHiddenOrNoise(normalizeSearchQuery(query))
}

func SearchQueryTargetsHiddenFile(query string) bool {
	normalizedQuery := normalizeSearchQuery(query)
	for _, token := range normalizedQuery.term.tokens {
		if isDotLiteralToken(token) {
			return true
		}
	}
	return false
}

func normalizeSearchTerm(value string) normalizedSearchTerm {
	tokens := strings.Fields(strings.ToLower(strings.TrimSpace(value)))
	return normalizedSearchTerm{
		normalized: strings.Join(tokens, " "),
		compact:    strings.Join(tokens, ""),
		tokens:     tokens,
	}
}

func isDotLiteralSearchTerm(term normalizedSearchTerm) bool {
	return len(term.tokens) == 1 && isDotLiteralToken(term.tokens[0])
}

func isDotLiteralToken(token string) bool {
	return len(token) > 1 && strings.HasPrefix(token, ".")
}

func candidateContainsFilenameDotLiteralTokens(term normalizedSearchTerm, candidate searchCandidateContext) bool {
	for _, token := range term.tokens {
		if !isFilenameDotLiteralToken(token) {
			continue
		}
		if !strings.Contains(candidate.basename, token) {
			return false
		}
	}
	return true
}

func isFilenameDotLiteralToken(token string) bool {
	if !isDotLiteralToken(token) {
		return false
	}
	_, isNoiseSegment := searchNoiseSegments[token]
	return !isNoiseSegment
}

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

func normalizeCandidateRelativePath(value string) string {
	value = strings.TrimSpace(strings.ReplaceAll(value, "\\", "/"))
	value = strings.TrimPrefix(value, "./")
	value = strings.TrimSuffix(value, "/")
	if value == "" {
		return ""
	}
	cleaned := path.Clean(value)
	if cleaned == "." || cleaned == "/" || cleaned == ".." || strings.HasPrefix(cleaned, "/") || strings.HasPrefix(cleaned, "../") {
		return ""
	}
	return cleaned
}
