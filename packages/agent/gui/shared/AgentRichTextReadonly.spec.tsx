import "@testing-library/jest-dom/vitest";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentRichTextReadonly } from "./AgentRichTextReadonly";

describe("AgentRichTextReadonly", () => {
  it("hydrates workspace app mention icons without putting icon data in the href", async () => {
    const iconUrl = "data:image/png;base64,weather";
    const { container } = render(
      <AgentRichTextReadonly
        value={
          "Run [@Weather](mention://workspace-app/weather?workspaceId=workspace-1)"
        }
        workspaceAppIcons={[
          {
            appId: "weather",
            workspaceId: "workspace-1",
            iconUrl
          }
        ]}
      />
    );

    await waitFor(() =>
      expect(
        container.querySelector('[data-agent-mention-kind="workspace-app"]')
      ).not.toBeNull()
    );

    const mention = container.querySelector(
      '[data-agent-mention-kind="workspace-app"]'
    );
    expect(mention).toHaveTextContent("Weather");
    expect(mention).toHaveAttribute(
      "data-agent-mention-href",
      "mention://workspace-app/weather?workspaceId=workspace-1"
    );
    expect(mention).toHaveAttribute("data-agent-mention-icon-url", iconUrl);
    expect(mention?.querySelector("img")).toHaveAttribute("src", iconUrl);
  });

  it("does not override mention wrapper width in readonly messages", async () => {
    const { container } = render(
      <AgentRichTextReadonly
        value={
          "Run [@Long Workspace App Name](mention://workspace-app/weather?workspaceId=workspace-1)"
        }
      />
    );

    await waitFor(() =>
      expect(
        container.querySelector('[data-agent-mention-kind="workspace-app"]')
      ).not.toBeNull()
    );

    const editor = container.querySelector(".ProseMirror");
    expect(editor).not.toHaveClass(
      "[&_[data-agent-file-mention=true]]:max-w-full"
    );
  });

  it("marks readonly messages that only contain one mention", async () => {
    const { container, rerender } = render(
      <AgentRichTextReadonly
        value={
          "[@Long Workspace App Name](mention://workspace-app/weather?workspaceId=workspace-1)"
        }
      />
    );

    await waitFor(() =>
      expect(
        container.querySelector('[data-agent-mention-kind="workspace-app"]')
      ).not.toBeNull()
    );

    expect(container.firstElementChild).toHaveAttribute(
      "data-agent-mention-only",
      "true"
    );

    rerender(
      <AgentRichTextReadonly
        value={
          "Run [@Long Workspace App Name](mention://workspace-app/weather?workspaceId=workspace-1)"
        }
      />
    );

    expect(container.firstElementChild).not.toHaveAttribute(
      "data-agent-mention-only"
    );
  });

  it("hydrates app workspace-reference mention icons from workspace app icons", async () => {
    const iconUrl = "data:image/png;base64,canvas";
    const { container } = render(
      <AgentRichTextReadonly
        value={
          "Use [@AI Canvas](mention://workspace-reference/ai-canvas?source=app&workspaceId=workspace-1)"
        }
        workspaceAppIcons={[
          {
            appId: "ai-canvas",
            workspaceId: "workspace-1",
            iconUrl
          }
        ]}
      />
    );

    await waitFor(() =>
      expect(
        container.querySelector(
          '[data-agent-mention-kind="workspace-reference"]'
        )
      ).not.toBeNull()
    );

    const mention = container.querySelector(
      '[data-agent-mention-kind="workspace-reference"]'
    );
    expect(mention).toHaveTextContent("AI Canvas");
    expect(mention).toHaveAttribute(
      "data-agent-mention-href",
      "mention://workspace-reference/ai-canvas?source=app&workspaceId=workspace-1"
    );
    expect(mention).toHaveAttribute("data-agent-mention-icon-url", iconUrl);
    expect(mention?.querySelector("img")).toHaveAttribute("src", iconUrl);
  });

  it("renders workspace app factory markdown as a mention token", async () => {
    const { container } = render(
      <AgentRichTextReadonly
        value={"[@Create App](mention://workspace-app-factory/create)"}
      />
    );

    await waitFor(() =>
      expect(
        container.querySelector(
          '[data-agent-mention-kind="workspace-app-factory"]'
        )
      ).not.toBeNull()
    );

    const mention = container.querySelector(
      '[data-agent-mention-kind="workspace-app-factory"]'
    );
    expect(mention).toHaveTextContent("Create App");
    expect(mention).toHaveAttribute(
      "data-agent-mention-href",
      "mention://workspace-app-factory/create"
    );
    expect(container).not.toHaveTextContent(
      "mention://workspace-app-factory/create"
    );
  });

  it("renders known skill triggers as skill tokens", async () => {
    const { container } = render(
      <AgentRichTextReadonly
        value="Use /caveman and /compact"
        availableSkills={[
          {
            name: "caveman",
            trigger: "$caveman",
            sourceKind: "personal"
          }
        ]}
      />
    );

    await waitFor(() =>
      expect(
        container.querySelector('[data-agent-skill-token="true"]')
      ).not.toBeNull()
    );

    const skillToken = container.querySelector(
      '[data-agent-skill-token="true"]'
    );
    expect(skillToken).toHaveTextContent("/caveman");
    expect(skillToken).toHaveAttribute("data-agent-skill-trigger", "/caveman");
    expect(container).toHaveTextContent("/compact");
  });
});
