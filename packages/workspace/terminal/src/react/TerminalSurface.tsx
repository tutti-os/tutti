import { useEffect, useMemo, useRef, useState } from "react";
import type {
  TerminalNodeExternalState,
  TerminalPreviewChangeHandler,
  TerminalSessionStatus
} from "../contracts/index.ts";
import type { TerminalNodeFeature } from "../core/feature.ts";
import { createTerminalSurfaceDiagnostics } from "../core/sessionDiagnostics.ts";
import { createTerminalSurfaceRuntime } from "./terminalSurfaceRuntime.ts";
import { isTerminalFindShortcut } from "./terminalFindShortcut.ts";
import { useTerminalFindController } from "./useTerminalFindController.ts";
import { useTerminalSessionController } from "./useTerminalSessionController.ts";

export interface TerminalSurfaceProps {
  controllerLeaseRetainedExternally?: boolean;
  externalState: TerminalNodeExternalState | null;
  feature: TerminalNodeFeature;
  nodeId: string;
  onPreviewChange?: TerminalPreviewChangeHandler;
  sessionId: string;
  status: TerminalSessionStatus;
}

export function TerminalSurface({
  controllerLeaseRetainedExternally = false,
  externalState,
  feature,
  nodeId,
  onPreviewChange,
  sessionId,
  status
}: TerminalSurfaceProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const currentCwdRef = useRef<string | null>(externalState?.cwd ?? null);
  const featureRef = useRef(feature);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const runtimeRef = useRef<ReturnType<
    typeof createTerminalSurfaceRuntime
  > | null>(null);
  const [interactionError, setInteractionError] = useState<string | null>(null);
  const { controller, state } = useTerminalSessionController({
    feature,
    nodeId,
    retainLease: !controllerLeaseRetainedExternally,
    sessionId
  });
  const find = useTerminalFindController({
    getRuntime: () => runtimeRef.current
  });
  const theme = useMemo(
    () =>
      feature.resolveTheme({
        runtimeKind: externalState?.runtimeKind ?? "local",
        sessionId,
        status
      }),
    [externalState?.runtimeKind, feature, sessionId, status]
  );
  const surfaceDiagnostics = useMemo(
    () =>
      createTerminalSurfaceDiagnostics({
        diagnostics: feature.diagnostics,
        nodeId,
        sessionId
      }),
    [feature.diagnostics, nodeId, sessionId]
  );
  const surfaceError = interactionError ?? state.surfaceError;

  useEffect(() => {
    currentCwdRef.current = externalState?.cwd ?? null;
  }, [externalState?.cwd]);

  useEffect(() => {
    featureRef.current = feature;
  }, [feature]);

  useEffect(() => {
    if (!find.state.open) {
      return;
    }
    const input = findInputRef.current;
    if (!input) {
      return;
    }
    input.focus();
    input.select();
  }, [find.state.open]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    surfaceDiagnostics.mount();
    setInteractionError(null);

    const runtime = createTerminalSurfaceRuntime({
      container,
      diagnostics: surfaceDiagnostics,
      feature: featureRef.current,
      getCwd: () => currentCwdRef.current,
      nodeId,
      onResize: ({ cols, rows }) => {
        surfaceDiagnostics.resize({ cols, rows });
        void controller.resize({ cols, rows });
      },
      onPreviewChange,
      onUserInput: (data, encoding) => {
        controller.write(data, encoding);
      },
      sessionId,
      theme
    });
    runtimeRef.current = runtime;
    runtime.syncOutput(state.rawOutput, state.contentEpoch);
    runtime.focus();

    return () => {
      surfaceDiagnostics.dispose();
      runtime.dispose();
      if (runtimeRef.current === runtime) {
        runtimeRef.current = null;
      }
    };
  }, [controller, nodeId, sessionId, surfaceDiagnostics]);

  useEffect(() => {
    runtimeRef.current?.setTheme(theme);
  }, [theme]);

  useEffect(() => {
    runtimeRef.current?.syncOutput(state.rawOutput, state.contentEpoch);
  }, [state.contentEpoch, state.rawOutput]);

  const writeInput = (data: string) => {
    controller.write(data);
  };

  return (
    <div
      className="workspace-terminal__surface-shell"
      onKeyDownCapture={(event) => {
        if (!isTerminalFindShortcut(event)) {
          if (event.key === "Escape" && find.state.open) {
            find.actions.close();
            runtimeRef.current?.focus();
          }
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        find.actions.open();
      }}
      onDragOver={(event) => {
        if (feature.dropInput) {
          event.preventDefault();
        }
      }}
      onDrop={(event) => {
        if (!feature.dropInput) {
          return;
        }
        event.preventDefault();
        void Promise.resolve(
          feature.dropInput({
            cwd: externalState?.cwd ?? null,
            dataTransfer: event.dataTransfer,
            sessionId
          })
        )
          .then((input) => {
            if (input) {
              writeInput(input);
            }
          })
          .catch((error: unknown) => setInteractionError(errorMessage(error)));
      }}
    >
      {find.state.open ? (
        <form
          className="workspace-terminal__find"
          onSubmit={(event) => {
            event.preventDefault();
            find.actions.onSubmit();
          }}
        >
          <input
            aria-label={feature.i18n.t("findPlaceholder")}
            ref={findInputRef}
            onChange={(event) => {
              find.actions.onQueryChange(event.currentTarget.value);
            }}
            placeholder={feature.i18n.t("findPlaceholder")}
            type="search"
            value={find.state.query}
          />
          <button
            className="workspace-terminal__find-toggle"
            aria-label={feature.i18n.t("actions.caseSensitive")}
            aria-pressed={find.state.caseSensitive}
            onClick={() => find.actions.toggleCaseSensitive()}
            type="button"
          >
            Aa
          </button>
          <button
            className="workspace-terminal__find-toggle"
            aria-label={feature.i18n.t("actions.regex")}
            aria-pressed={find.state.regex}
            onClick={() => find.actions.toggleRegex()}
            type="button"
          >
            .*
          </button>
          <button
            className="workspace-terminal__find-nav workspace-terminal__find-nav--previous"
            aria-label={feature.i18n.t("actions.previous")}
            onClick={() => find.actions.findPrevious()}
            type="button"
          />
          <button
            className="workspace-terminal__find-nav workspace-terminal__find-nav--next"
            aria-label={feature.i18n.t("actions.next")}
            onClick={() => find.actions.findNext()}
            type="submit"
          />
        </form>
      ) : null}
      <div
        className="workspace-terminal__xterm"
        data-terminal-xterm=""
        ref={containerRef}
      />
      {surfaceError ? (
        <div className="workspace-terminal__surface-error" role="status">
          {surfaceError}
        </div>
      ) : null}
    </div>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
