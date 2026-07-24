import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Avatar } from "./avatar";

class MockImage extends EventTarget {
  complete = false;
  naturalWidth = 0;
  private source = "";

  get src(): string {
    return this.source;
  }

  set src(value: string) {
    if (value !== this.source) {
      this.complete = false;
      this.naturalWidth = 0;
      this.source = value;
    }
  }
}

let preloadedImages: MockImage[] = [];
let resizeObservers: MockResizeObserver[] = [];

class MockResizeObserver {
  constructor(private callback: ResizeObserverCallback) {
    resizeObservers.push(this);
  }

  disconnect(): void {}

  observe(): void {}

  resize(width: number, height: number): void {
    this.callback(
      [
        {
          contentRect: { height, width }
        } as ResizeObserverEntry
      ],
      this as unknown as ResizeObserver
    );
  }

  unobserve(): void {}
}

function expectDeliveryUrl(
  source: string,
  expected: {
    format?: string;
    height: string;
    width: string;
  }
): void {
  const url = new URL(source);
  expect(url.searchParams.get("width")).toBe(expected.width);
  expect(url.searchParams.get("height")).toBe(expected.height);
  expect(url.searchParams.get("format")).toBe(expected.format ?? "webp");
  expect(url.searchParams.get("fit")).toBe("inside");
}

function finishPreload(status: "error" | "loaded"): void {
  const image = preloadedImages.at(-1);
  if (!image) {
    throw new Error("Expected Radix Avatar to create an image preloader");
  }

  if (status === "loaded") {
    image.complete = true;
    image.naturalWidth = 40;
  }

  act(() => {
    image.dispatchEvent(new Event(status === "loaded" ? "load" : "error"));
  });
}

describe("Avatar", () => {
  beforeEach(() => {
    preloadedImages = [];
    resizeObservers = [];
    vi.stubGlobal(
      "Image",
      class extends MockImage {
        constructor() {
          super();
          preloadedImages.push(this);
        }
      }
    );
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders a decorative image and forwards root and image props", () => {
    const onLoad = vi.fn();

    render(
      <Avatar
        aria-label="Jun Sun"
        data-testid="avatar"
        imageClassName="object-contain"
        imageProps={{ "data-testid": "avatar-image", onLoad }}
        label="Jun Sun"
        src="https://example.test/avatar.png"
        surfaceClassName="bg-muted"
      />
    );

    expect(screen.getByTestId("avatar")).toHaveAttribute(
      "data-avatar-state",
      "loading"
    );
    expect(screen.queryByTestId("avatar-image")).not.toBeInTheDocument();

    finishPreload("loaded");
    const image = screen.getByTestId("avatar-image");
    fireEvent.load(image);

    expect(screen.getByTestId("avatar")).toHaveAttribute(
      "data-avatar-state",
      "image"
    );
    expect(screen.getByTestId("avatar")).toHaveAttribute(
      "aria-label",
      "Jun Sun"
    );
    expect(image).toHaveAttribute("alt", "");
    expect(image).toHaveClass("object-contain");
    expect(onLoad).toHaveBeenCalledOnce();
  });

  it("falls back to the requested initial when an image fails", () => {
    render(
      <Avatar
        data-testid="avatar"
        fallbackColor="rgb(10, 20, 30)"
        imageProps={{ "data-testid": "avatar-image" }}
        initial="j"
        label="Jun Sun"
        size="sm"
        src="https://example.test/avatar.png"
      />
    );

    finishPreload("error");
    expect(preloadedImages.at(-1)?.src).toBe("https://example.test/avatar.png");
    finishPreload("error");

    expect(screen.getByTestId("avatar")).toHaveAttribute(
      "data-avatar-state",
      "initial"
    );
    expect(screen.getByTestId("avatar")).toHaveTextContent("J");
    expect(
      screen.getByTestId("avatar").querySelector('[data-slot="avatar-surface"]')
    ).toHaveStyle({ backgroundColor: "rgb(10, 20, 30)" });
  });

  it("does not show the initial while an image is loading", () => {
    render(
      <Avatar
        data-testid="avatar"
        label="Jun Sun"
        src="https://example.test/avatar.png"
      />
    );

    expect(screen.getByTestId("avatar")).toHaveAttribute(
      "data-avatar-state",
      "loading"
    );
    expect(screen.getByTestId("avatar")).not.toHaveTextContent("J");
    expect(
      screen.getByTestId("avatar").querySelector('[data-slot="avatar-surface"]')
    ).toHaveClass("bg-transparent");

    finishPreload("error");
    finishPreload("error");
    expect(screen.getByTestId("avatar")).toHaveTextContent("J");
  });

  it("falls back when the rendered image fails after preloading", () => {
    const onError = vi.fn();

    render(
      <Avatar
        data-testid="avatar"
        imageProps={{ "data-testid": "avatar-image", onError }}
        label="Jun Sun"
        src="https://example.test/avatar.png"
      />
    );

    finishPreload("loaded");
    fireEvent.error(screen.getByTestId("avatar-image"));
    expect(preloadedImages.at(-1)?.src).toBe("https://example.test/avatar.png");
    finishPreload("error");

    expect(screen.getByTestId("avatar")).toHaveAttribute(
      "data-avatar-state",
      "initial"
    );
    expect(screen.getByTestId("avatar")).toHaveTextContent("J");
    expect(screen.queryByTestId("avatar-image")).not.toBeInTheDocument();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("supports an intentionally empty fallback and numeric sizing", () => {
    render(
      <Avatar
        data-testid="avatar"
        fallback="empty"
        fallbackColor="red"
        label="Private profile"
        size={18}
      />
    );

    expect(screen.getByTestId("avatar")).toHaveAttribute(
      "data-avatar-state",
      "empty"
    );
    expect(screen.getByTestId("avatar")).toHaveStyle({
      height: "18px",
      width: "18px"
    });
    expect(screen.getByTestId("avatar")).toHaveTextContent("");
  });

  it("renders a loading surface without an image or initial", () => {
    render(
      <Avatar
        data-testid="avatar"
        label="Jun Sun"
        loading
        src="https://example.test/avatar.png"
      />
    );

    expect(screen.getByTestId("avatar")).toHaveAttribute(
      "data-avatar-state",
      "loading"
    );
    expect(screen.getByTestId("avatar")).toHaveTextContent("");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(
      screen.getByTestId("avatar").querySelector('[data-slot="avatar-surface"]')
    ).toHaveClass("animate-pulse", "motion-reduce:animate-none");
  });

  it("retries a failed URL after the source changes away and back", () => {
    const { rerender } = render(
      <Avatar
        imageProps={{ "data-testid": "avatar-image" }}
        label="Jun Sun"
        src="https://example.test/a.png"
      />
    );

    finishPreload("error");
    rerender(
      <Avatar
        imageProps={{ "data-testid": "avatar-image" }}
        label="Jun Sun"
        src="https://example.test/b.png"
      />
    );
    finishPreload("loaded");
    rerender(
      <Avatar
        imageProps={{ "data-testid": "avatar-image" }}
        label="Jun Sun"
        src="https://example.test/a.png"
      />
    );
    finishPreload("loaded");

    expect(screen.getByTestId("avatar-image")).toHaveAttribute(
      "src",
      expect.stringContaining("https://example.test/a.png?")
    );
  });

  it("requests a bucketed 2x WebP image and preserves unrelated query params", () => {
    render(
      <Avatar
        label="Jun Sun"
        size="lg"
        src="https://cdn.example.test/avatar.png?token=preserved"
      />
    );

    const source = preloadedImages.at(-1)?.src;
    expect(source).toBeDefined();
    expectDeliveryUrl(source ?? "", { height: "96", width: "96" });
    expect(new URL(source ?? "").searchParams.get("token")).toBe("preserved");
  });

  it("updates delivery dimensions from the rendered avatar box", () => {
    render(
      <Avatar label="Jun Sun" src="https://cdn.example.test/avatar.png" />
    );

    act(() => {
      resizeObservers.at(-1)?.resize(88, 40);
    });

    expectDeliveryUrl(preloadedImages.at(-1)?.src ?? "", {
      height: "96",
      width: "192"
    });
  });

  it("supports requesting the original source without delivery params", () => {
    render(
      <Avatar
        delivery="original"
        label="Jun Sun"
        src="https://cdn.example.test/avatar.png?token=preserved"
      />
    );

    expect(preloadedImages.at(-1)?.src).toBe(
      "https://cdn.example.test/avatar.png?token=preserved"
    );
  });

  it("does not transform non-HTTP image sources", () => {
    render(<Avatar label="Jun Sun" src="data:image/png;base64,cHJldmlldw==" />);

    expect(preloadedImages.at(-1)?.src).toBe(
      "data:image/png;base64,cHJldmlldw=="
    );
  });

  it("retries the original URL when image delivery fails", () => {
    render(
      <Avatar
        imageProps={{ "data-testid": "avatar-image" }}
        label="Jun Sun"
        src="https://cdn.example.test/avatar.png?token=preserved"
      />
    );

    finishPreload("error");
    expect(preloadedImages.at(-1)?.src).toBe(
      "https://cdn.example.test/avatar.png?token=preserved"
    );
    finishPreload("loaded");

    expect(screen.getByTestId("avatar-image")).toHaveAttribute(
      "src",
      "https://cdn.example.test/avatar.png?token=preserved"
    );
  });

  it("renders overlays outside the clipped image surface", () => {
    render(
      <Avatar data-testid="avatar" label="Alice">
        <span data-testid="badge">online</span>
      </Avatar>
    );

    expect(screen.getByTestId("avatar")).toContainElement(
      screen.getByTestId("badge")
    );
  });

  it("uses the first Unicode character and a question mark for blank labels", () => {
    const { rerender } = render(<Avatar data-testid="avatar" label="阿丽塔" />);
    expect(screen.getByTestId("avatar")).toHaveTextContent("阿");

    rerender(<Avatar data-testid="avatar" label="" />);
    expect(screen.getByTestId("avatar")).toHaveTextContent("?");
  });
});
