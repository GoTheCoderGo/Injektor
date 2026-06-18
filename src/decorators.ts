import {
  INJECTABLE_KEY,
  CONSTRUCTOR_INJECT_KEY,
  PROPERTY_INJECT_KEY,
} from "./consts.ts";
import { InvalidDecoratorUsageError } from "./errors.ts";
import type {
  ServiceIdentifier,
  PropertyInjectMetadata,
} from "./types.ts";

// Polyfill Symbol.metadata for runtimes that don't yet expose it natively.
// @ts-ignore — Symbol.metadata is a stage 3 well-known symbol
Symbol.metadata ??= Symbol.for("Symbol.metadata");

/**
 * Marks a class as available for dependency injection.
 * Must be applied to any class that will be resolved by the Container.
 *
 * @example
 * ```ts
 * @injectable()
 * class MyService { }
 * ```
 */
export function injectable() {
  return (_: any, context: DecoratorContext) => {
    if (context.kind !== "class") {
      throw new InvalidDecoratorUsageError(
        "injectable",
        `can only be applied to a class, but was applied to a ${context.kind}.`
      );
    }
    context.metadata[INJECTABLE_KEY] = true;
    // Initialize metadata maps if they haven't been set by other decorators yet.
    context.metadata[CONSTRUCTOR_INJECT_KEY] ??= [];
    context.metadata[PROPERTY_INJECT_KEY] ??= new Map();
  };
}

/**
 * Declares the service identifiers for constructor parameter injection.
 * Tokens must be listed in the same order as the constructor parameters.
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
export function injectConstructor(...tokens: ServiceIdentifier[]) {
  return (_: any, context: DecoratorContext) => {
    if (context.kind !== "class") {
      throw new InvalidDecoratorUsageError(
        "injectConstructor",
        `can only be applied to a class, but was applied to a ${context.kind}.`
      );
    }
    context.metadata[CONSTRUCTOR_INJECT_KEY] = tokens;
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
