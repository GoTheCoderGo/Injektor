/**
 * Metadata keys — unique symbols used to store DI metadata
 * on class definitions via `context.metadata` / `Symbol.metadata`.
 */

/** Marker that a class has been decorated with @injectable(). */
export const INJECTABLE_KEY = Symbol("injektor:injectable");

/** Ordered array of service identifiers for constructor injection. */
export const CONSTRUCTOR_INJECT_KEY = Symbol("injektor:constructorInject");

/** Map of field name → service identifier for property injection. */
export const PROPERTY_INJECT_KEY = Symbol("injektor:propertyInject");

/** Map of field name → named constraint for property injection. */
export const NAMED_INJECT_KEY = Symbol("injektor:namedInject");

/** Map of field name → tagged constraints for property injection. */
export const TAGGED_INJECT_KEY = Symbol("injektor:taggedInject");

/** Map of field name → service identifier for multi-inject property injection. */
export const MULTI_INJECT_KEY = Symbol("injektor:multiInject");