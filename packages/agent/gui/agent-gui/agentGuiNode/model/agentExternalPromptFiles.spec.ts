import { describe, expect, it, vi } from "vitest";
import {
  createAgentExternalPromptFilePreparation,
  remainingAgentComposerPromptAssetSlots,
  type AgentExternalPromptFilePreparer,
  type AgentPreparedExternalPromptFile
} from "./agentExternalPromptFiles";

describe("agentExternalPromptFiles", () => {
  it("counts every prompt asset kind against the host limit", () => {
    expect(
      remainingAgentComposerPromptAssetSlots({
        files: 5,
        images: 4,
        largeTexts: 2,
        limit: 16
      })
    ).toBe(5);
    expect(
      remainingAgentComposerPromptAssetSlots({
        files: 8,
        images: 8,
        largeTexts: 1,
        limit: 16
      })
    ).toBe(0);
  });

  it("publishes pending files before resolving prepared locators", async () => {
    const files = [
      new File(["alpha"], "alpha.txt", { type: "text/plain" }),
      new File(["beta"], "beta.bin", {
        type: "application/octet-stream"
      })
    ];
    const prepareExternalPromptFiles = vi.fn<AgentExternalPromptFilePreparer>(
      async () => [
        {
          sourceIndex: 0,
          status: "prepared",
          file: {
            name: "alpha.txt",
            mimeType: "text/plain",
            sizeBytes: 5,
            uri: "object://alpha",
            url: "https://assets.example/alpha.txt"
          }
        },
        {
          sourceIndex: 1,
          status: "error",
          errorCode: "preparation_failed"
        }
      ]
    );

    const preparation = createAgentExternalPromptFilePreparation(files);

    expect(preparation.pendingFiles).toEqual([
      expect.objectContaining({
        name: "alpha.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
        uploading: true
      }),
      expect.objectContaining({
        name: "beta.bin",
        mimeType: "application/octet-stream",
        sizeBytes: 4,
        uploading: true
      })
    ]);

    await expect(
      preparation.complete(prepareExternalPromptFiles)
    ).resolves.toEqual([
      expect.objectContaining({
        name: "alpha.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
        uploading: false,
        uri: "object://alpha",
        url: "https://assets.example/alpha.txt"
      }),
      expect.objectContaining({
        name: "beta.bin",
        uploading: false,
        uploadError: "preparation_failed",
        uploadErrorCode: "preparation_failed"
      })
    ]);
    expect(prepareExternalPromptFiles).toHaveBeenCalledWith(files);
  });

  it("rejects prepared files without a provider-readable locator", async () => {
    const preparation = createAgentExternalPromptFilePreparation([
      new File(["x"], "missing.txt", { type: "text/plain" })
    ]);

    const settled = await preparation.complete(async () => [
      {
        sourceIndex: 0,
        status: "prepared",
        file: { name: "missing.txt" } as AgentPreparedExternalPromptFile
      }
    ]);

    expect(settled[0]).toEqual(
      expect.objectContaining({
        uploading: false,
        uploadError: "preparation_failed",
        uploadErrorCode: "preparation_failed"
      })
    );
  });

  it("rejects host-private identities without a path or URL", async () => {
    const preparation = createAgentExternalPromptFilePreparation([
      new File(["x"], "private.txt", { type: "text/plain" })
    ]);

    const settled = await preparation.complete(async () => [
      {
        sourceIndex: 0,
        status: "prepared",
        file: {
          name: "private.txt",
          assetId: "asset-1",
          uri: "object://private.txt"
        } as AgentPreparedExternalPromptFile
      }
    ]);

    expect(settled[0]).toEqual(
      expect.objectContaining({
        uploading: false,
        uploadError: "preparation_failed",
        uploadErrorCode: "preparation_failed"
      })
    );
  });
});
