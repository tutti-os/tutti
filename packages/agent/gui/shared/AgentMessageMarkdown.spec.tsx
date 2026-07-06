import "@testing-library/jest-dom/vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentMessageMarkdown,
  resetCachedMarkdownImagesForTests,
  splitStreamingMarkdownBlocks
} from "./AgentMessageMarkdown";
import {
  MANAGED_AGENT_ICON_ROUNDED_URLS,
  managedAgentRoundedIconUrl
} from "./managedAgentIcons";

describe("AgentMessageMarkdown", () => {
  afterEach(() => {
    resetCachedMarkdownImagesForTests();
  });

  it("renders a workspace-reference mention as one chip without a file-count badge", () => {
    const href = `mention://workspace-reference/topic1?count=3&icon=${encodeURIComponent("https://x.png")}&source=task&workspaceId=ws1`;
    render(
      <AgentMessageMarkdown content={`[@我的小项目](${href}) 里面有啥`} />
    );
    const chip = screen.getByRole("link", { name: "我的小项目" });
    expect(chip).toHaveAttribute(
      "data-agent-mention-kind",
      "workspace-reference"
    );
    expect(chip).toHaveAttribute("data-agent-reference-source", "task");
    // 角标数字已移除:chip 只展示标签,不再渲染文件数。
    expect(chip).toHaveTextContent("我的小项目");
    expect(chip).not.toHaveTextContent("3");
  });

  it("renders app workspace-reference mentions with app icons", () => {
    const iconUrl = "data:image/png;base64,canvas";
    const { container } = render(
      <AgentMessageMarkdown
        content="使用 [@AI Canvas](mention://workspace-reference/ai-canvas?source=app&workspaceId=room-1)"
        workspaceAppIcons={[
          {
            appId: "ai-canvas",
            iconUrl,
            workspaceId: "room-1"
          }
        ]}
      />
    );

    const mention = container.querySelector('[data-agent-file-mention="true"]');
    expect(mention).toHaveAttribute(
      "data-agent-mention-kind",
      "workspace-reference"
    );
    expect(mention).toHaveAttribute("data-agent-reference-source", "app");
    expect(mention).toHaveAttribute("data-agent-mention-icon-url", iconUrl);
    expect(
      mention?.querySelector('[data-agent-mention-app-icon="true"] img')
    ).toHaveAttribute("src", iconUrl);
    expect(mention).toHaveTextContent("AI Canvas");
  });

  it("renders markdown links, inline code, and lists", () => {
    render(
      <AgentMessageMarkdown
        content={
          "已读取 [README.md](README.md) 和 `src/App.tsx`，**重点**\n\n- 第一项\n- 第二项"
        }
      />
    );

    expect(screen.queryByRole("link", { name: "README.md" })).toBeNull();
    expect(screen.getByText("README.md")).toBeInTheDocument();
    expect(screen.getByText("src/App.tsx")).toBeInTheDocument();
    expect(screen.getByText("重点").tagName).toBe("STRONG");
    expect(screen.getByText("第一项")).toBeInTheDocument();
    expect(screen.getByText("第二项")).toBeInTheDocument();
    expect(screen.getByRole("list")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });
  it("renders GFM tables as table elements", () => {
    render(
      <AgentMessageMarkdown
        content={
          "| 模式 | 体现 |\n| --- | --- |\n| 多模型抽象 | 统一 API 格式适配不同 LLM 提供商 |\n| 插件化 Skills | 跨 Agent 共享 |"
        }
      />
    );

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "模式" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("cell", { name: "统一 API 格式适配不同 LLM 提供商" })
    ).toBeInTheDocument();
  });
  it("keeps links inert for now", () => {
    render(
      <AgentMessageMarkdown
        content={"打开 [本地服务](http://127.0.0.1:8765/)"}
      />
    );

    const link = screen.getByRole("link", { name: "本地服务" });
    const event = fireEvent.click(link);

    expect(event).toBe(false);
  });

  it("renders relative markdown links as plain text", () => {
    const onLinkAction = vi.fn();
    render(
      <AgentMessageMarkdown
        content={
          "已读取 [README.md](README.md)，目录 [content/posts](content/posts)。"
        }
        onLinkAction={onLinkAction}
        workspaceLinkContext={{
          workspaceRoot: "/Users/local/project",
          basePath: "/Users/local/project/docs",
          source: "agent-markdown"
        }}
      />
    );

    expect(screen.queryByRole("link", { name: "README.md" })).toBeNull();
    expect(screen.queryByRole("link", { name: "content/posts" })).toBeNull();
    expect(screen.getByText("README.md")).toBeInTheDocument();
    expect(screen.getByText("content/posts")).toBeInTheDocument();
    expect(onLinkAction).not.toHaveBeenCalled();
  });

  it("keeps standard markdown link hrefs clickable", () => {
    const onLinkClick = vi.fn();
    render(
      <AgentMessageMarkdown
        content={
          "[Email](mailto:hello@example.com) [Phone](tel:+123456789) [Section](#details) [Chat](xmpp:hello@example.com)"
        }
        onLinkClick={onLinkClick}
      />
    );

    for (const [label, href] of [
      ["Email", "mailto:hello@example.com"],
      ["Phone", "tel:+123456789"],
      ["Section", "#details"],
      ["Chat", "xmpp:hello@example.com"]
    ] as const) {
      fireEvent.click(screen.getByRole("link", { name: label }));
      expect(onLinkClick).toHaveBeenLastCalledWith(href);
    }
  });

  it("renders unsafe markdown links as plain text", () => {
    const onLinkClick = vi.fn();
    render(
      <AgentMessageMarkdown
        content={"不要打开 [bad](javascript:alert(1))"}
        onLinkClick={onLinkClick}
      />
    );

    expect(screen.queryByRole("link", { name: "bad" })).toBeNull();
    expect(screen.getByText("bad")).toBeInTheDocument();
    expect(onLinkClick).not.toHaveBeenCalled();
  });

  it("does not nest path links inside markdown links with inline code labels", () => {
    const onLinkClick = vi.fn();
    const { container } = render(
      <AgentMessageMarkdown
        content={
          "已创建 [`AGENTS.md`](/Users/ryan/Documents/tutti/proj2/AGENTS.md)"
        }
        onLinkClick={onLinkClick}
        workspaceLinkContext={{
          workspaceRoot: "/Users/ryan/Documents/tutti/proj2",
          basePath: "/Users/ryan/Documents/tutti/proj2",
          source: "agent-markdown"
        }}
      />
    );

    const link = screen.getByRole("link", { name: "AGENTS.md" });
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(link.querySelector("code")).toHaveTextContent("AGENTS.md");

    fireEvent.click(link);

    expect(onLinkClick).toHaveBeenCalledWith(
      "/Users/ryan/Documents/tutti/proj2/AGENTS.md"
    );
  });

  it("resolves workspace link actions when workspace context is provided", () => {
    const onLinkAction = vi.fn();
    render(
      <AgentMessageMarkdown
        content={"已读取 [README.md](/Users/local/project/docs/README.md)"}
        onLinkAction={onLinkAction}
        workspaceLinkContext={{
          workspaceRoot: "/Users/local/project",
          basePath: "/Users/local/project/docs",
          source: "agent-markdown"
        }}
      />
    );

    fireEvent.click(screen.getByRole("link", { name: "README.md" }));

    expect(onLinkAction).toHaveBeenCalledWith({
      type: "open-workspace-file",
      path: "/Users/local/project/docs/README.md",
      directoryPath: "/Users/local/project/docs",
      workspaceRoot: "/Users/local/project",
      source: "agent-markdown"
    });
  });

  it("resolves home-relative markdown file links when workspace context is provided", () => {
    const onLinkAction = vi.fn();
    render(
      <AgentMessageMarkdown
        content={"已保存 [notes](~/docs/notes.md)"}
        onLinkAction={onLinkAction}
        workspaceLinkContext={{
          workspaceRoot: "/Users/local/project",
          basePath: "/Users/local/project",
          source: "agent-markdown"
        }}
      />
    );

    fireEvent.click(screen.getByRole("link", { name: "notes" }));

    expect(onLinkAction).toHaveBeenCalledWith({
      type: "open-workspace-file",
      path: "~/docs/notes.md",
      directoryPath: "~/docs",
      workspaceRoot: "/Users/local/project",
      source: "agent-markdown"
    });
  });

  it("resolves Windows absolute markdown file links when workspace context is provided", () => {
    const onLinkAction = vi.fn();
    render(
      <AgentMessageMarkdown
        content={"已读取 [README.md](C:/Users/local/project/docs/README.md)"}
        onLinkAction={onLinkAction}
        workspaceLinkContext={{
          workspaceRoot: "C:/Users/local/project",
          basePath: "C:/Users/local/project/docs",
          source: "agent-markdown"
        }}
      />
    );

    fireEvent.click(screen.getByRole("link", { name: "README.md" }));

    expect(onLinkAction).toHaveBeenCalledWith({
      type: "open-workspace-file",
      path: "C:/Users/local/project/docs/README.md",
      directoryPath: "C:/Users/local/project/docs",
      workspaceRoot: "C:/Users/local/project",
      source: "agent-markdown"
    });
  });

  it("resolves direct generated image links outside the workspace root", () => {
    const onLinkAction = vi.fn();
    render(
      <AgentMessageMarkdown
        content={
          "图片在这里： `/Users/local/.tutti-dev/agent/runs/session-1/codex-home/generated_images/imagegen/ig_123.png`"
        }
        onLinkAction={onLinkAction}
        workspaceLinkContext={{
          workspaceRoot: "/Users/local/project",
          basePath: "/Users/local/project",
          source: "agent-markdown"
        }}
      />
    );

    fireEvent.click(
      screen.getByRole("link", {
        name: "/Users/local/.tutti-dev/agent/runs/session-1/codex-home/generated_images/imagegen/ig_123.png"
      })
    );

    expect(onLinkAction).toHaveBeenCalledWith({
      type: "open-workspace-file",
      path: "/Users/local/.tutti-dev/agent/runs/session-1/codex-home/generated_images/imagegen/ig_123.png",
      directoryPath:
        "/Users/local/.tutti-dev/agent/runs/session-1/codex-home/generated_images/imagegen",
      workspaceRoot: "/Users/local/project",
      source: "agent-markdown"
    });
  });

  it("renders workspace markdown images from workspace file bytes instead of raw path URLs", async () => {
    const readFile = vi.fn().mockResolvedValue({
      bytes: new Uint8Array([137, 80, 78, 71])
    });
    window.agentHostApi = {
      ...(window.agentHostApi ?? {}),
      workspace: {
        ...(window.agentHostApi?.workspace ?? {}),
        readFile
      }
    } as typeof window.agentHostApi;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:tsh-markdown-image")
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn()
    });

    render(
      <AgentMessageMarkdown
        content={"![generated image](/workspace/output/imagegen/dance.png)"}
      />
    );

    expect(
      await screen.findByRole("img", {
        name: "generated image"
      })
    ).toHaveAttribute("src", "blob:tsh-markdown-image");
    expect(readFile).toHaveBeenCalledWith({
      path: "/workspace/output/imagegen/dance.png"
    });
  });

  it("renders workspace markdown videos from workspace file bytes", async () => {
    const readFile = vi.fn().mockResolvedValue({
      bytes: new Uint8Array([0, 0, 0, 24])
    });
    window.agentHostApi = {
      ...(window.agentHostApi ?? {}),
      workspace: {
        ...(window.agentHostApi?.workspace ?? {}),
        readFile
      }
    } as typeof window.agentHostApi;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:tsh-markdown-video")
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn()
    });

    render(
      <AgentMessageMarkdown
        content={
          "![generated video](/workspace/output/generated_videos/dance.mp4)"
        }
      />
    );

    const video = await screen.findByLabelText("generated video");
    expect(video.tagName).toBe("VIDEO");
    expect(video).toHaveAttribute("src", "blob:tsh-markdown-video");
    expect(video).toHaveAttribute("controls");
    expect(readFile).toHaveBeenCalledWith({
      path: "/workspace/output/generated_videos/dance.mp4"
    });
  });

  it("shows a loading placeholder while a workspace markdown image is still being read", async () => {
    let resolveRead: ((value: { bytes: Uint8Array }) => void) | undefined;
    const readFile = vi.fn(
      () =>
        new Promise<{ bytes: Uint8Array }>((resolve) => {
          resolveRead = resolve;
        })
    );
    window.agentHostApi = {
      ...(window.agentHostApi ?? {}),
      workspace: {
        ...(window.agentHostApi?.workspace ?? {}),
        readFile
      }
    } as typeof window.agentHostApi;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:tsh-markdown-image")
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn()
    });

    render(
      <AgentMessageMarkdown
        content={"![generated image](/workspace/output/imagegen/dance.png)"}
      />
    );

    await waitFor(() =>
      expect(screen.getByText("Loading preview...")).toBeTruthy()
    );
    expect(screen.queryByRole("img", { name: "generated image" })).toBeNull();
    expect(resolveRead).toBeTruthy();

    if (!resolveRead) {
      throw new Error("expected readFile promise resolver");
    }
    resolveRead({ bytes: new Uint8Array([137, 80, 78, 71]) });

    expect(
      await screen.findByRole("img", {
        name: "generated image"
      })
    ).toHaveAttribute("src", "blob:tsh-markdown-image");
  });

  it("falls back to the raw workspace image src when workspace file access is unavailable", () => {
    const workspace = { ...(window.agentHostApi?.workspace ?? {}) } as Partial<
      NonNullable<typeof window.agentHostApi>["workspace"]
    >;
    delete workspace.readFile;

    window.agentHostApi = {
      ...(window.agentHostApi ?? {}),
      workspace: workspace as NonNullable<
        typeof window.agentHostApi
      >["workspace"]
    } as unknown as typeof window.agentHostApi;

    render(
      <AgentMessageMarkdown
        content={"![generated image](/workspace/output/imagegen/dance.png)"}
      />
    );

    expect(
      screen.getByRole("img", { name: "generated image" })
    ).toHaveAttribute("src", "/workspace/output/imagegen/dance.png");
    expect(screen.queryByText("Loading preview...")).toBeNull();
  });

  it("falls back to a file URL for local absolute markdown image paths when workspace file access is unavailable", () => {
    const workspace = { ...(window.agentHostApi?.workspace ?? {}) } as Partial<
      NonNullable<typeof window.agentHostApi>["workspace"]
    >;
    delete workspace.readFile;

    window.agentHostApi = {
      ...(window.agentHostApi ?? {}),
      workspace: workspace as NonNullable<
        typeof window.agentHostApi
      >["workspace"]
    } as unknown as typeof window.agentHostApi;

    render(
      <AgentMessageMarkdown
        content={
          "![generated image](/Users/example/Documents/a/output/imagegen/lamb-storybook.png)"
        }
      />
    );

    expect(
      screen.getByRole("img", { name: "generated image" })
    ).toHaveAttribute(
      "src",
      "file:///Users/example/Documents/a/output/imagegen/lamb-storybook.png"
    );
    expect(screen.queryByText("Loading preview...")).toBeNull();
  });

  it("falls back to a file URL video for local absolute markdown video paths when workspace file access is unavailable", () => {
    const workspace = { ...(window.agentHostApi?.workspace ?? {}) } as Partial<
      NonNullable<typeof window.agentHostApi>["workspace"]
    >;
    delete workspace.readFile;

    window.agentHostApi = {
      ...(window.agentHostApi ?? {}),
      workspace: workspace as NonNullable<
        typeof window.agentHostApi
      >["workspace"]
    } as unknown as typeof window.agentHostApi;

    render(
      <AgentMessageMarkdown
        content={
          "![generated video](/Users/example/.tutti/agent/runs/session/codex-home/generated_videos/dance.mp4)"
        }
      />
    );

    const video = screen.getByLabelText("generated video");
    expect(video.tagName).toBe("VIDEO");
    expect(video).toHaveAttribute(
      "src",
      "file:///Users/example/.tutti/agent/runs/session/codex-home/generated_videos/dance.mp4"
    );
    expect(screen.queryByText("Loading preview...")).toBeNull();
  });

  it("does not render arbitrary local absolute markdown video paths when workspace file access is unavailable", () => {
    const workspace = { ...(window.agentHostApi?.workspace ?? {}) } as Partial<
      NonNullable<typeof window.agentHostApi>["workspace"]
    >;
    delete workspace.readFile;

    window.agentHostApi = {
      ...(window.agentHostApi ?? {}),
      workspace: workspace as NonNullable<
        typeof window.agentHostApi
      >["workspace"]
    } as unknown as typeof window.agentHostApi;

    render(
      <AgentMessageMarkdown
        content={"![private video](/Users/example/Movies/private.mp4)"}
      />
    );

    expect(screen.queryByLabelText("private video")).toBeNull();
    expect(
      screen.queryByText("Preview is not available for this file.")
    ).toBeTruthy();
    expect(screen.queryByText("Loading preview...")).toBeNull();
  });

  it("keeps image zoom disabled by default outside AgentGui callers", async () => {
    const readFile = vi.fn().mockResolvedValue({
      bytes: new Uint8Array([137, 80, 78, 71])
    });
    window.agentHostApi = {
      ...(window.agentHostApi ?? {}),
      workspace: {
        ...(window.agentHostApi?.workspace ?? {}),
        readFile
      }
    } as typeof window.agentHostApi;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:tsh-markdown-image")
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn()
    });

    render(
      <AgentMessageMarkdown
        content={"![generated image](/workspace/output/imagegen/dance.png)"}
      />
    );

    expect(
      await screen.findByRole("img", {
        name: "generated image"
      })
    ).toHaveAttribute("src", "blob:tsh-markdown-image");
    expect(screen.queryByRole("button", { name: /Zoom image/ })).toBeNull();
  });

  it("opens a zoom preview when a workspace markdown image is clicked", async () => {
    const readFile = vi.fn().mockResolvedValue({
      bytes: new Uint8Array([137, 80, 78, 71])
    });
    window.agentHostApi = {
      ...(window.agentHostApi ?? {}),
      workspace: {
        ...(window.agentHostApi?.workspace ?? {}),
        readFile
      }
    } as typeof window.agentHostApi;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:tsh-markdown-image")
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn()
    });

    const { rerender } = render(
      <AgentMessageMarkdown
        content={"![generated image](/workspace/output/imagegen/dance.png)"}
        enableImageZoom
      />
    );

    const zoomButton = await screen.findByRole("button", {
      name: /Zoom image/
    });
    fireEvent.click(zoomButton);

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    rerender(
      <AgentMessageMarkdown
        content={"![generated image](/workspace/output/imagegen/dance.png)"}
        enableImageZoom
      />
    );
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Loading preview...")).toBeNull();
    expect(
      screen.getAllByRole("img", { name: "generated image" })
    ).toHaveLength(2);
  });

  it("resizes the image inside the zoom preview", async () => {
    const readFile = vi.fn().mockResolvedValue({
      bytes: new Uint8Array([137, 80, 78, 71])
    });
    window.agentHostApi = {
      ...(window.agentHostApi ?? {}),
      workspace: {
        ...(window.agentHostApi?.workspace ?? {}),
        readFile
      }
    } as typeof window.agentHostApi;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:tsh-markdown-image")
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn()
    });

    render(
      <AgentMessageMarkdown
        content={"![generated image](/workspace/output/imagegen/dance.png)"}
        enableImageZoom
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: /Zoom image/ }));
    const dialog = await screen.findByRole("dialog");
    const modalImage = dialog.querySelector("[data-rmiz-modal-img]");
    expect(modalImage).toBeInstanceOf(HTMLElement);

    expect(screen.getByRole("status")).toHaveTextContent("100%");

    fireEvent.click(
      screen.getByRole("button", { name: /Zoom in image|common\.zoomInImage/ })
    );
    await waitFor(() => {
      expect(modalImage).toHaveAttribute("data-tsh-image-zoom", "1.25");
    });
    expect(modalImage).toHaveStyle({ transform: "scale(1.25)" });
    expect((modalImage as HTMLElement).style.transformOrigin).toBe("");
    expect(screen.getByRole("status")).toHaveTextContent("125%");

    fireEvent.click(
      screen.getByRole("button", {
        name: /Reset image zoom|common\.resetImageZoom/
      })
    );
    await waitFor(() => {
      expect(modalImage).toHaveAttribute("data-tsh-image-zoom", "1");
    });
    expect(screen.getByRole("status")).toHaveTextContent("100%");

    fireEvent.click(
      screen.getByRole("button", {
        name: /Zoom out image|common\.zoomOutImage/
      })
    );
    await waitFor(() => {
      expect(modalImage).toHaveAttribute("data-tsh-image-zoom", "0.75");
    });
    expect(modalImage).toHaveStyle({ transform: "scale(0.75)" });

    const windowWheel = vi.fn();
    window.addEventListener("wheel", windowWheel);
    try {
      fireEvent.wheel(modalImage as HTMLElement, {
        bubbles: true,
        cancelable: true,
        deltaY: -20
      });
      await waitFor(() => {
        expect(
          Number(modalImage?.getAttribute("data-tsh-image-zoom"))
        ).toBeGreaterThan(0.75);
      });
      expect(
        Number(modalImage?.getAttribute("data-tsh-image-zoom"))
      ).toBeLessThan(0.8);
      expect(modalImage).toHaveStyle({ transition: "none" });
      expect(windowWheel).not.toHaveBeenCalled();

      fireEvent.wheel(modalImage as HTMLElement, {
        bubbles: true,
        cancelable: true,
        deltaY: 20
      });
      await waitFor(() => {
        expect(modalImage).toHaveAttribute("data-tsh-image-zoom", "0.75");
      });
      expect(windowWheel).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("wheel", windowWheel);
    }

    fireEvent.click(screen.getByRole("button", { name: /Minimize image/ }));
    await waitFor(() => {
      expect(modalImage).toHaveAttribute("data-tsh-image-zoom", "1");
    });
  });

  it("copies and downloads a workspace markdown image from preview actions", async () => {
    const readFile = vi.fn().mockResolvedValue({
      bytes: new Uint8Array([137, 80, 78, 71])
    });
    const write = vi.fn().mockResolvedValue(undefined);
    const fetchImage = vi.fn().mockResolvedValue({
      blob: () => Promise.resolve(new Blob(["image"], { type: "image/png" }))
    });
    let downloadedName = "";
    const clickDownload = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloadedName = this.download;
      });
    const clipboardItems: unknown[] = [];
    class TestClipboardItem {
      constructor(items: unknown) {
        clipboardItems.push(items);
      }
    }
    vi.stubGlobal("ClipboardItem", TestClipboardItem);
    vi.stubGlobal("fetch", fetchImage);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write }
    });
    window.agentHostApi = {
      ...(window.agentHostApi ?? {}),
      workspace: {
        ...(window.agentHostApi?.workspace ?? {}),
        readFile
      }
    } as typeof window.agentHostApi;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:tsh-markdown-image")
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn()
    });

    render(
      <AgentMessageMarkdown
        content={"![generated image](/workspace/output/imagegen/dance.png)"}
        enableImageZoom
      />
    );

    const image = await screen.findByRole("img", { name: "generated image" });
    fireEvent.contextMenu(image, { clientX: 12, clientY: 34 });
    const inlineMenu = screen.getByRole("menu");
    expect(inlineMenu).toHaveStyle({ left: "12px", top: "34px" });
    expect(inlineMenu.parentElement).toBe(document.body);

    fireEvent.click(screen.getByRole("menuitem", { name: "Copy image" }));
    await waitFor(() => {
      expect(write).toHaveBeenCalledTimes(1);
    });
    expect(fetchImage).toHaveBeenCalledWith("blob:tsh-markdown-image");
    expect(clipboardItems).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /Zoom image/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Copy image" }));
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("Copied");
    });

    const modalImage = dialog.querySelector("img");
    expect(modalImage).toBeInstanceOf(HTMLElement);
    fireEvent.contextMenu(modalImage as HTMLElement, {
      clientX: 18,
      clientY: 40
    });
    expect(screen.getByRole("menu").closest(".tsh-zoom-dialog")).toBe(dialog);
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy image" }));
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("Copied");
    });
    fireEvent.click(screen.getByRole("button", { name: "Download image" }));
    expect(clickDownload).toHaveBeenCalledTimes(1);
    expect(downloadedName).toMatch(/^dance-\d{8}-\d{6}-[a-z0-9]{4}\.png$/);

    clickDownload.mockRestore();
  });

  it("closes the zoom preview when the unzoom button is clicked", async () => {
    const readFile = vi.fn().mockResolvedValue({
      bytes: new Uint8Array([137, 80, 78, 71])
    });
    window.agentHostApi = {
      ...(window.agentHostApi ?? {}),
      workspace: {
        ...(window.agentHostApi?.workspace ?? {}),
        readFile
      }
    } as typeof window.agentHostApi;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:tsh-markdown-image")
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn()
    });

    render(
      <AgentMessageMarkdown
        content={"![generated image](/workspace/output/imagegen/dance.png)"}
        enableImageZoom
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: /Zoom image/ }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Minimize image/ }));
    const modalImage = dialog.querySelector("[data-rmiz-modal-img]");
    expect(modalImage).toBeInstanceOf(HTMLElement);
    fireEvent.transitionEnd(modalImage as HTMLElement);

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("does not add a zoom trigger when the markdown image is already inside a link", async () => {
    const readFile = vi.fn().mockResolvedValue({
      bytes: new Uint8Array([137, 80, 78, 71])
    });
    const onLinkClick = vi.fn();
    window.agentHostApi = {
      ...(window.agentHostApi ?? {}),
      workspace: {
        ...(window.agentHostApi?.workspace ?? {}),
        readFile
      }
    } as typeof window.agentHostApi;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:tsh-markdown-image")
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn()
    });

    render(
      <AgentMessageMarkdown
        content={
          "[![generated image](/workspace/output/imagegen/dance.png)](https://example.com/generated-image)"
        }
        onLinkClick={onLinkClick}
        enableImageZoom
      />
    );

    const link = await screen.findByRole("link", { name: "generated image" });
    expect(screen.queryByRole("button", { name: /Zoom image/ })).toBeNull();

    fireEvent.click(link);

    expect(onLinkClick).toHaveBeenCalledWith(
      "https://example.com/generated-image"
    );
  });

  it("supports inline rendering for title-sized markdown content", () => {
    render(
      <h2>
        <AgentMessageMarkdown
          content={
            "[@wang jomes & Codex hi](mention://agent-session/session-1?workspaceId=room-1)"
          }
          inline
        />
      </h2>
    );

    expect(
      screen.getByRole("link", {
        name: "wang jomes & Codex hi"
      })
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        "[@wang jomes & Codex hi](mention://agent-session/session-1?workspaceId=room-1)"
      )
    ).toBeNull();
  });

  it("marks mention-only markdown so object tokens do not use mixed-text offset", () => {
    const { container, rerender } = render(
      <AgentMessageMarkdown
        content={
          " [@local & Codex 帮我整理这个文件夹@Documents](mention://agent-session/session-1?workspaceId=room-1) "
        }
      />
    );

    expect(
      container.querySelector('[data-workspace-agent-markdown="true"]')
    ).toHaveAttribute("data-agent-mention-only", "true");

    rerender(
      <AgentMessageMarkdown
        content={
          "回复 [@local & Codex 帮我整理这个文件夹@Documents](mention://agent-session/session-1?workspaceId=room-1)"
        }
      />
    );

    expect(
      container.querySelector('[data-workspace-agent-markdown="true"]')
    ).not.toHaveAttribute("data-agent-mention-only");
  });

  it("renders session mentions as entity tokens instead of raw mention links", () => {
    const onLinkClick = vi.fn();
    const { container } = render(
      <AgentMessageMarkdown
        content={
          "回复 [@2046494774160003072 & Codex 哈喽](mention://agent-session/session-1?workspaceId=room-1)"
        }
        onLinkClick={onLinkClick}
      />
    );

    const mention = container.querySelector('[data-agent-file-mention="true"]');
    expect(mention).toHaveAttribute("data-agent-mention-kind", "session");
    expect(mention).toHaveClass("tsh-agent-object-token");
    expect(mention).toHaveTextContent("2046494774160003072 & Codex 哈喽");
    expect(screen.queryByText(/mention:\/\/session/)).toBeNull();

    fireEvent.click(mention as HTMLElement);

    expect(onLinkClick).toHaveBeenCalledWith(
      "mention://agent-session/session-1?workspaceId=room-1"
    );
  });

  it("renders workspace file mentions as file object tokens", () => {
    const onLinkClick = vi.fn();
    const { container } = render(
      <AgentMessageMarkdown
        content={"请看 [@README.md](/workspace/demo/README.md)"}
        onLinkClick={onLinkClick}
      />
    );

    const mention = container.querySelector('[data-agent-file-mention="true"]');
    expect(mention).toHaveAttribute("data-agent-mention-kind", "file");
    expect(mention).toHaveAttribute("data-agent-file-entry-kind", "file");
    expect(mention).toHaveAttribute("data-agent-file-visual-kind", "markdown");
    expect(mention).toHaveAttribute(
      "data-agent-mention-href",
      "/workspace/demo/README.md"
    );
    expect(mention).toHaveClass("tsh-agent-object-token");
    expect(mention).toHaveClass("tsh-agent-object-token--file");
    expect(
      mention?.querySelector(".tsh-agent-object-token__icon")
    ).toBeInTheDocument();
    expect(
      mention?.querySelector(".tsh-agent-object-token__main")
    ).toHaveTextContent("README.md");
    expect(
      screen.queryByText("[@README.md](/workspace/demo/README.md)")
    ).toBeNull();

    fireEvent.click(mention as HTMLElement);

    expect(onLinkClick).toHaveBeenCalledWith("/workspace/demo/README.md");
  });

  it("renders workspace app mentions with app icons", () => {
    const iconUrl = "data:image/png;base64,weather";
    const { container } = render(
      <AgentMessageMarkdown
        content="使用 [@Weather](mention://workspace-app/weather?workspaceId=room-1)"
        workspaceAppIcons={[
          {
            appId: "weather",
            iconUrl,
            workspaceId: "room-1"
          }
        ]}
      />
    );

    const mention = container.querySelector('[data-agent-file-mention="true"]');
    expect(mention).toHaveAttribute("data-agent-mention-kind", "workspace-app");
    expect(mention).toHaveAttribute("data-agent-mention-icon-url", iconUrl);
    expect(
      mention?.querySelector('[data-agent-mention-app-icon="true"]')
    ).toHaveClass("h-4", "w-4");
    expect(
      mention?.querySelector('[data-agent-mention-app-icon="true"] img')
    ).toHaveAttribute("src", iconUrl);
    expect(mention).toHaveTextContent("Weather");
  });

  it("renders agent target mentions with managed agent icons", () => {
    const iconUrl = MANAGED_AGENT_ICON_ROUNDED_URLS["claude-code"];
    const { container } = render(
      <AgentMessageMarkdown
        content="让 [@Claude Code](mention://agent-target/local:claude-code?workspaceId=room-1) 做题"
        agentTargets={[
          {
            agentTargetId: "local:claude-code",
            iconUrl,
            name: "Claude Code",
            provider: "claude-code",
            workspaceId: "room-1"
          }
        ]}
      />
    );

    const mention = container.querySelector('[data-agent-file-mention="true"]');
    expect(mention).toHaveAttribute("data-agent-mention-kind", "agent-target");
    expect(mention).toHaveAttribute("data-agent-mention-icon-url", iconUrl);
    expect(
      mention?.querySelector('[data-agent-mention-app-icon="true"] img')
    ).toHaveAttribute("src", iconUrl);
    expect(mention).toHaveTextContent("Claude Code");
  });

  it("renders agent target mentions without provider ids as agent tokens", () => {
    const { container } = render(
      <AgentMessageMarkdown content="让 [@Claude Code](mention://agent-target/local:claude-code?workspaceId=room-1) 做题" />
    );

    const mention = container.querySelector('[data-agent-file-mention="true"]');
    expect(mention).toHaveAttribute("data-agent-mention-kind", "agent-target");
    expect(mention).toHaveAttribute(
      "data-agent-mention-icon-url",
      managedAgentRoundedIconUrl(undefined)
    );
    expect(
      mention?.querySelector(".tsh-agent-object-token__icon")
    ).not.toBeInTheDocument();
  });

  it("renders workspace app factory mentions as object tokens", () => {
    const { container, queryByText } = render(
      <AgentMessageMarkdown content="[@Create App](mention://workspace-app-factory/create)" />
    );

    const mention = container.querySelector('[data-agent-file-mention="true"]');
    expect(mention).toHaveAttribute(
      "data-agent-mention-kind",
      "workspace-app-factory"
    );
    expect(mention).toHaveTextContent("Create App");
    expect(
      queryByText("[@Create App](mention://workspace-app-factory/create)")
    ).toBeNull();
  });

  it("renders extensionless workspace mentions as folder object tokens", () => {
    const onLinkClick = vi.fn();
    const { container } = render(
      <AgentMessageMarkdown
        content={"请看 [@Codex](/workspace/demo/Codex)"}
        onLinkClick={onLinkClick}
      />
    );

    const mention = container.querySelector('[data-agent-file-mention="true"]');
    expect(mention).toHaveAttribute("data-agent-mention-kind", "file");
    expect(mention).toHaveAttribute("data-agent-file-entry-kind", "directory");
    expect(mention).toHaveAttribute("data-agent-file-visual-kind", "folder");
    expect(mention).toHaveAttribute(
      "data-agent-link-href",
      "/workspace/demo/Codex"
    );

    fireEvent.click(mention as HTMLElement);

    expect(onLinkClick).toHaveBeenCalledWith("/workspace/demo/Codex");
  });

  it("keeps explicit extensionless file mentions as file object tokens", () => {
    const { container } = render(
      <AgentMessageMarkdown
        content={"请看 [@LICENSE](/workspace/demo/LICENSE?kind=file)"}
      />
    );

    const mention = container.querySelector('[data-agent-file-mention="true"]');
    expect(mention).toHaveAttribute("data-agent-file-entry-kind", "file");
    expect(mention).toHaveAttribute("data-agent-file-visual-kind", "binary");
    expect(mention).toHaveAttribute(
      "data-agent-link-href",
      "/workspace/demo/LICENSE"
    );
  });

  it("keeps line-wrapped mention markdown links as entity tokens", () => {
    const { container } = render(
      <AgentMessageMarkdown
        content={
          "回复 [@sunhello135-png & Nexight 长标题会话]\n(mention://agent-session/session-with-long-title?workspaceId=room-1)"
        }
      />
    );

    const mention = container.querySelector('[data-agent-file-mention="true"]');
    expect(mention).toHaveAttribute("data-agent-mention-kind", "session");
    expect(mention).toHaveTextContent("sunhello135-png & Nexight 长标题会话");
    expect(screen.queryByText(/mention:\/\/session/)).toBeNull();
  });

  it("turns inline code paths into clickable links", () => {
    const onLinkClick = vi.fn();
    render(
      <AgentMessageMarkdown
        content={
          "Now using `/Users/example/demo/abc` as the working directory."
        }
        onLinkClick={onLinkClick}
      />
    );

    fireEvent.click(
      screen.getByRole("link", { name: "/Users/example/demo/abc" })
    );

    expect(onLinkClick).toHaveBeenCalledWith("/Users/example/demo/abc");
  });

  it("turns inline code home-relative paths into clickable links", () => {
    const onLinkAction = vi.fn();
    render(
      <AgentMessageMarkdown
        content={"已保存到 `~/docs/a.md`。"}
        onLinkAction={onLinkAction}
        workspaceLinkContext={{
          workspaceRoot: "/Users/example/demo",
          basePath: "/Users/example/demo",
          source: "agent-markdown"
        }}
      />
    );

    fireEvent.click(screen.getByRole("link", { name: "~/docs/a.md" }));

    expect(onLinkAction).toHaveBeenCalledWith({
      type: "open-workspace-file",
      path: "~/docs/a.md",
      directoryPath: "~/docs",
      workspaceRoot: "/Users/example/demo",
      source: "agent-markdown"
    });
  });

  it("turns inline code Windows absolute paths into clickable links", () => {
    const onLinkAction = vi.fn();
    render(
      <AgentMessageMarkdown
        content={"已保存到 `C:\\Users\\local\\project\\docs\\README.md`。"}
        onLinkAction={onLinkAction}
        workspaceLinkContext={{
          workspaceRoot: "C:/Users/local/project",
          basePath: "C:/Users/local/project",
          source: "agent-markdown"
        }}
      />
    );

    fireEvent.click(
      screen.getByRole("link", {
        name: "C:\\Users\\local\\project\\docs\\README.md"
      })
    );

    expect(onLinkAction).toHaveBeenCalledWith({
      type: "open-workspace-file",
      path: "C:/Users/local/project/docs/README.md",
      directoryPath: "C:/Users/local/project/docs",
      workspaceRoot: "C:/Users/local/project",
      source: "agent-markdown"
    });
  });

  it("turns inline code http urls into clickable links", () => {
    const onLinkClick = vi.fn();
    render(
      <AgentMessageMarkdown
        content={"浏览器里直接打开：`http://127.0.0.1:9999`"}
        onLinkClick={onLinkClick}
      />
    );

    fireEvent.click(
      screen.getByRole("link", { name: "http://127.0.0.1:9999" })
    );

    expect(onLinkClick).toHaveBeenCalledWith("http://127.0.0.1:9999");
  });

  it("prevents default navigation for markdown http links", () => {
    const onLinkClick = vi.fn();
    render(
      <AgentMessageMarkdown
        content={
          "浏览器里直接打开：[http://127.0.0.1:9999](http://127.0.0.1:9999)"
        }
        onLinkClick={onLinkClick}
      />
    );

    const link = screen.getByRole("link", {
      name: "http://127.0.0.1:9999"
    });
    expect(link).not.toHaveAttribute("href");
    expect(link).toHaveAttribute(
      "data-agent-link-href",
      "http://127.0.0.1:9999"
    );
    const clickEvent = new MouseEvent("click", {
      bubbles: true,
      cancelable: true
    });
    link.dispatchEvent(clickEvent);

    expect(clickEvent.defaultPrevented).toBe(true);
    expect(onLinkClick).toHaveBeenCalledWith("http://127.0.0.1:9999");
  });

  it("turns bare local absolute paths into clickable links", () => {
    const onLinkClick = vi.fn();
    render(
      <AgentMessageMarkdown
        content={
          "已创建空的 txt 文件：\n\n/Users/example/demo/83c66a52-4ff2-436a-a300-e346c9fdd9d2/note.txt\n\n当前大小：0 bytes。"
        }
        onLinkClick={onLinkClick}
      />
    );

    fireEvent.click(
      screen.getByRole("link", {
        name: "/Users/example/demo/83c66a52-4ff2-436a-a300-e346c9fdd9d2/note.txt"
      })
    );

    expect(onLinkClick).toHaveBeenCalledWith(
      "/Users/example/demo/83c66a52-4ff2-436a-a300-e346c9fdd9d2/note.txt"
    );
  });

  it("does not auto-link bare relative paths", () => {
    const onLinkClick = vi.fn();
    render(
      <AgentMessageMarkdown
        content={"已在 abc/123.txt 写入内容。"}
        onLinkClick={onLinkClick}
      />
    );

    expect(screen.queryByRole("link", { name: "abc/123.txt" })).toBeNull();
    expect(screen.getByText(/abc\/123\.txt/)).toBeInTheDocument();
    expect(onLinkClick).not.toHaveBeenCalled();
  });

  it("does not link relative file paths inside inline code without workspace context", () => {
    const onLinkClick = vi.fn();
    render(
      <AgentMessageMarkdown
        content={"已创建 `a.md`，内容为 `xxx`。"}
        onLinkClick={onLinkClick}
      />
    );

    expect(screen.queryByRole("link", { name: "a.md" })).toBeNull();
    expect(screen.getByText("a.md")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "xxx" })).toBeNull();
    expect(onLinkClick).not.toHaveBeenCalled();
  });

  it("does not link relative file paths inside inline code when workspace context is provided", () => {
    const onLinkAction = vi.fn();
    render(
      <AgentMessageMarkdown
        content={
          "已创建目录 [empty-files](empty-files/)，里面包含：\n- `xx.html`\n- `xx.md`\n- `content/posts`\n- `lib/site.ts`\n- `README.md`"
        }
        onLinkAction={onLinkAction}
        workspaceLinkContext={{
          workspaceRoot: "/Users/local/project",
          basePath: "/Users/local/project",
          source: "agent-markdown"
        }}
      />
    );

    for (const label of [
      "empty-files",
      "xx.html",
      "xx.md",
      "content/posts",
      "lib/site.ts",
      "README.md"
    ]) {
      expect(screen.queryByRole("link", { name: label })).toBeNull();
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(onLinkAction).not.toHaveBeenCalled();
  });

  it("does not treat ordinary inline code as a path", () => {
    const onLinkClick = vi.fn();
    render(
      <AgentMessageMarkdown
        content={"内容是 `hello world`。"}
        onLinkClick={onLinkClick}
      />
    );

    expect(screen.queryByRole("link", { name: "hello world" })).toBeNull();
    expect(screen.getByText("hello world")).toBeInTheDocument();
  });

  it("does not leak markdown ast node props into the DOM", () => {
    const { container } = render(
      <AgentMessageMarkdown
        content={"段落里有 [链接](README.md) 和 `代码`。"}
      />
    );

    expect(container.querySelector("[node]")).toBeNull();
  });

  it("collapses long messages and expands them on demand", () => {
    render(
      <AgentMessageMarkdown
        content={Array.from(
          { length: 9 },
          (_, index) => `第 ${index + 1} 行`
        ).join("\n")}
        collapsible
        expandLabel="展开全部"
      />
    );

    const expandButton = screen.getByRole("button", { name: "展开全部" });
    const markdown = expandButton.parentElement?.querySelector(
      '[data-workspace-agent-markdown="true"]'
    );
    expect(markdown).toHaveAttribute("data-collapsed", "true");

    fireEvent.click(expandButton);

    expect(markdown).toHaveAttribute("data-collapsed", "false");
    expect(screen.queryByRole("button", { name: "展开全部" })).toBeNull();
  });

  it("defers full markdown rendering for long messages when requested", () => {
    vi.useFakeTimers();
    try {
      const content = `请看 [README.md](README.md)\n\n${"x".repeat(4096)}`;
      const { container } = render(
        <AgentMessageMarkdown content={content} deferLongContentRender />
      );

      expect(
        container.querySelector(
          '[data-workspace-agent-markdown-deferred="true"]'
        )
      ).toBeTruthy();
      expect(screen.queryByRole("link", { name: "README.md" })).toBeNull();

      act(() => {
        vi.advanceTimersByTime(80);
      });

      expect(screen.queryByRole("link", { name: "README.md" })).toBeNull();
      expect(screen.getByText("README.md")).toBeInTheDocument();
      expect(
        container.querySelector(
          '[data-workspace-agent-markdown-deferred="true"]'
        )
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("splitStreamingMarkdownBlocks", () => {
  it("splits stable markdown blocks without splitting fenced code", () => {
    expect(
      splitStreamingMarkdownBlocks(
        [
          "Intro paragraph.",
          "",
          "```ts",
          "const value = 1;",
          "",
          "console.log(value);",
          "```",
          "",
          "- Tail item"
        ].join("\n")
      ).map((block) => block.content)
    ).toEqual([
      "Intro paragraph.\n",
      "```ts\nconst value = 1;\n\nconsole.log(value);\n```\n",
      "- Tail item"
    ]);
  });
});
