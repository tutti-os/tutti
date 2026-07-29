import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

export function WorkspaceMarkdownPreview({
  content
}: {
  content: string;
}): React.JSX.Element {
  return (
    <div className="h-full min-h-0 min-w-0 overflow-auto bg-[var(--background-fronted)]">
      <article
        className={[
          "mx-auto w-full max-w-[840px] px-6 py-5 text-[13px] leading-[1.65] text-[var(--text-primary)] [overflow-wrap:anywhere]",
          "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
          "[&_h1]:mt-7 [&_h1]:mb-3 [&_h1]:border-b [&_h1]:border-[var(--line-2)] [&_h1]:pb-2 [&_h1]:text-[24px] [&_h1]:font-semibold [&_h1]:leading-tight",
          "[&_h2]:mt-6 [&_h2]:mb-3 [&_h2]:border-b [&_h2]:border-[var(--line-2)] [&_h2]:pb-1.5 [&_h2]:text-[20px] [&_h2]:font-semibold [&_h2]:leading-tight",
          "[&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:text-[17px] [&_h3]:font-semibold [&_h3]:leading-snug",
          "[&_h4]:mt-4 [&_h4]:mb-2 [&_h4]:text-[14px] [&_h4]:font-semibold",
          "[&_p]:my-3",
          "[&_a]:font-medium [&_a]:text-[var(--tutti-purple)] [&_a]:underline [&_a]:underline-offset-2",
          "[&_strong]:font-semibold",
          "[&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6",
          "[&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6",
          "[&_li]:my-1 [&_li>p]:my-1",
          "[&_blockquote]:my-4 [&_blockquote]:border-l-4 [&_blockquote]:border-[var(--line-2)] [&_blockquote]:pl-4 [&_blockquote]:text-[var(--text-secondary)]",
          "[&_hr]:my-6 [&_hr]:border-0 [&_hr]:border-t [&_hr]:border-[var(--line-2)]",
          "[&_code]:rounded-[3px] [&_code]:bg-[var(--transparency-block)] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-[var(--tsh-font-mono)] [&_code]:text-[12px]",
          "[&_pre]:my-4 [&_pre]:overflow-auto [&_pre]:rounded-[8px] [&_pre]:bg-[var(--transparency-block)] [&_pre]:p-3",
          "[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[12px] [&_pre_code]:leading-[1.6]",
          "[&_table]:my-4 [&_table]:w-full [&_table]:border-collapse [&_table]:text-[12px]",
          "[&_th]:border [&_th]:border-[var(--line-2)] [&_th]:bg-[var(--transparency-block)] [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold",
          "[&_td]:border [&_td]:border-[var(--line-2)] [&_td]:px-3 [&_td]:py-2 [&_td]:align-top",
          "[&_img]:my-4 [&_img]:max-w-full [&_img]:rounded-[8px]",
          "[&_input[type=checkbox]]:mr-2"
        ].join(" ")}
        data-workspace-markdown-preview="true"
      >
        <ReactMarkdown
          rehypePlugins={[rehypeSanitize]}
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ children, node: _node, ...props }) => (
              <a {...props} rel="noreferrer" target="_blank">
                {children}
              </a>
            )
          }}
        >
          {content}
        </ReactMarkdown>
      </article>
    </div>
  );
}
