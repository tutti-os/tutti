import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type PointerEvent
} from "react";
import type { AgentGUIQuickComposerAgentTarget } from "@tutti-os/agent-gui/quick-composer";
import { Button, CloseIcon } from "@tutti-os/ui-system";
import { createTranslator } from "../../../../../shared/i18n/index.ts";
import type { DesktopCaptureWindowController } from "./desktopCaptureWindowController.ts";

const loadDesktopCaptureComposer = () => import("./DesktopCaptureComposer.tsx");
const DesktopCaptureComposer = lazy(async () => ({
  default: (await loadDesktopCaptureComposer()).DesktopCaptureComposer
}));

export function DesktopCaptureWindow({
  controller
}: {
  controller: DesktopCaptureWindowController;
}) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );
  const translator = useMemo(
    () => createTranslator(snapshot.capture?.locale ?? "en"),
    [snapshot.capture?.locale]
  );
  const agentTargets = useMemo<AgentGUIQuickComposerAgentTarget[]>(
    () =>
      (snapshot.capture?.agents ?? []).map((agent) => ({
        agentTargetId: agent.id,
        description: agent.description ?? undefined,
        iconUrl: agent.iconUrl,
        label: agent.name,
        provider: agent.provider
      })),
    [snapshot.capture?.agents]
  );
  const capabilitiesByAgentTargetId = useMemo(
    () =>
      Object.fromEntries(
        (snapshot.capture?.agents ?? []).map((agent) => [
          agent.id,
          agent.capabilities
        ])
      ),
    [snapshot.capture?.agents]
  );
  const composerOptions = useMemo(
    () =>
      snapshot.capture?.agents.find(
        (agent) => agent.id === snapshot.agentTargetId
      )?.composerOptions ?? null,
    [snapshot.agentTargetId, snapshot.capture?.agents]
  );
  useEffect(() => {
    void controller.initialize();
  }, [controller]);

  useEffect(() => {
    const capture = snapshot.capture;
    if (!capture) {
      return;
    }
    document.documentElement.lang = capture.locale;
    document.documentElement.dataset.theme = capture.themeAppearance;
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
  }, [snapshot.capture]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      controller.cancelSelection();
    };
    // Composer menus render in portals and handle Escape themselves. Capture
    // at the window boundary so Escape always cancels the ephemeral window.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [controller]);

  const pointerPosition = (
    event: PointerEvent<HTMLDivElement>
  ): { x: number; y: number } => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(bounds.width, event.clientX - bounds.left)),
      y: Math.max(0, Math.min(bounds.height, event.clientY - bounds.top))
    };
  };

  if (!snapshot.capture || snapshot.stage === "loading") {
    return (
      <div className="fixed inset-0 grid place-items-center bg-[var(--background)] font-[var(--font-ui)] text-[13px] leading-[1.4] text-[var(--text-secondary)]">
        {translator.t(snapshot.failed ? "capture.error" : "capture.loading")}
      </div>
    );
  }

  if (snapshot.stage === "selecting") {
    return (
      <div
        className={`fixed inset-0 overflow-hidden bg-transparent select-none ${snapshot.selectionPending ? "cursor-progress" : "cursor-crosshair"}`}
        onPointerDown={(event) => {
          void loadDesktopCaptureComposer();
          event.currentTarget.setPointerCapture(event.pointerId);
          controller.beginSelection(pointerPosition(event));
        }}
        onPointerMove={(event) =>
          controller.updateSelection(pointerPosition(event))
        }
        onPointerUp={(event) => {
          void controller.finishSelection().finally(() => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          });
        }}
      >
        <img
          alt={translator.t("capture.screenPreviewAlt")}
          className="pointer-events-none absolute inset-0 h-full w-full object-fill"
          draggable={false}
          src={snapshot.capture.screenshotDataUrl}
        />
        {snapshot.selection ? (
          <div
            className="pointer-events-none absolute z-[1] border border-[color-mix(in_srgb,var(--white-stationary)_92%,transparent)]"
            style={{
              boxShadow:
                "0 0 0 99999px color-mix(in srgb, var(--black-stationary) 46%, transparent), 0 0 0 1px color-mix(in srgb, var(--black-stationary) 36%, transparent)",
              height: snapshot.selection.height,
              left: snapshot.selection.x,
              top: snapshot.selection.y,
              width: snapshot.selection.width
            }}
          />
        ) : (
          <div className="pointer-events-none absolute inset-0 bg-[color-mix(in_srgb,var(--black-stationary)_46%,transparent)]" />
        )}
        <div className="pointer-events-none absolute top-6 left-1/2 z-[2] -translate-x-1/2 rounded-lg border border-[color-mix(in_srgb,var(--white-stationary)_18%,transparent)] bg-[color-mix(in_srgb,var(--black-stationary)_78%,transparent)] px-3 py-[7px] font-[var(--font-ui)] text-[13px] leading-[1.4] text-[var(--white-stationary)] shadow-[0_8px_30px_color-mix(in_srgb,var(--black-stationary)_26%,transparent)]">
          {translator.t(
            snapshot.selectionPending ? "capture.loading" : "capture.selectHint"
          )}
        </div>
        {snapshot.failed ? (
          <p
            className="absolute bottom-6 left-1/2 z-[2] m-0 -translate-x-1/2 rounded-lg bg-[var(--background-fronted)] px-3 py-2 text-[12px] text-[var(--state-danger)] shadow-panel"
            role="alert"
          >
            {translator.t("capture.error")}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <main className="fixed inset-0 flex overflow-hidden bg-transparent font-[var(--font-ui)] text-[var(--text-primary)]">
      <section className="flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-[14px] border border-[var(--border-1)] bg-[var(--background-fronted)]">
        <header className="flex h-10 shrink-0 items-center border-b border-[var(--border-1)]">
          <div className="flex h-full min-w-0 flex-1 !cursor-grab items-center gap-2 pl-3 [-webkit-app-region:drag] active:!cursor-grabbing">
            <h1 className="m-0 truncate text-[13px] leading-5 font-medium">
              {translator.t("capture.title")}
            </h1>
          </div>
          <Button
            aria-label={translator.t("common.close")}
            className="mr-2 shrink-0 [-webkit-app-region:no-drag]"
            disabled={snapshot.submitting}
            onClick={() => controller.cancelSelection()}
            size="icon-sm"
            variant="chrome"
          >
            <CloseIcon size={14} />
          </Button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2 [-webkit-app-region:no-drag]">
          {snapshot.stage === "preparing" ? (
            <div
              className={`grid min-h-0 flex-1 place-items-center rounded-[10px] border border-[var(--border-1)] text-[12px] ${snapshot.failed ? "text-[var(--state-danger)]" : "text-[var(--text-secondary)]"}`}
              role={snapshot.failed ? "alert" : "status"}
            >
              {translator.t(
                snapshot.failed ? "capture.error" : "capture.loading"
              )}
            </div>
          ) : (
            <div className="min-h-0 flex-1">
              <Suspense
                fallback={
                  <div
                    className="grid min-h-24 place-items-center rounded-[10px] border border-[var(--border-1)] text-[12px] text-[var(--text-secondary)]"
                    role="status"
                  >
                    {translator.t("capture.loading")}
                  </div>
                }
              >
                <DesktopCaptureComposer
                  agentTargets={agentTargets}
                  capabilitiesByAgentTargetId={capabilitiesByAgentTargetId}
                  composerOptions={composerOptions}
                  composerOptionsLoading={snapshot.refreshingAgentOptions}
                  composerSettings={snapshot.composerSettings}
                  content={snapshot.content}
                  controller={controller}
                  disabled={snapshot.submitting}
                  locale={snapshot.capture.locale}
                  projectPath={snapshot.projectPath}
                  selectedAgentTargetId={snapshot.agentTargetId}
                  taskActionHint={translator.t("capture.taskPromptHint")}
                  taskActionLabel={translator.t("capture.taskPromptAction")}
                  taskInstruction={translator.t("capture.taskPrompt")}
                  trackWithTask={snapshot.trackWithTask}
                  workspaceId={snapshot.capture.workspaceId}
                />
              </Suspense>
            </div>
          )}

          {snapshot.failed && snapshot.stage === "composing" ? (
            <p
              className="m-0 text-[11px] leading-4 text-[var(--state-danger)]"
              role="alert"
            >
              {translator.t("capture.error")}
            </p>
          ) : null}
        </div>
      </section>
    </main>
  );
}
