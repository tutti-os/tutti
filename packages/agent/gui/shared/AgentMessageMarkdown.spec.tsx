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

describe("AgentMessageMarkdown", () => {
  afterEach(() => {
    resetCachedMarkdownImagesForTests();
  });

  it("renders markdown links, inline code, and lists", () => {
    const { container } = render(
      <AgentMessageMarkdown
        content={
          "已读取 [README.md](README.md) 和 `src/App.tsx`，**重点**\n\n- 第一项\n- 第二项"
        }
      />
    );

    expect(screen.getByRole("link", { name: "README.md" })).toHaveAttribute(
      "data-agent-link-href",
      "README.md"
    );
    expect(screen.getByText("src/App.tsx")).toBeInTheDocument();
    expect(screen.getByText("重点").tagName).toBe("STRONG");
    expect(screen.getByText("第一项")).toBeInTheDocument();
    expect(screen.getByText("第二项")).toBeInTheDocument();
    expect(screen.getByRole("list")).toHaveStyle({
      margin: "12px 0px 8px",
      "padding-inline-start": "0"
    });
    expect(screen.getByRole("list").className).toContain("[&_li]:pl-[34px]");
    expect(screen.getByRole("list").className).toContain(
      "[&_li::before]:left-4"
    );
    expect(screen.getByRole("list").className).toContain(
      "[&_li::before]:bg-[var(--text-tertiary)]"
    );
    expect(screen.getAllByRole("listitem")[0]).toHaveStyle({
      margin: "4px 0px"
    });

    const markdown = container.querySelector(
      '[data-workspace-agent-markdown="true"]'
    );
    expect(markdown?.className).not.toContain("hover:[&_a]:underline");
    expect(markdown?.className).toContain("text-[var(--text-primary)]");
    expect(markdown?.className).toContain("[&_a]:cursor-pointer");
    expect(markdown?.className).toContain("[&_a]:text-[var(--tutti-purple)]");
    expect(markdown?.className).toContain("[&_a:hover]:underline");
    expect(markdown?.className).toContain("[&_strong]:font-semibold");
    expect(markdown?.className).toContain("[&_code]:text-[11px]");
    expect(markdown?.className).toContain(
      "[&_code]:text-[var(--text-primary)]"
    );
    expect(markdown?.className).toContain("[&_code]:inline");
    expect(markdown?.className).toContain("[&_code]:rounded-[2px]");
    expect(markdown?.className).toContain("[&_code]:[overflow-wrap:anywhere]");
    expect(markdown?.className).toContain(
      "[&_code]:[box-decoration-break:clone]"
    );
    expect(markdown?.className).toContain("[&_pre_code]:h-auto");
    expect(markdown?.className).toContain(
      "[&_pre_code]:[white-space:pre-wrap]"
    );
    expect(markdown?.className).toContain(
      "[&_pre_code]:[overflow-wrap:anywhere]"
    );
  });

  it("allows long inline code to wrap inside narrow message containers", () => {
    const { container } = render(
      <AgentMessageMarkdown
        content={
          '字体栈：`css "JetBrains Mono", "SFMono-Regular", "Cascadia Code", Menlo, Consolas, monospace` 已应用。'
        }
      />
    );

    const markdown = container.querySelector(
      '[data-workspace-agent-markdown="true"]'
    );
    const inlineCode = screen.getByText(
      'css "JetBrains Mono", "SFMono-Regular", "Cascadia Code", Menlo, Consolas, monospace'
    );
    expect(markdown?.className).toContain("[&_code]:inline");
    expect(markdown?.className).toContain("[&_code]:[overflow-wrap:anywhere]");
    expect(inlineCode.tagName).toBe("CODE");
  });

  it("allows fenced code blocks to wrap in conversation detail surfaces", () => {
    const { container } = render(
      <AgentMessageMarkdown
        content={
          '字体栈：\n\n```css\n"JetBrains Mono", "SFMono-Regular", "Cascadia Code", Menlo, Consolas, monospace\n```'
        }
      />
    );

    const markdown = container.querySelector(
      '[data-workspace-agent-markdown="true"]'
    );
    const code = screen.getByText(
      '"JetBrains Mono", "SFMono-Regular", "Cascadia Code", Menlo, Consolas, monospace'
    );
    expect(code.closest("pre")).toBeInTheDocument();
    expect(markdown?.className).toContain(
      "[&_pre_code]:[white-space:pre-wrap]"
    );
    expect(markdown?.className).toContain(
      "[&_pre_code]:[overflow-wrap:anywhere]"
    );
  });

  it("allows consumers to share markdown rendering with surface-specific classes", () => {
    const { container } = render(
      <AgentMessageMarkdown
        content={"已读取 [README.md](README.md)"}
        className="summary-markdown"
      />
    );

    const markdown = container.querySelector(
      '[data-workspace-agent-markdown="true"]'
    );
    expect(markdown).toHaveClass("summary-markdown");
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

  it("keeps ordered list left padding clear of the card edge", () => {
    render(<AgentMessageMarkdown content={"1. Awwwards\n2. Mobbin"} />);

    expect(screen.getByRole("list")).toHaveStyle({
      margin: "12px 0px 8px",
      "padding-inline-start": "34px",
      "padding-inline-end": "16px"
    });
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

  it("dispatches link clicks when an action handler is provided", () => {
    const onLinkClick = vi.fn();
    render(
      <AgentMessageMarkdown
        content={"已读取 [README.md](README.md)"}
        onLinkClick={onLinkClick}
      />
    );

    fireEvent.click(screen.getByRole("link", { name: "README.md" }));

    expect(onLinkClick).toHaveBeenCalledWith("README.md");
  });

  it("resolves workspace link actions when workspace context is provided", () => {
    const onLinkAction = vi.fn();
    render(
      <AgentMessageMarkdown
        content={"已读取 [README.md](README.md)"}
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

  it("resolves direct generated image links outside the workspace root", () => {
    const onLinkAction = vi.fn();
    render(
      <AgentMessageMarkdown
        content={
          "图片在这里： `/Users/local/.tutti-dev/agent/runs/run-1/session-1/codex-home/generated_images/imagegen/ig_123.png`"
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
        name: "/Users/local/.tutti-dev/agent/runs/run-1/session-1/codex-home/generated_images/imagegen/ig_123.png"
      })
    );

    expect(onLinkAction).toHaveBeenCalledWith({
      type: "open-workspace-file",
      path: "/Users/local/.tutti-dev/agent/runs/run-1/session-1/codex-home/generated_images/imagegen/ig_123.png",
      directoryPath:
        "/Users/local/.tutti-dev/agent/runs/run-1/session-1/codex-home/generated_images/imagegen",
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
          "[![generated image](/workspace/output/imagegen/dance.png)](README.md)"
        }
        onLinkClick={onLinkClick}
        enableImageZoom
      />
    );

    const link = await screen.findByRole("link", { name: "generated image" });
    expect(screen.queryByRole("button", { name: /Zoom image/ })).toBeNull();

    fireEvent.click(link);

    expect(onLinkClick).toHaveBeenCalledWith("README.md");
  });

  it("supports inline rendering for title-sized markdown content", () => {
    render(
      <h2>
        <AgentMessageMarkdown
          content={
            "[@wang jomes & Codex hi](mention://agent-session?workspaceId=room-1&id=session-1)"
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
        "[@wang jomes & Codex hi](mention://agent-session?workspaceId=room-1&id=session-1)"
      )
    ).toBeNull();
  });

  it("marks mention-only markdown so object tokens do not use mixed-text offset", () => {
    const { container, rerender } = render(
      <AgentMessageMarkdown
        content={
          " [@local & Codex 帮我整理这个文件夹@Documents](mention://agent-session?workspaceId=room-1&id=session-1) "
        }
      />
    );

    expect(
      container.querySelector('[data-workspace-agent-markdown="true"]')
    ).toHaveAttribute("data-agent-mention-only", "true");

    rerender(
      <AgentMessageMarkdown
        content={
          "回复 [@local & Codex 帮我整理这个文件夹@Documents](mention://agent-session?workspaceId=room-1&id=session-1)"
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
          "回复 [@2046494774160003072 & Codex 哈喽](mention://agent-session?workspaceId=room-1&id=session-1)"
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
      "mention://agent-session?workspaceId=room-1&id=session-1"
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
        content="使用 [@Weather](mention://workspace-app?workspaceId=room-1&appId=weather)"
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

  it("renders workspace app factory mentions as object tokens", () => {
    const { container, queryByText } = render(
      <AgentMessageMarkdown content="[@Create App](mention://workspace-app-factory)" />
    );

    const mention = container.querySelector('[data-agent-file-mention="true"]');
    expect(mention).toHaveAttribute(
      "data-agent-mention-kind",
      "workspace-app-factory"
    );
    expect(mention).toHaveTextContent("Create App");
    expect(
      queryByText("[@Create App](mention://workspace-app-factory)")
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
          "回复 [@sunhello135-png & Nexight 长标题会话]\n(mention://agent-session?workspaceId=room-1&id=session-with-long-title)"
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

  it("does not link relative file paths inside inline code", () => {
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

  it("keeps long inline code wrapping-friendly", () => {
    const { container } = render(
      <AgentMessageMarkdown
        content={
          "摘要：`这是一段很长的行内代码文本，用来确认它不会被固定高度和 flex 布局限制住。`"
        }
      />
    );

    const markdown = container.querySelector(
      '[data-workspace-agent-markdown="true"]'
    );
    expect(markdown?.className).not.toContain("[&_code]:inline-flex");
    expect(markdown?.className).not.toContain("[&_code]:h-4");
    expect(markdown?.className).toContain(
      "[&_code]:[box-decoration-break:clone]"
    );
    expect(markdown?.className).toContain(
      "[&_code]:[-webkit-box-decoration-break:clone]"
    );
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
    expect(expandButton.className).toContain("text-[var(--tutti-purple)]");
    const markdown = expandButton.parentElement?.querySelector(
      '[data-workspace-agent-markdown="true"]'
    );
    expect(markdown).toHaveAttribute("data-collapsed", "true");
    expect(markdown?.className).toContain("transition-[max-height]");
    expect(markdown?.className).toContain("[mask-image:linear-gradient");
    expect(markdown?.className).not.toContain("after:bg-");

    fireEvent.click(expandButton);

    expect(markdown).toHaveAttribute("data-collapsed", "false");
    expect(markdown?.className).toContain("max-h-[72rem]");
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

      expect(screen.getByRole("link", { name: "README.md" })).toHaveAttribute(
        "data-agent-link-href",
        "README.md"
      );
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
