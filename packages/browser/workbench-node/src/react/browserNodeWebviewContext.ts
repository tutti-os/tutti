import { createContext, useContext } from "react";
import type { BrowserNodeWebviewTag } from "./webviewTag.ts";

export const BrowserNodeWebviewContext =
  createContext<BrowserNodeWebviewTag | null>(null);

export function useActiveBrowserNodeWebview(): BrowserNodeWebviewTag | null {
  return useContext(BrowserNodeWebviewContext);
}
