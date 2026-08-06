import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { renderMentionRow } from "./MentionRow.tsx";

afterEach(() => cleanup());

describe("MentionRow image fallbacks", () => {
  test("retries an app icon once before showing the kind glyph", async () => {
    const view = render(
      renderMentionRow({
        kind: "app",
        name: "Weather",
        iconUrl: "https://cdn.example.test/weather.png"
      })
    );

    const firstImage = view.container.querySelector("img") as HTMLImageElement;
    fireEvent.error(firstImage);
    const retriedImage = await waitFor(() => {
      const image = view.container.querySelector("img");
      expect(image).not.toBeNull();
      expect(image).not.toBe(firstImage);
      return image as HTMLImageElement;
    });
    fireEvent.error(retriedImage);

    await waitFor(() => expect(view.container.querySelector("img")).toBeNull());
    expect(
      view.container.querySelector(".rich-text-at-mention-kind-icon--app")
    ).not.toBeNull();
  });

  test("retries an image thumbnail once before showing the file glyph", async () => {
    const view = render(
      renderMentionRow({
        kind: "file",
        name: "diagram.png",
        visualKind: "image",
        thumbnailUrl: "https://cdn.example.test/diagram.png"
      })
    );

    const firstImage = view.container.querySelector("img") as HTMLImageElement;
    fireEvent.error(firstImage);
    const retriedImage = await waitFor(() => {
      const image = view.container.querySelector("img");
      expect(image).not.toBeNull();
      expect(image).not.toBe(firstImage);
      return image as HTMLImageElement;
    });
    fireEvent.error(retriedImage);

    await waitFor(() => expect(view.container.querySelector("img")).toBeNull());
    expect(
      view.container.querySelector(
        '[data-rich-text-at-mention-file-visual-kind="image"]'
      )
    ).not.toBeNull();
  });

  test("replaces a failed user avatar and placeholder with a user glyph", async () => {
    const view = render(
      renderMentionRow({
        kind: "session",
        participant: "Agent",
        userAvatarUrl: "https://cdn.example.test/user.png",
        userAvatarPlaceholderUrl: "https://cdn.example.test/placeholder.png",
        agentIconUrl: "https://cdn.example.test/agent.png"
      })
    );

    const userAvatar = view.container.querySelector(
      "[data-rich-text-at-mention-user-avatar] img"
    ) as HTMLImageElement;
    fireEvent.error(userAvatar);
    const retriedUserAvatar = await waitFor(() => {
      const image = view.container.querySelector(
        "[data-rich-text-at-mention-user-avatar] img"
      );
      expect(image).not.toBe(userAvatar);
      expect(image?.getAttribute("src")).toBe(
        "https://cdn.example.test/user.png"
      );
      return image as HTMLImageElement;
    });
    fireEvent.error(retriedUserAvatar);
    await waitFor(() => {
      expect(
        view.container
          .querySelector("[data-rich-text-at-mention-user-avatar] img")
          ?.getAttribute("src")
      ).toBe("https://cdn.example.test/placeholder.png");
    });
    const firstPlaceholder = view.container.querySelector(
      "[data-rich-text-at-mention-user-avatar] img"
    ) as HTMLImageElement;
    fireEvent.error(firstPlaceholder);
    const retriedPlaceholder = await waitFor(() => {
      const image = view.container.querySelector(
        "[data-rich-text-at-mention-user-avatar] img"
      );
      expect(image).not.toBe(firstPlaceholder);
      expect(image?.getAttribute("src")).toBe(
        "https://cdn.example.test/placeholder.png"
      );
      return image as HTMLImageElement;
    });
    fireEvent.error(retriedPlaceholder);
    await waitFor(() => {
      expect(
        view.container.querySelector(
          "[data-rich-text-at-mention-user-avatar] img"
        )
      ).toBeNull();
    });
    expect(
      view.container.querySelector(
        "[data-rich-text-at-mention-user-avatar] svg"
      )
    ).not.toBeNull();
  });
});
