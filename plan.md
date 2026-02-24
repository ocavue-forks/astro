# Plan: Add include/exclude filter logic to Preact's `check()` in server.ts

## Goal

When multiple JSX renderers are active (e.g., React + Preact), Preact's `check()` function currently tries to render **every** component, causing false positives (it claims React components) and noisy console errors. The `include`/`exclude` options that users pass to `preact({ include: '...' })` are only used by the Vite JSX transform plugin — they are completely ignored during SSR renderer selection.

This plan adds filter logic to Preact's `check()` so it rejects components whose file path doesn't match the user's `include`/`exclude` patterns, using `metadata.componentUrl` (available for hydrated components).

## How it works

### Data flow

```
User config                     Virtual module                Server module
preact({                   →    astro:preact:opts         →   server.ts check()
  include: ['**/preact/*'],     exports { include, exclude }  imports opts, builds filter,
  exclude: [...]                                              uses metadata.componentUrl
})
```

### Why `metadata.componentUrl`

The `check()` function receives 4 arguments: `(Component, props, children, metadata)`. For hydrated components (`client:load`, `client:idle`, `client:visible`, `client:media`), `metadata.componentUrl` contains the full file path (e.g., `/Users/.../src/components/preact/Counter.tsx`). The filter can match this against the `include`/`exclude` patterns.

For SSR-only components (no `client:*` directive), `metadata.componentUrl` is `undefined`. In this case, the filter cannot apply and `check()` falls back to its current behavior (try-render). This is a known limitation — SSR-only components can still be claimed by the wrong renderer.

**Future improvement**: Ideally, the Astro compiler should emit `componentUrl` for SSR-only components too — not just hydrated ones. Adding it for all framework components would let `check()` filter correctly in all cases. However, the Astro team is currently migrating the compiler from Go to Rust (`@astrojs/compiler-rs`), so this is low priority and should not block that migration.

**Compiler code references** (commit `811e90fa`):

- **Where `client:component-path` IS emitted** (hydrated components): [`transform.go#L535-L540`](https://github.com/withastro/compiler/blob/811e90fa02bc0e0eb504dc4775ab9f1b64847766/internal/transform/transform.go#L535-L540) — inside `AddComponentProps`, this block only runs when the component has a `client:` directive attribute (guarded by `strings.HasPrefix(attr.Key, "client:")` at [line 497](https://github.com/withastro/compiler/blob/811e90fa02bc0e0eb504dc4775ab9f1b64847766/internal/transform/transform.go#L497)).

- **Where `client:component-path` IS emitted** (`client:only`): [`printer.go#L625-L630`](https://github.com/withastro/compiler/blob/811e90fa02bc0e0eb504dc4775ab9f1b64847766/internal/printer/printer.go#L625-L630) — separate code path for `client:only` components during the printing phase.

- **Where SSR-only components are rendered WITHOUT it**: [`print-to-js.go#L380-L440`](https://github.com/withastro/compiler/blob/811e90fa02bc0e0eb504dc4775ab9f1b64847766/internal/printer/print-to-js.go#L380-L440) — SSR-only components go through `$$renderComponent()` but `AddComponentProps` never runs for them (no `client:` attributes → the conditional at line 497 is never entered), so no `client:component-path` is emitted.

- **`server:component-path` is unrelated**: The `server:` branch at [`transform.go#L551-L575`](https://github.com/withastro/compiler/blob/811e90fa02bc0e0eb504dc4775ab9f1b64847766/internal/transform/transform.go#L551-L575) handles **Server Islands** (components with `server:defer`), not regular SSR-only components. A plain `<MyComponent />` without any directive has no `client:` or `server:` attributes, so neither branch in `AddComponentProps` is entered — it gets no path metadata at all.

**How to emit `componentUrl` for SSR-only components** (future compiler change):

Two parts need to change — the compiler (to emit the path) and the Astro runtime (to read it):

**Compiler side** — [`transform.go#L494-L587`](https://github.com/withastro/compiler/blob/811e90fa02bc0e0eb504dc4775ab9f1b64847766/internal/transform/transform.go#L494-L587): `AddComponentProps` currently only enters the path-emitting code when `strings.HasPrefix(attr.Key, "client:")` (line 497) or `strings.HasPrefix(attr.Key, "server:")` (line 551). For SSR-only components, add a fallback after the `for` loop that runs when no `client:` or `server:` attribute was found. It should call `matchNodeToImportStatement(doc, n)` and, if a match is found, append a new attribute like `"ssr:component-path"` with the resolved specifier — similar to how `client:component-path` is emitted at lines 535-540. The key should use a distinct prefix (e.g., `ssr:`) to avoid conflicting with the `client:` extraction logic.

**Runtime side** — Two files need changes:

1. [`hydration.ts`](https://github.com/withastro/astro/blob/main/packages/astro/src/runtime/server/hydration.ts) line 54: `extractDirectives` only creates the `hydration` object when it sees a `client:` prefix. A new branch should extract `ssr:component-path` into a separate field on the extracted result (not inside `hydration`, since SSR-only components don't hydrate).
2. [`component.ts`](https://github.com/withastro/astro/blob/main/packages/astro/src/runtime/server/render/component.ts) lines 104-109: `metadata.componentUrl` is only set from `hydration.componentUrl`. Add a fallback that reads from the new `ssr:component-path` extracted value when `hydration` is absent.

### Reference implementation

The React integration already uses a virtual module (`astro:react:opts`) to pass options from `index.ts` to `server.ts`. The test renderers (woof/meow in `test/fixtures/multiple-jsx-renderers/`) demonstrate the exact `createFilter` + `metadata.componentUrl` pattern we're implementing here.

## Files to modify

### 1. `packages/integrations/preact/src/index.ts` — Add virtual module Vite plugin

**Current state**: `include`/`exclude` are only passed to `@preact/preset-vite` for JSX transform. No virtual module exists.

**Changes**:

- Add a new Vite plugin `@astrojs/preact:opts` (following React's `@astrojs/react:opts` pattern)
- The plugin creates virtual module `astro:preact:opts` that exports the `include` and `exclude` values
- Use `devalue.uneval()` for serialization. `FilterPattern` from `@preact/preset-vite` can be `string | RegExp | (string | RegExp)[] | null | undefined`. `devalue.uneval()` handles all of these correctly (strings become JSON-stringified literals, RegExp becomes `new RegExp(source, flags)`, arrays become array literals). Add `devalue` as a dependency of `@astrojs/preact` — it's already a dependency of `astro`, so anyone who has `@astrojs/preact` installed already has it available.

**Specific changes to `index.ts`**:

```typescript
import { uneval } from 'devalue';

// Add new function (modeled after react/src/index.ts:33-66)
function optionsPlugin(include: Options['include'], exclude: Options['exclude']): Plugin {
  const virtualModule = 'astro:preact:opts';
  const virtualModuleId = '\0' + virtualModule;
  return {
    name: '@astrojs/preact:opts',
    resolveId: {
      filter: { id: new RegExp(`^${virtualModule}$`) },
      handler() {
        return virtualModuleId;
      },
    },
    load: {
      filter: { id: new RegExp(`^${virtualModuleId}$`) },
      handler() {
        return {
          code: `export default {
            include: ${uneval(include ?? null)},
            exclude: ${uneval(exclude ?? null)}
          }`,
        };
      },
    },
  };
}
```

Then add `optionsPlugin(include, exclude)` to the `viteConfig.plugins` array at line 45, alongside the existing `preactPlugin` and `configEnvironmentPlugin(compat)`.

**Note on serialization**: `devalue.uneval()` correctly serializes all `FilterPattern` values — strings, RegExp, arrays of strings/regexes, and null. This is the same approach used by the woof/meow test renderers.

### 2. `packages/integrations/preact/env.d.ts` — Create type declaration for virtual module

**Current state**: This file does not exist.

**Create** `packages/integrations/preact/env.d.ts`:

```typescript
declare module 'astro:preact:opts' {
  const opts: {
    include: import('@preact/preset-vite').PreactPluginOptions['include'] | null;
    exclude: import('@preact/preset-vite').PreactPluginOptions['exclude'] | null;
  };
  export default opts;
}
```

This provides type safety for the import in `server.ts`. The React integration has the same pattern in `packages/integrations/react/env.d.ts`.

### 3. `packages/integrations/preact/src/server.ts` — Add filter logic to `check()`

**Current state** (lines 14-44): `check()` accepts `(Component, props, children)` with no `metadata` parameter. It checks if `Component` is a function, does prototype checks, then falls back to try-rendering via `renderToStaticMarkup`.

**Changes**:

#### 3a. Add imports at top of file

```typescript
import { createFilter } from 'vite';
import opts from 'astro:preact:opts';
```

`createFilter` is from `vite` (already a dependency of `@astrojs/preact` — see package.json line 42). It takes `(include, exclude)` and returns a `(id: string) => boolean` function.

#### 3b. Create filter at module scope

```typescript
const filter = opts.include || opts.exclude ? createFilter(opts.include, opts.exclude) : null;
```

This is computed once at module load time, not per `check()` call. When the user doesn't provide `include`/`exclude`, `filter` is `null` and `check()` behaves identically to today.

#### 3c. Add `metadata` parameter to `check()` and add filter logic

Change the `check()` signature to accept the 4th `metadata` argument (which Astro already passes — see `component.ts:141`):

```typescript
async function check(
  this: RendererContext,
  Component: any,
  props: Record<string, any>,
  children: any,
  metadata?: AstroComponentMetadata, // ADD THIS
) {
  if (typeof Component !== 'function') return false;
  if (Component.name === 'QwikComponent') return false;

  // NEW: If a filter is configured and componentUrl is available,
  // reject components that don't match the include/exclude pattern.
  if (filter && metadata?.componentUrl && !filter(metadata.componentUrl)) {
    return false;
  }

  // ... rest of existing check logic unchanged ...
}
```

The filter check is placed **early** (before `useConsoleFilter()` and the expensive `renderToStaticMarkup` call). This means:

- When the filter rejects a component, we skip the try-render entirely — no console noise, no wasted work
- When `filter` is null (no `include`/`exclude` configured), the check is a no-op
- When `metadata?.componentUrl` is undefined (SSR-only component), the check is skipped and we fall through to existing behavior

### 4. `packages/integrations/preact/tsconfig.json` — Add env.d.ts reference (if needed)

Check if the tsconfig needs to reference the new `env.d.ts` for TypeScript to resolve the `astro:preact:opts` module declaration. React's integration handles this — we should mirror that setup.

## What this fixes

| Scenario                                                         | Before                                                                  | After                                                                          |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `client:load` React component, Preact has `include`              | Preact's `check()` tries to render it → false positive or console error | Preact's `check()` rejects immediately via filter → correct renderer found     |
| `client:load` Preact component, Preact has `include` matching it | `check()` try-renders → true                                            | Filter passes → `check()` try-renders → true (same result, slightly more work) |
| SSR-only React component, Preact has `include`                   | `check()` try-renders → false positive                                  | **Still broken** — `metadata.componentUrl` is undefined, filter can't apply    |
| No `include`/`exclude` configured                                | `check()` try-renders all components                                    | Identical behavior (filter is null)                                            |

## What this does NOT fix

1. **SSR-only components**: Without `client:*` directives, `metadata.componentUrl` is undefined. The filter can't apply. This is a deeper architectural issue — the component file path is only available when the compiler emits `client:component-path` metadata.

2. **`client:only` components**: These take a completely different code path (`client:only` specifies the renderer name directly). No `check()` is called, so the filter is irrelevant.

## Testing strategy

The existing `multiple-jsx-renderers` test fixture (woof/meow renderers) already validates this exact pattern. For the real preact integration, we should verify with the existing `preact-component` test fixture or a new one that uses both React and Preact with `include` patterns.

Specific test scenarios to validate:

1. Preact-only project (no `include`/`exclude`) — should work identically to today
2. React + Preact with `include` patterns — `client:load` components should be assigned to the correct renderer
3. React + Preact with `include` patterns — SSR-only components still have the known limitation

### Can we remove `useConsoleFilter`?

**No — at least 2 tests would break:**

1. **`e2e/react19-preact-hook-error.test.js`** — Asserts that no "Invalid hook call" errors appear in dev server logs when React + Preact are used together. Without the console filter, the error would leak through whenever Preact's `check()` tries to render a React component.

2. **`test/react-jsx-export.test.js`** — Asserts that build logs contain no "Invalid hook call" warnings.

**However**, with the filter logic in this plan, the console filter becomes less critical:

- When `include`/`exclude` is configured and `componentUrl` is available (hydrated components), `check()` rejects mismatched components **before** reaching `renderToStaticMarkup` — so the "Invalid hook call" error is never triggered in the first place.
- The console filter is still needed as a safety net for cases where the filter can't apply (SSR-only components without `componentUrl`, or no `include`/`exclude` configured).

**Recommendation**: Keep `useConsoleFilter` for now. It can be removed in a follow-up once the compiler provides `componentUrl` for all components (not just hydrated ones), making the filter logic comprehensive.

**Testing escape hatch**: To write tests that verify the console filter is no longer _needed_ (i.e., the filter logic in `check()` rejects mismatched components before `renderToStaticMarkup` is ever called), add an env variable `ASTRO_INTERNAL_TEST_DISABLE_CONSOLE_FILTER`. When set, `useConsoleFilter()` becomes a no-op. This follows the existing `ASTRO_INTERNAL_TEST_` convention used in `packages/db/src/core/integration/index.ts` (line 93) and its tests. This way, a test can set the env var, render a page with React + Preact (both with `include` patterns), and assert that no "Invalid hook call" errors appear — proving the filter logic alone is sufficient for hydrated components.

## Todo list

### Phase 1: Add `devalue` dependency

- [x] **1.1** Add `devalue` to `dependencies` in `packages/integrations/preact/package.json`
  - File: `packages/integrations/preact/package.json`
  - Add `"devalue": "^5.x.x"` (match the version used by `astro` in the workspace) to the `dependencies` object
- [x] **1.2** Run `pnpm install` from the repo root to update the lockfile

### Phase 2: Create `astro:preact:opts` virtual module plugin in index.ts

- [x] **2.1** Add `import { uneval } from 'devalue'` to the top of `packages/integrations/preact/src/index.ts`
- [x] **2.2** Add the `optionsPlugin()` function to `packages/integrations/preact/src/index.ts`
  - Modeled after React's `optionsPlugin` in `packages/integrations/react/src/index.ts:33-66`
  - Takes `include` and `exclude` parameters (type: `Options['include']`, `Options['exclude']`)
  - Creates a Vite plugin named `@astrojs/preact:opts` that:
    - `resolveId`: matches `astro:preact:opts` → returns `\0astro:preact:opts`
    - `load`: for `\0astro:preact:opts` → returns JS code exporting `{ include, exclude }` serialized with `uneval()`
  - Uses the object-form `resolveId`/`load` with `filter` (matching React's pattern) instead of the function-form
- [x] **2.3** Wire `optionsPlugin(include, exclude)` into the `viteConfig.plugins` array
  - File: `packages/integrations/preact/src/index.ts`, inside `astro:config:setup` hook
  - Current line 45: `viteConfig.plugins = [preactPlugin, configEnvironmentPlugin(compat)];`
  - Change to: `viteConfig.plugins = [preactPlugin, optionsPlugin(include, exclude), configEnvironmentPlugin(compat)];`

### Phase 3: Create type declaration for virtual module

- [x] **3.1** Create `packages/integrations/preact/env.d.ts`
  - Declare module `astro:preact:opts` with default export `{ include: ... | null, exclude: ... | null }`
  - Use `import('@preact/preset-vite').PreactPluginOptions['include']` for the types (same types the integration already accepts)
  - Follows the pattern in `packages/integrations/react/env.d.ts`
- [x] **3.2** Update `packages/integrations/preact/tsconfig.json` to include `env.d.ts`
  - Current: `"include": ["src"]`
  - Change to: `"include": ["src", "env.d.ts"]`
  - This matches the React integration's tsconfig (`packages/integrations/react/tsconfig.json:3`)

### Phase 4: Add filter logic to `check()` in server.ts

- [x] **4.1** Add imports to the top of `packages/integrations/preact/src/server.ts`
  - `import { createFilter } from 'vite';` — `vite` is already a dependency (package.json line 42)
  - `import opts from 'astro:preact:opts';` — the virtual module from Phase 2
- [x] **4.2** Create the filter at module scope (after imports, before the `check()` function)
  - `const filter = (opts.include || opts.exclude) ? createFilter(opts.include, opts.exclude) : null;`
  - Computed once at module load time; `null` when user doesn't configure `include`/`exclude`
- [x] **4.3** Add `metadata` as the 4th parameter to the `check()` function
  - Current signature (line 14-19): `async function check(this: RendererContext, Component: any, props: Record<string, any>, children: any)`
  - New signature: add `metadata?: AstroComponentMetadata` after `children`
  - `AstroComponentMetadata` is already imported at line 1 (`import type { AstroComponentMetadata, ... } from 'astro'`)
- [x] **4.4** Add early-return filter logic inside `check()`, after the `QwikComponent` check (line 21) and before `useConsoleFilter()` (line 27)
  - Insert: `if (filter && metadata?.componentUrl && !filter(metadata.componentUrl)) { return false; }`
  - This rejects mismatched components before the expensive try-render, avoiding console noise entirely

### Phase 5: Add `ASTRO_INTERNAL_TEST_DISABLE_CONSOLE_FILTER` env variable

- [x] **5.1** Modify `filteredConsoleError()` in `packages/integrations/preact/src/server.ts` (line 133-147)
  - Add a check at the top: `if (process.env.ASTRO_INTERNAL_TEST_DISABLE_CONSOLE_FILTER) { originalConsoleError(msg, ...rest); return; }`
  - When the env var is set, the filter function forwards all errors to the original `console.error` without suppressing anything
  - `useConsoleFilter()` and `finishUsingConsoleFilter()` remain unchanged — the hook is still installed and ref-counted, but the filter itself becomes a passthrough

### Phase 6: Build and typecheck

- [x] **6.1** Build the preact package: run `pnpm --filter @astrojs/preact build`
  - Verifies that the virtual module import compiles, `devalue` import resolves, and all TypeScript is valid
- [x] **6.2** Run typecheck: `pnpm --filter @astrojs/preact build` includes `tsc` (see package.json build script: `astro-scripts build "src/**/*.ts" && tsc`)
  - Verify no new type errors from the `opts` import or `metadata` parameter

### Phase 7: Run existing tests (regression check)

- [x] **7.1** Run `pnpm test -- packages/astro/test/preact-component.test.js`
  - Unit tests for Preact components — should all pass unchanged (no `include`/`exclude` in these tests, filter is `null`)
- [x] **7.2** Run `pnpm test -- packages/astro/test/multiple-jsx-renderers.test.js`
  - Tests the woof/meow mock renderers with `include` patterns — should all pass (these test the pattern, not the preact integration directly)
- [x] **7.3** Run `pnpm test -- packages/astro/test/react-jsx-export.test.js`
  - Tests React JSX exports with no "Invalid hook call" warnings — should pass (console filter still active)
- [x] **7.4** Run `pnpm test -- packages/astro/e2e/react19-preact-hook-error.test.js`
  - E2E test for React v19 + Preact hook error suppression — should pass
  - This test uses `preact({ include: ['**/preact/*'] })` and `react({ include: ['**/react/*'] })` with `client:visible` components
  - With our change, Preact's `check()` will now reject the React component via the filter (before try-render), so the console error is never triggered — the test should still pass (and for a better reason now)

### Phase 8: Add new test verifying filter-only correctness (optional but recommended)

- [ ] **8.1** Add a new test to `e2e/react19-preact-hook-error.test.js` (or a new test file) that:
  - Sets `process.env.ASTRO_INTERNAL_TEST_DISABLE_CONSOLE_FILTER = 'true'` before starting the dev server
  - Renders the same page with React + Preact `client:visible` components
  - Asserts no "Invalid hook call" errors appear
  - This proves the filter logic alone is sufficient (the console filter is disabled, yet no errors leak)
  - Cleans up with `delete process.env.ASTRO_INTERNAL_TEST_DISABLE_CONSOLE_FILTER` in afterAll

### Phase 9: Clean up debug statements

- [x] **9.1** Remove debug `console.error` calls from `packages/astro/src/runtime/server/render/component.ts` (already cleaned up in prior commit)
  - Line 111: `console.error('[DEBUG] renderFrameworkComponent', ...)`
  - Line 461: `console.error('[DEBUG] renderAstroComponent')`
  - Line 488-489: `console.error('[DEBUG] renderComponent')` and stack trace
  - Line 493: `console.error('[DEBUG] renderComponent async')`
  - Line 540-541: `if (Math.random() < 1.01) { console.error('[DEBUG] v2'); }`
  - Line 552: `console.error('[DEBUG] renderComponentToString', ...)`
  - Line 583: `console.error('[DEBUG] renderComponentToString v2')`
