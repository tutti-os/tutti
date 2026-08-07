import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import type {
  TerminalPreviewChangeHandler,
  TerminalTheme,
  TerminalWriteEncoding
} from "../contracts/index.ts";
import type { TerminalNodeFeature } from "../core/feature.ts";
import { createTerminalScreenStateCache } from "../core/index.ts";
import type { TerminalSurfaceDiagnostics } from "../core/sessionDiagnostics.ts";
import { createTerminalFileLinkProvider } from "./terminalFileLinkProvider.ts";
import {
  resolveTerminalClipboardPlatform,
  resolveTerminalClipboardShortcut
} from "./terminalClipboardShortcuts.ts";
import { createTerminalImeInputGuard } from "./terminalImeInputGuard.ts";
import { resolveTerminalSurfaceOutputPlan } from "./terminalSurfaceOutputPlan.ts";
import { createTerminalPreviewSnapshot } from "./terminalSurfacePreview.ts";
import { resolveTerminalSurfaceResizePlan } from "./terminalSurfaceResizePlan.ts";
import { resolveTerminalSurfaceScreenCachePlan } from "./terminalSurfaceScreenCachePlan.ts";
import { drainTerminalWriteBatch } from "./terminalWriteBatch.ts";
import type { TerminalFindRuntime } from "./useTerminalFindController.ts";

const terminalScreenStateCache = createTerminalScreenStateCache();

export interface TerminalSurfaceRuntime extends TerminalFindRuntime {
  dispose(): void;
  focus(): void;
  setTheme(theme: TerminalTheme): void;
  syncOutput(rawOutput: string, contentEpoch: number): void;
}

export function createTerminalSurfaceRuntime(input: {
  container: HTMLElement;
  diagnostics: TerminalSurfaceDiagnostics;
  feature: TerminalNodeFeature;
  getCwd: () => string | null;
  nodeId: string;
  onResize: (size: { cols: number; rows: number }) => void;
  onPreviewChange?: TerminalPreviewChangeHandler;
  onUserInput: (data: string, encoding?: TerminalWriteEncoding) => void;
  sessionId: string;
  theme: TerminalTheme;
}): TerminalSurfaceRuntime {
  let contentEpoch = 0;
  let committedRawOutput = "";
  let initialLayoutFrame: number | null = null;
  let initialLayoutTimeout: number | null = null;
  let lastSize: { cols: number; rows: number } | null = null;
  let pendingRevealFinalizeFrame: number | null = null;
  let pendingRevealStartFrame: number | null = null;
  let pendingRevealWrite: {
    bytes: number;
    mode: "cache" | "replace";
    remainingChunkCount: number;
  } | null = null;
  let pendingWriteFrame: number | null = null;
  let pendingWriteChunks: string[] = [];
  let pendingRenderedWrite: {
    bytes: number;
    mode: "append" | "cache" | "replace";
    remainingChunkCount: number;
  } | null = null;
  let lastPreviewRevision: string | null = null;

  const terminal = new Terminal({
    allowProposedApi: false,
    convertEol: true,
    cursorBlink: true,
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    fontSize: 13,
    scrollback: input.feature.limits.maxScrollbackLines,
    theme: resolveXtermTheme(input.theme)
  });
  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon();
  const serializeAddon = new SerializeAddon();
  const webLinksAddon = new WebLinksAddon((_event, uri) => {
    void input.feature.linkHandler?.open({ url: uri });
  });
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(searchAddon);
  terminal.loadAddon(serializeAddon);
  terminal.loadAddon(webLinksAddon);
  const fileLinkDisposable = terminal.registerLinkProvider(
    createTerminalFileLinkProvider({
      feature: input.feature,
      getCwd: input.getCwd,
      terminal
    })
  );
  terminal.open(input.container);
  const imeInputGuard = createTerminalImeInputGuard({
    textarea: terminal.textarea
  });
  const clipboardPlatform = resolveTerminalClipboardPlatform();
  terminal.attachCustomKeyEventHandler((event) => {
    const clipboardAction = resolveTerminalClipboardShortcut(event, {
      hasSelection: terminal.hasSelection(),
      platform: clipboardPlatform
    });
    if (clipboardAction === "copy") {
      const clipboard = getNavigatorClipboard();
      const selection = terminal.getSelection();
      if (!clipboard || !selection) {
        return imeInputGuard.shouldProcessKeyEvent(event);
      }
      event.preventDefault();
      event.stopPropagation();
      void clipboard
        .writeText(selection)
        .catch(() => copyTerminalTextFallback(selection, terminal));
      return false;
    }
    if (clipboardAction === "paste") {
      const clipboard = getNavigatorClipboard();
      if (!clipboard) {
        return imeInputGuard.shouldProcessKeyEvent(event);
      }
      event.preventDefault();
      event.stopPropagation();
      void clipboard
        .readText()
        .then((text) => {
          if (text) {
            terminal.paste(text);
          }
        })
        .catch(() => undefined);
      return false;
    }
    return imeInputGuard.shouldProcessKeyEvent(event);
  });

  const dataSubscription = terminal.onData((data) => {
    input.onUserInput(data);
  });
  const binarySubscription = terminal.onBinary((data) => {
    input.onUserInput(data, "binary");
  });
  const writeParsedSubscription =
    typeof terminal.onWriteParsed === "function"
      ? terminal.onWriteParsed(() => {
          if (!pendingRenderedWrite) {
            refreshTerminalSurface();
            return;
          }
          const renderedWrite = pendingRenderedWrite;
          pendingRenderedWrite = null;
          if (
            renderedWrite.mode === "cache" ||
            renderedWrite.mode === "replace"
          ) {
            scheduleHydratedReveal({
              bytes: renderedWrite.bytes,
              mode: renderedWrite.mode,
              remainingChunkCount: renderedWrite.remainingChunkCount
            });
            return;
          }
          refreshTerminalSurface();
          logSurfaceWrite(
            renderedWrite.mode,
            renderedWrite.bytes,
            renderedWrite.remainingChunkCount
          );
        })
      : { dispose: () => undefined };

  const resizeTerminal = () => {
    try {
      fitAddon.fit();
    } catch {
      return;
    }
    const plan = resolveTerminalSurfaceResizePlan({
      lastSize,
      nextSize: { cols: terminal.cols, rows: terminal.rows }
    });
    if (!plan) {
      return;
    }
    lastSize = plan;
    input.onResize(plan);
  };

  const resizeObserver =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => resizeTerminal());
  resizeObserver?.observe(input.container);
  scheduleInitialLayoutSync();

  const cached = terminalScreenStateCache.get(input.nodeId, input.sessionId);
  if (cached) {
    terminal.write(cached.serialized, () => {
      queueRenderedWrite("cache", cached.serialized.length, 0);
    });
    committedRawOutput = cached.rawSnapshot;
  }

  return {
    dispose() {
      resizeObserver?.disconnect();
      dataSubscription.dispose();
      binarySubscription.dispose();
      writeParsedSubscription.dispose();
      fileLinkDisposable.dispose();
      imeInputGuard.dispose();
      clearInitialLayoutSync();
      clearPendingReveal();
      const hasPendingWrites =
        pendingWriteFrame !== null || pendingWriteChunks.length > 0;
      const cachePlan = resolveTerminalSurfaceScreenCachePlan({
        hasPendingWrites,
        rawSnapshot: committedRawOutput,
        serialized: hasPendingWrites ? "" : serializeAddon.serialize()
      });
      if (cachePlan.action === "save") {
        terminalScreenStateCache.set(input.nodeId, {
          cols: terminal.cols,
          rawSnapshot: cachePlan.rawSnapshot,
          rows: terminal.rows,
          serialized: cachePlan.serialized,
          sessionId: input.sessionId
        });
      } else if (cachePlan.action === "remove") {
        terminalScreenStateCache.remove(input.nodeId, input.sessionId);
      }
      clearPendingWrites();
      emitTerminalPreviewSnapshot();
      terminal.dispose();
    },
    findNext(query, options) {
      searchAddon.findNext(query, options);
    },
    findPrevious(query, options) {
      searchAddon.findPrevious(query, options);
    },
    focus() {
      terminal.focus();
      resizeTerminal();
    },
    setTheme(theme) {
      terminal.options.theme = resolveXtermTheme(theme);
      emitTerminalPreviewSnapshot();
    },
    syncOutput(rawOutput, nextContentEpoch) {
      const plan = resolveTerminalSurfaceOutputPlan({
        committedRawOutput,
        contentEpoch,
        nextContentEpoch,
        rawOutput
      });
      input.diagnostics.outputSync({
        contentEpoch: nextContentEpoch,
        nextCommittedBytes:
          plan?.nextCommittedRawOutput.length ?? committedRawOutput.length,
        plan: resolveOutputSyncPlan(plan),
        previousCommittedBytes: committedRawOutput.length,
        rawBytes: rawOutput.length,
        writeBytes: plan?.write?.length ?? 0
      });
      if (!plan) {
        return;
      }
      contentEpoch = plan.nextContentEpoch;
      if (plan.reset && plan.write) {
        replaceTerminalView(plan.write, { reset: true });
      } else if (plan.reset) {
        resetTerminalView();
      }
      if (plan.write && !plan.reset) {
        writeToTerminal(plan.write);
      }
      committedRawOutput = plan.nextCommittedRawOutput;
    }
  };

  function clearPendingWrites() {
    pendingWriteChunks = [];
    if (pendingWriteFrame === null) {
      return;
    }
    if (typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(pendingWriteFrame);
    } else {
      clearTimeout(pendingWriteFrame);
    }
    pendingWriteFrame = null;
  }

  function clearInitialLayoutSync() {
    if (initialLayoutFrame !== null) {
      if (typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(initialLayoutFrame);
      } else {
        clearTimeout(initialLayoutFrame);
      }
      initialLayoutFrame = null;
    }
    if (initialLayoutTimeout !== null) {
      clearTimeout(initialLayoutTimeout);
      initialLayoutTimeout = null;
    }
  }

  function clearPendingReveal() {
    if (pendingRevealStartFrame !== null) {
      if (typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(pendingRevealStartFrame);
      } else {
        clearTimeout(pendingRevealStartFrame);
      }
      pendingRevealStartFrame = null;
    }
    if (pendingRevealFinalizeFrame !== null) {
      if (typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(pendingRevealFinalizeFrame);
      } else {
        clearTimeout(pendingRevealFinalizeFrame);
      }
      pendingRevealFinalizeFrame = null;
    }
    pendingRevealWrite = null;
  }

  function flushPendingWrites() {
    pendingWriteFrame = null;
    const batch = drainTerminalWriteBatch(
      pendingWriteChunks,
      input.feature.limits.maxWriteBatchBytes
    );
    pendingWriteChunks = batch.remainingChunks;

    if (!batch.nextWrite) {
      return;
    }
    terminal.write(batch.nextWrite, () => {
      queueRenderedWrite(
        "append",
        batch.nextWrite.length,
        pendingWriteChunks.length
      );
      if (pendingWriteChunks.length > 0) {
        requestWriteFlush();
      }
    });
  }

  function requestWriteFlush() {
    if (pendingWriteFrame !== null) {
      return;
    }
    if (typeof requestAnimationFrame === "function") {
      pendingWriteFrame = requestAnimationFrame(flushPendingWrites);
      return;
    }
    pendingWriteFrame = window.setTimeout(flushPendingWrites, 0);
  }

  function resetTerminalView() {
    clearPendingReveal();
    clearPendingWrites();
    terminal.reset();
    refreshTerminalSurface();
    logSurfaceWrite("reset", 0, 0);
  }

  function replaceTerminalView(
    data: string,
    options?: {
      reset?: boolean;
    }
  ) {
    const transformed =
      input.feature.outputTransform?.({
        data,
        sessionId: input.sessionId
      }) ?? data;
    if (transformed == null || transformed === "") {
      return;
    }
    clearPendingReveal();
    clearPendingWrites();
    if (options?.reset) {
      terminal.reset();
    }
    terminal.write(transformed, () => {
      queueRenderedWrite("replace", transformed.length, 0);
    });
  }

  function refreshTerminalSurface() {
    if (terminal.rows <= 0) {
      return;
    }
    terminal.refresh(0, terminal.rows - 1);
    emitTerminalPreviewSnapshot();
  }

  function emitTerminalPreviewSnapshot() {
    if (!input.onPreviewChange || terminal.cols <= 0 || terminal.rows <= 0) {
      return;
    }
    const snapshot = createTerminalPreviewSnapshot(terminal);
    if (snapshot.revision === lastPreviewRevision) {
      return;
    }
    lastPreviewRevision = snapshot.revision;
    input.onPreviewChange({
      nodeId: input.nodeId,
      sessionId: input.sessionId,
      snapshot
    });
  }

  function scheduleInitialLayoutSync() {
    resizeTerminal();
    if (typeof requestAnimationFrame === "function") {
      initialLayoutFrame = requestAnimationFrame(() => {
        initialLayoutFrame = null;
        resizeTerminal();
        refreshTerminalSurface();
      });
    } else {
      initialLayoutFrame = window.setTimeout(() => {
        initialLayoutFrame = null;
        resizeTerminal();
        refreshTerminalSurface();
      }, 0);
    }
    initialLayoutTimeout = window.setTimeout(() => {
      initialLayoutTimeout = null;
      resizeTerminal();
      refreshTerminalSurface();
    }, 32);
  }

  function scheduleTerminalWrite(data: string) {
    pendingWriteChunks.push(data);
    requestWriteFlush();
  }

  function writeToTerminal(data: string) {
    const transformed =
      input.feature.outputTransform?.({
        data,
        sessionId: input.sessionId
      }) ?? data;
    if (transformed == null || transformed === "") {
      return;
    }
    scheduleTerminalWrite(transformed);
  }

  function queueRenderedWrite(
    mode: "append" | "cache" | "replace",
    bytes: number,
    remainingChunkCount: number
  ) {
    if (pendingRenderedWrite && pendingRenderedWrite.mode === mode) {
      pendingRenderedWrite = {
        bytes: pendingRenderedWrite.bytes + bytes,
        mode,
        remainingChunkCount
      };
      return;
    }
    pendingRenderedWrite = {
      bytes,
      mode,
      remainingChunkCount
    };
  }

  function scheduleHydratedReveal(write: {
    bytes: number;
    mode: "cache" | "replace";
    remainingChunkCount: number;
  }) {
    if (pendingRevealWrite) {
      pendingRevealWrite = {
        bytes: pendingRevealWrite.bytes + write.bytes,
        mode: write.mode,
        remainingChunkCount: write.remainingChunkCount
      };
    } else {
      pendingRevealWrite = write;
    }
    if (
      pendingRevealStartFrame !== null ||
      pendingRevealFinalizeFrame !== null
    ) {
      return;
    }
    pendingRevealStartFrame = requestTerminalFrame(() => {
      pendingRevealStartFrame = null;
      resizeTerminal();
      pendingRevealFinalizeFrame = requestTerminalFrame(() => {
        pendingRevealFinalizeFrame = null;
        refreshTerminalSurface();
        const revealWrite = pendingRevealWrite;
        pendingRevealWrite = null;
        if (!revealWrite) {
          return;
        }
        logSurfaceWrite(
          revealWrite.mode,
          revealWrite.bytes,
          revealWrite.remainingChunkCount
        );
      });
    });
  }

  function logSurfaceWrite(
    mode: "append" | "cache" | "replace" | "reset",
    bytes: number,
    remainingChunkCount: number
  ) {
    const buffer = terminal.buffer.active;
    const xtermElement =
      input.container.querySelector(".xterm") instanceof HTMLElement
        ? (input.container.querySelector(".xterm") as HTMLElement)
        : null;
    const screenElement =
      input.container.querySelector(".xterm-screen") instanceof HTMLElement
        ? (input.container.querySelector(".xterm-screen") as HTMLElement)
        : null;
    const helperElement =
      input.container.querySelector(".xterm-helpers") instanceof HTMLElement
        ? (input.container.querySelector(".xterm-helpers") as HTMLElement)
        : null;
    const rowContainerElement =
      input.container.querySelector(".xterm-rows") instanceof HTMLElement
        ? (input.container.querySelector(".xterm-rows") as HTMLElement)
        : null;
    const firstCanvas =
      screenElement?.querySelector("canvas") instanceof HTMLCanvasElement
        ? (screenElement.querySelector("canvas") as HTMLCanvasElement)
        : null;
    const firstLine = buffer.getLine(0)?.translateToString(true) ?? "";
    const cursorLine =
      buffer.getLine(buffer.cursorY)?.translateToString(true) ?? "";
    const xtermStyle = xtermElement
      ? window.getComputedStyle(xtermElement)
      : null;
    const screenStyle = screenElement
      ? window.getComputedStyle(screenElement)
      : null;
    const renderDimensions = resolveXtermRenderDimensions(terminal);
    input.diagnostics.outputWritten({
      bufferCursorX: buffer.cursorX,
      bufferCursorY: buffer.cursorY,
      bufferLength: buffer.length,
      bytes,
      canvasClientHeight: firstCanvas?.clientHeight ?? 0,
      canvasClientWidth: firstCanvas?.clientWidth ?? 0,
      canvasCount: screenElement?.querySelectorAll("canvas").length ?? 0,
      cols: terminal.cols,
      containerClientHeight: input.container.clientHeight,
      containerClientWidth: input.container.clientWidth,
      cursorLinePreview: previewTerminalLine(cursorLine),
      firstLinePreview: previewTerminalLine(firstLine),
      helperChildCount: helperElement?.childElementCount ?? 0,
      mode,
      remainingChunkCount,
      renderDimensionsReady: renderDimensions !== undefined,
      rowContainerChildCount: rowContainerElement?.childElementCount ?? 0,
      rowContainerTextPreview: previewTerminalLine(
        rowContainerElement?.textContent ?? ""
      ),
      rows: terminal.rows,
      screenChildCount: screenElement?.childElementCount ?? 0,
      screenClientHeight: screenElement?.clientHeight ?? 0,
      screenClientWidth: screenElement?.clientWidth ?? 0,
      screenDisplay: screenStyle?.display ?? "",
      screenOpacity: screenStyle?.opacity ?? "",
      screenVisibility: screenStyle?.visibility ?? "",
      serializedBytes: serializeAddon.serialize().length,
      xtermClientHeight: xtermElement?.clientHeight ?? 0,
      xtermClientWidth: xtermElement?.clientWidth ?? 0,
      xtermDisplay: xtermStyle?.display ?? "",
      xtermOpacity: xtermStyle?.opacity ?? "",
      xtermVisibility: xtermStyle?.visibility ?? ""
    });
  }
}

function getNavigatorClipboard(): Clipboard | null {
  if (typeof navigator === "undefined") {
    return null;
  }
  return navigator.clipboard ?? null;
}

function copyTerminalTextFallback(text: string, terminal: Terminal): void {
  const document = terminal.element?.ownerDocument;
  if (!document?.body) {
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand("copy");
  } finally {
    textarea.remove();
    terminal.focus();
  }
}

function requestTerminalFrame(callback: () => void) {
  if (typeof requestAnimationFrame === "function") {
    return requestAnimationFrame(callback);
  }
  return window.setTimeout(callback, 0);
}

function resolveOutputSyncPlan(
  plan: ReturnType<typeof resolveTerminalSurfaceOutputPlan>
): "append" | "replace" | "reset" | "skip" {
  if (!plan) {
    return "skip";
  }
  if (plan.reset && plan.write) {
    return "replace";
  }
  if (plan.reset) {
    return "reset";
  }
  return "append";
}

function resolveXtermRenderDimensions(terminal: Terminal): unknown {
  const core: unknown = Reflect.get(terminal, "_core");
  if (core == null || typeof core !== "object") {
    return undefined;
  }
  const renderService: unknown = Reflect.get(core, "_renderService");
  if (renderService == null || typeof renderService !== "object") {
    return undefined;
  }
  return Reflect.get(renderService, "dimensions");
}

function previewTerminalLine(value: string, maxChars = 80) {
  return value
    .slice(0, maxChars)
    .replaceAll("\\", "\\\\")
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n");
}

function resolveXtermTheme(theme: TerminalTheme) {
  return {
    background: theme.background,
    cursor: theme.cursor,
    foreground: theme.foreground,
    selectionBackground: theme.selectionBackground
  };
}
