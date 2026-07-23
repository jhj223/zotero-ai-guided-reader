# AI Guided Reader reliability and local CLI design

## Scope

Upgrade the existing Zotero reader sidebar without changing its bootstrapped
architecture or creating persistent Zotero annotations.

The release must:

- keep every visible claim traceable to a PDF location;
- prefer character-range selection and keep the current selection visible;
- never silently present an ambiguous fuzzy match as exact;
- render LaTeX, tables, and cached MinerU images in the sidebar;
- restore cached outlines and generated section guides when a paper reopens;
- make section close reading collapsible;
- expose model choices, including local Codex CLI and Claude Code CLI;
- retain Note and Anki exports as secondary actions.

## Positioning

Use a three-tier locator:

1. Exact normalized text-layer match. Rich MinerU text is converted to visible
   text before matching: HTML tags are removed, entities decoded, LaTeX layout
   commands discarded, and compatibility characters normalized.
2. A bbox-scoped fuzzy match is accepted only when its score is above the
   threshold and sufficiently better than the runner-up. Position breaks ties,
   but cannot turn a low-quality match into an exact result.
3. If text cannot be resolved safely, select the PDF characters whose centers
   overlap the MinerU bbox. This is a persistent block-level selection, not
   Zotero's two-second `_highlightPosition` flash.

The UI may report `exact`, `approximate`, or `block` precision. Page-only
navigation remains the final fallback when the Reader text layer or page size is
unavailable.

## MinerU rich content

Parse cache version 3 stores typed anchor payloads:

- equations: LaTeX source;
- tables: sanitized source HTML and caption;
- images/charts: caption, MinerU description, and a relative cached asset name.

ZIP assets are extracted only from `images/`, with path traversal checks,
extension allowlisting, count and byte limits. Existing v2 parse and guide
caches remain usable for text. They are not reparsed automatically. A paper
needs one explicit reparse only when the user requests missing legacy image
assets.

Table reading is grounded in the extracted table HTML. Figure reading uses the
MinerU caption/description and displays the original extracted image. When no
description exists, generated prose must say it is based on the caption rather
than infer unseen details.

## Rendering and state

KaTeX renders `$...$`, `$$...$$`, `\\(...\\)`, and `\\[...\\]` fragments.
Non-math text is emitted as text nodes; arbitrary LLM HTML is never executed.

On mount, the service reads valid parse and guide caches and hydrates the
outline plus every generated structured section. Expanded/collapsed state is
UI-only. The action becomes `Expand close reading` / `Collapse` and does not
regenerate an already cached section.

Save Note and Export Anki stay implemented but move under a secondary More
menu. Note is generally useful for Zotero-native persistence. Anki remains
useful only to Anki users and is not a primary reading action.

## Providers and models

API providers keep independent BYOK settings. Model selection is a curated
dropdown with a Custom option. Provider changes update the available choices
without overwriting an explicitly stored custom model.

`codex-cli` and `claude-cli` are first-class providers and require no API key.
The plugin detects only known native executable locations or an explicitly
configured absolute executable path.

Prompts are written to stdin, never interpolated into a shell command. Each
process has a fixed argument vector, an isolated empty working directory, a
timeout, combined output limit, and non-zero-exit diagnostics that exclude the
prompt. Codex uses ephemeral, read-only, ignored-user-config execution. Claude
uses print mode, JSON output, no session persistence, strict empty MCP config,
and no tools. LLM JSON is still validated by the existing local normalizers.

## Acceptance

- Exact rich-text evidence selects the intended character range and remains
  highlighted until another selection/navigation action.
- Ambiguous repeated text is either resolved by bbox with high confidence or
  visibly downgraded; it never silently selects the wrong occurrence.
- Reopening a generated paper shows its cached outline and generated sections
  without pressing Parse or Generate.
- Equations render with KaTeX; tables and newly cached figures are readable.
- All providers have selectable models; both local CLIs complete a structured
  smoke prompt without an API key.
- Unit tests, TypeScript build, production XPI build, installation, and Zotero
  runtime checks pass.
