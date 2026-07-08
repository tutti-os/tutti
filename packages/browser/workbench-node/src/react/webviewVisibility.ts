export function shouldHideBrowserNodeWebview(input: {
  hidden: boolean;
  isHostMinimizing: boolean;
}): boolean {
  return input.hidden || input.isHostMinimizing;
}
