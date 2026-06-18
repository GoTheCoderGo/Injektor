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
  /** Binding to a synchronous factory function. */
  Factory = "Factory",
  /** Binding to an asynchronous factory function. */
  AsyncFactory = "AsyncFactory",
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
  /** The async factory function (for AsyncFactory bindings). */
  asyncFactory?: () => Promise<T>;
  /** Cached singleton instance. */
  cache?: T;
  /** Named constraint for this binding. */
  name?: string;
  /** Tagged constraints for this binding. */
  tags?: Record<string, unknown>;
}

/**
 * Describes constraints for a constructor injection argument.
 */
export interface InjectDescriptor<T = unknown> {
  /** The service identifier token. */
  token: ServiceIdentifier<T>;
  /** Named constraint for disambiguation. */
  named?: string;
  /** Tagged constraints for conditional resolution. */
  tags?: Record<string, unknown>;
  /** If true, resolve all bindings as an array. */
  multi?: boolean;
}

/**
 * A constructor injection argument: either a plain token or a rich descriptor.
 */
export type InjectArg<T = unknown> = ServiceIdentifier<T> | InjectDescriptor<T>;

/**
 * Shape of constructor injection metadata stored on a class.
 * An ordered array of injection arguments matching the constructor parameters.
 */
export type ConstructorInjectMetadata = ReadonlyArray<InjectArg>;

/**
 * Shape of property injection metadata stored on a class.
 * Maps field name → service identifier token.
 */
export type PropertyInjectMetadata = Map<string | symbol, ServiceIdentifier>;

/**
 * Shape of named property injection metadata.
 * Maps field name → constraint name.
 */
export type NamedInjectMetadata = Map<string | symbol, string>;

/**
 * Shape of tagged property injection metadata.
 * Maps field name → tags record.
 */
export type TaggedInjectMetadata = Map<string | symbol, Record<string, unknown>>;

/**
 * Shape of multi-inject property metadata.
 * Maps field name → service identifier token.
 */
export type MultiInjectMetadata = Map<string | symbol, ServiceIdentifier>;

/**
 * Options for the Container constructor.
 */
export interface ContainerOptions {
  /** Parent container for hierarchical resolution. */
  parent?: import("./container.ts").Container;
}