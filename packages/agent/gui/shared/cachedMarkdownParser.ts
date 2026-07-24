import { readParsedDocumentCache } from "./parsedDocumentCache";

type MarkdownParser = (...args: unknown[]) => unknown;

interface MarkdownProcessor {
  parser?: unknown;
}

interface CachedMarkdownParserOptions {
  cacheKey: string;
  content: string;
}

export function cachedMarkdownParser(
  this: MarkdownProcessor,
  options: CachedMarkdownParserOptions
): void {
  if (typeof this.parser !== "function") {
    return;
  }
  const parse = this.parser as MarkdownParser;
  this.parser = (...args: unknown[]) =>
    structuredClone(
      readParsedDocumentCache({
        namespace: "markdown",
        identity: options.cacheKey,
        source: options.content,
        create: () => parse.apply(this, args)
      })
    );
}
