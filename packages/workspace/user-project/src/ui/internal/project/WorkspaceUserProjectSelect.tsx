import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState
} from "react";
import { useSnapshot } from "valtio";
import { proxy } from "valtio/vanilla";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FolderIcon,
  Input,
  LinkIcon,
  NewWorkspaceLinedIcon,
  NoWorkspaceLinedIcon,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  cn
} from "@tutti-os/ui-system";
import type {
  WorkspaceUserProject,
  WorkspaceUserProjectApi,
  WorkspaceUserProjectSelectionPreparation,
  WorkspaceUserProjectSelectionPreparationInput,
  WorkspaceUserProjectService
} from "../../../contracts/index.ts";
import {
  basenameWorkspaceUserProjectPath,
  getWorkspaceUserProjectErrorCode,
  prepareWorkspaceUserProjectSelection,
  resolveWorkspaceUserProjectDisplayLabel,
  upsertWorkspaceUserProject
} from "../../../core/index.ts";
import {
  createDefaultWorkspaceUserProjectI18nRuntime,
  type WorkspaceUserProjectI18nRuntime
} from "../../../i18n/index.ts";

export type WorkspaceUserProjectSelectLabels = {
  addProject: string;
  createProjectCancel: string;
  createProjectConfirm: string;
  createProjectDocumentsUnavailable: string;
  createProjectFailed: string;
  createProjectNameConflict: string;
  createProjectNameInvalid: string;
  createProjectNameLabel: string;
  createProjectNamePlaceholder: string;
  createProjectNameRequired: string;
  createProjectPermissionDenied: string;
  createProjectTitle: string;
  linkExistingProject: string;
  loadingProjects: string;
  noProject: string;
  projectLabel: string;
  projectLocked: string;
  projectMissingTitle: string;
  projectUnavailable: string;
};

export type WorkspaceUserProjectSelectLabelOverrides =
  Partial<WorkspaceUserProjectSelectLabels>;

export interface WorkspaceUserProjectSelectClassNames {
  content?: string;
  item?: string;
  trigger?: string;
}

export type WorkspaceUserProjectSelectChangeAction =
  | "clear"
  | "create_new"
  | "select_existing";

export interface WorkspaceUserProjectSelectProps {
  api?: WorkspaceUserProjectApi | null;
  classNames?: WorkspaceUserProjectSelectClassNames;
  contentAlign?: "center" | "end" | "start";
  contentSide?: "bottom" | "left" | "right" | "top";
  contentSideOffset?: number;
  disabled?: boolean;
  i18n?: WorkspaceUserProjectI18nRuntime;
  labels?: WorkspaceUserProjectSelectLabelOverrides;
  onProjectMissingChange?: (isMissing: boolean) => void;
  /**
   * Called when the select menu or create dialog is about to restore focus.
   * Call `event.preventDefault()` to keep focus from returning to the trigger,
   * then move focus to the preferred surface (for example the composer input).
   */
  onDismissAutoFocus?: (event: Event) => void;
  onProjectPathChange: (
    path: string | null,
    metadata?: {
      action: WorkspaceUserProjectSelectChangeAction;
      project?: WorkspaceUserProject;
    }
  ) => void;
  projectLocked?: boolean;
  renderAddProjectIcon?: () => ReactNode;
  shouldApplyPreparedSelection?: boolean;
  showKnownProjectOptions?: boolean;
  service?: WorkspaceUserProjectService | null;
  selectedProjectPath?: string | null;
  showCreateProjectAction?: boolean;
  showNoProjectAction?: boolean;
  unlistedProjectLabel?: string;
}

const noProjectOptionValue = "__tutti_no_project__";
const addProjectOptionValue = "__tutti_add_project__";
const linkExistingProjectOptionValue = "__tutti_link_existing_project__";
const workspaceUserProjectOverflowLabelStyle = `
@keyframes workspace-user-project-label-marquee {
  0% {
    transform: translateX(0);
  }

  44%,
  56% {
    transform: translateX(var(--workspace-user-project-label-marquee-distance, 0px));
  }

  88%,
  100% {
    transform: translateX(0);
  }
}

.workspace-user-project-overflow-label {
  --workspace-user-project-label-marquee-distance: 0px;
  container-type: normal;
  display: block;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}

.workspace-user-project-trigger-label {
  align-items: center;
  display: flex;
  flex: 1 1 auto;
  gap: 0.5rem;
  min-width: 0;
}

.workspace-user-project-overflow-label__content {
  display: block;
  max-width: 100%;
  min-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  transform: translateX(0);
  white-space: nowrap;
  width: max-content;
}

.workspace-user-project-overflow-label[data-overflow="true"]:hover
  .workspace-user-project-overflow-label__content,
[data-slot="select-item"]:hover
  .workspace-user-project-overflow-label[data-overflow="true"]
  .workspace-user-project-overflow-label__content {
  animation: workspace-user-project-label-marquee 14s linear infinite;
  max-width: none;
  overflow: visible;
  text-overflow: clip;
}

@media (prefers-reduced-motion: reduce) {
  .workspace-user-project-overflow-label[data-overflow="true"]:hover
    .workspace-user-project-overflow-label__content,
  [data-slot="select-item"]:hover
    .workspace-user-project-overflow-label[data-overflow="true"]
    .workspace-user-project-overflow-label__content {
    animation: none;
  }
}
`;
const defaultWorkspaceUserProjectSelectI18n =
  createDefaultWorkspaceUserProjectI18nRuntime();
const emptyWorkspaceUserProjectServiceSnapshot = proxy({
  error: null,
  initialized: false,
  isLoading: false,
  isMutationPending: false,
  projects: [],
  revision: 0
});

export function WorkspaceUserProjectSelect({
  api,
  classNames,
  contentAlign = "start",
  contentSide = "top",
  contentSideOffset = 4,
  disabled: disabledProp = false,
  i18n = defaultWorkspaceUserProjectSelectI18n,
  labels,
  onProjectMissingChange,
  onDismissAutoFocus,
  onProjectPathChange,
  projectLocked = false,
  renderAddProjectIcon,
  shouldApplyPreparedSelection = true,
  showKnownProjectOptions = true,
  service,
  selectedProjectPath,
  showCreateProjectAction = hasWorkspaceUserProjectMethod(
    service,
    "createProject"
  ) || hasWorkspaceUserProjectMethod(api, "create"),
  showNoProjectAction = true,
  unlistedProjectLabel
}: WorkspaceUserProjectSelectProps): React.JSX.Element {
  "use memo";
  const serviceSnapshot = useSnapshot(
    service?.store ?? emptyWorkspaceUserProjectServiceSnapshot
  );
  const effectiveApi = useMemo(
    () => createWorkspaceUserProjectApiAdapter(api, service),
    [api, service]
  );
  const resolvedLabels = useMemo(
    () => resolveWorkspaceUserProjectSelectLabels(i18n, labels),
    [i18n, labels]
  );
  const createProjectNameDescription =
    resolvedLabels.createProjectNameLabel.trim();
  const createProjectNameInputLabel =
    createProjectNameDescription ||
    resolvedLabels.createProjectNamePlaceholder.trim();
  const [apiProjects, setApiProjects] = useState<WorkspaceUserProject[]>([]);
  const [isApiLoading, setIsApiLoading] = useState(false);
  const [isApiUnavailable, setIsApiUnavailable] = useState(!effectiveApi);
  const [isProjectDialogOpen, setIsProjectDialogOpen] = useState(false);
  const [isSelectOpen, setIsSelectOpen] = useState(false);
  const [draftProjectName, setDraftProjectName] = useState("");
  const [projectCreationError, setProjectCreationError] = useState<
    string | null
  >(null);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [suppressedSelectedPath, setSuppressedSelectedPath] = useState<
    string | null
  >(null);
  const [hasPinnedNoProjectSelection, setHasPinnedNoProjectSelection] =
    useState(false);
  const [isSelectedPathMissing, setIsSelectedPathMissing] = useState(false);
  const rawSelectedPath = selectedProjectPath?.trim() ?? "";
  const selectedPath =
    rawSelectedPath && rawSelectedPath === suppressedSelectedPath
      ? ""
      : rawSelectedPath;
  const projects = service ? [...serviceSnapshot.projects] : apiProjects;
  const visibleProjects = showKnownProjectOptions ? projects : [];
  const isLoading = service
    ? serviceSnapshot.isLoading && !serviceSnapshot.initialized
    : isApiLoading;
  const isUnavailable = service
    ? Boolean(serviceSnapshot.error) && !serviceSnapshot.initialized
    : isApiUnavailable;
  const selectedPathLabel =
    basenameWorkspaceUserProjectPath(selectedPath) || selectedPath;
  const selectedProject = showKnownProjectOptions
    ? (projects.find((project) => project.path === selectedPath) ?? null)
    : null;
  const selectedProjectLabel = selectedProject
    ? resolveWorkspaceUserProjectDisplayLabel(selectedProject)
    : "";
  const isSelectedNoProjectPath =
    Boolean(selectedPath) &&
    Boolean(effectiveApi?.isNoProjectPath?.({ path: selectedPath }));
  const shouldShowMissingProjectNotice = isSelectedPathMissing;
  const shouldShowLockedProjectPath =
    projectLocked &&
    selectedPath !== "" &&
    !isSelectedNoProjectPath &&
    !selectedProject &&
    !isSelectedPathMissing;
  const selectValue = selectedProject
    ? selectedProject.path
    : noProjectOptionValue;
  const triggerLabel = shouldShowMissingProjectNotice
    ? resolvedLabels.projectMissingTitle
    : isSelectedNoProjectPath
      ? resolvedLabels.noProject
      : shouldShowLockedProjectPath
        ? selectedPathLabel
        : selectedProject
          ? selectedProjectLabel
          : selectedPath
            ? unlistedProjectLabel || selectedPathLabel
            : isLoading
              ? resolvedLabels.loadingProjects
              : resolvedLabels.noProject;
  const shouldDisableWhileLoading =
    showKnownProjectOptions || shouldApplyPreparedSelection;
  const disabled =
    disabledProp ||
    projectLocked ||
    serviceSnapshot.isMutationPending === true ||
    (shouldDisableWhileLoading && isLoading) ||
    !effectiveApi;
  const hasProjectActions =
    Boolean(effectiveApi?.selectDirectory) ||
    showCreateProjectAction ||
    showNoProjectAction;
  const showProjectActionDivider =
    visibleProjects.length > 0 && hasProjectActions;

  useEffect(() => {
    if (!disabled) return;
    if (isSelectOpen) setIsSelectOpen(false);
    if (isProjectDialogOpen) {
      setIsProjectDialogOpen(false);
      setProjectCreationError(null);
    }
  }, [disabled, isProjectDialogOpen, isSelectOpen]);

  useEffect(() => {
    onProjectMissingChange?.(shouldShowMissingProjectNotice);
  }, [onProjectMissingChange, shouldShowMissingProjectNotice]);

  useEffect(() => {
    if (rawSelectedPath) {
      setHasPinnedNoProjectSelection(false);
    }
    if (
      suppressedSelectedPath &&
      (!rawSelectedPath || rawSelectedPath !== suppressedSelectedPath)
    ) {
      setSuppressedSelectedPath(null);
    }
  }, [rawSelectedPath, suppressedSelectedPath]);

  const applyPreparedSelection = useEffectEvent(
    (prepared: WorkspaceUserProjectSelectionPreparation): void => {
      if (!service) {
        setApiProjects(prepared.projects);
      }
      setIsSelectedPathMissing(prepared.isSelectedPathMissing);
      if (!shouldApplyPreparedSelection) {
        return;
      }
      if (prepared.selection.kind === "clear") {
        setHasPinnedNoProjectSelection(true);
        setSuppressedSelectedPath(prepared.selection.suppressedPath);
        onProjectPathChange(null);
        return;
      }
      if (prepared.selection.kind === "select") {
        setHasPinnedNoProjectSelection(false);
        onProjectPathChange(prepared.selection.path);
      }
    }
  );

  useEffect(() => {
    let canceled = false;
    if (!effectiveApi) {
      setApiUnavailableUnlessService(setIsApiUnavailable, service);
      return;
    }
    if (hasPinnedNoProjectSelection) {
      return;
    }
    setIsApiLoading(true);
    setApiUnavailableUnlessService(setIsApiUnavailable, service, false);
    const input = {
      projectLocked,
      selectedPath
    } satisfies WorkspaceUserProjectSelectionPreparationInput;
    void prepareWorkspaceUserProjectSelection(effectiveApi, input)
      .then((prepared) => {
        if (!canceled) {
          applyPreparedSelection(prepared);
        }
      })
      .catch(() => {
        if (!canceled) {
          setApiUnavailableUnlessService(setIsApiUnavailable, service);
        }
      })
      .finally(() => {
        if (!canceled) {
          setIsApiLoading(false);
        }
      });
    return () => {
      canceled = true;
    };
  }, [
    effectiveApi,
    hasPinnedNoProjectSelection,
    projectLocked,
    selectedPath,
    serviceSnapshot.revision,
    service
  ]);

  const refreshPreparedSelection = useCallback((): void => {
    if (!effectiveApi) {
      return;
    }
    const input = {
      projectLocked,
      selectedPath
    } satisfies WorkspaceUserProjectSelectionPreparationInput;
    void prepareWorkspaceUserProjectSelection(effectiveApi, input).then(
      applyPreparedSelection,
      () => {
        setApiUnavailableUnlessService(setIsApiUnavailable, service);
      }
    );
  }, [
    effectiveApi,
    projectLocked,
    selectedPath,
    service,
    shouldApplyPreparedSelection
  ]);

  const useProjectPath = useCallback(
    async (
      path: string,
      action: WorkspaceUserProjectSelectChangeAction
    ): Promise<void> => {
      if (!effectiveApi) {
        setApiUnavailableUnlessService(setIsApiUnavailable, service);
        return;
      }
      try {
        const project =
          (await effectiveApi.use?.({ path })) ??
          ({
            id: path,
            label: path,
            path,
            pinnedAtUnixMs: 0
          } satisfies WorkspaceUserProject);
        setApiProjects((current) =>
          upsertWorkspaceUserProject(current, project)
        );
        setHasPinnedNoProjectSelection(false);
        onProjectPathChange(project.path, { action, project });
        refreshPreparedSelection();
      } catch {
        setApiUnavailableUnlessService(setIsApiUnavailable, service);
      }
    },
    [effectiveApi, onProjectPathChange, refreshPreparedSelection, service]
  );

  const createProject = useCallback(async (): Promise<void> => {
    if (disabled) return;
    const name = draftProjectName.trim();
    if (!effectiveApi?.create) {
      setProjectCreationError(resolvedLabels.createProjectFailed);
      setApiUnavailableUnlessService(setIsApiUnavailable, service);
      return;
    }
    if (!name) {
      setProjectCreationError(resolvedLabels.createProjectNameRequired);
      return;
    }
    setIsCreatingProject(true);
    setProjectCreationError(null);
    try {
      const project = await effectiveApi.create({ name });
      setApiProjects((current) => upsertWorkspaceUserProject(current, project));
      setHasPinnedNoProjectSelection(false);
      onProjectPathChange(project.path, { action: "create_new", project });
      setDraftProjectName("");
      setIsProjectDialogOpen(false);
      refreshPreparedSelection();
    } catch (error) {
      setProjectCreationError(
        resolveProjectCreationErrorLabel(error, resolvedLabels)
      );
    } finally {
      setIsCreatingProject(false);
    }
  }, [
    disabled,
    effectiveApi,
    draftProjectName,
    onProjectPathChange,
    refreshPreparedSelection,
    resolvedLabels,
    service
  ]);

  const submitProjectDialog = (event: FormEvent<HTMLFormElement>): void => {
    // Dialog content is portaled in the DOM, but still sits under any ancestor
    // React form (for example the Agent composer). Stop bubbling so Create /
    // Enter cannot submit that outer form and send a draft prompt.
    event.preventDefault();
    event.stopPropagation();
    void createProject();
  };

  const closeProjectDialog = (): void => {
    setIsProjectDialogOpen(false);
    setProjectCreationError(null);
  };

  const handleProjectValueChange = (nextValue: string): void => {
    if (!effectiveApi || projectLocked) {
      return;
    }
    if (nextValue === noProjectOptionValue) {
      void effectiveApi.rememberDefaultSelection?.({ path: null });
      setHasPinnedNoProjectSelection(true);
      onProjectPathChange(null, { action: "clear" });
      return;
    }
    if (nextValue === addProjectOptionValue) {
      setDraftProjectName("");
      setProjectCreationError(null);
      setIsProjectDialogOpen(true);
      return;
    }
    if (nextValue === linkExistingProjectOptionValue) {
      void Promise.resolve(effectiveApi.selectDirectory?.())
        .then(async (selection) => {
          const path = selection?.path?.trim() ?? "";
          if (!path) {
            return;
          }
          await useProjectPath(path, "select_existing");
          // Native directory pickers skip Radix close-auto-focus; restore the
          // caller's preferred focus target after the path settles.
          onDismissAutoFocus?.(new Event("focus"));
        })
        .catch(() => {});
      return;
    }
    const knownProject = projects.find((project) => project.path === nextValue);
    if (knownProject) {
      void effectiveApi.rememberDefaultSelection?.({ path: knownProject.path });
      setHasPinnedNoProjectSelection(false);
      onProjectPathChange(knownProject.path, { action: "select_existing" });
      return;
    }
    void useProjectPath(nextValue, "select_existing");
  };

  return (
    <>
      <style>{workspaceUserProjectOverflowLabelStyle}</style>
      <Select
        disabled={disabled}
        open={isSelectOpen}
        value={selectValue}
        onOpenChange={setIsSelectOpen}
        onValueChange={handleProjectValueChange}
      >
        <SelectTrigger
          aria-label={
            projectLocked
              ? resolvedLabels.projectLocked
              : isUnavailable
                ? resolvedLabels.projectUnavailable
                : resolvedLabels.projectLabel
          }
          className={classNames?.trigger}
        >
          <span
            className="workspace-user-project-trigger-label"
            data-workspace-user-project-trigger-label="true"
          >
            {selectedProject || shouldShowLockedProjectPath ? (
              <FolderIcon aria-hidden className="shrink-0" size={15} />
            ) : (
              <NoWorkspaceLinedIcon
                aria-hidden
                className="shrink-0"
                data-agent-project-trigger-no-workspace-icon="true"
                size={15}
              />
            )}
            <WorkspaceUserProjectOverflowLabel label={triggerLabel} />
          </span>
        </SelectTrigger>
        <SelectContent
          align={contentAlign}
          className={classNames?.content}
          collisionPadding={16}
          side={contentSide}
          sideOffset={contentSideOffset}
          onCloseAutoFocus={onDismissAutoFocus}
        >
          {visibleProjects.map((project) => {
            const projectLabel =
              resolveWorkspaceUserProjectDisplayLabel(project);
            return (
              <SelectItem
                className={classNames?.item}
                key={project.id || project.path}
                value={project.path}
              >
                <span className="flex min-w-0 flex-1 items-center gap-2 pr-1">
                  <FolderIcon aria-hidden size={15} />
                  <WorkspaceUserProjectOverflowLabel label={projectLabel} />
                </span>
              </SelectItem>
            );
          })}
          {showProjectActionDivider ? (
            <SelectSeparator
              className="mx-[12px] my-1 shrink-0 bg-[var(--line-2)]"
              data-workspace-user-project-action-separator="true"
            />
          ) : null}
          {hasProjectActions ? (
            <SelectGroup
              className="gap-0.5 p-0"
              data-workspace-user-project-action-group="true"
            >
              {effectiveApi?.selectDirectory ? (
                <SelectItem
                  className={classNames?.item}
                  value={linkExistingProjectOptionValue}
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2 pr-1">
                    <LinkIcon aria-hidden size={15} />
                    <span className="truncate">
                      {resolvedLabels.linkExistingProject}
                    </span>
                  </span>
                </SelectItem>
              ) : null}
              {showCreateProjectAction ? (
                <SelectItem
                  className={classNames?.item}
                  value={addProjectOptionValue}
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2 pr-1">
                    {renderAddProjectIcon?.() ?? (
                      <NewWorkspaceLinedIcon
                        aria-hidden
                        data-workspace-user-project-add-icon="true"
                        size={15}
                      />
                    )}
                    <span className="truncate">
                      {resolvedLabels.addProject}
                    </span>
                  </span>
                </SelectItem>
              ) : null}
              {showNoProjectAction ? (
                <SelectItem
                  className={classNames?.item}
                  value={noProjectOptionValue}
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2 pr-1">
                    <NoWorkspaceLinedIcon
                      aria-hidden
                      data-agent-project-no-workspace-icon="true"
                      size={15}
                    />
                    <span className="truncate">{resolvedLabels.noProject}</span>
                  </span>
                </SelectItem>
              ) : null}
            </SelectGroup>
          ) : null}
        </SelectContent>
      </Select>
      {isProjectDialogOpen ? (
        <Dialog
          open
          onOpenChange={(nextOpen) => !nextOpen && closeProjectDialog()}
        >
          <DialogContent
            className="w-[480px] max-w-[calc(100vw-32px)] sm:max-w-[480px]"
            showCloseButton={false}
            onCloseAutoFocus={onDismissAutoFocus}
          >
            <form className="grid gap-4" onSubmit={submitProjectDialog}>
              <DialogHeader>
                <DialogTitle>{resolvedLabels.createProjectTitle}</DialogTitle>
                {createProjectNameDescription ? (
                  <DialogDescription>
                    {createProjectNameDescription}
                  </DialogDescription>
                ) : null}
              </DialogHeader>
              <label className="grid gap-1.5">
                <span className="sr-only">{createProjectNameInputLabel}</span>
                <Input
                  autoFocus
                  className="h-10"
                  disabled={disabled || isCreatingProject}
                  placeholder={resolvedLabels.createProjectNamePlaceholder}
                  value={draftProjectName}
                  onChange={(event) => {
                    setDraftProjectName(event.target.value);
                    if (projectCreationError) {
                      setProjectCreationError(null);
                    }
                  }}
                />
              </label>
              {projectCreationError ? (
                <p className="text-[13px] text-[var(--state-danger)]">
                  {projectCreationError}
                </p>
              ) : null}
              <DialogFooter>
                <Button
                  disabled={disabled || isCreatingProject}
                  size="dialog"
                  type="button"
                  variant="secondary"
                  onClick={closeProjectDialog}
                  onPointerDown={(event) => {
                    if (event.button === 0 && !isCreatingProject) {
                      closeProjectDialog();
                    }
                  }}
                >
                  {resolvedLabels.createProjectCancel}
                </Button>
                <Button
                  disabled={
                    disabled || isCreatingProject || !draftProjectName.trim()
                  }
                  size="dialog"
                  type="submit"
                >
                  {resolvedLabels.createProjectConfirm}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

function WorkspaceUserProjectOverflowLabel({
  className,
  label
}: {
  className?: string;
  label: string;
}): React.JSX.Element {
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const contentRef = useRef<HTMLSpanElement | null>(null);
  const updateMarqueeDistance = useCallback(() => {
    const root = rootRef.current;
    const content = contentRef.current;
    if (!root || !content) {
      return;
    }
    const overflowDistance = content.scrollWidth - root.clientWidth;
    if (overflowDistance <= 1) {
      root.style.setProperty(
        "--workspace-user-project-label-marquee-distance",
        "0px"
      );
      root.removeAttribute("data-overflow");
      return;
    }
    root.style.setProperty(
      "--workspace-user-project-label-marquee-distance",
      `${-overflowDistance}px`
    );
    root.setAttribute("data-overflow", "true");
  }, []);

  useEffect(() => {
    updateMarqueeDistance();

    const root = rootRef.current;
    const content = contentRef.current;
    if (!root || !content || typeof globalThis.ResizeObserver === "undefined") {
      return;
    }

    const observer = new globalThis.ResizeObserver(updateMarqueeDistance);
    observer.observe(root);
    observer.observe(content);
    return () => observer.disconnect();
  }, [label, updateMarqueeDistance]);

  return (
    <span
      ref={rootRef}
      className={cn("workspace-user-project-overflow-label", className)}
      data-workspace-user-project-overflow-label="true"
      onFocus={updateMarqueeDistance}
      onPointerEnter={updateMarqueeDistance}
    >
      <span
        ref={contentRef}
        className="workspace-user-project-overflow-label__content"
      >
        {label}
      </span>
    </span>
  );
}

function createWorkspaceUserProjectApiAdapter(
  api: WorkspaceUserProjectApi | null | undefined,
  service: WorkspaceUserProjectService | null | undefined
): WorkspaceUserProjectApi | null {
  if (!service) {
    return api ?? null;
  }
  const apiCheckPath = hasWorkspaceUserProjectMethod(api, "checkPath")
    ? (input: { path: string }) => api!.checkPath!(input)
    : undefined;
  const apiCreate = hasWorkspaceUserProjectMethod(api, "create")
    ? (input: { name: string }) => api!.create!(input)
    : undefined;
  const apiGetDefaultSelection = hasWorkspaceUserProjectMethod(
    api,
    "getDefaultSelection"
  )
    ? () => api!.getDefaultSelection!()
    : undefined;
  const apiIsNoProjectPath = hasWorkspaceUserProjectMethod(
    api,
    "isNoProjectPath"
  )
    ? (input: { path: string }) => api!.isNoProjectPath!(input)
    : undefined;
  const apiRememberDefaultSelection = hasWorkspaceUserProjectMethod(
    api,
    "rememberDefaultSelection"
  )
    ? (input: { path: string | null }) => api!.rememberDefaultSelection!(input)
    : undefined;
  const apiSelectDirectory = hasWorkspaceUserProjectMethod(
    api,
    "selectDirectory"
  )
    ? () => api!.selectDirectory!()
    : undefined;
  const apiUse = hasWorkspaceUserProjectMethod(api, "use")
    ? (input: { path: string }) => api!.use!(input)
    : undefined;
  return {
    checkPath: hasWorkspaceUserProjectMethod(service, "checkProjectPath")
      ? ({ path }) => service.checkProjectPath!(path)
      : apiCheckPath,
    create:
      apiCreate ??
      (hasWorkspaceUserProjectMethod(service, "createProject")
        ? ({ name }) => service.createProject!(name)
        : undefined),
    getDefaultSelection: hasWorkspaceUserProjectMethod(
      service,
      "getDefaultSelection"
    )
      ? () => service.getDefaultSelection!()
      : apiGetDefaultSelection,
    isNoProjectPath: hasWorkspaceUserProjectMethod(service, "isNoProjectPath")
      ? ({ path }) => service.isNoProjectPath!(path)
      : apiIsNoProjectPath,
    list: async () => {
      await (service.ensureLoaded?.() ?? service.refresh());
      return { projects: [...service.store.projects] };
    },
    prepareSelection: (input) => service.prepareSelection(input),
    rememberDefaultSelection: hasWorkspaceUserProjectMethod(
      service,
      "rememberDefaultSelection"
    )
      ? ({ path }) => service.rememberDefaultSelection!({ path })
      : apiRememberDefaultSelection,
    selectDirectory:
      apiSelectDirectory ??
      (hasWorkspaceUserProjectMethod(service, "selectDirectory")
        ? () => service.selectDirectory!()
        : undefined),
    use: hasWorkspaceUserProjectMethod(service, "registerProjectPath")
      ? ({ path }) => service.registerProjectPath!(path)
      : apiUse
  };
}

function hasWorkspaceUserProjectMethod(
  value: object | null | undefined,
  key: string
): boolean {
  return value ? typeof Reflect.get(value, key) === "function" : false;
}

function setApiUnavailableUnlessService(
  setIsApiUnavailable: (value: boolean) => void,
  service: WorkspaceUserProjectService | null | undefined,
  value = true
): void {
  if (!service) {
    setIsApiUnavailable(value);
  }
}

export function resolveWorkspaceUserProjectSelectLabels(
  i18n: WorkspaceUserProjectI18nRuntime = defaultWorkspaceUserProjectSelectI18n,
  overrides?: WorkspaceUserProjectSelectLabelOverrides
): WorkspaceUserProjectSelectLabels {
  return {
    addProject: overrides?.addProject ?? i18n.t("projectSelect.addProject"),
    createProjectCancel:
      overrides?.createProjectCancel ??
      i18n.t("projectSelect.createProjectCancel"),
    createProjectConfirm:
      overrides?.createProjectConfirm ??
      i18n.t("projectSelect.createProjectConfirm"),
    createProjectDocumentsUnavailable:
      overrides?.createProjectDocumentsUnavailable ??
      i18n.t("projectSelect.createProjectDocumentsUnavailable"),
    createProjectFailed:
      overrides?.createProjectFailed ??
      i18n.t("projectSelect.createProjectFailed"),
    createProjectNameConflict:
      overrides?.createProjectNameConflict ??
      i18n.t("projectSelect.createProjectNameConflict"),
    createProjectNameInvalid:
      overrides?.createProjectNameInvalid ??
      i18n.t("projectSelect.createProjectNameInvalid"),
    createProjectNameLabel:
      overrides?.createProjectNameLabel ??
      i18n.t("projectSelect.createProjectNameLabel"),
    createProjectNamePlaceholder:
      overrides?.createProjectNamePlaceholder ??
      i18n.t("projectSelect.createProjectNamePlaceholder"),
    createProjectNameRequired:
      overrides?.createProjectNameRequired ??
      i18n.t("projectSelect.createProjectNameRequired"),
    createProjectPermissionDenied:
      overrides?.createProjectPermissionDenied ??
      i18n.t("projectSelect.createProjectPermissionDenied"),
    createProjectTitle:
      overrides?.createProjectTitle ??
      i18n.t("projectSelect.createProjectTitle"),
    linkExistingProject:
      overrides?.linkExistingProject ??
      i18n.t("projectSelect.linkExistingProject"),
    loadingProjects:
      overrides?.loadingProjects ?? i18n.t("projectSelect.loadingProjects"),
    noProject: overrides?.noProject ?? i18n.t("projectSelect.noProject"),
    projectLabel:
      overrides?.projectLabel ?? i18n.t("projectSelect.projectLabel"),
    projectLocked:
      overrides?.projectLocked ?? i18n.t("projectSelect.projectLocked"),
    projectMissingTitle:
      overrides?.projectMissingTitle ??
      i18n.t("projectSelect.projectMissingTitle"),
    projectUnavailable:
      overrides?.projectUnavailable ??
      i18n.t("projectSelect.projectUnavailable")
  };
}

function resolveProjectCreationErrorLabel(
  error: unknown,
  labels: WorkspaceUserProjectSelectLabels
): string {
  switch (getWorkspaceUserProjectErrorCode(error)) {
    case "EEXIST":
    case "project_directory_already_exists":
      return labels.createProjectNameConflict;
    case "project_name_invalid":
      return labels.createProjectNameInvalid;
    case "EACCES":
    case "EPERM":
    case "project_directory_permission_denied":
      return labels.createProjectPermissionDenied;
    case "ENOENT":
    case "project_documents_unavailable":
      return labels.createProjectDocumentsUnavailable;
    default:
      return labels.createProjectFailed;
  }
}
