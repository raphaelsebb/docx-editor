Each numbered group is one shippable PR, in dependency order. Per-PR gate: `bun run typecheck` → engine unit tests (synchronous `scheduleFrame` stub) → **FULL** Playwright suite in BOTH adapters (not a grep subset — this is the hot editing loop) → visual-regression before/after → `api:extract` + `check:parity-contract` → `bun changeset` (patch) → `bun run format`. Wire React first (canonical, expect zero behavior delta), validate, then wire Vue.

## 1. Engine skeleton + layout pipeline — engine.run(state)

- [ ] 1.1 Create `packages/core/src/editor/` with `DocxEditorEngine.ts` + `EngineHost.ts` (the full host interface from design, even though only the layout subset is implemented now). Add `./editor` export + tsup entry + typesVersions + exports-map allowlist.
- [ ] 1.2 Lift the 6-step pass from React `useLayoutPipeline.ts:204-527` into `engine.run(state)`: toFlowBlocks → computePerBlockWidths+measure → collectFootnoteRefs → HF resolve (via `host.getHfPmView`) → margin extension → layoutDocument (+ two-pass footnote stabilize) → renderPages (full React option set).
- [ ] 1.3 Route adapter-specific outputs through host hooks: `onLayout(layout,blocks,measures)`, `onPainted()`, `onAnchorPositions(map)`, `onScrollRestore(pending)`, `onTotalPages(n)`. Each optional.
- [ ] 1.4 React: `useLayoutPipeline.ts` calls `engine.run`; keep React's useState/refs + scroll-restore useLayoutEffect + painter:painted listener as host-hook implementations. Verify zero behavior delta.
- [ ] 1.5 Vue: `useDocxEditor.ts:308-526` runLayoutPipeline calls `engine.run`; implement the host hooks Vue needs, leave React-only ones undefined. Vue gains columns/scroll-restore/painter:painted/render-options.
- [ ] 1.6 Engine unit tests (synchronous host): run produces expected Layout for a fixture doc (with/without footnotes, with/without columns). Core test under `editor/__tests__/`.
- [ ] 1.7 Verify: full suite both adapters; visual-regression diff; api:extract + parity; changeset.

## 2. rAF coalescing scheduler — engine.scheduleLayout(state)

- [ ] 2.1 Lift React's coalescer (`useLayoutPipeline.ts:597-613`) into `engine.scheduleLayout(state)` using `host.scheduleFrame`. Export a rAF `scheduleFrame` factory for adapters.
- [ ] 2.2 React: route the existing `scheduleLayout` callers through the engine (no behavior change).
- [ ] 2.3 Vue: replace synchronous `runLayoutPipeline(newState)` (`useDocxEditor.ts:576`) with `engine.scheduleLayout(newState)` + a rAF `scheduleFrame`. Closes the per-keystroke perf gap.
- [ ] 2.4 Engine unit test: N scheduleLayout calls in one frame → one run with the latest state; synchronous host runs immediately.
- [ ] 2.5 Verify: full suite both adapters (watch for timing-sensitive selection/overlay specs in Vue); changeset.

## 3. Transaction→repaint loop — engine.handleTransaction(tr, state)

- [ ] 3.1 Lift the shared handler from React `PagedEditor.tsx:476-510` into `engine.handleTransaction(tr,newState)`: decoration-notify, docChanged → incrementStateSeq + scheduleLayout + onDocumentChange, requestRender, selection-only → immediate overlay/SDT-focus. Strip `UPDATED_SCROLL` (from `HiddenProseMirror.tsx:317`).
- [ ] 3.2 React: body `dispatchTransaction` (HiddenProseMirror) + HF dispatch (HiddenHeaderFooterPMs:261-266 → PagedEditor:820) route through `engine.handleTransaction`.
- [ ] 3.3 Vue: body + HF `dispatchTransaction` (`useDocxEditor.ts:566-604`, `761-778`) route through `engine.handleTransaction`. Add scroll-flag stripping (Vue currently lacks it).
- [ ] 3.4 Engine unit test: docChanged schedules + notifies; selection-only updates overlay only; scroll flag cleared; HF docChanged triggers writeback + body schedule.
- [ ] 3.5 Decide (per design open question): fold cell-drag→CellSelection promotion into this PR or defer.
- [ ] 3.6 Verify: full suite both adapters; typing/undo/redo + selection specs; changeset.

## 4. PM view lifecycle — body + per-rId HF map

- [ ] 4.1 Lift body view create/teardown (React `HiddenProseMirror.tsx:282-421`) and HF enumerate/mount/teardown/writeback (`HiddenHeaderFooterPMs.tsx:122-275`) into the engine behind `host.mountView`/`destroyView`. Engine owns the `Map<rId,EditorView>` + per-rId ExtensionManager.
- [ ] 4.2 Add `engine.syncHfViews(document)` (enumerate+dedup+diff+mount+teardown+writeback). Keep the trigger adapter-side.
- [ ] 4.3 React: `HiddenProseMirror`/`HiddenHeaderFooterPMs` become thin — call engine view methods; drive `syncHfViews` from the existing `useEffect([slots])`.
- [ ] 4.4 Vue: `createEditorView`/`syncHfPMs` (`useDocxEditor.ts:532-781`) call engine view methods; drive `syncHfViews` from the imperative load path.
- [ ] 4.5 Engine unit test (happy-dom): syncHfViews mounts deduped views, tears down removed rIds + their managers, writes back on docChanged.
- [ ] 4.6 Verify: full suite both adapters; HF edit/click/type specs (hf-click-and-type, hf-text-selection, hf-selection-rects); changeset.

## 5. Load/save session seam — engine.load / engine.save

- [ ] 5.1 Lift load into `engine.load(buffer)` with the private generation counter (race guard from React `useDocumentLoader.ts:59,75,80`): normalize → parseDocx → recreate views → initial run.
- [ ] 5.2 Lift save into `engine.save({selective})` with the selective-via-agent path + reply-marker injection + `clearTrackedChanges` (from React `useFileIO.ts:59-120`).
- [ ] 5.3 React: `useDocumentLoader`/`useFileIO` delegate to engine.load/save (no behavior change).
- [ ] 5.4 Vue: `useDocxEditor.ts:816-888` loadBuffer/save delegate to engine — Vue gains the race guard, selective save, and post-save tracker clear. Note the selective-save output-byte change in the changeset; round-trip-test in Word/LibreOffice.
- [ ] 5.5 Engine unit test: late parse dropped (race guard); selective vs full repack path selection; tracker cleared post-save.
- [ ] 5.6 Verify: full suite both adapters; save/load round-trip specs; manual Word/LibreOffice round-trip; changeset.

## 6. Wrap-up

- [ ] 6.1 Confirm React `PagedEditor`/hooks and Vue `useDocxEditor` are thin engine wrappers (line-count drop); no duplicated orchestration remains.
- [ ] 6.2 Update CLAUDE.md architecture section to point at `core/editor/DocxEditorEngine` as the orchestration owner.
- [ ] 6.3 Update issue #696 with Tier 2 completion; note #89 (vanilla pkg) is now a thin-wrapper follow-up.
