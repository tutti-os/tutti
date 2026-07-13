export function shouldHideBrowserNodeWebview(input: {
  hidden: boolean;
  isHostOverlayOpen?: boolean;
  isHostMinimizing: boolean;
}): boolean {
  return (
    input.hidden || input.isHostMinimizing || input.isHostOverlayOpen === true
  );
}
