import { cleanup, render, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AgentMessageMermaid } from "./AgentMessageMermaid";

describe("AgentMessageMermaid real renderer", () => {
  const originalGetBBox = Object.getOwnPropertyDescriptor(
    SVGElement.prototype,
    "getBBox"
  );
  const originalGetComputedTextLength = Object.getOwnPropertyDescriptor(
    SVGElement.prototype,
    "getComputedTextLength"
  );

  beforeAll(() => {
    Object.defineProperties(SVGElement.prototype, {
      getBBox: {
        configurable: true,
        value: () => ({ height: 20, width: 120, x: 0, y: 0 })
      },
      getComputedTextLength: {
        configurable: true,
        value: () => 120
      }
    });
  });

  afterAll(() => {
    restoreProperty(SVGElement.prototype, "getBBox", originalGetBBox);
    restoreProperty(
      SVGElement.prototype,
      "getComputedTextLength",
      originalGetComputedTextLength
    );
  });

  afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute("data-theme");
  });

  it("keeps flowchart labels after the defense-in-depth sanitizer", async () => {
    document.documentElement.dataset.theme = "light";
    const view = render(
      <AgentMessageMermaid
        source={`%%{init: {"htmlLabels": true}}%%
          flowchart TD
            A["ACP Client<br/>启动 Agent"] --> B{"初始化成功？"}
            B -->|"是"| C["创建会话"]`}
        streaming={false}
      />
    );

    await waitFor(() => {
      expect(view.queryByTestId("agent-mermaid-svg")).not.toBeNull();
    });
    const container = view.getByTestId("agent-mermaid-svg");

    expect(container.querySelector("foreignObject")).toBeNull();
    expect(container.textContent).toContain("ACP Client");
    expect(container.textContent).toContain("启动 Agent");
    expect(container.textContent).toContain("初始化成功？");
    expect(container.textContent).toContain("创建会话");
  });
});

function restoreProperty(
  target: object,
  property: string,
  descriptor: PropertyDescriptor | undefined
): void {
  if (descriptor) {
    Object.defineProperty(target, property, descriptor);
    return;
  }
  Reflect.deleteProperty(target, property);
}
