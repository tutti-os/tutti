package events

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

var expectedAnalyticsEvents = []string{
	"app.startup_failed",
	"app.renderer_error",
	"daemon.startup_failed",
	"daemon.disconnected",
	"daemon.reconnected",
	"workspace.opened",
	"workspace.open_failed",
	"workspace.overview.retry_clicked",
	"workspace.close_guard_shown",
	"workspace.close_guard_confirmed",
	"workspace.close_guard_cancelled",
	"launchpad.opened",
	"launchpad.closed",
	"launchpad.searched",
	"launchpad.item_launched",
	"launchpad.page_changed",
	"mission_control.activated",
	"mission_control.deactivated",
	"agent.session_started",
	"agent.message_sent",
	"agent.message_stopped",
	"agent.workspace_file_referenced",
	"agent.provider_login_initiated",
	"agent.provider_login_result",
	"agent.provider_ready",
	"agent.chat_ready",
	"agent.conversation_pinned",
	"agent.conversation_unpinned",
	"agent.settings.model_changed",
	"agent.settings.permission_mode_changed",
	"agent.settings.reasoning_effort_changed",
	"agent.settings.project_changed",
	"app_center.opened",
	"app_center.app_opened",
	"app_center.app_stopped",
	"app_center.app_installed",
	"app_center.app_install_failed",
	"app_center.app_uninstalled",
	"app_center.app_deleted",
	"app_center.app_updated",
	"app_center.catalog_refreshed",
	"app_center.factory_job_created",
	"issue_manager.opened",
	"issue_manager.issue_created",
	"issue_manager.issue_saved",
	"issue_manager.issue_deleted",
	"issue_manager.task_created",
	"issue_manager.task_saved",
	"issue_manager.task_deleted",
	"issue_manager.task_run_initiated",
	"issue_manager.issue_breakdown_initiated",
	"issue_manager.context_ref_added",
	"issue_manager.context_ref_removed",
	"issue_manager.topic_changed",
	"issue_manager.task_searched",
	"file_manager.opened",
	"file_manager.file_created",
	"file_manager.path_copied",
	"file_manager.directory_expanded",
	"file_preview.opened",
	"file_preview.closed",
	"browser.opened",
	"browser.closed",
	"terminal.opened",
	"terminal.closed",
	"settings.opened",
	"settings.section_switched",
	"settings.language_changed",
	"settings.theme_changed",
	"settings.wallpaper_changed",
	"settings.custom_wallpaper_uploaded",
	"settings.custom_wallpaper_cleared",
	"message_center.opened",
	"message_center.notification_actioned",
	"app_update.status_changed",
	"app_update.action_clicked",
	"error.agent_session_failed",
	"error.app_runtime_failed",
	"error.workspace_unavailable",
}

func TestEveryAnalyticsSpecEventHasServerReporterPackage(t *testing.T) {
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime caller unavailable")
	}
	eventsDir := filepath.Dir(filename)
	var missing []string
	for _, eventName := range expectedAnalyticsEvents {
		if !hasEventPackageFile(filepath.Join(eventsDir, eventPackagePath(eventName))) {
			missing = append(missing, eventName)
		}
	}
	if len(missing) > 0 {
		t.Fatalf("missing server analytics event packages: %v", missing)
	}

	actual := actualAnalyticsEvents(t, eventsDir)
	expected := make(map[string]bool, len(expectedAnalyticsEvents))
	for _, eventName := range expectedAnalyticsEvents {
		expected[eventName] = true
	}
	var unexpected []string
	for _, eventName := range actual {
		if !expected[eventName] {
			unexpected = append(unexpected, eventName)
		}
	}
	if len(unexpected) > 0 {
		t.Fatalf("unexpected server analytics event packages: %v", unexpected)
	}
}

func actualAnalyticsEvents(t *testing.T, eventsDir string) []string {
	t.Helper()
	var eventNames []string
	err := filepath.WalkDir(eventsDir, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".go" || strings.HasSuffix(entry.Name(), "_test.go") {
			return nil
		}
		eventDir := filepath.Dir(path)
		if eventDir == eventsDir {
			return nil
		}
		relative, err := filepath.Rel(eventsDir, eventDir)
		if err != nil {
			return err
		}
		eventNames = append(eventNames, strings.ReplaceAll(filepath.ToSlash(relative), "/", "."))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return eventNames
}

func hasEventPackageFile(eventDir string) bool {
	entries, err := os.ReadDir(eventDir)
	if err != nil {
		return false
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if filepath.Ext(name) == ".go" && !strings.HasSuffix(name, "_test.go") {
			return true
		}
	}
	return false
}

func eventPackagePath(eventName string) string {
	parts := []rune(eventName)
	for i, part := range parts {
		if part == '.' {
			parts[i] = filepath.Separator
		}
	}
	return string(parts)
}
