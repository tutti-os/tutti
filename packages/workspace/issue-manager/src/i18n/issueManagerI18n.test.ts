import assert from "node:assert/strict";
import test from "node:test";
import { createI18nRuntime } from "@tutti-os/ui-i18n-runtime";
import {
  createIssueManagerI18nRuntime,
  issueManagerI18nResources
} from "./issueManagerI18n.ts";

test("zh-CN task terminology and status labels use requested copy", () => {
  const copy = createIssueManagerI18nRuntime(
    createI18nRuntime({ dictionaries: [issueManagerI18nResources["zh-CN"]] })
  );

  assert.equal(copy.t("dockLabel"), "任务");
  assert.equal(copy.t("title"), "任务");
  assert.equal(copy.t("actions.addSubtask"), "添加任务");
  assert.equal(copy.t("actions.createIssue"), "新建任务");
  assert.equal(copy.t("actions.createTask"), "新建任务");
  assert.equal(copy.t("actions.deleteIssue"), "删除任务");
  assert.equal(copy.t("actions.deleteTask"), "删除任务");
  assert.equal(copy.t("actions.editIssue"), "编辑任务");
  assert.equal(copy.t("actions.editTask"), "编辑任务");
  assert.equal(copy.t("actions.runTask"), "运行任务");
  assert.equal(copy.t("actions.saveIssue"), "保存任务");
  assert.equal(copy.t("actions.saveSubtask"), "保存任务");
  assert.equal(copy.t("actions.saveTask"), "保存任务");
  assert.equal(
    copy.t("composer.issueContentPlaceholder"),
    "补充这个任务的背景、目标或上下文"
  );
  assert.equal(copy.t("composer.issueTitlePlaceholder"), "任务标题");
  assert.equal(
    copy.t("composer.subtaskContentPlaceholder"),
    "补充任务目标、执行方式和验收标准"
  );
  assert.equal(copy.t("composer.subtaskTitlePlaceholder"), "请输入任务标题");
  assert.equal(
    copy.t("composer.taskContentPlaceholder"),
    "描述这个任务的执行要求和预期结果。"
  );
  assert.equal(copy.t("composer.taskTitlePlaceholder"), "任务标题");
  assert.equal(copy.t("labels.issueDetails"), "任务详情");
  assert.equal(copy.t("labels.issueList"), "任务");
  assert.equal(copy.t("labels.searchIssues"), "搜索任务");
  assert.equal(copy.t("labels.subtasks"), "子任务");
  assert.equal(copy.t("labels.taskAcceptance"), "任务待验收");
  assert.equal(copy.t("labels.taskCount", { count: 7 }), "7 个子任务");
  assert.equal(copy.t("labels.taskDetails"), "任务详情");
  assert.equal(copy.t("labels.taskList"), "任务");
  assert.equal(copy.t("messages.noIssues"), "还没有任务");
  assert.equal(copy.t("messages.noTasks"), "还没有任务");
  assert.equal(copy.t("status.notStarted"), "待开始");
  assert.equal(copy.t("status.running"), "执行中");
  assert.equal(copy.t("status.pendingAcceptance"), "待验收");
  assert.equal(copy.t("status.completed"), "已完成");
  assert.equal(copy.t("status.failed"), "失败");
  assert.equal(copy.t("status.canceled"), "已取消");
});

test("en task terminology and status labels use requested copy", () => {
  const copy = createIssueManagerI18nRuntime(
    createI18nRuntime({ dictionaries: [issueManagerI18nResources.en] })
  );

  assert.equal(copy.t("dockLabel"), "Tasks");
  assert.equal(copy.t("title"), "Tasks");
  assert.equal(copy.t("actions.addSubtask"), "Add subtask");
  assert.equal(copy.t("actions.createIssue"), "New task");
  assert.equal(copy.t("actions.createTask"), "Create task");
  assert.equal(copy.t("actions.deleteIssue"), "Delete task");
  assert.equal(copy.t("actions.deleteTask"), "Delete task");
  assert.equal(copy.t("actions.editIssue"), "Edit task");
  assert.equal(copy.t("actions.editTask"), "Edit task");
  assert.equal(copy.t("actions.runTask"), "Run task");
  assert.equal(copy.t("actions.saveIssue"), "Save task");
  assert.equal(copy.t("actions.saveSubtask"), "Save subtask");
  assert.equal(copy.t("actions.saveTask"), "Save task");
  assert.equal(
    copy.t("composer.issueContentPlaceholder"),
    "Describe the task, goals, or context."
  );
  assert.equal(copy.t("composer.issueTitlePlaceholder"), "Task title");
  assert.equal(
    copy.t("composer.subtaskContentPlaceholder"),
    "Add the subtask goal, execution approach, and acceptance criteria."
  );
  assert.equal(
    copy.t("composer.subtaskTitlePlaceholder"),
    "Enter a subtask title"
  );
  assert.equal(
    copy.t("composer.taskContentPlaceholder"),
    "Describe the executable task and expected result."
  );
  assert.equal(copy.t("composer.taskTitlePlaceholder"), "Task title");
  assert.equal(copy.t("labels.issueDetails"), "Task details");
  assert.equal(copy.t("labels.issueList"), "Tasks");
  assert.equal(copy.t("labels.searchIssues"), "Search tasks");
  assert.equal(copy.t("labels.subtasks"), "Subtasks");
  assert.equal(copy.t("labels.taskAcceptance"), "Task pending acceptance");
  assert.equal(copy.t("labels.taskCount", { count: 7 }), "7 subtasks");
  assert.equal(copy.t("labels.taskDetails"), "Task details");
  assert.equal(copy.t("labels.taskList"), "Tasks");
  assert.equal(copy.t("messages.noIssues"), "No tasks yet");
  assert.equal(copy.t("messages.noTasks"), "No tasks yet");
  assert.equal(copy.t("status.notStarted"), "Todo");
  assert.equal(copy.t("status.running"), "Running");
  assert.equal(copy.t("status.pendingAcceptance"), "In review");
  assert.equal(copy.t("status.completed"), "Done");
  assert.equal(copy.t("status.failed"), "Failed");
  assert.equal(copy.t("status.canceled"), "Canceled");
});
