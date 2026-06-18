import type { Token } from "./tokens.ts";

/**
 * A constructable class type.
 */
export type Constructor<T = unknown> = new (...args: any[]) => T;

/**
 * Union of all valid service identifier types.
 * Mirrors InversifyJS's ServiceIdentifier but adds Token<T> support.
 */
export type ServiceIdentifier<T = unknown> =
  | string
  | symbol
  | Constructor<T>
  | Token<T>;

/**
 * Lifecycle scope for a binding.
 */
export enum Scope {
  /** A new instance is created on every resolution (default). */
  Transient = "Transient",
  /** A single instance is shared across all resolutions. */
  Singleton = "Singleton",
  /** A single instance is shared within a single `container.get()` call graph. */
  Request = "Request",
}

/**
 * The type of value a binding resolves to.
 */
export enum BindingType {
  /** Binding to a class constructor. */
  Instance = "Instance",
  /** Binding to a constant value. */
  Constant = "Constant",
  /** Binding to a factory function. */
  Factory = "Factory",
}

/**
 * Internal representation of a configured binding.
 */
export interface Binding<T = unknown> {
  /** The identifier this binding is registered under. */
  id: ServiceIdentifier<T>;
  /** What kind of binding this is. */
  type: BindingType;
  /** The lifecycle scope. */
  scope: Scope;
  /** The implementation class (for Instance bindings). */
  implementationClass?: Constructor<T>;
  /** The constant value (for Constant bindings). */
  value?: T;
  /** The factory function (for Factory bindings). */
  factory?: () => T;
  /** Cached singleton instance. */
  cache?: T;
}

/**
 * Shape of constructor injection metadata stored on a class.
 * An ordered array of service identifiers matching the constructor parameters.
 */
export type ConstructorInjectMetadata = ReadonlyArray<ServiceIdentifier>;

/**
 * Shape of property injection metadata stored on a class.
 * Maps field name → service identifier token.
 */
export type PropertyInjectMetadata = Map<string | symbol, ServiceIdentifier>;