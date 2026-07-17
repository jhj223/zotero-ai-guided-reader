# Zotero AI Guided Reader

Zotero 9 bootstrapped plugin for Chinese academic PDF guided reading. It uses
the user's own MinerU API key to parse PDFs into structured, page-anchored
chunks, then uses the user's own LLM API key to generate section-level outlines
and on-demand close-reading notes. Generated anchor markers such as
`[[ANCHOR:chunk_0042]]` render as clickable page links back to the PDF.

Built from `windingwind/zotero-plugin-template` with
`zotero-plugin-scaffold`, TypeScript, React, `zotero-plugin-toolkit`,
`zotero-types`, and JSZip.

## Development

```bash
npm install
npm test
npm run build
npm start
```

`npm start` runs `zotero-plugin serve`, which builds the plugin, launches Zotero
from `.env`, and hot-reloads source changes.

Copy `.env.example` to `.env` and set the Zotero executable/profile paths for
local development.

## BYOK Configuration

Open Zotero settings, then the **AI Guided Reader** pane.

LLM settings and MinerU settings are intentionally separate:

- **LLM provider**: Anthropic, OpenAI, DeepSeek, Qwen, VolcEngine, or
  SiliconFlow.
- **LLM API Key**: used only for guided-reading generation.
- **Model/Base URL**: optional overrides. Defaults are provider-specific.
- **MinerU API Key**: used only for PDF structured parsing.
- **MinerU model**: defaults to `vlm`.
- **Force OCR**: optional for scanned PDFs.

Keys are stored in the plugin preference namespace
`extensions.zotero.zoteroaiguidedreader.*`. The plugin masks keys in validation
messages and does not log plaintext keys.

## MinerU Parsing

The implementation follows the current MinerU precise parsing docs:

- `POST https://mineru.net/api/v4/file-urls/batch`
- signed `PUT` upload to the returned file URL
- poll `GET https://mineru.net/api/v4/extract-results/batch/{batch_id}`
- download `full_zip_url`
- parse `content_list_v2.json`, `content_list.json`, `middle.json`, and
  `full.md` from the result ZIP

Known MinerU limits surfaced in the UI:

- one file <= 200MB
- one file <= 200 pages
- 1000 highest-priority pages per account per day; later pages may queue longer

Degradation copy for quota/API failures:

> MinerU parsing is unavailable or delayed. The plugin will keep the current
> cached result if one exists. Otherwise, retry after the daily priority quota
> resets or after the MinerU API error is resolved. No fallback pdf.js layout
> parser is used in v1 because it would lose formula/table/multi-column quality.

`samples/mineru/` contains a placeholder for real response captures. A real
Token was not available in this environment, so the exact account response shape
still needs one live run before production use.

## Guided Reading Flow

1. Resolve the active reader item to a PDF attachment.
2. Reuse the cached MinerU parse for that attachment key if present.
3. Otherwise parse with MinerU and cache the normalized anchors under the Zotero
   data directory in `zotero-ai-guided-reader/`.
4. Generate a JSON outline from compact section/chunk context.
5. Expand individual sections on demand. Long papers are not sent wholesale to
   the LLM.
6. Convert `[[ANCHOR:chunk_0001]]` placeholders into clickable PDF page links.

Existing Zotero annotations are read with `item.getAnnotations(false)` and
included in the outline prompt so already-highlighted areas can be deprioritized
or marked as previously noticed.

## Jumping Back to PDF

Reliable v1 jump:

```text
zotero://open-pdf/library/items/{attachmentKey}?page=N
```

Group libraries use:

```text
zotero://open-pdf/groups/{groupID}/items/{attachmentKey}?page=N
```

MinerU `page_idx` is 0-based, while Zotero open-pdf links use user-visible page
numbers, so the plugin sends `page_idx + 1`.

Precise rect scroll/highlight is a progressive enhancement. The plugin logs a
TODO where a future Zotero Reader instance API experiment should wire temporary
session-only bbox highlighting. It deliberately does not create persistent
annotations via `Zotero.Annotations.saveFromJSON()`.

## Save and Export

- **Save Note** creates a Zotero note under the PDF parent item. Links are plain
  `zotero://open-pdf/...` anchors, not custom JavaScript.
- **Export Anki** writes a UTF-8 TSV with `Front / Back / Tags` columns. Anki's
  own FSRS scheduler handles review after import.

## Known Limits

- MinerU live parsing has not been executed without a user Token.
- Precise bbox highlighting is logged as an experimental TODO.
- Figure/table-level navigation is not implemented in v1.
- LLM adapters use common current HTTP APIs; provider-specific edge cases may
  need live BYOK validation.
- This project does not include plugin store publishing workflow.

## Sources Checked

- Zotero 7 developer documentation:
  https://www.zotero.org/support/dev/zotero_7_for_developers
- Zotero `ItemPaneManager.registerView()` API issue/example:
  https://github.com/zotero/zotero/issues/3380
- Zotero open-pdf recommended URL format:
  https://forums.zotero.org/discussion/90858/pdf-reader-and-zotero-open-pdf-links
- MinerU precise parsing API docs:
  https://mineru.net/apiManage/docs
- MinerU output file format:
  https://opendatalab.github.io/MinerU/reference/output_files/
- React `createRoot`:
  https://react.dev/reference/react-dom/client/createRoot
