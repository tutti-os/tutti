import { describe, expect, it, vi } from "vitest";
import { executeConfirmedProjectRemoval } from "./AgentGUIProjectActionConfirmationDialog";

describe("executeConfirmedProjectRemoval", () => {
  it("awaits the authoritative project-removal operation", async () => {
    const onRemoveProject = vi.fn(async () => true);

    await expect(
      executeConfirmedProjectRemoval({
        onRemoveProject,
        path: "/workspace/project"
      })
    ).resolves.toBe(true);

    expect(onRemoveProject).toHaveBeenCalledWith("/workspace/project");
  });

  it("keeps the dialog open when authoritative removal fails", async () => {
    const onRemoveProject = vi.fn(async () => false);

    await expect(
      executeConfirmedProjectRemoval({
        onRemoveProject,
        path: "/workspace/project"
      })
    ).resolves.toBe(false);

    expect(onRemoveProject).toHaveBeenCalledOnce();
  });
});
