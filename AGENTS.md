# Injektor agent guide

Injektor (`@ilya_coder/injektor`) is a Bun-first TypeScript dependency injection library with zero runtime or peer dependencies. Keep the public package usable from Bun, Node ESM, Node CommonJS, and browser bundles.

## Repository map

- `index.ts` defines the public exports. Update it and the relevant README examples when changing the public API.
- `src/container.ts` handles binding selection, hierarchical lookup, lifetimes, sync and async resolution, and module registration.
- `src/binding.ts` implements the fluent builder. `src/module.ts` defines the module registry API.
- `src/decorators.ts` records Stage 3 decorator metadata using the keys in `src/consts.ts`. `src/async-local.ts` handles native async context and the browser fallback.
- `src/types.ts` and `src/tokens.ts` define the public types and typed tokens. `src/errors.ts` defines the library errors.
- `tests/` has Bun tests, a subprocess fixture for browser-style resolution, and packed consumer fixtures. `benchmarks/` has Mitata timing and Node V8 allocation benchmarks.

## Development and verification

Run commands from the repository root. Install development dependencies with `bun install` when needed.

| Command | Purpose |
| --- | --- |
| `bun test` | Run the Bun suite, including browser-fallback resolution. |
| `bun test tests/resolution-lifecycle.test.ts` | Run a single test file while iterating. |
| `bun x tsc --noEmit` | Type-check the source, Bun tests, scripts, and benchmarks. |
| `bun run build` | Recreate `dist/` with runtime bundles and declarations. |
| `bun run test:package` | Build and pack the package, compile consumer fixtures, and exercise Node, Bun, and a browser bundle with no `process` global. Requires Node on `PATH`. |

Use `bun:test` and the `.test.ts` suffix for behavior tests. Exercise public behavior through `index.ts` and use `tests/package/` for installed-package behavior or declaration checks. Run the package smoke test for public API, type declaration, or packaging changes. The smoke test uses the local TypeScript compiler by default and accepts an absolute compiler path via `TSC_BIN`.

For performance changes, run `bun benchmarks/container.bench.ts` or `bun benchmarks/heavy.bench.ts`. Run allocation scenarios in separate processes, for example `node --expose-gc --import tsx benchmarks/allocations.bench.ts sync`.

## Code conventions

- Use explicit `.ts` extensions on local imports and use `import type` and `export type` for type-only references. Follow the surrounding style and document public APIs with JSDoc.
- Use the existing error classes for binding, decorator, and resolution errors.
- Use standard Stage 3 decorators and `Symbol.metadata`. Constructor injection uses `@injectConstructor()`. Property injection uses auto-accessors and the captured `context.access.set` so private and static accessors work.
- Each injectable class owns its opt-in marker and default scope. Inherited accessor metadata is copied before edits. Forwarding constructors can inherit the base argument list. A subclass with a non-forwarding constructor declares its own injection tokens with `@injectConstructor()` when it needs them.

## Resolution invariants

- Single lookups try matching local bindings before ancestors and fall back to autobinding when eligible. Multi-lookups combine local and ancestor bindings in that order. Ancestor singletons resolve dependencies through their owning container.
- Request scope shares values inside one resolution graph and isolates separate top-level lookups. Factories use their captured `ResolutionContext` for lookups after `await` in browsers. Keep Node built-ins out of static imports in runtime source so the browser fallback can load.
- Track caching and cycles by binding identity. Pending async singleton and request resolutions can be shared by concurrent callers, and failures clear the pending entry for retry. A synchronous lookup throws `AsyncBindingError` if it would need to wait for pending initialization. A cached `undefined` is a cache hit.
- Preserve promise-valued services from synchronous factories in sync lookups, injection, and async multi-lookups. Public single async lookups await their result. Async cycle detection covers both recursive lookups and waits between parallel branches.
- Keep module registries synchronous and roll back their registrations on failure. When bindings are retargeted or removed, keep module ownership and caches consistent. An in-flight lookup finishes against the binding it started with.
- Preserve the distinction between typed token lookup and registration. Lookups infer the service type, and registration rejects widening the type of a branded token.

## Package compatibility

Edit source and build scripts to change generated output. `scripts/build.ts` emits the browser/default ESM bundle, the CommonJS runtime, and a Node ESM wrapper over that runtime. Node ESM and CommonJS share class, error, and decorator metadata identities. Keep the `.d.ts` and `.d.cts` entry points backed by the same declarations under `dist/src/`.

`tsconfig.build.json` limits declaration generation to `index.ts` and `src/`. The `prepare` and `prepublishOnly` scripts check the public source with TypeScript 5.7.3 before building with the local compiler. Keep those compatibility checks when changing source types or package exports.
