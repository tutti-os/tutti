import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { WorkbenchDockComponentPreviewFrame } from "./WorkbenchDockComponentPreviewFrame.tsx";

describe("WorkbenchDockComponentPreviewFrame", () => {
  it("owns preview geometry and keeps decorative content out of hit testing", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const previousActEnvironment = (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT;
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    try {
      await act(async () => {
        root.render(
          <WorkbenchDockComponentPreviewFrame
            sourceSize={{ height: 560, width: 1040 }}
            viewport={{ height: 95, width: 157 }}
          >
            <span data-preview-content="true" />
          </WorkbenchDockComponentPreviewFrame>
        );
      });

      const frame = container.querySelector<HTMLElement>(
        "[data-workbench-dock-component-preview-frame]"
      );
      const content = container.querySelector<HTMLElement>(
        "[data-workbench-dock-component-preview-content]"
      );

      expect(frame?.getAttribute("aria-hidden")).toBe("true");
      expect(frame?.style.height).toBe("95px");
      expect(frame?.style.pointerEvents).toBe("none");
      expect(frame?.style.width).toBe("157px");
      expect(content?.style.height).toBe("560px");
      expect(content?.style.transform).toBe(
        "translate(-50%, -50%) scale(0.15096153846153845)"
      );
      expect(content?.style.width).toBe("1040px");
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      (
        globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
      ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
  });
});
