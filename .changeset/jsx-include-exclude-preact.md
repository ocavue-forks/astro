---
'@astrojs/preact': patch
---

If `include`/`exclude` options are passed to the Preact integration, use them to filter the components during SSR. This is useful when multiple JSX renderers are used (e.g. React + Preact).
