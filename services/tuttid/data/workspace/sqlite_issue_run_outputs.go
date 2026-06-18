package workspace

import (
	"context"
	"fmt"
	"strings"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
)

// SearchRunOutputs matches output files by display name across one workspace,
// joining the owning issue for its title (and for topic scoping). Results are
// recency-ordered and deduplicated by path, mirroring GetIssueDetail outputs.
func (s *SQLiteStore) SearchRunOutputs(ctx context.Context, params workspaceissues.RunOutputSearchParams) ([]workspaceissues.RunOutputSearchHit, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return nil, err
	}
	if err := s.ensureIssueWorkspace(ctx, params.WorkspaceID); err != nil {
		return nil, err
	}

	// query 为空时 LIKE '%%' 匹配全部 —— 即「仅按类型筛选」的 list-all(由下方 filters 收窄)。
	where := []string{"o.workspace_id = ?", "LOWER(o.display_name) LIKE ?"}
	args := []any{params.WorkspaceID, "%" + strings.ToLower(params.Query) + "%"}
	if params.IssueID != "" {
		where = append(where, "o.issue_id = ?")
		args = append(args, params.IssueID)
	} else if params.TopicID != "" {
		where = append(where, "i.topic_id = ?")
		args = append(args, params.TopicID)
	}
	// 文件类型筛选(全局统一口径):按 display_name 扩展名收窄,见 reference_filter_categories.go。
	if clause, clauseArgs := referenceFilterDisplayNameClause("o.display_name", params.Filters); clause != "" {
		where = append(where, clause)
		args = append(args, clauseArgs...)
	}

	query := fmt.Sprintf(`
SELECT o.id, o.output_id, o.run_id, o.task_id, o.issue_id, o.workspace_id,
       o.path, o.display_name, o.media_type, o.size_bytes, o.created_at_unix_ms,
       i.title
FROM workspace_issue_run_outputs o
JOIN workspace_issues i
  ON i.workspace_id = o.workspace_id AND i.issue_id = o.issue_id
WHERE %s
ORDER BY o.created_at_unix_ms DESC, o.id DESC
LIMIT ?
`, strings.Join(where, " AND "))
	args = append(args, params.Limit)

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("search workspace issue run outputs: %w", err)
	}
	defer rows.Close()

	hits := make([]workspaceissues.RunOutputSearchHit, 0)
	seenPaths := map[string]struct{}{}
	for rows.Next() {
		hit, err := scanWorkspaceIssueRunOutputSearchHit(rows)
		if err != nil {
			return nil, err
		}
		dedupKey := strings.TrimSpace(hit.Output.Path)
		if _, exists := seenPaths[dedupKey]; exists {
			continue
		}
		seenPaths[dedupKey] = struct{}{}
		hits = append(hits, hit)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate workspace issue run output search: %w", err)
	}
	return hits, nil
}
