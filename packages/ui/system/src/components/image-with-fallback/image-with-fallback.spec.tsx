import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ImageWithFallback } from "./image-with-fallback";

afterEach(() => cleanup());

describe("ImageWithFallback", () => {
  it("retries the same source once before showing fallback", async () => {
    const view = render(
      <ImageWithFallback
        src="https://cdn.example.test/icon.png"
        retryDelayMs={0}
        fallback={<span data-testid="fallback">fallback</span>}
      />
    );
    const firstImage = view.container.querySelector("img") as HTMLImageElement;

    fireEvent.error(firstImage);
    const retriedImage = await waitFor(() => {
      const image = view.container.querySelector("img");
      expect(image).not.toBe(firstImage);
      expect(image?.getAttribute("src")).toBe(
        "https://cdn.example.test/icon.png"
      );
      return image as HTMLImageElement;
    });

    fireEvent.error(retriedImage);
    await waitFor(() => {
      expect(view.container.querySelector("img")).toBeNull();
      expect(screen.getByTestId("fallback")).not.toBeNull();
    });
  });

  it("renders fallback without requesting an empty source", () => {
    const view = render(
      <ImageWithFallback
        src=" "
        fallback={<span data-testid="fallback">fallback</span>}
      />
    );

    expect(view.container.querySelector("img")).toBeNull();
    expect(screen.getByTestId("fallback")).not.toBeNull();
  });
});
