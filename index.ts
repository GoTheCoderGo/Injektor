// ── Core ──
export { Container } from "./src/container.ts";
export { BindingBuilder } from "./src/binding.ts";
export { ContainerModule } from "./src/module.ts";
export type { BindFunction } from "./src/module.ts";

// ── Decorators ──
export {
  injectable,
  inject,
  injectConstructor,
  named,
  tagged,
  multiInject,
} from "./src/decorators.ts";

// ── Tokens ──
export { createToken } from "./src/tokens.ts";
export type { Token } from "./src/tokens.ts";

// ── Types ──
export { Scope, BindingType } from "./src/types.ts";
export type {
  ServiceIdentifier,
  Constructor,
  Binding,
  InjectDescriptor,
  InjectArg,
  ContainerOptions,
} from "./src/types.ts";

// ── Errors ──
export {
  ServiceNotFoundError,
  CircularDependencyError,
  InvalidDecoratorUsageError,
  NotInjectableError,
  AmbiguousBindingError,
} from "./src/errors.ts";