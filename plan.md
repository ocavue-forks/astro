# Plan: Implement `createFilter` in `@astrojs/internal-helpers`

## Motivation

The Preact integration (`packages/integrations/preact/src/server.ts`) currently imports `createFilter` from `@rollup/pluginutils` to filter component URLs based on `include`/`exclude` glob patterns. This is problematic because:

1. `@rollup/pluginutils` uses Node.js APIs (`path.resolve`, `path.win32`, `path.posix`, `path.isAbsolute`) — making it incompatible with edge/browser runtimes where SSR renderers may run.
2. It brings in a large package (`@rollup/pluginutils`) for a single function.
3. The test fixtures (`renderers/meow`, `renderers/woof`) currently import `createFilter` from `vite` — which also relies on Node.js internals.

The goal is to implement a standalone `createFilter` in `@astrojs/internal-helpers` that is **compatible with non-Node.js environments** while maintaining API compatibility with `@rollup/pluginutils`' version.

## Reference Implementation

The original `@rollup/pluginutils` `createFilter` ([source](https://github.com/rollup/plugins/blob/7d16103b995bcf61f5af1040218a50399599c37e/packages/pluginutils/src/createFilter.ts#L26)):

```typescript
// Simplified pseudocode of the original
function createFilter(include?, exclude?, options?) {
  const resolutionBase = options?.resolve;

  const getMatcher = (id) =>
    id instanceof RegExp ? id : { test: (what) => picomatch(getMatcherString(id, resolutionBase), { dot: true })(what) };

  const includeMatchers = ensureArray(include).map(getMatcher);
  const excludeMatchers = ensureArray(exclude).map(getMatcher);

  return function (id) {
    if (typeof id !== 'string') return false;
    if (/\0/.test(id)) return false;            // reject virtual module IDs
    const pathId = normalizePath(id);            // backslash → forward slash
    for (const m of excludeMatchers) if (m.test(pathId)) return false;  // exclude wins
    for (const m of includeMatchers) if (m.test(pathId)) return true;
    return !includeMatchers.length;              // if no include patterns, default true
  };
}
```

### Node.js APIs used by the original

| API | Where | Purpose |
|-----|-------|---------|
| `path.win32.sep` | `normalizePath` | Used to build a regex for replacing `\` with `/` |
| `path.posix.sep` | `normalizePath` | The replacement character `/` |
| `path.isAbsolute()` | `getMatcherString` | Check if a glob pattern is absolute |
| `path.resolve()` | `getMatcherString` | Resolve relative globs against a base directory |
| `path.posix.join()` | `getMatcherString` | Join resolved base with the glob pattern |

## Implementation Plan

### Step 1: Add `picomatch` dependency

`picomatch` is a pure JavaScript glob matching library with no Node.js dependencies. It's already used transitively in the monorepo (Astro core depends on it: `packages/astro/package.json` line 154).

```jsonc
// packages/internal-helpers/package.json
{
  "dependencies": {
    "picomatch": "^4.0.3"
  },
  "devDependencies": {
    "astro-scripts": "workspace:*",
    "@types/picomatch": "^4.0.2"
  }
}
```

### Step 2: Implement helper functions (no Node.js APIs)

These replace the Node.js `path` module equivalents:

```typescript
// Normalize backslashes to forward slashes (replaces path.win32.sep → path.posix.sep)
function normalizePath(filename: string): string {
  return filename.replace(/\\/g, '/');
}

// Check if a path is absolute (replaces path.isAbsolute)
// Matches: /foo, C:\foo, C:/foo, D:\foo
const ABSOLUTE_PATH_REGEX = /^(?:\/|(?:[A-Za-z]:)?[/\\|])/;
function isAbsolute(path: string): boolean {
  return ABSOLUTE_PATH_REGEX.test(path);
}
```

### Step 3: Implement `ensureArray`

Converts `FilterPattern` values to arrays:

```typescript
function ensureArray<T>(thing: readonly T[] | T | undefined | null): readonly T[] {
  if (Array.isArray(thing)) return thing;
  if (thing == null) return [];
  return [thing];
}
```

### Step 4: Implement `getMatcherString`

The original uses `path.resolve()` and `path.posix.join()` to resolve relative globs. Since we're removing Node.js APIs, we **drop the `resolutionBase` / `options.resolve` parameter entirely**. This is acceptable because:

- The Astro use case filters by component URLs which are already absolute Vite-style paths (e.g., `/src/components/Counter.tsx`).
- Users provide patterns like `'**/*.tsx'` or `'/src/components/**'` — both already handled without resolution.

```typescript
function getMatcherString(glob: string): string {
  return normalizePath(glob);
}
```

If a glob pattern starts with `**` or is already absolute, it's used as-is (after normalization). For other relative patterns, they're normalized but not resolved against `process.cwd()`.

### Step 5: Implement `createFilter`

```typescript
import picomatch from 'picomatch';

export type FilterPattern = ReadonlyArray<string | RegExp> | string | RegExp | null;

export function createFilter(
  include?: FilterPattern,
  exclude?: FilterPattern,
): (id: string | unknown) => boolean {
  const getMatcher = (id: string | RegExp) => {
    if (id instanceof RegExp) {
      return id;
    }
    const pattern = normalizePath(id);
    const fn = picomatch(pattern, { dot: true });
    return { test: (what: string) => fn(what) };
  };

  const includeMatchers = ensureArray(include).map(getMatcher);
  const excludeMatchers = ensureArray(exclude).map(getMatcher);

  if (!includeMatchers.length && !excludeMatchers.length) {
    return (id) => typeof id === 'string' && !id.includes('\0');
  }

  return function (id: string | unknown): boolean {
    if (typeof id !== 'string') return false;
    if (id.includes('\0')) return false;

    const pathId = normalizePath(id);

    for (const matcher of excludeMatchers) {
      if (matcher instanceof RegExp) {
        matcher.lastIndex = 0;
      }
      if (matcher.test(pathId)) return false;
    }

    for (const matcher of includeMatchers) {
      if (matcher instanceof RegExp) {
        matcher.lastIndex = 0;
      }
      if (matcher.test(pathId)) return true;
    }

    return !includeMatchers.length;
  };
}
```

### Key behaviors preserved from the original

| Behavior | Details |
|----------|---------|
| **Exclude wins** | If a path matches both include and exclude, it's excluded |
| **Default pass-through** | If no include patterns given, all non-excluded IDs pass |
| **Null byte rejection** | IDs containing `\0` are rejected (virtual module IDs) |
| **Non-string rejection** | Non-string values return `false` |
| **Path normalization** | Backslashes normalized to forward slashes |
| **Dot files** | `picomatch` is configured with `{ dot: true }` to match dotfiles |
| **RegExp lastIndex reset** | Stateful RegExp objects have `lastIndex` reset after each test |

### Behavior removed (intentionally)

| Behavior | Reason |
|----------|--------|
| **`options.resolve` parameter** | Requires `path.resolve()` (Node.js API). Not needed for Astro's use case — component URLs from Vite are already absolute. |
| **Relative glob resolution** | The original resolves relative globs against `process.cwd()` or `options.resolve`. We skip this since all Astro component URLs are absolute paths. |

## Step 6: Update `package.json` exports

```jsonc
// packages/internal-helpers/package.json
{
  "exports": {
    "./path": "./dist/path.js",
    "./remote": "./dist/remote.js",
    "./fs": "./dist/fs.js",
    "./cli": "./dist/cli.js",
    "./create-filter": "./dist/create-filter.js"     // NEW
  },
  "typesVersions": {
    "*": {
      // ... existing entries ...
      "create-filter": ["./dist/create-filter.d.ts"]  // NEW
    }
  }
}
```

## Step 7: Update consumers

### Preact integration (`packages/integrations/preact/src/server.ts`)

```diff
-import { createFilter } from '@rollup/pluginutils';
+import { createFilter } from '@astrojs/internal-helpers/create-filter';
```

After migration, `@rollup/pluginutils` can be removed from `packages/integrations/preact/package.json` dependencies (note: `packages/astro/package.json` still uses `dataToEsm` from `@rollup/pluginutils`, so only remove from preact).

Also remove `'@rollup/pluginutils'` from the `optimizeDeps.include` array in `packages/integrations/preact/src/index.ts` (line 118).

### Test fixtures (`renderers/meow` and `renderers/woof`)

```diff
-import { createFilter } from 'vite';
+import { createFilter } from '@astrojs/internal-helpers/create-filter';
```

## Step 8: Write tests

Add `packages/internal-helpers/test/create-filter.test.js` following the existing test pattern (see `test/path.test.js`):

```javascript
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFilter } from '../dist/create-filter.js';

describe('createFilter', () => {
  describe('basic filtering', () => {
    it('should return a function', () => {
      const filter = createFilter();
      assert.equal(typeof filter, 'function');
    });

    it('should pass all strings when no patterns given', () => {
      const filter = createFilter();
      assert.equal(filter('/src/foo.ts'), true);
      assert.equal(filter('bar.js'), true);
    });

    it('should reject non-string values', () => {
      const filter = createFilter(['**/*.ts']);
      assert.equal(filter(42), false);
      assert.equal(filter(null), false);
      assert.equal(filter(undefined), false);
    });

    it('should reject strings with null bytes', () => {
      const filter = createFilter();
      assert.equal(filter('file\0.ts'), false);
    });
  });

  describe('include patterns', () => {
    it('should filter by glob pattern', () => {
      const filter = createFilter(['**/*.tsx']);
      assert.equal(filter('/src/components/Button.tsx'), true);
      assert.equal(filter('/src/utils/helper.ts'), false);
    });

    it('should accept a single string pattern', () => {
      const filter = createFilter('**/*.tsx');
      assert.equal(filter('/src/Button.tsx'), true);
      assert.equal(filter('/src/helper.ts'), false);
    });

    it('should accept RegExp patterns', () => {
      const filter = createFilter(/\.tsx$/);
      assert.equal(filter('/src/Button.tsx'), true);
      assert.equal(filter('/src/helper.ts'), false);
    });
  });

  describe('exclude patterns', () => {
    it('should exclude matching paths', () => {
      const filter = createFilter(null, ['**/node_modules/**']);
      assert.equal(filter('/src/app.ts'), true);
      assert.equal(filter('/node_modules/pkg/index.js'), false);
    });

    it('should prioritize exclude over include', () => {
      const filter = createFilter(['**/*.ts'], ['**/test/**']);
      assert.equal(filter('/src/app.ts'), true);
      assert.equal(filter('/test/app.ts'), false);
    });
  });

  describe('path normalization', () => {
    it('should normalize backslashes', () => {
      const filter = createFilter(['**/*.ts']);
      assert.equal(filter('src\\components\\App.ts'), true);
    });
  });
});
```

## Todo List

### Phase 1: Setup — Prepare the `internal-helpers` package

- [ ] **1.1** Add `picomatch` as a runtime dependency in `packages/internal-helpers/package.json`
  - Add `"picomatch": "^4.0.3"` to `"dependencies"`
- [ ] **1.2** Add `@types/picomatch` as a dev dependency in `packages/internal-helpers/package.json`
  - Add `"@types/picomatch": "^4.0.2"` to `"devDependencies"`
- [ ] **1.3** Add the `"./create-filter"` entry to `"exports"` in `packages/internal-helpers/package.json`
  - Value: `"./dist/create-filter.js"`
- [ ] **1.4** Add the `"create-filter"` entry to `"typesVersions"` in `packages/internal-helpers/package.json`
  - Value: `["./dist/create-filter.d.ts"]`
- [ ] **1.5** Run `pnpm install` from the repo root to update the lockfile with the new dependencies

### Phase 2: Implement — Write the `createFilter` function

- [ ] **2.1** Implement the `normalizePath` helper in `packages/internal-helpers/src/create-filter.ts`
  - Replace backslashes with forward slashes using `/\\/g` regex
  - Must NOT import from `node:path`
- [ ] **2.2** Implement the `ensureArray` helper in `packages/internal-helpers/src/create-filter.ts`
  - Handle `null`, `undefined`, single values, and arrays
  - Keep it local/private to this module (not exported)
- [ ] **2.3** Implement the `createFilter` function body in `packages/internal-helpers/src/create-filter.ts`
  - Import `picomatch` at the top of the file
  - Keep the existing `FilterPattern` type export
  - Keep the existing function signature `(include?: FilterPattern, exclude?: FilterPattern) => (id: string | unknown) => boolean`
  - Build include/exclude matchers: RegExp used directly, strings compiled via `picomatch(normalizePath(pattern), { dot: true })`
  - Early return when no patterns: `(id) => typeof id === 'string' && !id.includes('\0')`
  - Filter logic: reject non-strings → reject null bytes → normalize path → check excludes first → check includes → default to `!includeMatchers.length`
  - Reset `RegExp.lastIndex` to 0 before each `.test()` call on RegExp matchers
- [ ] **2.4** Verify the file has NO imports from `node:path`, `node:fs`, or any other `node:*` module

### Phase 3: Build — Verify the package compiles

- [ ] **3.1** Run the `internal-helpers` build: `pnpm --filter @astrojs/internal-helpers build`
- [ ] **3.2** Verify `packages/internal-helpers/dist/create-filter.js` is generated
- [ ] **3.3** Verify `packages/internal-helpers/dist/create-filter.d.ts` is generated and exports `FilterPattern` type and `createFilter` function

### Phase 4: Test — Write and run unit tests

- [ ] **4.1** Create `packages/internal-helpers/test/create-filter.test.js`
  - Use `node:assert/strict` and `node:test` (matching existing `test/path.test.js` style)
  - Import from `'../dist/create-filter.js'`
- [ ] **4.2** Write test: no patterns → returns true for all strings
- [ ] **4.3** Write test: no patterns → rejects non-string values
- [ ] **4.4** Write test: no patterns → rejects strings containing `\0`
- [ ] **4.5** Write test: include with glob string (`'**/*.tsx'`) → matches `.tsx` files, rejects `.ts` files
- [ ] **4.6** Write test: include with glob array (`['**/*.tsx', '**/*.jsx']`) → matches both extensions
- [ ] **4.7** Write test: include with RegExp (`/\.tsx$/`) → matches `.tsx` files
- [ ] **4.8** Write test: exclude with glob (`'**/node_modules/**'`) → excludes node_modules paths
- [ ] **4.9** Write test: exclude wins over include when both match the same path
- [ ] **4.10** Write test: include present but path doesn't match → returns false (not default true)
- [ ] **4.11** Write test: backslash normalization — `'src\\App.ts'` matches `'**/*.ts'`
- [ ] **4.12** Write test: global RegExp with `lastIndex` state is handled correctly (reset between calls)
- [ ] **4.13** Run the tests: `pnpm --filter @astrojs/internal-helpers test`

### Phase 5: Migrate — Update consumers to use the new module

- [ ] **5.1** Update `packages/integrations/preact/src/server.ts` line 9
  - Change `import { createFilter } from '@rollup/pluginutils'` → `import { createFilter } from '@astrojs/internal-helpers/create-filter'`
- [ ] **5.2** Update `packages/integrations/preact/src/index.ts` line 118
  - Remove `'@rollup/pluginutils'` from the `optimizeDeps.include` array in `configEnvironmentPlugin`
- [ ] **5.3** Update `packages/integrations/preact/package.json`
  - Remove `"@rollup/pluginutils": "^5.3.0"` from `"dependencies"`
  - Add `"@astrojs/internal-helpers": "workspace:*"` to `"dependencies"` (if not already present)
- [ ] **5.4** Update `packages/astro/test/fixtures/multiple-jsx-renderers/renderers/meow/meow-server.mjs` line 2
  - Change `import { createFilter } from 'vite'` → `import { createFilter } from '@astrojs/internal-helpers/create-filter'`
- [ ] **5.5** Update `packages/astro/test/fixtures/multiple-jsx-renderers/renderers/woof/woof-server.mjs` line 2
  - Change `import { createFilter } from 'vite'` → `import { createFilter } from '@astrojs/internal-helpers/create-filter'`
- [ ] **5.6** Run `pnpm install` again to sync dependency changes

### Phase 6: Validate — Run integration tests and build

- [ ] **6.1** Build the preact integration: `pnpm --filter @astrojs/preact build`
- [ ] **6.2** Run the preact integration tests (if any): `pnpm --filter @astrojs/preact test`
- [ ] **6.3** Run the multiple-jsx-renderers test: look for relevant test file in `packages/astro/test/` and run it
- [ ] **6.4** Run `pnpm --filter @astrojs/internal-helpers test` one final time to confirm all unit tests pass
- [ ] **6.5** Verify no remaining imports of `createFilter` from `@rollup/pluginutils` or `vite` (grep the codebase)

## File Change Summary

| File | Action |
|------|--------|
| `packages/internal-helpers/src/create-filter.ts` | Implement the function |
| `packages/internal-helpers/package.json` | Add `picomatch` dep, add `create-filter` export |
| `packages/integrations/preact/src/server.ts` | Change import source |
| `packages/integrations/preact/src/index.ts` | Remove `@rollup/pluginutils` from optimizeDeps |
| `packages/integrations/preact/package.json` | Remove `@rollup/pluginutils` dependency |
| `packages/astro/test/fixtures/multiple-jsx-renderers/renderers/meow/meow-server.mjs` | Change import source |
| `packages/astro/test/fixtures/multiple-jsx-renderers/renderers/woof/woof-server.mjs` | Change import source |
| `packages/internal-helpers/test/create-filter.test.js` | New test file |
