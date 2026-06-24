---
'@eigenpal/docx-editor-react': patch
'@eigenpal/docx-editor-core': patch
---

Reduce typing latency on large documents by ~70%. Three fixes: (1) `useDocumentHistory` called `JSON.stringify` on the full Document on every keystroke to check equality — replaced with reference equality, saving 185–262ms per keypress on a 39MB file. (2) Painter now skips full DOM repopulation for pages whose layout didn't change (only PM offsets shifted after an edit earlier in the document), using a fast in-place attribute update instead. (3) Float-zone setup in the measurement pipeline is memoised so text-only keystrokes skip the O(N) scan. Also suppress browser spell-check and autocorrect pipelines on the off-screen PM, and exclude it from the AX tree.
