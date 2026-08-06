import { afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import { createRichTextMentionService } from "../service/RichTextMentionService.ts";
import { createRichTextMarkdownLinkInsertResult } from "../plugins/trigger.ts";
import type { RichTextTriggerProvider } from "../types/trigger.ts";
import { TooltipProvider } from "@tutti-os/ui-system/components";
import { RichTextTriggerEditor } from "./RichTextTriggerEditor.tsx";

const palette = {
  categories: [{ id: "files", label: "Files", providerIds: ["file"] }],
  defaultCategoryId: "files",
  directoryNavigation: {
    providerId: "file",
    labels: {
      back: "Back",
      enter: "Enter folder",
      navigateHierarchy: "Navigate folders"
    }
  },
  labels: {
    cycleFilter: "Cycle filter",
    moveSelection: "Move selection",
    tabHint: "Filter"
  }
} as const;

beforeAll(() => {
  const rect = {
    bottom: 20,
    height: 20,
    left: 0,
    right: 100,
    top: 0,
    width: 100,
    x: 0,
    y: 0,
    toJSON: () => ({})
  } satisfies DOMRect;
  Range.prototype.getBoundingClientRect = () => rect;
  Range.prototype.getClientRects = () =>
    Object.assign([rect], { item: (index: number) => [rect][index] ?? null });
  window.scrollBy = () => undefined;
});

afterEach(() => cleanup());

describe("RichTextTriggerEditor directory navigation", () => {
  test("enters and returns from provider directories", async () => {
    const directoryPaths: string[] = [];
    const mentionService = createRichTextMentionService({
      providers: [
        createFileProvider({
          queryDirectory(input) {
            directoryPaths.push(input.directoryPath);
            return input.directoryPath
              ? [{ kind: "file", path: "/workspace/docs/readme.md" }]
              : [{ kind: "directory", path: "/workspace/docs" }];
          }
        })
      ]
    });

    const view = render(
      <RichTextTriggerEditor
        focusSignal={0}
        mentionService={mentionService}
        onChange={() => undefined}
        palette={palette}
        value="@"
      />
    );
    view.rerender(
      <RichTextTriggerEditor
        focusSignal={1}
        mentionService={mentionService}
        onChange={() => undefined}
        palette={palette}
        value="@"
      />
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Enter folder" })
    );
    await waitFor(() => expect(directoryPaths.at(-1)).toBe("/workspace/docs"));
    const callCountBeforeBack = directoryPaths.length;
    fireEvent.click(await screen.findByRole("button", { name: "Back" }));
    await waitFor(() => {
      expect(directoryPaths.length).toBeGreaterThan(callCountBeforeBack);
      expect(directoryPaths.at(-1)).toBe("");
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Enter folder" })
    );
    await waitFor(() => expect(directoryPaths.at(-1)).toBe("/workspace/docs"));
    view.rerender(
      <RichTextTriggerEditor
        focusSignal={2}
        mentionService={mentionService}
        onChange={() => undefined}
        palette={palette}
        value="@read"
      />
    );
    await waitFor(() => expect(screen.queryByText("docs")).toBeNull());
    const callCountBeforeClearingSearch = directoryPaths.length;
    view.rerender(
      <RichTextTriggerEditor
        focusSignal={3}
        mentionService={mentionService}
        onChange={() => undefined}
        palette={palette}
        value="@"
      />
    );
    await waitFor(() => {
      expect(directoryPaths.length).toBeGreaterThan(
        callCountBeforeClearingSearch
      );
      expect(directoryPaths.at(-1)).toBe("");
    });
  });

  test("inserts a directory path from the row body", async () => {
    const changes: string[] = [];
    const mentionService = createRichTextMentionService({
      providers: [
        createFileProvider({
          queryDirectory: () => [{ kind: "directory", path: "/workspace/docs" }]
        })
      ]
    });

    const view = render(
      <TooltipProvider>
        <RichTextTriggerEditor
          focusSignal={0}
          mentionService={mentionService}
          onChange={(value) => changes.push(value)}
          palette={palette}
          value="@"
        />
      </TooltipProvider>
    );
    view.rerender(
      <TooltipProvider>
        <RichTextTriggerEditor
          focusSignal={1}
          mentionService={mentionService}
          onChange={(value) => changes.push(value)}
          palette={palette}
          value="@"
        />
      </TooltipProvider>
    );

    const label = await screen.findByText("docs");
    const option = label.closest('[role="option"]');
    expect(option).not.toBeNull();
    fireEvent.click(option as Element);
    await waitFor(() =>
      expect(changes.at(-1)).toBe("[docs](/workspace/docs/)")
    );
  });

  test("hides hierarchy controls when the provider lacks the capability", async () => {
    const mentionService = createRichTextMentionService({
      providers: [
        createFileProvider({
          query: () => [{ kind: "directory", path: "/workspace/docs" }]
        })
      ]
    });

    const view = render(
      <RichTextTriggerEditor
        focusSignal={0}
        mentionService={mentionService}
        onChange={() => undefined}
        palette={palette}
        value="@"
      />
    );
    view.rerender(
      <RichTextTriggerEditor
        focusSignal={1}
        mentionService={mentionService}
        onChange={() => undefined}
        palette={palette}
        value="@"
      />
    );

    await screen.findByText("docs");
    expect(screen.queryByRole("button", { name: "Enter folder" })).toBeNull();
    expect(screen.queryByText("Navigate folders")).toBeNull();
  });

  test("renders a localized error when directory loading fails", async () => {
    const mentionService = createRichTextMentionService({
      providers: [
        createFileProvider({
          queryDirectory: async () => {
            throw new Error("directory unavailable");
          }
        })
      ]
    });

    const view = render(
      <RichTextTriggerEditor
        focusSignal={0}
        mentionService={mentionService}
        onChange={() => undefined}
        palette={palette}
        value="@"
      />
    );
    view.rerender(
      <RichTextTriggerEditor
        focusSignal={1}
        mentionService={mentionService}
        onChange={() => undefined}
        palette={palette}
        value="@"
      />
    );

    expect(await screen.findByText("Unable to load references")).toBeTruthy();
  });
});

function createFileProvider(
  overrides: Partial<RichTextTriggerProvider<FileItem>>
): RichTextTriggerProvider<FileItem> {
  return {
    id: "file",
    trigger: "@",
    query: () => [],
    getItemDirectory: (item) =>
      item.kind === "directory" ? { path: item.path } : null,
    getItemKey: (item) => item.path,
    getItemLabel: (item) => item.path.split("/").at(-1) ?? item.path,
    toInsertResult: (item) =>
      createRichTextMarkdownLinkInsertResult(
        item.path.split("/").at(-1) ?? item.path,
        item.kind === "directory" ? `${item.path}/` : item.path
      ),
    ...overrides
  };
}

interface FileItem {
  kind: "directory" | "file";
  path: string;
}
