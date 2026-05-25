<p align="center">
  <a href="https://www.docx-editor.dev/">
    <img src="https://raw.githubusercontent.com/eigenpal/docx-editor/main/.github/assets/header.png" alt="DOCX Editor — .docx in, .docx out. Open source, agent ready, client-side." width="500" />
  </a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@eigenpal/docx-editor-core"><img src="https://img.shields.io/npm/v/@eigenpal/docx-editor-core.svg?style=flat-square&color=3B5BDB" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@eigenpal/docx-editor-core"><img src="https://img.shields.io/npm/dm/@eigenpal/docx-editor-core.svg?style=flat-square&color=3B5BDB" alt="npm downloads" /></a>
  <a href="https://github.com/eigenpal/docx-editor/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache_2.0-blue.svg?style=flat-square&color=3B5BDB" alt="license" /></a>
  <a href="https://docx-editor.dev/editor"><img src="https://img.shields.io/badge/Live_Demo-3B5BDB?style=flat-square&logo=vercel&logoColor=white" alt="Demo" /></a>
  <a href="https://www.docx-editor.dev/docs"><img src="https://img.shields.io/badge/Docs-3B5BDB?style=flat-square&logo=readthedocs&logoColor=white" alt="Documentation" /></a>
</p>

# @eigenpal/docx-editor-core

Framework-agnostic core for the [docx-editor](https://docx-editor.dev). Parses DOCX, builds the document model, runs ProseMirror, renders Word-fidelity pages, **and converts DOCX to Markdown for LLM pipelines**. Powers the React and Vue adapters and anything else you build on top.

## DOCX → Markdown

Best-in-class headless converter that preserves what Pandoc and mammoth throw away: page boundaries, merged-cell tables, tracked changes, comments, footnotes, headers. Built on the same layout engine that paginates our live WYSIWYG editor.

```bash
npm install @eigenpal/docx-editor-core
```

```ts
import { toMarkdown } from '@eigenpal/docx-editor-core/markdown';
import { readFile } from 'node:fs/promises';

const { markdown, images, warnings } = await toMarkdown(await readFile('doc.docx'));
console.log(markdown);
```

### Which function do I want?

| Need                                                                         | Use                    |
| ---------------------------------------------------------------------------- | ---------------------- |
| One continuous markdown string                                               | `toMarkdown`           |
| Per-page markdown (for RAG citations, page-anchored LLM input)               | `toMarkdownPaged`      |
| Substitute each image through an async handler (vision models, blob uploads) | `toMarkdownAsync`      |
| Both of the above                                                            | `toMarkdownPagedAsync` |

### Compared to alternatives

|                                          | this | mammoth | Pandoc  |
| ---------------------------------------- | :--: | :-----: | :-----: |
| Browser-native (no binary)               |  ✅  |   ✅    |   ❌    |
| Page boundaries preserved                |  ✅  |   ❌    |   ❌    |
| Merged-cell tables (`colspan`/`rowspan`) |  ✅  |   ❌    | partial |
| Tracked changes (`<ins>`/`<del>`)        |  ✅  |   ❌    | partial |
| Comments (inline + sidecar)              |  ✅  |   ❌    |   ❌    |
| Image substitution callback              |  ✅  |   ❌    |   ❌    |
| Auto-loaded Office font substitutes      |  ✅  |   ❌    |   ❌    |
| Owns the full DOCX rendering stack       |  ✅  |   ❌    |   ❌    |

### Server-side pagination

For DOCX files that have never been opened in Word (programmatically generated, freshly built from templates), the heuristic page splitter has nothing to act on. Opt in to the layout engine instead:

```bash
npm install --save-optional @napi-rs/canvas
```

```ts
import { toMarkdownPagedAsync } from '@eigenpal/docx-editor-core/markdown';
const { pages } = await toMarkdownPagedAsync(buffer, { useLayoutEngine: 'fallback' });
```

The library auto-downloads Google's Croscore substitutes (Carlito for Calibri, Caladea for Cambria, Arimo for Arial/Aptos, Tinos for Times New Roman, Cousine for Courier New) into a tmp cache on first use.

**Live demo:** [`examples/markdown-playground`](../../examples/markdown-playground) — drop a `.docx`, see Word view + markdown side by side, toggle every option live.

## Quick Start for the WYSIWYG editor

Most users want the [React](https://www.npmjs.com/package/@eigenpal/docx-editor-react) or [Vue](https://www.npmjs.com/package/@eigenpal/docx-editor-vue) adapter. Reach for core directly when building a custom adapter, running headless on the server, or driving DOCX parsing/serialization without a UI.

```ts
import { readFile } from 'node:fs/promises';
import { parseDocx } from '@eigenpal/docx-editor-core/docx';

const buffer = await readFile('contract.docx');
const document = await parseDocx(buffer);
console.log(document.paragraphs.length);
```

Each subpath tree-shakes independently. Pick the smallest entry point that gives you what you need.

## Packages

| Package                                                                                      | Description                                                                                                                                |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| [`@eigenpal/docx-editor-react`](https://www.npmjs.com/package/@eigenpal/docx-editor-react)   | <img src="https://cdn.simpleicons.org/react/61DAFB" width="20" align="middle" /> &nbsp; React adapter. Toolbar, paged editor, plugins.     |
| [`@eigenpal/docx-editor-vue`](https://www.npmjs.com/package/@eigenpal/docx-editor-vue)       | <img src="https://cdn.simpleicons.org/vuedotjs/4FC08D" width="20" align="middle" /> &nbsp; Vue 3 adapter. Toolbar, paged editor, plugins.  |
| [`@eigenpal/docx-editor-core`](https://www.npmjs.com/package/@eigenpal/docx-editor-core)     | Framework-agnostic core: OOXML parser, serializer, layout engine, ProseMirror schema. Depend on this if you fork the React or Vue adapter. |
| [`@eigenpal/docx-editor-i18n`](https://www.npmjs.com/package/@eigenpal/docx-editor-i18n)     | Shared locale strings and types consumed by both adapters.                                                                                 |
| [`@eigenpal/docx-editor-agents`](https://www.npmjs.com/package/@eigenpal/docx-editor-agents) | Agent SDK and chat UI: framework-agnostic bridge, MCP server, AI SDK adapters, plus React UI.                                              |

> **Forking the adapter?** Keep your fork thin. Depend on `@eigenpal/docx-editor-core` directly so parser, serializer, and rendering fixes land in your build automatically, without backporting each upstream change by hand.

## Subpath map

| Building...                       | Import from                                                      | What you get                                                                                                                  |
| --------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| A new framework adapter           | `./docx`, `./prosemirror/conversion`, `./prosemirror/extensions` | `parseDocx`, `toProseDoc` / `fromProseDoc`, `createStarterKit`, `ExtensionManager`                                            |
| DOCX to Markdown                  | `./markdown`                                                     | `toMarkdown`, `toMarkdownPaged`, `toMarkdownAsync`. See [`examples/markdown-playground`](../../examples/markdown-playground). |
| Custom layout / rendering         | `./layout-engine`, `./layout-bridge`, `./layout-painter`         | `layoutDocument`, `mouseToPosition`, `renderPage`, `LayoutPainter`                                                            |
| Editor commands and plugins       | `./prosemirror/commands`, `./prosemirror/plugins`                | Formatting, tables, suggestion mode, selection tracker                                                                        |
| Saving back to `.docx`            | `./docx`                                                         | `repackDocx`, `attemptSelectiveSave`                                                                                          |
| Headless agents (no UI)           | `./agent`                                                        | `DocumentAgent`, `executeCommand`, `AgentCommand` types                                                                       |
| An MCP server                     | `./mcp`                                                          | Model Context Protocol server scaffolding                                                                                     |
| Just unit/color/clipboard helpers | `./utils`                                                        | `twipsToPixels`, `resolveColor`, font loading, clipboard, selection helpers                                                   |
| Just a type                       | `./types/document`, `./types/content`, `./types/agentApi`        | `Document`, `Paragraph`, `Comment`, `AgentCommand`, ...                                                                       |
| Default editor stylesheet         | `./prosemirror/editor.css`                                       | Import once at the top of your app                                                                                            |

## Stability

`./layout-engine`, `./layout-painter`, `./layout-bridge`, and `./plugin-api` are **`@experimental`** — used by the first-party adapters but the API may change in minor releases until a third-party adapter validates it. Pin a version range. Everything else follows SemVer.

## Peer dependencies

ProseMirror packages are declared as `peerDependencies` so consumer bundles don't ship duplicates:

```bash
npm i prosemirror-commands prosemirror-dropcursor prosemirror-history \
      prosemirror-keymap prosemirror-model prosemirror-state \
      prosemirror-tables prosemirror-transform prosemirror-view
```

## Architecture

Dual-rendering: a hidden ProseMirror instance owns editing state (selection, undo/redo, commands) while `layout-painter` produces the visible pages. Full breakdown: **[docx-editor.dev/docs/architecture](https://www.docx-editor.dev/docs/architecture)**.

## Contributing

Contributions welcome. See [CONTRIBUTING.md](https://github.com/eigenpal/docx-editor/blob/main/CONTRIBUTING.md) for setup, tests, and the one-time CLA signature.

## Commercial Support

> [!TIP]
> Questions or custom features? Email **[docx-editor@eigenpal.com](mailto:docx-editor@eigenpal.com)**.
