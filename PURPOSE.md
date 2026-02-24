# Proposal: Emit `ssr:component-path` for SSR-only components in the Astro compiler

## Summary

The Astro compiler should emit a component path attribute for **all** framework components rendered during SSR, not just hydrated ones (those with `client:*` directives). This would allow renderer `check()` functions to filter components by file path in all rendering modes, solving the long-standing multi-renderer conflict problem.

## Background: The multi-renderer conflict problem

When an Astro project uses multiple JSX renderers (e.g. React + Preact), Astro must decide which renderer handles each component. This is done via a `check()` loop in `renderFrameworkComponent()` (`packages/astro/src/runtime/server/render/component.ts:130-147`):

```typescript
for (const r of renderers) {
    if (await r.ssr.check.call({ result }, Component, props, children, metadata)) {
        renderer = r;
        break; // first match wins
    }
}
```

The problem: renderers like Preact use a "try to render it" strategy in `check()` — they call `renderToStaticMarkup` on the component and check if it produces valid HTML. This **false-positives** on components from other frameworks (e.g. a React component can often be rendered by Preact's render function, just incorrectly). The first renderer in the list claims components it shouldn't.

Users configure `include`/`exclude` patterns on their integrations (e.g. `preact({ include: ['**/preact/*'] })`) to tell Vite which JSX transform plugin handles which files. But these patterns were **completely ignored** during runtime renderer selection.

## What we've already fixed

In PR #15619 and the follow-up work on the `ocavue/multi-jsx-2` branch, we've fixed this for **hydrated components** (those with `client:load`, `client:idle`, `client:visible`, `client:media`):

1. **Pass `metadata` to `check()`**: `component.ts:133` now passes `metadata` as the 4th argument to `check()`.

2. **Virtual module for options**: Each integration creates a virtual module (e.g. `astro:preact:opts`) that exports the user's `include`/`exclude` configuration.

3. **Filter in `check()`**: The renderer's `check()` function imports the options, builds a filter using Vite's `createFilter()`, and early-returns `false` when `metadata.componentUrl` doesn't match:

```typescript
const filter = opts.include || opts.exclude
    ? createFilter(opts.include, opts.exclude)
    : null;

async function check(Component, props, children, metadata?) {
    if (filter && metadata?.componentUrl && !filter(metadata.componentUrl)) {
        return false; // reject before expensive try-render
    }
    // ... existing try-render logic
}
```

This works because for hydrated components, `metadata.componentUrl` is populated from the `client:component-path` attribute that the compiler emits.

## The remaining problem: SSR-only components

For SSR-only components (plain `<MyComponent />` without any `client:*` or `server:*` directive), `metadata.componentUrl` is **always `undefined`**. The filter cannot apply, and the `check()` loop falls back to the old try-render behavior — first renderer wins.

### Why `componentUrl` is undefined for SSR-only components

The Astro compiler only emits `client:component-path` when a component has a `client:` directive. Here's the code flow:

**1. In `transform.go` — `AddComponentProps` (lines 494-587)**

The function iterates component attributes and looks for `client:` or `server:` prefixes:

```go
// Line 497 — only enters for hydrated components
for _, attr := range n.Attr {
    if strings.HasPrefix(attr.Key, "client:") {
        // ... resolves import path ...
        // Line 535-540 — emits client:component-path
        n.Attr = append(n.Attr, astro.Attribute{
            Key:  "client:component-path",
            Val:  specifier,  // e.g., "/src/components/Counter.tsx"
            Type: astro.QuotedAttribute,
        })
    }
}
```

For a plain `<MyComponent />` with no `client:` attributes, this loop body never executes, and no path is emitted.

**2. In `print-to-js.go` (lines 380-440)**

SSR-only components are rendered via `$$renderComponent()` but without any path metadata:

```javascript
// Compiler output for SSR-only component:
$$renderComponent($$result, 'MyComponent', MyComponent, {})

// vs. for hydrated component:
$$renderComponent($$result, 'MyComponent', MyComponent, {
    "client:load": true,
    "client:component-path": "/src/components/MyComponent.tsx",
    "client:component-export": "default",
    "client:component-hydration": ""
})
```

**3. In the runtime — `hydration.ts:extractDirectives()` (line 54)**

The `hydration` object (which holds `componentUrl`) is only created when a `client:` prefix key is found:

```typescript
for (const [key, value] of Object.entries(inputProps)) {
    if (key.startsWith('client:')) {
        if (!extracted.hydration) {
            extracted.hydration = { /* ... componentUrl: '' ... */ };
        }
        // ... extracts componentUrl from 'client:component-path'
    }
}
```

For SSR-only components, no `client:` keys exist, so `extracted.hydration` remains `null`, and `metadata.componentUrl` is never set.

## Proposed solution: `ssr:component-path`

### Compiler change

Add a new attribute `ssr:component-path` that the compiler emits for **all** framework components, regardless of whether they have `client:` or `server:` directives.

In `transform.go`, after the existing `for` loop in `AddComponentProps` that checks for `client:` and `server:` prefixes, add a **fallback** that runs when no directive was found:

```go
func AddComponentProps(doc *astro.Node, n *astro.Node) {
    hasDirective := false

    for _, attr := range n.Attr {
        if strings.HasPrefix(attr.Key, "client:") {
            hasDirective = true
            // ... existing logic: emit client:component-path ...
        } else if strings.HasPrefix(attr.Key, "server:") {
            hasDirective = true
            // ... existing logic: emit server:component-path ...
        }
    }

    // NEW: For SSR-only components (no client: or server: directive),
    // emit ssr:component-path so the runtime can identify the source file
    if !hasDirective {
        importInfo := matchNodeToImportStatement(doc, n)
        if importInfo != nil {
            n.Attr = append(n.Attr, astro.Attribute{
                Key:  "ssr:component-path",
                Val:  importInfo.Specifier,
                Type: astro.QuotedAttribute,
            })
        }
    }
}
```

This would make the compiler output for SSR-only components include the path:

```javascript
// Before (current):
$$renderComponent($$result, 'MyComponent', MyComponent, {})

// After (proposed):
$$renderComponent($$result, 'MyComponent', MyComponent, {
    "ssr:component-path": "/src/components/MyComponent.tsx"
})
```

### Why `ssr:` prefix instead of reusing `client:component-path`

1. **No semantic confusion**: `client:component-path` implies the component will be hydrated on the client. SSR-only components have no client-side behavior.

2. **No interference with existing logic**: The `extractDirectives()` function creates the `hydration` object when it sees any `client:` key. If we emitted `client:component-path` for SSR-only components, it would incorrectly create a hydration object and potentially trigger hydration logic for a component that shouldn't hydrate.

3. **Clean separation**: `client:` = hydration metadata, `server:` = server islands metadata, `ssr:` = SSR rendering metadata. Each prefix has a clear purpose.

4. **Backwards compatible**: Existing code that only looks for `client:` or `server:` prefixes won't be affected by the new `ssr:` attributes.

### Runtime changes needed

**1. `hydration.ts:extractDirectives()`**

Add a new branch to extract `ssr:component-path` into a separate field on the extracted result (NOT inside `hydration`, since SSR-only components don't hydrate):

```typescript
export function extractDirectives(inputProps, clientDirectives): ExtractedProps {
    let extracted: ExtractedProps = {
        isPage: false,
        hydration: null,
        props: {},
        propsWithoutTransitionAttributes: {},
        ssrComponentPath: undefined,  // NEW field
    };

    for (const [key, value] of Object.entries(inputProps)) {
        if (key.startsWith('client:')) {
            // ... existing hydration logic (unchanged) ...
        } else if (key === 'ssr:component-path') {
            // NEW: extract SSR component path
            extracted.ssrComponentPath = value;
        } else {
            // ... existing prop forwarding ...
        }
    }

    return extracted;
}
```

**2. `component.ts:renderFrameworkComponent()`**

Use `ssrComponentPath` as a fallback when `hydration.componentUrl` is not available:

```typescript
const { hydration, isPage, props, propsWithoutTransitionAttributes, ssrComponentPath } =
    extractDirectives(_props, clientDirectives);

if (hydration) {
    metadata.componentUrl = hydration.componentUrl;
    // ... other hydration fields ...
} else if (ssrComponentPath) {
    // NEW: set componentUrl from ssr:component-path for SSR-only components
    metadata.componentUrl = ssrComponentPath;
}
```

No other changes needed. The renderer's `check()` function already uses `metadata.componentUrl` — once it's populated for SSR-only components, the existing filter logic works automatically.

## Why this matters

### Current behavior with multiple renderers (SSR-only)

```
Config: preact({ include: ['**/preact/*'] }), react({ include: ['**/react/*'] })

<ReactCounter />  ← SSR-only, no client: directive
  → metadata.componentUrl = undefined
  → Preact check() can't filter → tries to render → FALSE POSITIVE
  → React component rendered by Preact → wrong output or silent failure
```

### Expected behavior after this change

```
<ReactCounter />  ← SSR-only, has ssr:component-path
  → metadata.componentUrl = "/src/components/react/ReactCounter.tsx"
  → Preact check() sees path doesn't match '**/preact/*' → returns false
  → React check() sees path matches '**/react/*' → returns true ✓
```

### Who benefits

1. **Users with React + Preact**: The most common multi-renderer combo. Currently broken for SSR-only components even with correct `include` patterns.

2. **Users with React + Solid**: Same issue — Solid's `check()` also uses try-render.

3. **Custom renderer authors**: Anyone building a custom Astro renderer that supports `include`/`exclude` patterns.

4. **Framework-agnostic**: The fix works for any current or future renderer, not just Preact.

## Test evidence

The `multiple-jsx-renderers` test fixture on the `ocavue/multi-jsx-2` branch explicitly documents this limitation:

```javascript
// From packages/astro/test/multiple-jsx-renderers.test.js
it('MeowCounter rendered by woof incorrectly (known limitation)', async () => {
    const html = await fixture.readFile('/ssr/index.html');
    const $ = cheerio.load(html);
    const meowRoot = $('#meow-root');

    // BUG: SSR-only components don't have metadata.componentUrl, so check()
    // can't filter by include pattern. Woof is registered first and claims
    // MeowCounter. This should be fixed so meow renders its own component.
    assert.equal(meowRoot.find('[data-renderer="woof"]').length, 1);
});
```

With `ssr:component-path`, this test would pass correctly — MeowCounter would be rendered by meow, not woof.

## Compatibility with the Rust compiler migration

We're aware that the Astro team is migrating the compiler from Go to Rust (`@astrojs/compiler-rs`). The proposed change is architecturally simple:

1. It follows the exact same pattern as `client:component-path` — same resolution logic (`matchNodeToImportStatement`), same attribute format, just a different key prefix.

2. The Rust compiler would need to implement the same logic: when no `client:` or `server:` directive is present, emit `ssr:component-path` with the resolved import specifier.

3. This could be implemented in either compiler (or both) independently — it's a self-contained addition.

## Summary

| Aspect | Current state | After `ssr:component-path` |
|---|---|---|
| Hydrated components (`client:*`) | `componentUrl` available, filter works | No change |
| SSR-only components | `componentUrl` undefined, filter can't apply, wrong renderer selected | `componentUrl` available via `ssr:component-path`, filter works correctly |
| `client:only` components | Explicit renderer via directive | No change |
| Server islands (`server:defer`) | Own path via `server:component-path` | No change |
| Single-renderer projects | No conflict | No change |

The change is minimal in scope (one new attribute emission in the compiler, two small runtime extractions), follows existing patterns exactly, and unblocks a correct solution to a real user-facing bug.
