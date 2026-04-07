# Plan: Use **astro_tag_component** to associate JSX components with renderers

## Idea

Astro already has a mechanism to skip the `check()` loop: `__astro_tag_component__`. It sets `Component[Symbol.for('astro:renderer')] = rendererName`, and `renderFrameworkComponent` (component.ts:124-133) checks this tag BEFORE the `check()` loop. If tagged, the renderer is looked up by name directly — no `check()` calls at all.

Currently only MDX uses this (in `vite-plugin-mdx-postprocess.ts`). The approach: each integration adds a **separate** Vite plugin that tags components from matching files.

## How it works

### 1. MDX's existing pattern (reference)

In `vite-plugin-mdx-postprocess.ts`, MDX appends to transformed code:

```javascript
import { __astro_tag_component__ } from 'astro/runtime/server/index.js';
__astro_tag_component__(Content, 'astro:jsx');
```

This tags the `Content` component so the renderer is resolved instantly at render time (component.ts:131-133):

```javascript
if (isTagged) {
  const rendererName = Component[Symbol.for('astro:renderer')];
  renderer = renderers.find(({ name }) => name === rendererName);
}
```

### 2. The tagging Vite plugin (separate from JSX transform)

The tagging plugin must be **separate** from the JSX transform plugin. Reason: in real integrations like `@astrojs/react` and `@astrojs/preact`, the JSX transform is handled by third-party plugins (`@vitejs/plugin-react`, `@preact/preset-vite`) that we don't own. We can't modify those. The tagging plugin is an additional Astro-owned plugin registered alongside them.

The plugin runs with `enforce: 'post'` to ensure it executes AFTER the JSX transform plugins (which run in normal order). At this point, JSX syntax has been compiled but the module export structure is preserved — `es-module-lexer` can still parse it.

### 3. When to tag (only when absolutely necessary)

Tagging is ONLY needed when multiple renderers could conflict — i.e., when the `check()` loop might pick the wrong renderer. This happens when:

- The user has configured `include` (meaning they have multiple JSX renderers and want explicit file → renderer mapping)
- There's at least one other JSX renderer registered

If `include` is NOT set, there's no conflict to resolve — either there's only one renderer, or the user accepts first-renderer-wins behavior. No tagging needed.

In practice: the integration only creates the tagging plugin when `include` is set.

### 4. es-module-lexer: handling all export patterns

The tagging plugin uses `es-module-lexer` to find exports and tag them. `parse(code)` returns `[imports, exports]` where each export has:

- `n`: export name (e.g., `'default'`, `'Foo'`)
- `ln`: local binding name (`string | undefined`)
- `s`, `e`: start/end positions of the export name in source
- `ls`, `le`: start/end positions of the local name

**Case 1: `ln` is available** — direct tagging

| Pattern                            | `ln` value | Example              |
| ---------------------------------- | ---------- | -------------------- |
| `export default function Foo() {}` | `'Foo'`    | Named function       |
| `export default class Foo {}`      | `'Foo'`    | Named class          |
| `export default Foo` (reference)   | `'Foo'`    | Existing binding     |
| `export { Foo as default }`        | `'Foo'`    | Re-export as default |
| `export function Bar() {}`         | `'Bar'`    | Named export         |
| `export const Baz = () => {}`      | `'Baz'`    | Const export         |

For these, simply append:

```javascript
import { __astro_tag_component__ } from 'astro/runtime/server/index.js';
__astro_tag_component__(Foo, '@astrojs/react');
```

**Case 2: `ln` is undefined** — need to rewrite

| Pattern                             | Why `ln` is undefined        |
| ----------------------------------- | ---------------------------- |
| `export default () => {}`           | Anonymous arrow              |
| `export default memo(Foo)`          | Expression, not identifier   |
| `export { default } from './other'` | Binding is in another module |

For these, we rewrite the default export to capture the value:

```javascript
// Before:
export default memo(Foo);

// After:
const __astro_tagged_default__ = memo(Foo);
__astro_tag_component__(__astro_tagged_default__, '@astrojs/react');
export default __astro_tagged_default__;
```

**However**, the re-export case (`export { default } from './other'`) cannot be tagged here — the component lives in another module. This is an edge case; in practice, framework components are almost always defined in the file they're exported from.

**Full code snippet for the tagging Vite plugin:**

```javascript
import { parse } from 'es-module-lexer';

function astroTagComponentPlugin(rendererName, include) {
  return {
    name: `astro:${rendererName}:tag-components`,
    enforce: 'post',
    async transform(code, id) {
      // Only process JSX/TSX files
      if (!id.endsWith('.jsx') && !id.endsWith('.tsx')) return null;

      // Only process files matching the include pattern
      // (In real code, use picomatch to match `include` against `id`)
      if (!matchesInclude(id, include)) return null;

      const [, exports] = parse(code);

      // Tag the default export
      const defaultExport = exports.find((e) => e.n === 'default');
      if (!defaultExport) return null;

      // Prepare the import
      let result = code;
      const tagImport = `\nimport { __astro_tag_component__ } from 'astro/runtime/server/index.js';`;

      if (defaultExport.ln) {
        // Case 1: local name available — tag directly
        result += tagImport;
        result += `\n__astro_tag_component__(${defaultExport.ln}, ${JSON.stringify(rendererName)});`;
      } else {
        // Case 2: no local name (anonymous/wrapped export)
        // Rewrite: extract the default export expression into a variable
        //
        // Find the default export statement boundaries using es-module-lexer positions.
        // `s` is the start of "default" keyword in the export statement.
        // We need to find "export default <expr>" and rewrite it.
        //
        // Strategy: find "export default " in the code near position `s`,
        // replace it with a variable assignment + tagging + re-export.
        const exportStart = code.lastIndexOf('export', defaultExport.s);
        const afterDefault = code.indexOf('default', defaultExport.s) + 'default'.length;
        // Skip whitespace after "default"
        let exprStart = afterDefault;
        while (exprStart < code.length && /\s/.test(code[exprStart])) exprStart++;

        // Find the end of the expression (next semicolon or end of file)
        // This is simplified — a robust implementation would use the AST
        let exprEnd = code.indexOf(';', exprStart);
        if (exprEnd === -1) exprEnd = code.length;

        const expr = code.slice(exprStart, exprEnd);
        const before = code.slice(0, exportStart);
        const after = code.slice(exprEnd + 1);

        result = before;
        result += `const __astro_tagged_default__ = ${expr};`;
        result += tagImport;
        result += `\n__astro_tag_component__(__astro_tagged_default__, ${JSON.stringify(rendererName)});`;
        result += `\nexport default __astro_tagged_default__;`;
        result += after;
      }

      // Tag named exports too (they might be used as components)
      for (const exp of exports) {
        if (exp.n === 'default') continue;
        if (!exp.ln) continue;
        // Only tag function/class exports, not constants like `url` or `file`
        // In practice, we tag all named exports — the tag is harmless on non-components
        if (!result.includes(tagImport)) {
          result += tagImport;
        }
        result += `\n__astro_tag_component__(${exp.ln}, ${JSON.stringify(rendererName)});`;
      }

      return { code: result, map: null };
    },
  };
}
```

### Can we distinguish components from non-components?

**Short answer: No, and we don't need to.** A JSX file can export anything — components, utility functions, constants, types. At static analysis time (Vite transform), there's no reliable way to know which exports are React/Preact components and which are plain functions. A component is just a function that happens to return JSX — syntactically indistinguishable from any other function.

**But tagging non-components is harmless.** Here's why:

1. `__astro_tag_component__` (index.ts:62-70) only acts on functions (`typeof Component !== 'function'` → returns). Constants, objects, strings, etc. are silently skipped.

2. The tag (`Symbol.for('astro:renderer')`) is a non-enumerable property on the function object. It doesn't affect the function's behavior — calling it, passing it as a callback, `JSON.stringify`, `Object.keys`, etc. all work identically.

3. The tag is ONLY read inside `renderFrameworkComponent` (component.ts:124-133), which is ONLY called when something is used as `<Component />` in an `.astro` template. If an exported utility function is never used as a component in Astro, its tag is never read.

4. If a tagged non-component IS mistakenly used as `<UtilFn />` in Astro, it gets routed to the tagged renderer. The renderer's `renderToStaticMarkup` would then fail or produce unexpected output — but this is the same behavior as without tagging (the check() loop would also route it to some renderer).

**Therefore: we tag ALL function exports from matching files.** This is safe and avoids the impossible task of distinguishing components from non-components at build time. In practice, the only exports that matter are those used as `<Component />` in `.astro` files — and for those, the tag ensures the correct renderer.

For the code snippet above, the approach is:

- Tag the default export (most common case for components)
- Tag named exports too (they could be components used as `<NamedExport />`)
- Non-function exports are silently ignored by `__astro_tag_component__`

### Unresolved limitation

Tagging non-component exports is unacceptable because we don't know if there are bad side effects, and it's not good for bundle size. Since we cannot statically distinguish components from non-components at build time (a component is just a function that returns JSX — syntactically identical to any other function), the `__astro_tag_component__` approach at the JSX file level cannot selectively tag only components.

**Status: ARCHIVED** — this approach is blocked by the inability to identify components at build time.

### 5. How it applies to real integrations

**`@astrojs/react` (`packages/integrations/react/src/index.ts`)**:

```javascript
// In getViteConfiguration():
plugins: [
  react({ include, exclude, babel }),         // Third-party JSX transform (not ours)
  optionsPlugin({ ... }),                     // Astro-owned options plugin
  configEnvironmentPlugin(reactConfig),       // Astro-owned env config
  // NEW: only when include is set
  ...(include ? [astroTagComponentPlugin('@astrojs/react', include)] : []),
],
```

**`@astrojs/preact` (`packages/integrations/preact/src/index.ts`)**:

```javascript
// In hooks['astro:config:setup']:
viteConfig.plugins = [
  preactPlugin, // Third-party JSX transform (not ours)
  configEnvironmentPlugin(compat), // Astro-owned env config
  // NEW: only when include is set
  ...(include ? [astroTagComponentPlugin('@astrojs/preact', include)] : []),
];
```

Both integrations pass their `include` option to the third-party JSX plugin (for build-time JSX transform) AND to the tagging plugin (for runtime renderer selection). The tagging plugin is only active when `include` is set.

Note: Preact already detects multiple JSX renderers at `astro:config:done` (line 57-66 of preact/index.ts) and warns if `include`/`exclude` isn't set. The tagging plugin aligns with this — it's only needed when `include` IS set.

### 6. What happens at render time

With tagging:

1. `WoofCounter.woof.jsx` → Vite JSX transform → Vite tagging plugin → `__astro_tag_component__(WoofCounter, 'woof')`
2. At render time, `Component[Symbol.for('astro:renderer')]` is `'woof'`
3. component.ts:131-133 finds renderer `'woof'` directly — `check()` loop is skipped entirely
4. MeowCounter gets tagged with `'meow'` → resolved to meow renderer directly

### 7. Why this works for ALL rendering modes

- **SSR-only**: The tag is set on the component function at import time (during Vite transform). `renderFrameworkComponent` checks it at line 124-133. Works.
- **client:load**: Same as SSR — the component is tagged before render. Works.
- **client:only**: Bypasses the `check()` loop entirely via the directive value (separate code path at line 169-198). Not affected. Works.

This is the key advantage over the `metadata.componentUrl` approach (plan1.md): tagging works for SSR-only too, because it's set at module load time, not derived from compiler metadata.

## Files to change (for our test fixture)

| File                       | Change                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `renderers/woof/index.mjs` | Add separate tagging Vite plugin using `es-module-lexer` + `__astro_tag_component__` |
| `renderers/meow/index.mjs` | Same                                                                                 |

No Astro runtime changes. No new files. No changes to server.mjs, client.mjs, pages, or test file.

## Expected test results after this change

**With include option:**

- SSR: 3 pass (tagging resolves renderer correctly, no check() loop needed)
- client:load: 2 pass (same reason)
- client:only: pass (unchanged — explicit renderer via directive)

**Without include option:**

- All pass (no tagging → falls back to check() loop → first renderer wins, which is acceptable)

**Total: 10 pass, 0 fail**
