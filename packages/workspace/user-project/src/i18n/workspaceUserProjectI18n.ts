import {
  createScopedLocaleObjectsI18nModuleManifest,
  createI18nRuntime,
  createScopedI18nRuntime,
  type I18nDictionary,
  type I18nRuntime
} from "@tutti-os/ui-i18n-runtime";

type WorkspaceUserProjectI18nLocale = "en" | "zh-CN";

export const workspaceUserProjectI18nNamespace = "workspaceUserProject";
export const workspaceUserProjectI18nModule =
  createScopedLocaleObjectsI18nModuleManifest({
    localeObjectByLocale: {
      en: "workspaceUserProjectEn",
      "zh-CN": "workspaceUserProjectZhCN"
    },
    name: "workspace-user-project",
    namespace: workspaceUserProjectI18nNamespace,
    sourceRoot: "packages/workspace/user-project/src"
  });

const workspaceUserProjectEn = {
  projectSelect: {
    addProject: "Add project",
    createProjectCancel: "Cancel",
    createProjectConfirm: "Create",
    createProjectDocumentsUnavailable:
      "The workspace is unavailable. Use an existing project instead.",
    createProjectFailed: "Unable to create project",
    createProjectNameConflict:
      "A project with this name already exists. Use another name.",
    createProjectNameInvalid:
      "Project names cannot contain path separators or empty values.",
    createProjectNameLabel:
      "Enter a project name. A folder will be created under /workspace",
    createProjectNamePlaceholder: "Project name",
    createProjectNameRequired: "Project name is required",
    createProjectPermissionDenied:
      "Tutti does not have permission to create folders under /workspace.",
    createProjectTitle: "Add project",
    linkExistingProject: "Use existing project",
    loadingProjects: "Loading projects",
    noProject: "No project",
    projectLabel: "Project",
    projectLocked: "Project locked",
    projectMissingTitle: "Current working directory missing",
    projectUnavailable: "Project unavailable",
    selectDirectoryFailed: "Unable to select project directory"
  }
} as const satisfies I18nDictionary;

const workspaceUserProjectZhCN = {
  projectSelect: {
    addProject: "添加项目",
    createProjectCancel: "取消",
    createProjectConfirm: "创建",
    createProjectDocumentsUnavailable: "无法访问 /workspace。请选择已有项目。",
    createProjectFailed: "无法创建项目",
    createProjectNameConflict: "同名项目已存在，请换一个名称。",
    createProjectNameInvalid: "项目名称不能包含路径分隔符或为空。",
    createProjectNameLabel: "输入项目名称。系统会在 /workspace 下创建文件夹",
    createProjectNamePlaceholder: "项目名称",
    createProjectNameRequired: "请输入项目名称",
    createProjectPermissionDenied: "Tutti 没有权限在 /workspace 下创建文件夹。",
    createProjectTitle: "添加项目",
    linkExistingProject: "使用已有项目",
    loadingProjects: "正在加载项目",
    noProject: "不使用项目",
    projectLabel: "项目",
    projectLocked: "项目已锁定",
    projectMissingTitle: "当前工作目录不存在",
    projectUnavailable: "项目不可用",
    selectDirectoryFailed: "无法选择项目目录"
  }
} as const satisfies I18nDictionary;

export type WorkspaceUserProjectI18nKey =
  | "projectSelect.addProject"
  | "projectSelect.createProjectCancel"
  | "projectSelect.createProjectConfirm"
  | "projectSelect.createProjectDocumentsUnavailable"
  | "projectSelect.createProjectFailed"
  | "projectSelect.createProjectNameConflict"
  | "projectSelect.createProjectNameInvalid"
  | "projectSelect.createProjectNameLabel"
  | "projectSelect.createProjectNamePlaceholder"
  | "projectSelect.createProjectNameRequired"
  | "projectSelect.createProjectPermissionDenied"
  | "projectSelect.createProjectTitle"
  | "projectSelect.linkExistingProject"
  | "projectSelect.loadingProjects"
  | "projectSelect.noProject"
  | "projectSelect.projectLabel"
  | "projectSelect.projectLocked"
  | "projectSelect.projectMissingTitle"
  | "projectSelect.projectUnavailable"
  | "projectSelect.selectDirectoryFailed";

export type WorkspaceUserProjectI18nRuntime =
  I18nRuntime<WorkspaceUserProjectI18nKey>;

const workspaceUserProjectDefaults = {
  en: workspaceUserProjectEn,
  "zh-CN": workspaceUserProjectZhCN
} as const satisfies Record<WorkspaceUserProjectI18nLocale, I18nDictionary>;

export const workspaceUserProjectI18nResources = {
  en: {
    [workspaceUserProjectI18nNamespace]: workspaceUserProjectDefaults.en
  },
  "zh-CN": {
    [workspaceUserProjectI18nNamespace]: workspaceUserProjectDefaults["zh-CN"]
  }
} as const satisfies Record<WorkspaceUserProjectI18nLocale, I18nDictionary>;

const defaultWorkspaceUserProjectI18n = createI18nRuntime({
  dictionaries: [workspaceUserProjectI18nResources.en]
});

export function createWorkspaceUserProjectI18nRuntime(
  runtime: I18nRuntime<string> | undefined = undefined
): WorkspaceUserProjectI18nRuntime {
  return createScopedI18nRuntime<WorkspaceUserProjectI18nKey>(
    runtime ?? defaultWorkspaceUserProjectI18n,
    workspaceUserProjectI18nNamespace
  );
}

export function createDefaultWorkspaceUserProjectI18nRuntime(): WorkspaceUserProjectI18nRuntime {
  return createWorkspaceUserProjectI18nRuntime();
}
