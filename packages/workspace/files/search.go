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

	// Ranking compares the discrete match tier before fuzzy quality. The
	// transport score encodes that tuple only after ordering has been decided.
	searchRankScoreStep  = 1_000_000
	searchRankQualityMax = searchRankScoreStep - 1
	searchRankTierCount  = 8
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
	outsideRoot   bool
	path          string
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
	quality int
	target  SearchMatchTarget
	tier    int
}

type textMatchResult struct {
	indices []int
	quality int
	kind    textMatchKind
}

type textMatchKind int

const (
	textMatchExact textMatchKind = iota
	textMatchPrefix
	textMatchSubstring
	textMatchFuzzy
)

type pathSequenceChoice struct {
	indices          []int
	lastSegmentIndex int
	ok               bool
	quality          int
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
	normalizedQuery := normalizeSearchQuery(root, query)
	if normalizedQuery.outsideRoot || normalizedQuery.term.normalized == "" {
		return []SearchEntry{}
	}

	limit = NormalizeSearchLimit(limit)
	type scoredEntry struct {
		entry SearchEntry
		rank  scoredSearchMatch
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
		transportScore := searchScoreForRank(match)
		scored = append(scored, scoredEntry{
			rank: match,
			entry: SearchEntry{
				Path:          logicalPath,
				Name:          path.Base(relativePath),
				Kind:          candidate.Kind,
				DirectoryPath: LogicalPathDir(logicalPath),
				MatchIndices:  match.indices,
				MatchTarget:   match.target,
				Score:         transportScore,
			},
		})
	}

	sort.SliceStable(scored, func(i, j int) bool {
		if scored[i].rank.tier != scored[j].rank.tier {
			return scored[i].rank.tier < scored[j].rank.tier
		}
		if scored[i].rank.quality != scored[j].rank.quality {
			return scored[i].rank.quality > scored[j].rank.quality
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

func normalizeSearchQuery(root LogicalPath, query string) normalizedSearchQuery {
	normalizedPath := strings.ToLower(strings.TrimSpace(strings.ReplaceAll(query, "\\", "/")))
	if normalizedPath == "" {
		return normalizedSearchQuery{}
	}

	hasPathIntent := strings.Contains(normalizedPath, "/")
	trailingSlash := strings.HasSuffix(normalizedPath, "/")
	outsideRoot := false
	pathQuery := normalizedPath

	if strings.HasPrefix(pathQuery, "~/") {
		pathQuery = strings.TrimLeft(strings.TrimPrefix(pathQuery, "~/"), "/")
	} else if isAbsoluteSearchPath(pathQuery) {
		logicalRoot := strings.ToLower(NormalizeLogicalRoot(root.String()).String())
		canonicalQuery := canonicalAbsoluteSearchPath(pathQuery)
		if logicalRoot == "/" {
			pathQuery = strings.TrimPrefix(canonicalQuery, "/")
		} else if canonicalQuery == logicalRoot {
			pathQuery = ""
		} else if strings.HasPrefix(canonicalQuery, logicalRoot+"/") {
			pathQuery = strings.TrimPrefix(canonicalQuery, logicalRoot+"/")
		} else {
			outsideRoot = true
		}
	}

	pathQuery = path.Clean(pathQuery)
	if pathQuery == "." {
		pathQuery = ""
	} else if pathQuery == ".." || strings.HasPrefix(pathQuery, "../") {
		outsideRoot = true
	}
	pathQuery = strings.Trim(pathQuery, "/")
	term := normalizeSearchTerm(strings.ReplaceAll(pathQuery, "/", " "))
	pathTerms := make([]normalizedSearchTerm, 0, strings.Count(pathQuery, "/")+1)
	for _, part := range strings.Split(pathQuery, "/") {
		termPart := normalizeSearchTerm(part)
		if termPart.normalized == "" {
			continue
		}
		pathTerms = append(pathTerms, termPart)
	}
	return normalizedSearchQuery{
		term:          term,
		hasPathIntent: hasPathIntent,
		outsideRoot:   outsideRoot,
		path:          pathQuery,
		pathTerms:     pathTerms,
		trailingSlash: trailingSlash,
	}
}

func scoreSearchCandidate(query normalizedSearchQuery, candidate SearchCandidate) (scoredSearchMatch, bool) {
	context := createSearchCandidateContext(candidate)

	var match scoredSearchMatch
	var ok bool
	if query.hasPathIntent {
		match, ok = scorePathIntentCandidate(query, context)
	} else {
		match, ok = scoreNameIntentCandidate(query, context)
	}
	if !ok {
		return scoredSearchMatch{}, false
	}
	match.quality = applySearchPenalties(query, context, match.quality)
	match.indices = compactSortedIndices(match.indices)
	return match, true
}

func searchScoreForRank(match scoredSearchMatch) int {
	quality := match.quality
	if quality < 0 {
		quality = 0
	}
	if quality > searchRankQualityMax {
		quality = searchRankQualityMax
	}
	tierWeight := searchRankTierCount - match.tier
	if tierWeight < 0 {
		tierWeight = 0
	}
	return tierWeight*searchRankScoreStep + quality
}

func isAbsoluteSearchPath(value string) bool {
	return strings.HasPrefix(value, "/") || isWindowsAbsoluteSearchPath(value)
}

func isWindowsAbsoluteSearchPath(value string) bool {
	return len(value) >= 3 && value[1] == ':' && value[2] == '/'
}

func canonicalAbsoluteSearchPath(value string) string {
	if isWindowsAbsoluteSearchPath(value) {
		value = "/" + value
	}
	return path.Clean(value)
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

func scoreNameIntentCandidate(query normalizedSearchQuery, candidate searchCandidateContext) (scoredSearchMatch, bool) {
	if match, ok := scoreFilenameCandidate(query.term, candidate); ok {
		return match, true
	}
	if searchTermContainsFilenameDotLiteral(query.term) {
		return scoredSearchMatch{}, false
	}

	match, ok := scoreBestParentPathSegment(query.term, candidate)
	if !ok {
		return scoredSearchMatch{}, false
	}
	switch textMatchKind(match.tier) {
	case textMatchExact:
		match.tier = 5
	case textMatchPrefix, textMatchSubstring:
		match.tier = 6
	default:
		match.tier = 7
	}
	return match, true
}

func scorePathIntentCandidate(query normalizedSearchQuery, candidate searchCandidateContext) (scoredSearchMatch, bool) {
	if query.path == "" {
		return scoredSearchMatch{}, false
	}
	if candidate.relativePath == query.path && (!query.trailingSlash || candidate.kind == EntryKindDirectory) {
		return scoredSearchMatch{
			indices: sequentialSearchIndices(len(query.path)),
			quality: searchRankQualityMax - len(candidate.relativePath),
			target:  SearchMatchTargetPath,
			tier:    0,
		}, true
	}
	if strings.HasPrefix(candidate.relativePath, query.path) &&
		(!query.trailingSlash || strings.HasPrefix(candidate.relativePath, query.path+"/")) {
		return scoredSearchMatch{
			indices: sequentialSearchIndices(len(query.path)),
			quality: searchRankQualityMax - len(candidate.relativePath),
			target:  SearchMatchTargetPath,
			tier:    1,
		}, true
	}
	if choice, ok := scorePathTermSequence(query.pathTerms, candidate.segments, query.trailingSlash); ok {
		if query.trailingSlash &&
			candidate.kind != EntryKindDirectory &&
			choice.lastSegmentIndex == len(candidate.segments)-1 {
			return scoredSearchMatch{}, false
		}
		return scoredSearchMatch{
			indices: choice.indices,
			quality: choice.quality / len(query.pathTerms),
			target:  SearchMatchTargetPath,
			tier:    2,
		}, true
	}
	if !query.trailingSlash {
		compactQuery := strings.ReplaceAll(query.path, "/", "")
		if start, span, gaps, indices, ok := subsequenceMatch(candidate.relativePath, compactQuery); ok {
			return scoredSearchMatch{
				indices: indices,
				quality: fuzzySearchQuality(start, span, gaps, len(candidate.relativePath)),
				target:  SearchMatchTargetPath,
				tier:    3,
			}, true
		}
	}
	return scoredSearchMatch{}, false
}

func scoreFilenameCandidate(term normalizedSearchTerm, candidate searchCandidateContext) (scoredSearchMatch, bool) {
	if !candidateContainsFilenameDotLiteralTokens(term, candidate) {
		return scoredSearchMatch{}, false
	}

	if searchTermEqualsTarget(term, candidate.basename) {
		return scoredSearchMatch{
			indices: sequentialSearchIndices(len(candidate.basename)),
			quality: searchRankQualityMax - len(candidate.basename),
			target:  SearchMatchTargetBasename,
			tier:    0,
		}, true
	}
	if candidate.basename != candidate.stem && searchTermEqualsTarget(term, candidate.stem) {
		return scoredSearchMatch{
			indices: sequentialSearchIndices(len(candidate.stem)),
			quality: searchRankQualityMax - len(candidate.basename),
			target:  SearchMatchTargetBasename,
			tier:    1,
		}, true
	}

	best := scoredSearchMatch{}
	bestOK := false
	for _, target := range []string{candidate.stem, candidate.basename} {
		result, ok := classifyTextMatch(term, target)
		if !ok || result.kind == textMatchExact {
			continue
		}
		tier := 4
		switch result.kind {
		case textMatchPrefix:
			tier = 2
		case textMatchSubstring:
			tier = 3
		case textMatchFuzzy:
			tier = 4
		}
		match := scoredSearchMatch{
			indices: result.indices,
			quality: result.quality,
			target:  SearchMatchTargetBasename,
			tier:    tier,
		}
		if !bestOK || match.tier < best.tier || (match.tier == best.tier && match.quality > best.quality) {
			best = match
			bestOK = true
		}
	}
	return best, bestOK
}

func scoreBestParentPathSegment(term normalizedSearchTerm, candidate searchCandidateContext) (scoredSearchMatch, bool) {
	if len(candidate.segments) <= 1 {
		return scoredSearchMatch{}, false
	}
	best := scoredSearchMatch{}
	bestOK := false
	for index, segment := range candidate.segments[:len(candidate.segments)-1] {
		result, ok := classifyTextMatch(term, segment)
		if !ok {
			continue
		}
		match := scoredSearchMatch{
			indices: pathIndicesForSegment(candidate.segments, index, result.indices),
			quality: result.quality - index*3000,
			target:  SearchMatchTargetPath,
			tier:    int(result.kind),
		}
		if !bestOK || match.tier < best.tier || (match.tier == best.tier && match.quality > best.quality) {
			best = match
			bestOK = true
		}
	}
	return best, bestOK
}

func scorePathTermSequence(terms []normalizedSearchTerm, segments []string, requireFinalExact bool) (pathSequenceChoice, bool) {
	if len(terms) == 0 {
		return pathSequenceChoice{}, false
	}
	memo := map[[2]int]pathSequenceChoice{}
	var visit func(termIndex int, segmentIndex int) pathSequenceChoice
	visit = func(termIndex int, segmentIndex int) pathSequenceChoice {
		if termIndex == len(terms) {
			return pathSequenceChoice{lastSegmentIndex: -1, ok: true}
		}
		key := [2]int{termIndex, segmentIndex}
		if cached, ok := memo[key]; ok {
			return cached
		}

		best := pathSequenceChoice{}
		for index := segmentIndex; index < len(segments); index++ {
			result, ok := scorePathSegmentTerm(
				terms[termIndex],
				segments[index],
				requireFinalExact && termIndex == len(terms)-1,
			)
			if !ok {
				continue
			}
			next := visit(termIndex+1, index+1)
			if !next.ok {
				continue
			}
			quality := result.quality + next.quality - (index-segmentIndex)*4000
			choice := pathSequenceChoice{
				indices: append(
					pathIndicesForSegment(segments, index, result.indices),
					next.indices...,
				),
				lastSegmentIndex: index,
				ok:               true,
				quality:          quality,
			}
			if next.lastSegmentIndex >= 0 {
				choice.lastSegmentIndex = next.lastSegmentIndex
			}
			if !best.ok || choice.quality > best.quality {
				best = choice
			}
		}
		memo[key] = best
		return best
	}
	result := visit(0, 0)
	return result, result.ok
}

func scorePathSegmentTerm(term normalizedSearchTerm, segment string, requireExact bool) (textMatchResult, bool) {
	best := textMatchResult{}
	bestOK := false
	targets := []string{trimSearchStem(segment), segment}
	if requireExact {
		targets = []string{segment}
	}
	for _, target := range targets {
		result, ok := classifyTextMatch(term, target)
		if !ok || (requireExact && result.kind != textMatchExact) {
			continue
		}
		if !bestOK || result.kind < best.kind || (result.kind == best.kind && result.quality > best.quality) {
			best = result
			bestOK = true
		}
	}
	return best, bestOK
}

func classifyTextMatch(term normalizedSearchTerm, target string) (textMatchResult, bool) {
	if term.normalized == "" || target == "" {
		return textMatchResult{}, false
	}
	if searchTermEqualsTarget(term, target) {
		return textMatchResult{
			indices: sequentialSearchIndices(len(target)),
			quality: searchRankQualityMax - len(target),
			kind:    textMatchExact,
		}, true
	}
	if start, span, indices, ok := orderedTokenMatch(target, term.tokens); ok {
		kind := textMatchSubstring
		if start == 0 {
			kind = textMatchPrefix
		}
		return textMatchResult{
			indices: indices,
			quality: orderedSearchQuality(start, span, len(target)),
			kind:    kind,
		}, true
	}
	if start, span, gaps, indices, ok := subsequenceMatch(target, term.compact); ok {
		return textMatchResult{
			indices: indices,
			quality: fuzzySearchQuality(start, span, gaps, len(target)),
			kind:    textMatchFuzzy,
		}, true
	}
	return textMatchResult{}, false
}

func searchTermEqualsTarget(term normalizedSearchTerm, target string) bool {
	return term.normalized == target || term.compact == target
}

func orderedSearchQuality(start int, span int, targetLength int) int {
	return searchRankQualityMax - start*1200 - span*25 - targetLength
}

func fuzzySearchQuality(start int, span int, gaps int, targetLength int) int {
	return 750000 - start*1000 - gaps*160 - span*35 - targetLength
}

func sequentialSearchIndices(length int) []int {
	indices := make([]int, length)
	for index := range indices {
		indices[index] = index
	}
	return indices
}

func applySearchPenalties(query normalizedSearchQuery, candidate searchCandidateContext, quality int) int {
	hiddenPenalty := candidate.hiddenSegments * searchHiddenSegmentPenalty
	noisePenalty := candidate.noiseSegments * searchNoiseSegmentPenalty
	if searchQueryTargetsHiddenOrNoise(query) {
		hiddenPenalty /= 4
		noisePenalty /= 4
	}
	quality -= candidate.depth * searchDepthPenalty
	quality -= hiddenPenalty
	quality -= noisePenalty
	if quality < 0 {
		return 0
	}
	return quality
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
	return searchQueryTargetsHiddenOrNoise(normalizeSearchQuery(DefaultLogicalRoot, query))
}

func SearchQueryTargetsHiddenFile(query string) bool {
	normalizedQuery := normalizeSearchQuery(DefaultLogicalRoot, query)
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

func searchTermContainsFilenameDotLiteral(term normalizedSearchTerm) bool {
	for _, token := range term.tokens {
		if isFilenameDotLiteralToken(token) {
			return true
		}
	}
	return false
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
