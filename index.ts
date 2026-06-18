// ── Core ──
export { Container } from "./src/container.ts";
export { BindingBuilder } from "./src/binding.ts";

// ── Decorators ──
export { injectable, inject, injectConstructor } from "./src/decorators.ts";

// ── Tokens ──
export { createToken } from "./src/tokens.ts";
export type { Token } from "./src/tokens.ts";

// ── Types ──
export { Scope, BindingType } from "./src/types.ts";
export type {
  ServiceIdentifier,
  Constructor,
  Binding,
} from "./src/types.ts";

// ── Errors ──
export {
  ServiceNotFoundError,
  CircularDependencyError,
  InvalidDecoratorUsageError,
  NotInjectableError,
} from "./src/errors.ts";