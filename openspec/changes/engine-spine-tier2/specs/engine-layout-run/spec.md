## ADDED Requirements

### Requirement: Shared layout pass engine.run(state)

The engine SHALL expose `run(state)` implementing the 6-step layout pass: PM doc → flow blocks → measure → header/footer resolve → margin extension → `layoutDocument` (with two-pass footnote stabilization when footnotes exist) → `renderPages`. The pass SHALL be lifted from React's superset implementation, with column/per-block-width support, scroll-anchor restore, the `painter:painted` signal, and the full `renderPages` option set (including `resolvedCommentIds`, `pageBorders`, header/footer distances). Adapter-specific outputs SHALL be delivered through `EngineHost` hooks (`onLayout`, `onPainted`, `onAnchorPositions`, `onScrollRestore`, `onTotalPages`), each optional so an adapter opts into only what it renders.

#### Scenario: Identical layout for the same state

- **WHEN** `run(state)` executes for a given EditorState in either adapter
- **THEN** it produces the same `Layout`, blocks, and measures the prior adapter pipeline produced, and paints the same pages DOM

#### Scenario: Vue reaches React layout parity

- **WHEN** the Vue adapter adopts `engine.run`
- **THEN** Vue gains column layout, scroll-anchor restore, the `painter:painted` event, and the previously-missing render options — with no regression to the existing Vue layout output for documents that use none of those features

#### Scenario: Optional output hooks

- **WHEN** an adapter leaves `onAnchorPositions` / `onScrollRestore` undefined
- **THEN** `run` skips those outputs without error (the adapter simply doesn't render them)

#### Scenario: Footnote two-pass preserved

- **WHEN** the document contains footnotes
- **THEN** `run` performs the initial layout, builds the footnote content map, and stabilizes — matching the prior convergence behavior
