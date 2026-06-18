# Performance issue: typing latency on large docs with comments + suggestions

Living doc. Updated as we investigate. Last updated: 2026-06-18.

## Summary

A large document (~127K words / ~309 pages) edits smoothly with **no** review
markup. Once the same document carries **comments and tracked changes
(suggestions)**, typing and undo/redo become visibly laggy.

The plain large-doc spec (`performance-large-docs.spec.ts`) passes every typing
scenario. The new comments+suggestions variant fails the same scenarios purely
on keystroke→repaint latency.

## Status

- [x] Reproduced with a deterministic fixture + e2e test
- [ ] Root cause identified
- [ ] Fix landed (React)
- [ ] Mirrored in Vue (`useDocxEditor.ts`)
- [ ] Tests green

## Reproduction

Fixture: [`e2e/fixtures/issue-68-large-comments-suggestions.docx`](e2e/fixtures/issue-68-large-comments-suggestions.docx)

- Same body content/size as `issue-68-large.docx` (~127K words, 309 pages).
- **212 comments** (one every ~10 body paragraphs) with `comments.xml` +
  `commentsExtended.xml`.
- **211 tracked changes** — alternating `w:ins` insertions and `w:del`
  deletions, spread across the whole document.

Generator: [`scripts/generate-large-doc-comments-suggestions.ts`](scripts/generate-large-doc-comments-suggestions.ts)
(modeled on `scripts/generate-large-doc-issue68.ts`).

```bash
bun scripts/generate-large-doc-comments-suggestions.ts
```

Test: [`e2e/tests/performance-large-docs-comments-suggestions.spec.ts`](e2e/tests/performance-large-docs-comments-suggestions.spec.ts)
(mirrors `performance-large-docs.spec.ts` + one comment-adjacent typing test).

```bash
npx playwright test e2e/tests/performance-large-docs-comments-suggestions.spec.ts --timeout=120000 --workers=1
```

## Measured latency

Budget is `<500ms` per keystroke (same in both specs). Both specs are the same
scenarios on the same body; the only difference is the comments+suggestions
fixture. Numbers from back-to-back local runs on 2026-06-18 (Darwin arm64),
`--workers=1`.

Plain baseline: [`e2e/tests/performance-large-docs.spec.ts`](e2e/tests/performance-large-docs.spec.ts) (308 pages, no review markup).
Review variant: [`e2e/tests/performance-large-docs-comments-suggestions.spec.ts`](e2e/tests/performance-large-docs-comments-suggestions.spec.ts) (309 pages, 212 comments, 211 suggestions).

| Scenario | Plain (baseline) | Comments + suggestions | Slowdown |
| --- | --- | --- | --- |
| Load | 2466ms | 7159ms | ~2.9× |
| Typing at document start | 99ms ✅ | **3682ms** ❌ | ~37× |
| Typing in the middle | 17ms ✅ | 17ms ✅ | — |
| Typing near document end | 17ms ✅ | 17ms ✅ | — |
| Typing next to a comment + suggestion | n/a (test not present) | **3510ms** ❌ | — |
| Scrolling after edit | 1505ms ✅ | 1506ms ✅ | — |
| Undo | 64ms ✅ | **5215ms** ❌ | ~82× |
| Redo | 81ms ✅ | **2126ms** ❌ | ~26× |

✅ = under the 500ms budget (pass) · ❌ = over budget (fail).

### What the comparison tells us

- The slow scenarios are all **edit→re-render** paths. Steady-state typing in
  the **middle / end** of the doc is identical (17ms) in both — so the cost is
  not per-keystroke layout of the whole document.
- The blowup is concentrated where a transaction touches the **start of the
  document** or runs **undo/redo** — i.e. the paths that rebuild
  comment/suggestion-dependent state. Start-of-doc typing goes 99ms → 3682ms
  (~37×); undo goes 64ms → 5215ms (~82×).
- The comment-adjacent typing test (review variant only) confirms editing right
  next to review markup is in the same ~3.5s range.
- Load itself is ~2.9× slower, but that's a one-time cost, not the lag the user
  feels while editing.

## Suspects (unverified)

The keystroke path re-runs work proportional to the whole ~2400-block document
on every transaction:

- **Tracked-change overlay `<style>` rebuild** —
  [`DocxEditorShell.tsx:238`](packages/react/src/components/DocxEditor/DocxEditorShell.tsx#L238)
  rebuilds comment/insertion/deletion highlight CSS on transactions.
- **Comment sidebar anchor recomputation** —
  `components/DocxEditor/internals/sidebarAnchorPositions.ts` and
  `hooks/useCommentSidebarItems.tsx` recompute Y positions for all comments.
- **Selection overlay / sidebar item sync** — `useSelectionOverlay.ts`
  (`updateSelectionOverlay` / `onSelectionChange`) and
  `DocxEditor.tsx` (`onSelectionChange`, `expandedSidebarItem`).
- Worth confirming whether the painter re-paints all comment-range /
  `docx-insertion` / `docx-deletion` spans rather than only the dirty region.

## Next steps

1. Profile a single keystroke with the fixture loaded (Performance panel) to
   attribute the cost to a concrete code path.
2. Confirm whether cost scales with comment/suggestion count vs. document size
   (vary fixture density).
3. Once root cause is known: fix in React, mirror in Vue, keep both adapters in
   parity (see CLAUDE.md "React/Vue parity").

## Notes

- Test/fixture-only so far — no changeset needed yet. A changeset is required
  once a fix touches package code.
