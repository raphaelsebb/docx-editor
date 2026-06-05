## Context

Issue #696 Tier 2. Tier 1 (#706, merged) lifted the pure logic; this lifts the stateful orchestration. Exploration mapped four components against `origin/main` (file:line):

- **Layout pipeline** — React `useLayoutPipeline.ts:203-623`, Vue `useDocxEditor.ts:308-526`. ~85% identical 6-step pass. React is a strict superset.
- **PM view lifecycle** — React `HiddenProseMirror.tsx:282-421` (body) + `HiddenHeaderFooterPMs.tsx:122-275` (HF map); Vue `useDocxEditor.ts:532-781`. Create/teardown/writeback near-identical; the trigger differs (React reactive, Vue imperative).
- **Transaction→repaint loop** — React `PagedEditor.tsx:476-510` + scheduler `useLayoutPipeline.ts:597-613`; Vue `useDocxEditor.ts:566-604`. Only structural diff: React's rAF coalescer vs Vue's synchronous relayout.
- **Load/save** — React `useDocumentLoader.ts` (load, with `loadGenerationRef` guard) + `useFileIO.ts:59-120` (selective save + `clearTrackedChanges`); Vue `useDocxEditor.ts:816-888` (no race guard, full repack, no clear).

Constraints: CLAUDE.md dual-rendering model (hidden PM = editing state; painter = sole visible renderer; HF = one persistent EditorView per rId). Parity contract gates ref/prop surface. The intentional #670 divergence (Vue overlay adds scrollTop, React doesn't) must remain adapter-supplied. The float-zone measure pipeline (`measureBlocksWithFloats`) is already core and is the model for a clean lift.

## Goals / Non-Goals

**Goals:**

- One `DocxEditorEngine` in `core/editor/` owns the orchestration; React/Vue become thin wrappers.
- Behavior-identical for shared paths; adopt React (the complete impl) where adapters diverge, closing Vue gaps.
- Each of the 5 steps independently shippable under the full Playwright suite + parity contract.
- Keep reactivity bridges, overlay painting, and event-source subscriptions adapter-side.

**Non-Goals:**

- Shipping the vanilla package (#89) — separate change, unblocked by this.
- Changing the overlay-painting strategy (React declarative state vs Vue imperative createElement).
- The cell-drag→CellSelection pointer promotion (Vue cell-select gap) — pointer-controller work; may ride a step but is not core to the engine.
- Reworking the FlowBlock measure/layout/paint algorithms (already core).

## Decisions

**1. The engine is a plain class constructed with a DI'd `EngineHost`, not a framework-aware object.**

```
new DocxEditorEngine(host: EngineHost)
interface EngineHost {
  // view factories (framework-specific creation; engine owns lifecycle)
  mountView(hostEl, state, dispatch): EditorView
  destroyView(view): void
  getBodyHostEl(): HTMLElement
  getHfHostEl(): HTMLElement
  // render targets + read seams
  getPagesContainer(): HTMLElement | null
  getScrollContainer(): HTMLElement | null   // React; Vue may return null
  getDocument(): Document | null
  getZoom(): number                          // Vue defaults to 1
  // output hooks — each adapter implements what it renders (others no-op)
  onLayout?(layout, blocks, measures): void
  onPainted?(): void                          // React painter:painted signal
  onAnchorPositions?(map): void               // React sidebar
  onScrollRestore?(pending): void             // React scroll anchor
  onTotalPages?(n): void
  scheduleFrame(cb): cancel                    // rAF (React) / nextTick or rAF (Vue)
}
```

Rationale: the four components share state (views ↔ layout ↔ transactions ↔ session), so a single object that holds them and exposes `run`/`handleTransaction`/`load`/`save` is cleaner than 4 disconnected controller factories. `scheduleFrame` is DI'd (not hardcoded rAF) so a headless/SSR host can pass a synchronous stub. Alternative (free functions + a context bag threaded through every call, the Tier 1 style) was rejected: the orchestration is inherently stateful (pending-layout ref, view map, load generation), so a class owning that state is the right altitude.

**2. Adopt React as canonical for every divergence; Vue reaches parity in the same step.**
Per-component resolution: layout → React's superset (columns, scroll-restore, painter:painted, render options); scheduler → React's rAF coalescer; transaction → React's scroll-flag strip + gating; load → React's `loadGenerationRef`; save → React's selective-via-agent + `clearTrackedChanges`. Each is the more-complete/correct side. The DI hooks let Vue _opt out_ of purely-React-UI pieces (e.g. `onRenderedDomContext`) by leaving the hook undefined — so "adopt React" never forces React-only UI into Vue.

**3. Sequence is forced by data dependencies; ship one step per PR.**

```
 step 1 run(state) ──────────────┐
        │ (scheduler calls run)   │ (loop calls scheduler)
 step 2 scheduleLayout ───────────┤
        │                         │
 step 3 handleTransaction ────────┘  (dispatch → handleTransaction → schedule → run)
 step 4 view lifecycle  (views feed run + handleTransaction)
 step 5 load / save     (session seam; recreates views + initial run)
```

Steps 1-3 are the editing hot loop and are tightly coupled (3 calls 2 calls 1). Step 4 (views) feeds them but its trigger stays adapter-side, so it can land after the loop is shared. Step 5 (session) is the most independent. Each step: lift to engine, wire React first (it's the canonical source so its behavior shouldn't change), then wire Vue, then run the full suite in both.

**4. Reactivity stays adapter-side; the engine is push-based.**
The engine never reads framework reactive state. Adapters call `engine.handleTransaction(tr, state)` from their `dispatchTransaction`, and the engine calls back via `host.onLayout(...)` etc. React stores results in `useState`/refs; Vue assigns to `shallowRef`. The HF view _trigger_ (React `useEffect([slots])` vs Vue `syncHfPMs()` call) stays in the adapter; the engine exposes `engine.syncHfViews(document)` that does the actual enumerate/diff/mount/teardown, called from either trigger.

**5. The race guard and selective save move into the engine, not just lifted as helpers.**
`engine.load` owns the generation counter internally (a private field), so Vue gets the guard for free by calling `engine.load(buffer)`. `engine.save({selective})` owns the agent-path selective logic + `clearTrackedChanges` dispatch; Vue passes its document/view through the same path. The agent (`DocumentAgent`) is already core, so no new dependency.

## Risks / Trade-offs

- **[HIGH: behavior drift in the hot editing loop]** — this is the core typing/layout/paint path; a subtle regression (e.g. a dropped scroll-flag strip, a coalescing change) is felt on every keystroke. → Ship one step per PR; wire React first (canonical, zero behavior delta expected) and validate before touching Vue; run the FULL Playwright suite (not a grep subset) on each step in both adapters; keep before/after screenshots for the visual-regression specs.
- **[Vue gains React behaviors that may surface latent Vue bugs]** (rAF coalescing changes timing; selective save changes output bytes; race guard changes load ordering). → Each Vue adoption is its own PR half; treat output-byte changes (selective save) as a deliberate, changeset-noted behavior change and round-trip-test in Word/LibreOffice.
- **[The `EngineHost` interface ossifies early]** — get it wrong and every step fights it. → Design the full `EngineHost` in step 1 from all four exploration maps (done above), but only implement the layout subset first; add hooks per step. Treat it as the contract.
- **[Large diffs obscure review]** — each step deletes hundreds of adapter lines and adds engine lines. → Land the engine module and the React wiring in the same PR so the diff shows "moved, not rewritten"; lean on `git diff -M` rename detection where possible.
- **[rAF in tests/headless]** — coalescing via rAF breaks synchronous test expectations. → `scheduleFrame` is DI'd; the engine's own unit tests pass a synchronous stub; adapter E2E uses real rAF.
- **[#670 overlay-offset divergence]** — must stay Vue-only. → The engine never computes overlay coords; it emits layout, adapters paint overlays with their own offset rule (unchanged from today).

## Migration Plan

Five PRs, each merged to `main` independently with its own changeset (patch; the fixed group). No flag gating — shared paths stay behavior-identical; Vue gap-closers are additive or deliberate (selective save). Rollback is per-PR `git revert`. Order: 1 run → 2 scheduler → 3 transaction loop → 4 view lifecycle → 5 session. After all five, `PagedEditor`/`useDocxEditor` are thin wrappers and #89 is a small follow-up. If a step proves too risky mid-flight, it can stop there — the engine is usable with only the steps landed (e.g. engine owns layout+scheduler+loop while views/session stay adapter-side).

## Open Questions

- Does `engine.run` keep React's two-pass footnote stabilization inline, or is that already sufficiently core (`stabilizeFootnoteLayout`) to just call? (Leaning: already core, engine just orchestrates the two passes.)
- Should `scheduleFrame` default to rAF inside the engine with Vue overriding, or always be host-supplied? (Leaning: host-supplied, with a rAF default factory exported for adapters that want it.)
- Step 4: does the engine own the per-rId `ExtensionManager` lifecycle too, or just the EditorView? (Leaning: own both — they're 1:1 with the view and identical in both adapters.)
- Whether to fold the cell-drag→CellSelection pointer promotion into step 3 (it touches the same pointer/transaction area and closes a flagged Vue gap) or keep it separate. Decide when step 3 lands.
