export const svgDataUrlPrefix = "data:image/svg+xml,";

export function cssSafeSvgDataUrl(svg: string): string {
  return `${svgDataUrlPrefix}${encodeURIComponent(svg)}`;
}
