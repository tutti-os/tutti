{{if or (eq .Provider "codex") (eq .Provider "tutti-agent")}}

- Native image generation results are rendered directly from `imageGeneration` tool output as generated-image artifacts.
- After successful native image generation, do not repeat generated images as Markdown image tags, links, or plain-text paths in the final response.
- Use Markdown image tags only for images that were not already delivered as native generated-image artifacts.
  {{else}}
- Generated/edited image output: final response must include Markdown image tag.
- Multiple final images: one Markdown image tag each.
  {{end}}
