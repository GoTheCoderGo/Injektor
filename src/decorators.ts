import {
  INJECTABLE_KEY,
  CONSTRUCTOR_INJECT_KEY,
  PROPERTY_INJECT_KEY,
  NAMED_INJECT_KEY,
  TAGGED_INJECT_KEY,
  MULTI_INJECT_KEY,
  SCOPE_KEY,
} from "./consts.ts";
import { InvalidDecoratorUsageError } from "./errors.ts";
import type {
  ServiceIdentifier,
  InjectArg,
  PropertyInjectMetadata,
  NamedInjectMetadata,
  TaggedInjectMetadata,
  MultiInjectMetadata,
  Scope,
} from "./types.ts";

// Polyfill Symbol.metadata for runtimes that don't yet expose it natively.
// @ts-ignore — Symbol.metadata is a stage 3 well-known symbol
Symbol.metadata ??= Symbol.for("Symbol.metadata");

/**
 * Options for the @injectable decorator.
 */
export interface InjectableOptions {
  /** Default scope for the injected service. */
  scope?: Scope;
}

/**
 * Marks a class as available for dependency injection.
 * Must be applied to any class that will be resolved by the Container.
 *
 * @example
 * ```ts
 * @injectable()
 * class MyService { }
 * 
 * @injectable({ scope: Scope.Singleton })
 * class SingletonService { }
 * ```
 */
export function injectable(options?: InjectableOptions) {
  return (_: any, context: DecoratorContext) => {
    if (context.kind !== "class") {
      throw new InvalidDecoratorUsageError(
        "injectable",
        `can only be applied to a class, but was applied to a ${context.kind}.`
      );
    }
    context.metadata[INJECTABLE_KEY] = true;
    if (options?.scope) {
      context.metadata[SCOPE_KEY] = options.scope;
    }
    // Initialize metadata maps if they haven't been set by other decorators yet.
    context.metadata[CONSTRUCTOR_INJECT_KEY] ??= [];
    context.metadata[PROPERTY_INJECT_KEY] ??= new Map();
    context.metadata[NAMED_INJECT_KEY] ??= new Map();
    context.metadata[TAGGED_INJECT_KEY] ??= new Map();
    context.metadata[MULTI_INJECT_KEY] ??= new Map();
  };
}

/**
 * Declares the service identifiers for constructor parameter injection.
 * Tokens must be listed in the same order as the constructor parameters.
 *
 * Each argument can be a plain `ServiceIdentifier` or an `InjectDescriptor`
 * for named/tagged/multi constraints:
 * ```ts
 * @injectConstructor(WEAPON, { token: ARMOR, named: "heavy" })
 * ```
 *
 * Required because TC39 Stage 3 does not support parameter decorators.
 *
 * @example
 * ```ts
 * @injectable()
 * @injectConstructor(WEAPON_TOKEN, ARMOR_TOKEN)
 * class Warrior {
 *   constructor(weapon: Weapon, armor: Armor) { ... }
 * }
 * ```
 */
export function injectConstructor(...args: InjectArg[]) {
  return (_: any, context: DecoratorContext) => {
    if (context.kind !== "class") {
      throw new InvalidDecoratorUsageError(
        "injectConstructor",
        `can only be applied to a class, but was applied to a ${context.kind}.`
      );
    }
    context.metadata[CONSTRUCTOR_INJECT_KEY] = args;
  };
}

/**
 * Marks an auto-accessor field for property injection.
 *
 * Must be used with the `accessor` keyword so the container can
 * set the value via the generated setter after construction.
 *
 * @param token - The service identifier to resolve for this field.
 *
 * @example
 * ```ts
 * @injectable()
 * class Warrior {
 *   @inject(WEAPON_TOKEN) accessor weapon!: Weapon;
 * }
 * ```
 */
export function inject(token: ServiceIdentifier) {
  return (_value: any, context: DecoratorContext) => {
    if (context.kind !== "accessor") {
      throw new InvalidDecoratorUsageError(
        "inject",
        `must be applied to an auto-accessor field (use the 'accessor' keyword), ` +
        `but was applied to a ${context.kind}.`
      );
    }

    // Initialize the property map if it doesn't exist yet
    // (in case @inject runs before @injectable in decorator evaluation order).
    context.metadata[PROPERTY_INJECT_KEY] ??= new Map();
    const propMap = context.metadata[PROPERTY_INJECT_KEY] as PropertyInjectMetadata;
    propMap.set(context.name, token);
  };
}

/**
 * Specifies a named constraint on an auto-accessor injection point.
 * Stack with `@inject()` to disambiguate multiple bindings for the same token.
 *
 * @param name - The binding name to match against `.whenNamed()`.
 *
 * @example
 * ```ts
 * @injectable()
 * class Warrior {
 *   @inject(WEAPON) @named("katana") accessor weapon!: Weapon;
 * }
 * ```
 */
export function named(name: string) {
  return (_value: any, context: DecoratorContext) => {
    if (context.kind !== "accessor") {
      throw new InvalidDecoratorUsageError(
        "named",
        `must be applied to an auto-accessor field, but was applied to a ${context.kind}.`
      );
    }

    context.metadata[NAMED_INJECT_KEY] ??= new Map();
    const namedMap = context.metadata[NAMED_INJECT_KEY] as NamedInjectMetadata;
    namedMap.set(context.name, name);
  };
}

/**
 * Specifies a tagged constraint on an auto-accessor injection point.
 * Stack with `@inject()` to conditionally resolve bindings.
 *
 * @param key - The tag key.
 * @param value - The tag value to match.
 *
 * @example
 * ```ts
 * @injectable()
 * class Warrior {
 *   @inject(WEAPON) @tagged("tier", "legendary") accessor weapon!: Weapon;
 * }
 * ```
 */
export function tagged(key: string, value: unknown) {
  return (_value: any, context: DecoratorContext) => {
    if (context.kind !== "accessor") {
      throw new InvalidDecoratorUsageError(
        "tagged",
        `must be applied to an auto-accessor field, but was applied to a ${context.kind}.`
      );
    }

    context.metadata[TAGGED_INJECT_KEY] ??= new Map();
    const taggedMap = context.metadata[TAGGED_INJECT_KEY] as TaggedInjectMetadata;
    const existing = taggedMap.get(context.name) ?? {};
    existing[key] = value;
    taggedMap.set(context.name, existing);
  };
}

/**
 * Marks an auto-accessor field to receive ALL bindings for the given token as an array.
 *
 * @param token - The service identifier to resolve all bindings for.
 *
 * @example
 * ```ts
 * @injectable()
 * class Army {
 *   @multiInject(WEAPON) accessor weapons!: Weapon[];
 * }
 * ```
 */
export function multiInject(token: ServiceIdentifier) {
  return (_value: any, context: DecoratorContext) => {
    if (context.kind !== "accessor") {
      throw new InvalidDecoratorUsageError(
        "multiInject",
        `must be applied to an auto-accessor field, but was applied to a ${context.kind}.`
      );
    }

    context.metadata[MULTI_INJECT_KEY] ??= new Map();
    const multiMap = context.metadata[MULTI_INJECT_KEY] as MultiInjectMetadata;
    multiMap.set(context.name, token);
  };
}
