---
'@eigenpal/docx-editor-core': patch
---

Render embedded WMF and EMF images. Windows metafiles (which browsers can't decode, previously shown as a broken/white box) are now converted for display: vector metafiles render as crisp SVG, and ones using record types the vector path can't cover (e.g. CAD line-art) fall back to a rasterized image. The original metafile bytes are preserved, so saving round-trips the source losslessly. Decoders load on demand only when a document contains a metafile. Fixes #743, #755.
