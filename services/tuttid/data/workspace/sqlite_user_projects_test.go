package workspace

import (
	"context"
	"testing"
	"time"

	userprojectbiz "github.com/tutti-os/tutti/services/tuttid/biz/userproject"
)

func TestSQLiteStorePutUserProjectListsMostRecentlyUsedFirst(t *testing.T) {
	ctx := context.Background()
	store := openTestSQLiteStore(t)

	first, err := store.PutUserProject(ctx, userprojectbiz.Project{
		ID:    "user_project_first",
		Path:  "/workspace/first",
		Label: "first",
	})
	if err != nil {
		t.Fatalf("PutUserProject(first) error = %v", err)
	}
	time.Sleep(2 * time.Millisecond)
	second, err := store.PutUserProject(ctx, userprojectbiz.Project{
		ID:    "user_project_second",
		Path:  "/workspace/second",
		Label: "second",
	})
	if err != nil {
		t.Fatalf("PutUserProject(second) error = %v", err)
	}

	projects, err := store.ListUserProjects(ctx)
	if err != nil {
		t.Fatalf("ListUserProjects() error = %v", err)
	}
	if len(projects) != 2 {
		t.Fatalf("ListUserProjects() len = %d, want 2", len(projects))
	}
	if projects[0].ID != second.ID || projects[1].ID != first.ID {
		t.Fatalf("ListUserProjects() order = [%q, %q], want second then first", projects[0].ID, projects[1].ID)
	}

	time.Sleep(2 * time.Millisecond)
	usedFirst, err := store.PutUserProject(ctx, userprojectbiz.Project{
		ID:    first.ID,
		Path:  first.Path,
		Label: first.Label,
	})
	if err != nil {
		t.Fatalf("PutUserProject(first again) error = %v", err)
	}
	if usedFirst.CreatedAtUnixMS != first.CreatedAtUnixMS {
		t.Fatalf("PutUserProject(first again) createdAt = %d, want %d", usedFirst.CreatedAtUnixMS, first.CreatedAtUnixMS)
	}
	if usedFirst.LastUsedAtUnixMS <= first.LastUsedAtUnixMS {
		t.Fatalf("PutUserProject(first again) lastUsedAt = %d, want > %d", usedFirst.LastUsedAtUnixMS, first.LastUsedAtUnixMS)
	}

	projects, err = store.ListUserProjects(ctx)
	if err != nil {
		t.Fatalf("ListUserProjects() after reuse error = %v", err)
	}
	if projects[0].ID != first.ID || projects[1].ID != second.ID {
		t.Fatalf("ListUserProjects() after reuse order = [%q, %q], want first then second", projects[0].ID, projects[1].ID)
	}
}

func TestSQLiteStoreDeleteUserProjectRemovesRecentProject(t *testing.T) {
	ctx := context.Background()
	store := openTestSQLiteStore(t)

	project, err := store.PutUserProject(ctx, userprojectbiz.Project{
		ID:    "user_project_deleted",
		Path:  "/workspace/deleted",
		Label: "deleted",
	})
	if err != nil {
		t.Fatalf("PutUserProject() error = %v", err)
	}

	if err := store.DeleteUserProject(ctx, project.ID); err != nil {
		t.Fatalf("DeleteUserProject() error = %v", err)
	}
	projects, err := store.ListUserProjects(ctx)
	if err != nil {
		t.Fatalf("ListUserProjects() error = %v", err)
	}
	if len(projects) != 0 {
		t.Fatalf("ListUserProjects() len = %d, want 0", len(projects))
	}
}

// TestSQLiteStoreDeleteUserProjectByPathRemovesRowWithMismatchedID guards
// against the "remove project" no-op regression: the `path` column is the
// table's UNIQUE key (see applyUserProjectsV1), so deleting by path must
// still remove the row even if the stored `id` doesn't match whatever a
// caller would recompute from the path. Deleting by a recomputed id instead
// is exactly the bug this store method exists to avoid.
func TestSQLiteStoreDeleteUserProjectByPathRemovesRowWithMismatchedID(t *testing.T) {
	ctx := context.Background()
	store := openTestSQLiteStore(t)

	_, err := store.PutUserProject(ctx, userprojectbiz.Project{
		ID:    "user_project_stale-mismatched-id",
		Path:  "/workspace/mismatched",
		Label: "mismatched",
	})
	if err != nil {
		t.Fatalf("PutUserProject() error = %v", err)
	}

	if err := store.DeleteUserProjectByPath(ctx, "/workspace/mismatched"); err != nil {
		t.Fatalf("DeleteUserProjectByPath() error = %v", err)
	}
	projects, err := store.ListUserProjects(ctx)
	if err != nil {
		t.Fatalf("ListUserProjects() error = %v", err)
	}
	if len(projects) != 0 {
		t.Fatalf("ListUserProjects() len = %d, want 0", len(projects))
	}
}
