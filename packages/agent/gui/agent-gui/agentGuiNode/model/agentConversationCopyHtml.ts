import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

// react-markdown's default transform only keeps http(s)/irc(s)/mailto/xmpp
// URLs, which would strip the inline `data:image/...` sources the markdown
// serializer produces for attachments. Allow exactly those data images and
// defer everything else to the default sanitization. Raw HTML embedded in
// message text stays inert because react-markdown ignores html nodes.
//
// The allow-list is raster subtypes only, not a bare `data:image/` prefix:
// an image block's mimeType comes from unvalidated message content (tool
// output, a collaborator's message), so a `data:image/svg+xml` source could
// otherwise reach the text/html clipboard flavor verbatim — SVG is an XML
// document that can carry <script> and event handlers, unlike a raster
// image.
const SAFE_DATA_IMAGE_URL_PATTERN =
  /^data:image\/(?:png|jpe?g|gif|webp|bmp|avif|x-icon|vnd\.microsoft\.icon);/i;

function conversationCopyUrlTransform(url: string): string {
  return SAFE_DATA_IMAGE_URL_PATTERN.test(url) ? url : defaultUrlTransform(url);
}

/**
 * Renders the clipboard markdown transcript to an HTML fragment for the
 * `text/html` clipboard flavor. Rich-paste targets (Word, Feishu/Lark docs,
 * Notion, mail clients) consume this flavor, so inline data-URI images paste
 * as real images instead of a base64 wall of text; `text/plain` keeps the
 * markdown source for plain editors.
 */
export function renderAgentConversationCopyHtml(markdown: string): string {
  return renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkGfm],
        urlTransform: conversationCopyUrlTransform
      },
      markdown
    )
  );
}
