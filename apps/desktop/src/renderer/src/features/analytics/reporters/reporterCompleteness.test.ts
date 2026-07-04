import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const expectedAnalyticsEvents = [
  "app.pageview",
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
  "agent.node_result",
  "agent.env_detected",
  "agent.env_issue_reported",
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
  "error.workspace_unavailable"
] as const;

test("renderer reporter directories match analytics spec events", () => {
  const reportersDir = path.dirname(new URL(import.meta.url).pathname);
  const expectedReporterDirectories = expectedAnalyticsEvents.map(
    toReporterDirectoryName
  );
  const actualReporterDirectories = fs
    .readdirSync(reportersDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((dirName) =>
      fs.existsSync(path.join(reportersDir, dirName, "index.ts"))
    );

  const missing = expectedReporterDirectories.filter(
    (dirName) => !actualReporterDirectories.includes(dirName)
  );
  const unexpected = actualReporterDirectories.filter(
    (dirName) => !expectedReporterDirectories.includes(dirName)
  );

  assert.deepEqual({ missing, unexpected }, { missing: [], unexpected: [] });
});

function toReporterDirectoryName(eventName: string): string {
  return eventName.replaceAll(".", "-").replaceAll("_", "-");
}
