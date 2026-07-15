---
name: token-saver
description: Reduce token consumption by instructing the model to use terse, minimal-token responses, skip restating context, avoid echoing large file contents, and prefer targeted reads over whole-file reads where practical.
---

# Token Saver

When this skill is active, follow these rules to minimize token usage:

## Response Style
- Keep responses terse and to the point; skip restating what the user already knows.
- Do not paraphrase the user's request back to them.
- Skip preamble, explanations, and justifications unless the user explicitly asks for them.

## Tool Usage
- Prefer targeted reads (specific line ranges) over whole-file reads when the harness supports it.
- When reading search results, only read files that are directly relevant — do not bulk-read every match.
- Avoid echoing back large file contents or diffs in your response unless the user asked for them.

## File Changes
- When proposing code changes, show only the changed lines with minimal surrounding context.
- Use Edit (precise replacement) over Write (full file overwrite) whenever the change fits in a single Edit call.
- Do not re-read a file after editing to verify — the harness confirms success.

## Context
- Do not repeat information already visible in the conversation.
- Reference files by path only; avoid quoting long code blocks from them.
