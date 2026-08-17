import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DesktopCaptureWindow } from "../app/windows/capture/DesktopCaptureWindow.tsx";
import { createDesktopCaptureWindowContainer } from "../app/windows/capture/createDesktopCaptureWindowContainer.ts";
import "../style.css";

const root = document.querySelector<HTMLDivElement>("#capture-root");
if (!root) {
  throw new Error("Capture renderer root '#capture-root' was not found");
}
const container = createDesktopCaptureWindowContainer();

createRoot(root).render(
  <StrictMode>
    <DesktopCaptureWindow controller={container.controller} />
  </StrictMode>
);
