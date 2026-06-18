import type { ServiceIdentifier } from "./types.ts";

/**
 * Formats a ServiceIdentifier into a readable string for error messages.
 */
function formatId(id: ServiceIdentifier): string {
  if (typeof id === "symbol") return id.toString();
  if (typeof id === "string") return `"${id}"`;
  if (typeof id === "function") return id.name || "AnonymousClass";
  return String(id);
}

/**
 * Thrown when resolving a token that has no registered binding.
 */
export class ServiceNotFoundError extends Error {
  constructor(id: ServiceIdentifier) {
    super(`No binding found for service identifier: ${formatId(id)}`);
    this.name = "ServiceNotFoundError";
  }
}

/**
 * Thrown when a circular dependency is detected during resolution.
 */
export class CircularDependencyError extends Error {
  constructor(chain: ServiceIdentifier[]) {
    const path = chain.map(formatId).join(" → ");
    super(`Circular dependency detected: ${path}`);
    this.name = "CircularDependencyError";
  }
}

/**
 * Thrown when a decorator is applied to an invalid target.
 */
export class InvalidDecoratorUsageError extends Error {
  constructor(decoratorName: string, message: string) {
    super(`@${decoratorName}: ${message}`);
    this.name = "InvalidDecoratorUsageError";
  }
}

/**
 * Thrown when trying to resolve a class that was not decorated with @injectable().
 */
export class NotInjectableError extends Error {
  constructor(id: ServiceIdentifier) {
    super(
      `Cannot resolve ${formatId(id)}: class is not decorated with @injectable(). ` +
      `Make sure to add @injectable() to the class declaration.`
    );
    this.name = "NotInjectableError";
  }
}
