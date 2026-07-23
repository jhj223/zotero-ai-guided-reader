# Zotero AI Guided Reader collaboration guide

## Runtime and architecture

- Target Zotero 9.0.x. The manifest is bootstrapped (`manifest.json` plus
  `bootstrap.js`); do not introduce legacy XUL overlays.
- Keep the existing TypeScript, React, `zotero-plugin-scaffold`, and
  `zotero-plugin-toolkit` structure.
- The user should be able to start AI guided reading by right-clicking a PDF
  attachment (or its parent item) and by opening the reader sidebar.

## Confirmed product requirements

- Keep LLM generation, MinerU parsing, and optional semantic-location
  credentials independent. Never log or commit plaintext keys.
- Cloud LLM providers include Anthropic, OpenAI, DeepSeek, Qwen, VolcEngine,
  and SiliconFlow. Local Codex CLI and Claude Code CLI are selectable generation
  providers. Provider model lists must be discoverable with a fetch button and
  still allow a custom model.
- MinerU `vlm` is the recommended default for papers with formulas and complex
  layouts. OCR has only two states: force OCR or do not force OCR. Parsed data is
  cached by attachment key and restored when the paper is reopened.
- Semantic location is optional and supports multiple embedding vendors. It is
  a fallback for paraphrased claims, not a replacement for PDF coordinates.
- Generate a structured outline first, then expandable close reading per
  section. Allow regeneration and cache generated content. Do not impose an
  arbitrary generation limit or add a cancel-generation workflow unless the
  user asks for it later.
- Every visible generated claim must retain one or more source anchors. When a
  claim is supported by several locations, expose each distinct location rather
  than repeatedly linking the same block.
- Prefer persistent, character-range selection in the active reader. Resolve
  repeated text with page/bbox context. Fall back explicitly through
  approximate text, bbox highlight, and page navigation; never present an
  ambiguous match as character-exact.
- Do not create persistent annotations through
  `Zotero.Annotations.saveFromJSON()` for navigation.
- Render formulas with LaTeX/KaTeX. Preserve readable tables and MinerU figure
  assets/descriptions. Figure/table element-level navigation is outside v1.
- Keep close reading collapsible. Keep both Zotero Note saving and UTF-8 Anki
  TSV export; Anki scheduling remains Anki's FSRS responsibility.

## Source of truth and verification

- Keep this file, `README.md`, and design specs aligned with confirmed user
  decisions so collaborators do not need the chat transcript.
- Treat live MinerU endpoints and response fields as version-sensitive. Check
  official documentation and preserve only redacted response fixtures.
- Before reporting completion, run unit tests, TypeScript checking, linting,
  production XPI build, installation, and focused Zotero 9 runtime checks as
  appropriate to the change.

## Git workflow

- Commit each logically complete, verified change with a focused Conventional
  Commit. Include requirement/spec updates in the same logical change.
- Git commits are local by default. Push or create a GitHub repository only
  when the user explicitly requests a remote upload or push.
- Review the staged diff and scan for secrets before committing. Never commit
  `.env`, API keys, Zotero profile data, caches, logs, or build output.
- Do not revert unrelated user changes. Do not claim a GitHub upload unless a
  remote push has actually succeeded.
