import electron from "electron";
import type {
  TuttiExternalPdfMargin,
  TuttiExternalPdfPrintHtmlInput,
  TuttiExternalPdfPrintHtmlResult
} from "@tutti-os/workspace-external-core/contracts";
import type { WorkspaceAppGuestContext } from "./workspaceAppContextTypes.ts";

const { BrowserWindow } = electron;

type WorkspaceAppPrintLoadListener = (...args: unknown[]) => void;

interface WorkspaceAppPrintWebContents {
  loadURL(url: string): Promise<void>;
  off(event: string, listener: WorkspaceAppPrintLoadListener): unknown;
  once(event: string, listener: WorkspaceAppPrintLoadListener): unknown;
}

export async function printWorkspaceAppHtmlToPdf(
  context: WorkspaceAppGuestContext,
  input: TuttiExternalPdfPrintHtmlInput
): Promise<TuttiExternalPdfPrintHtmlResult> {
  const printWindow = new BrowserWindow({
    height: 900,
    parent: context.ownerWindow,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      session: context.ownerWindow.webContents.session
    },
    width: 720
  });

  try {
    await loadWorkspaceAppPrintHtml(printWindow.webContents, input);
    const pdf = await printWindow.webContents.printToPDF({
      margins: printMargins(input.margin),
      pageSize: input.pageSize ?? "A4",
      preferCSSPageSize: input.preferCSSPageSize === true,
      printBackground: input.printBackground !== false
    });
    return { bytes: new Uint8Array(pdf) };
  } finally {
    if (!printWindow.isDestroyed()) {
      printWindow.destroy();
    }
  }
}

export function loadWorkspaceAppPrintHtml(
  contents: WorkspaceAppPrintWebContents,
  input: TuttiExternalPdfPrintHtmlInput
): Promise<void> {
  const html = prepareWorkspaceAppPrintHtml(input);
  const url = `data:text/html;charset=utf-8;base64,${Buffer.from(html, "utf8").toString("base64")}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("PDF print HTML load timed out."));
    }, 30_000);
    const cleanup = (): void => {
      clearTimeout(timeout);
      contents.off("did-finish-load", handleLoaded);
      contents.off("did-fail-load", handleFailed);
    };
    const handleLoaded = (): void => {
      cleanup();
      resolve();
    };
    const handleFailed: WorkspaceAppPrintLoadListener = (...args) => {
      const errorDescription =
        typeof args[2] === "string"
          ? args[2]
          : "PDF print HTML failed to load.";
      cleanup();
      reject(new Error(errorDescription));
    };
    contents.once("did-finish-load", handleLoaded);
    contents.once("did-fail-load", handleFailed);
    void contents.loadURL(url).catch((error: unknown) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

export function prepareWorkspaceAppPrintHtml(
  input: TuttiExternalPdfPrintHtmlInput
): string {
  const base = input.baseUrl
    ? `<base href="${escapeHtml(input.baseUrl)}">`
    : "";
  const title = input.title ? `<title>${escapeHtml(input.title)}</title>` : "";
  const printHead = `${base}${title}`;
  if (!printHead) {
    return input.html;
  }
  if (/<head[^>]*>/iu.test(input.html)) {
    return input.html.replace(/<head([^>]*)>/iu, `<head$1>${printHead}`);
  }
  if (/<html[^>]*>/iu.test(input.html)) {
    return input.html.replace(
      /<html([^>]*)>/iu,
      `<html$1><head>${printHead}</head>`
    );
  }
  return `<!DOCTYPE html><html><head>${printHead}</head><body>${input.html}</body></html>`;
}

export function printMargins(
  margin: TuttiExternalPdfMargin | undefined
): Electron.Margins | undefined {
  if (!margin) {
    return undefined;
  }
  return {
    marginType: "custom",
    bottom: marginToPixels(margin.bottom),
    left: marginToPixels(margin.left),
    right: marginToPixels(margin.right),
    top: marginToPixels(margin.top)
  };
}

function marginToPixels(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const match = value.match(/^(\d+(?:\.\d+)?)(px|in|cm|mm)$/u);
  if (!match) {
    return 0;
  }
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === "px") {
    return amount;
  }
  if (unit === "in") {
    return amount * 96;
  }
  if (unit === "cm") {
    return (amount / 2.54) * 96;
  }
  return (amount / 25.4) * 96;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}
