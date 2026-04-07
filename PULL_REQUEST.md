# fix(preact): use `include`/`exclude` patterns in renderer `check()` to prevent cross-framework conflicts

Fixes #15341

## Problem

When multiple JSX renderers are active (e.g. React + Preact), Astro's renderer selection uses a `check()` loop that iterates **all** renderers and picks the first one whose `check()` returns `true`. The `include`/`exclude` options that users pass to integrations (e.g. `preact({ include: ['**/preact/*'] })`) are only used by the Vite JSX transform plugin — they are **completely ignored** during SSR renderer selection.

This means Preact's `check()` is called on React components (and vice versa). Preact's `check()` uses a "try to render it" strategy — it calls `renderToStaticMarkup` on the component to see if it produces valid HTML. When it tries this on a React component that uses hooks, React throws an "Invalid hook call" error to `console.error`.

PR #15619 (already merged) partially fixed this by updating Preact's console filter to recognize React v19's new error message format (which changed from `"Warning: Invalid hook call. ... reactjs.org/..."` to `"Invalid hook call. ... react.dev/..."`). However, that was only a bandaid — the underlying architectural problem remained: Preact still tries to render React components, wasting work and relying on fragile error string matching.

## Solution

This PR adds **filter logic to Preact's `check()` function** so it rejects components whose file path doesn't match the user's `include`/`exclude` patterns. This prevents mismatched components from being try-rendered in the first place.

### Architecture

```
User config                     Virtual module                Server module
preact({                   →    astro:preact:opts         →   server.ts check()
  include: ['**/preact/*'],     exports { include, exclude }  imports opts, builds filter,
  exclude: [...]                                              uses metadata.componentUrl
})
```

### Changes

**1. `packages/integrations/preact/src/index.ts` — Virtual module plugin**

Added `optionsPlugin()` that creates virtual module `astro:preact:opts`, exporting the `include`/`exclude` values serialized with `devalue.uneval()`. This follows the same pattern as `@astrojs/react`'s `astro:react:opts`.

**2. `packages/integrations/preact/src/server.ts` — Filter logic in `check()`**

- Import `createFilter` from `@rollup/pluginutils` and `opts` from the virtual module
- Build a filter at module scope (once, not per-call)
- Accept `metadata` as the 4th argument to `check()`
- **Early return** `false` when the filter rejects `metadata.componentUrl`, before the expensive try-render

**3. `packages/astro/src/runtime/server/render/component.ts` — Pass metadata to `check()`**

The `check()` loop now passes `metadata` as the 4th argument. Previously, `check()` only received `(Component, props, children)`. The `metadata.componentUrl` is already available at this point for hydrated components.

Also added a fallback for custom renderer resolution in `client:only` mode — custom renderers (like the woof/meow test renderers) can now be resolved by their exact name, not just by the `@astrojs/*` alias pattern.

**4. `packages/integrations/preact/env.d.ts` — Type declaration**

Type declaration for the `astro:preact:opts` virtual module.

**5. Test fixture: `multiple-jsx-renderers`**

Added a comprehensive test fixture with two mock renderers (woof/meow) that demonstrates the filter pattern. Tests cover:
- SSR-only rendering (known limitation documented)
- `client:load` rendering (filter works correctly)
- `client:only` rendering (explicit renderer, bypasses check)
- Both with and without `include` option

**6. E2E test: `react19-preact-hook-error`** (from PR #15619)

Validates that no "Invalid hook call" errors appear in dev server logs when React 19 + Preact are used together with `include` patterns.

### How it works per scenario

| Scenario | Before | After |
|---|---|---|
| `client:load` React component, Preact has `include` | Preact's `check()` tries to render → console error | Preact's `check()` rejects via filter → no error |
| `client:load` Preact component, Preact has `include` matching | `check()` try-renders → true | Filter passes → `check()` try-renders → true |
| SSR-only component, Preact has `include` | `check()` try-renders → false positive | **Still broken** — `metadata.componentUrl` is undefined |
| No `include`/`exclude` configured | `check()` try-renders all | Identical behavior (filter is null) |

### Known limitation

SSR-only components (those without any `client:*` directive) don't have `metadata.componentUrl`, because the Astro compiler only emits `client:component-path` for hydrated components. The filter can't apply in this case, and `check()` falls back to its existing try-render behavior.

This is a deeper architectural limitation that requires a compiler change to fix — the compiler should emit a path attribute (e.g. `ssr:component-path`) for **all** framework components, not just hydrated ones. See PURPOSE.md for the detailed proposal.

## Testing

- `pnpm test -- packages/astro/test/multiple-jsx-renderers.test.js` — 10 tests (all pass)
- `pnpm test -- packages/astro/e2e/react19-preact-hook-error.test.js` — E2E regression test
- Existing Preact tests remain passing (no `include`/`exclude` → filter is null → no behavior change)
