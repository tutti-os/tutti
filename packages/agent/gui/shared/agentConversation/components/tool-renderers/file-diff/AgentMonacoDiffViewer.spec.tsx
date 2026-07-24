import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MonacoModule } from "./loadMonaco";
import { loadMonaco } from "./loadMonaco";
import { AgentMonacoDiffViewer } from "./AgentMonacoDiffViewer";

vi.mock("./loadMonaco", () => ({
  loadMonaco: vi.fn()
}));

describe("AgentMonacoDiffViewer", () => {
  beforeEach(() => {
    vi.mocked(loadMonaco).mockReset();
  });

  it("detaches models before disposing the editor and owned models", async () => {
    const harness = createMonacoHarness();
    vi.mocked(loadMonaco).mockResolvedValue(harness.monaco);

    const view = render(
      <AgentMonacoDiffViewer
        oldValue="before"
        newValue="after"
        path="/workspace/file.ts"
        showHeader={false}
      />
    );
    await waitFor(() => {
      expect(harness.createDiffEditor).toHaveBeenCalledTimes(1);
    });

    view.unmount();

    expect(harness.events).toEqual([
      "editor.setModel",
      "editor.setModel(null)",
      "editor.dispose",
      "originalModel.dispose",
      "modifiedModel.dispose"
    ]);
  });

  it("does not create Monaco resources after unmounting during load", async () => {
    const harness = createMonacoHarness();
    let resolveMonaco: ((monaco: MonacoModule) => void) | null = null;
    vi.mocked(loadMonaco).mockReturnValue(
      new Promise((resolve) => {
        resolveMonaco = resolve;
      })
    );

    const view = render(
      <AgentMonacoDiffViewer
        oldValue="before"
        newValue="after"
        showHeader={false}
      />
    );
    view.unmount();
    await act(async () => {
      resolveMonaco?.(harness.monaco);
      await Promise.resolve();
    });

    expect(harness.createModel).not.toHaveBeenCalled();
    expect(harness.createDiffEditor).not.toHaveBeenCalled();
  });

  it("updates the existing models when diff content changes", async () => {
    const harness = createMonacoHarness();
    vi.mocked(loadMonaco).mockResolvedValue(harness.monaco);

    const view = render(
      <AgentMonacoDiffViewer
        oldValue="before"
        newValue="after"
        path="/workspace/file.ts"
        showHeader={false}
      />
    );
    await waitFor(() => {
      expect(harness.createDiffEditor).toHaveBeenCalledTimes(1);
    });

    view.rerender(
      <AgentMonacoDiffViewer
        oldValue="older"
        newValue="newer"
        path="/workspace/file.ts"
        showHeader={false}
      />
    );

    expect(harness.originalModel.setValue).toHaveBeenCalledWith("older");
    expect(harness.modifiedModel.setValue).toHaveBeenCalledWith("newer");
    expect(harness.createDiffEditor).toHaveBeenCalledTimes(1);
  });
});

function createMonacoHarness(): {
  monaco: MonacoModule;
  events: string[];
  createModel: ReturnType<typeof vi.fn>;
  createDiffEditor: ReturnType<typeof vi.fn>;
  originalModel: ReturnType<typeof createTextModel>;
  modifiedModel: ReturnType<typeof createTextModel>;
} {
  const events: string[] = [];
  const originalModel = createTextModel("before", "typescript", () => {
    events.push("originalModel.dispose");
  });
  const modifiedModel = createTextModel("after", "typescript", () => {
    events.push("modifiedModel.dispose");
  });
  const createModel = vi
    .fn()
    .mockReturnValueOnce(originalModel)
    .mockReturnValueOnce(modifiedModel);
  const editor = {
    setModel: vi.fn((model: unknown) => {
      events.push(model === null ? "editor.setModel(null)" : "editor.setModel");
    }),
    dispose: vi.fn(() => {
      events.push("editor.dispose");
    })
  };
  const createDiffEditor = vi.fn(() => editor);
  const monaco = {
    editor: {
      createModel,
      createDiffEditor,
      setTheme: vi.fn(),
      setModelLanguage: vi.fn()
    }
  } as unknown as MonacoModule;

  return {
    monaco,
    events,
    createModel,
    createDiffEditor,
    originalModel,
    modifiedModel
  };
}

function createTextModel(
  initialValue: string,
  language: string,
  onDispose: () => void
) {
  let value = initialValue;
  let disposed = false;
  return {
    getValue: vi.fn(() => value),
    setValue: vi.fn((nextValue: string) => {
      value = nextValue;
    }),
    getLanguageId: vi.fn(() => language),
    isDisposed: vi.fn(() => disposed),
    dispose: vi.fn(() => {
      disposed = true;
      onDispose();
    })
  };
}
