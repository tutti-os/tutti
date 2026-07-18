import { describe, expect, it } from "vitest";

import { cssSafeSvgDataUrl, svgDataUrlPrefix } from "./cssSafeSvgDataUrl";

describe("cssSafeSvgDataUrl", () => {
  it("encodes SVG markup for a quoted CSS url", () => {
    const svg = "<" + 'svg viewBox="0 0 24 24"><path fill="#000" /></svg>';
    const url = cssSafeSvgDataUrl(svg);

    expect(url).toMatch(/^data:image\/svg\+xml,%3Csvg/);
    expect(url).not.toContain("<" + "svg");
    expect(url).not.toContain('"');
    expect(url).not.toContain("#");
    expect(decodeURIComponent(url.slice(svgDataUrlPrefix.length))).toBe(svg);

    const style = document.createElement("span").style;
    style.maskImage = `url("${svgDataUrlPrefix}${svg}")`;
    expect(style.maskImage).toBe("");

    style.maskImage = `url("${url}")`;
    expect(style.maskImage).toBe(`url("${url}")`);
  });
});
