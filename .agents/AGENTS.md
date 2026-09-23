# Injektor Project - Agent Guidelines

These are the project-specific guidelines for the `injektor` project.

## General
* **Language**: The project is written in **TypeScript**. All new source files should use the `.ts` extension.
* **Environment**: The project uses **Bun**. 

## Code Style & Conventions
* **Imports**: Use explicit `.ts` extensions for all local file imports (e.g., `import { foo } from "./foo.ts";`).
* **Decorators**: The project heavily utilizes **Stage 3 Decorators** (e.g., `@injectable()`, `@injectConstructor()`, `@inject()`). Ensure new features align with this pattern and respect `Symbol.metadata`.
* **Documentation**: Provide JSDoc comments (`/** ... */`) for all public classes, methods, and interfaces.
* **Sectioning**: Use visual section dividers in code for readability, e.g., `// ─── Section Name ───`.
* **Error Handling**: Use the custom error classes defined in `src/errors.ts` (e.g., `ServiceNotFoundError`, `CircularDependencyError`) rather than throwing generic `Error` objects, except for unrecoverable state/developer errors.

## Testing
* **Framework**: Tests are written using the `bun:test` framework (`describe`, `it`, `expect`). Do not use Jest, Mocha, or other testing libraries.
* **Location**: Place all tests in the `tests/` directory.
* **Naming**: Test files should use the `.test.ts` suffix (e.g., `container.test.ts`).
* **Fixtures**: Define mock interfaces (often prefixed with `I`, e.g., `IWeapon`) and classes at the top of the test file or in dedicated fixture files.
