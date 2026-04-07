# Plan: Use metadata.componentUrl in check() to match include pattern

## Idea

The renderer's `check()` function receives `metadata` as its 4th argument (component.ts:140). For `client:load` components, `metadata.componentUrl` contains the full file path (e.g., `/Users/.../src/components/WoofCounter.woof.jsx`). The `check()` function can use this to reject components that don't match the renderer's include pattern.

## Why it works for client:load

- `client:load` → compiler emits `client:component-path` → `metadata.componentUrl` is set
- `check()` receives metadata → can inspect `componentUrl` → return `false` if it doesn't match

## Why it doesn't work for SSR-only

- SSR-only → compiler does NOT emit `client:component-path` → `metadata.componentUrl` is `undefined`
- `check()` has no file path info → can't filter → must fall back to default behavior (accept any function)

## Implementation

### How check() gets the include pattern

The `include` pattern is a user-provided option passed to the integration (e.g., `woof({ include: '**/*.woof.jsx' })`). The `check()` function lives in `server.mjs`, a separate module loaded at runtime. We need to bridge the gap.

Approach: use a **virtual module** to pass a pre-built filter function from the integration to the server module. This follows the same pattern used by the React integration (`astro:react:opts` defined in `packages/integrations/react/src/index.ts`).

### Type definitions for include/exclude

In real-world integrations (vite-plugin-react, vite-plugin-preact), `include` and `exclude` accept `FilterPattern` from vite — which can be a string, regex, or array of strings/regexes. The Woof and Meow renderers should use the same type:

```javascript
// In renderers/woof/index.mjs and renderers/meow/index.mjs
/** @param {{ include?: import('vite').FilterPattern, exclude?: import('vite').FilterPattern }} options */
export default function ({ include, exclude } = {}) {
```

### Virtual module in `renderers/woof/index.mjs`

Like `astro:react:opts`, the virtual module default-exports a plain data object with `include` and `exclude` values. The `createFilter` call happens in `server.mjs`, not in the virtual module.

We use `devalue.uneval()` to serialize `FilterPattern` values (string, RegExp, array, null) into JavaScript source code. `devalue` is already a dependency of the `astro` package. `uneval()` produces valid JS expressions — e.g., strings become JSON-stringified literals, RegExp becomes `new RegExp(source, flags)`, arrays become array literals with each element serialized.

The Vite plugin creates the virtual module:

```javascript
import * as devalue from 'devalue';

// Inside the updateConfig vite plugins array:
{
  name: 'woof-opts',
  resolveId(id) {
    if (id === 'astro:woof:opts') return '\0astro:woof:opts';
  },
  load(id) {
    if (id === '\0astro:woof:opts') {
      return {
        code: `export default {
          include: ${devalue.uneval(include ?? null)},
          exclude: ${devalue.uneval(exclude ?? null)}
        }`,
      };
    }
  },
},
```

### Type declaration: `renderers/woof/types.d.ts`

```typescript
declare module 'astro:woof:opts' {
  const opts: {
    include: import('vite').FilterPattern;
    exclude: import('vite').FilterPattern;
  };
  export default opts;
}
```

Same for meow: virtual module `astro:meow:opts` and `renderers/meow/types.d.ts`.

### Updated `renderers/woof/server.mjs`

`check()` imports the options from the virtual module and calls `createFilter` from vite to build a filter function, then uses it to match `metadata.componentUrl`:

```javascript
import { createFilter } from 'vite';
import opts from 'astro:woof:opts';

const filter = opts.include || opts.exclude ? createFilter(opts.include, opts.exclude) : null;

const check = (Component, props, slots, metadata) => {
  if (typeof Component !== 'function') return false;
  if (filter && metadata?.componentUrl && !filter(metadata.componentUrl)) {
    return false;
  }
  return true;
};
```

Same for `meow/server.mjs` importing from `astro:meow:opts`.

No Astro runtime changes needed — this is purely in the test renderer/integration code.

### How this maps to real integrations

In real integrations like `@astrojs/react` or `@astrojs/preact`, the same pattern applies:

1. The integration already receives `include`/`exclude` as `FilterPattern` from the user
2. Add a virtual module (e.g., `astro:react:opts` — already exists) that also exports the `include`/`exclude` values using `devalue.uneval()` to serialize patterns
3. The server entrypoint imports the opts, calls `createFilter(opts.include, opts.exclude)`, and uses the filter in `check()` to reject mismatched components

## Todo list

### Phase 1: Woof renderer — virtual module + filter in check()

- [x] **1.1** Update `renderers/woof/index.mjs` — change `include` type from `string` to `FilterPattern`, remove the hardcoded validation, add `exclude` param
- [x] **1.2** Update `renderers/woof/index.mjs` — add `import * as devalue from 'devalue'` at top
- [x] **1.3** Update `renderers/woof/index.mjs` — add the `woof-opts` virtual module Vite plugin (resolveId + load) alongside the existing `woof-jsx-transform` plugin
- [x] **1.4** Create `renderers/woof/types.d.ts` — declare module `astro:woof:opts` with default export `{ include: FilterPattern, exclude: FilterPattern }`
- [x] **1.5** Update `renderers/woof/server.mjs` — import `createFilter` from `vite` and opts from `astro:woof:opts`, build filter, update `check()` to use filter + `metadata.componentUrl`

### Phase 2: Meow renderer — same changes

- [x] **2.1** Update `renderers/meow/index.mjs` — same changes as 1.1–1.3 (FilterPattern type, devalue import, `meow-opts` virtual module plugin)
- [x] **2.2** Create `renderers/meow/types.d.ts` — declare module `astro:meow:opts`
- [x] **2.3** Update `renderers/meow/server.mjs` — import `createFilter` from `vite` and opts from `astro:meow:opts`, build filter, update `check()` to use filter + `metadata.componentUrl` (remove existing `console.log(metadata)` TODO)

### Phase 3: Update tests

- [x] **3.1** Update `multiple-jsx-renderers.test.js` — no changes needed (tests only use `include`, which is sufficient)
- [x] **3.2** Run tests — verified: 10 pass, 0 fail (SSR tests assert known-broken behavior with comments)

## Expected test results after this change

**With include option:**

- SSR: 3 pass — WoofCounter correctly rendered by woof (first renderer). MeowCounter incorrectly rendered by woof (known limitation: SSR-only components lack `metadata.componentUrl`, so check() can't filter by include pattern). Tests assert the current broken behavior with comments marking it as a known bug.
- client:load: 2 pass (componentUrl available → check() correctly rejects mismatched components)
- client:only: 1 pass (renderer specified explicitly, bypasses check() loop)

**Without include option:**

- All 4 pass (filter is null → check() accepts any function, same as before)

**Total: 10 pass, 0 fail.**

## Summary

This is a partial fix — proves that `metadata.componentUrl` in `check()` can solve the renderer selection bug for hydrated components. SSR-only remains unfixed because the componentUrl is not available.
