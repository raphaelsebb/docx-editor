---
'@eigenpal/docx-editor-react': minor
'@eigenpal/docx-editor-vue': minor
'@eigenpal/docx-editor-core': patch
---

Expose `mediaResolver` prop/option on both React and Vue adapters, enabling hosts to supply a server-side EMF/WMF→PNG converter for vector-only metafile images that browsers cannot render natively. The hook receives each `MediaFile` with its original bytes on `.data`; return a displayable URL to override the built-in placeholder, or `null`/`undefined` to keep default handling.
