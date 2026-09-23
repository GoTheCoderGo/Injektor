import {
  INJECTABLE_KEY,
  CONSTRUCTOR_INJECT_KEY,
  PROPERTY_INJECT_KEY,
  NAMED_INJECT_KEY,
  TAGGED_INJECT_KEY,
  MULTI_INJECT_KEY,
  ACCESSOR_INJECT_KEY,
  SCOPE_KEY,
} from "./consts.ts";
import { InvalidDecoratorUsageError } from "./errors.ts";
import { Scope } from "./types.ts";
import type {
  ServiceIdentifier,
  InjectArg,
  AccessorInjectInfo,
  ConstructorInjectMetadata,
} from "./types.ts";

// Polyfill Symbol.metadata for runtimes that don't yet expose it natively.
// @ts-ignore — Symbol.metadata is a stage 3 well-known symbol
Symbol.metadata ??= Symbol.for("Symbol.metadata");

/**
 * Retrieves or creates a Map on the metadata object as an own property,
 * copying entries from the prototype chain if present.
 */
function getOwnMap<K, V>(metadata: Record<symbol, any>, key: symbol): Map<K, V> {
  if (!Object.prototype.hasOwnProperty.call(metadata, key)) {
    const parentMap = metadata[key] as Map<K, V> | undefined;
    metadata[key] = parentMap ? new Map(parentMap) : new Map<K, V>();
  }
  return metadata[key];
}

/**
 * Remember the accessor setter. `context.name` for a private field is the
 * string "#field", and assigning that key does not call the private setter.
 */
function recordAccessor(context: DecoratorContext): void {
  if (context.kind !== "accessor") return;
  const accessor = context as DecoratorContext & {
    static: boolean;
    access: { set(receiver: unknown, value: unknown): void };
    addInitializer(initializer: (this: unknown) => void): void;
  };
  const map = getOwnMap<string | symbol, AccessorInjectInfo>(
    context.metadata,
    ACCESSOR_INJECT_KEY,
  );
  const info: AccessorInjectInfo = {
    set: accessor.access.set.bind(accessor.access),
    static: accessor.static,
  };
  if (accessor.static) {
    accessor.addInitializer(function (this: unknown) {
      info.home = this as Function;
    });
  }
  map.set(context.name, info);
}

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
  return (ctor: Function, context: DecoratorContext) => {
    if (context.kind !== "class") {
      throw new InvalidDecoratorUsageError(
        "injectable",
        `can only be applied to a class, but was applied to a ${context.kind}.`
      );
    }
    context.metadata[INJECTABLE_KEY] = true;
    if (options?.scope !== undefined) {
      context.metadata[SCOPE_KEY] = options.scope;
    } else if (!Object.prototype.hasOwnProperty.call(context.metadata, SCOPE_KEY)) {
      // Shadow a scope inherited through the metadata prototype.
      context.metadata[SCOPE_KEY] = Scope.Transient;
    }
    if (!Object.prototype.hasOwnProperty.call(context.metadata, CONSTRUCTOR_INJECT_KEY)) {
      const inherited = context.metadata[CONSTRUCTOR_INJECT_KEY] as
        | ConstructorInjectMetadata
        | undefined;
      // A declared constructor does not forward arguments. Copy the base list
      // only for the default constructor, which does.
      if (!classDeclaresConstructor(ctor) && inherited && inherited.length > 0) {
        context.metadata[CONSTRUCTOR_INJECT_KEY] = [...inherited];
      } else {
        context.metadata[CONSTRUCTOR_INJECT_KEY] = [];
      }
    }
    getOwnMap(context.metadata, PROPERTY_INJECT_KEY);
    getOwnMap(context.metadata, NAMED_INJECT_KEY);
    getOwnMap(context.metadata, TAGGED_INJECT_KEY);
    getOwnMap(context.metadata, MULTI_INJECT_KEY);
    getOwnMap(context.metadata, ACCESSOR_INJECT_KEY);
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

    recordAccessor(context);
    const propMap = getOwnMap<string | symbol, ServiceIdentifier>(
      context.metadata,
      PROPERTY_INJECT_KEY,
    );
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

    recordAccessor(context);
    const namedMap = getOwnMap<string | symbol, string>(
      context.metadata,
      NAMED_INJECT_KEY,
    );
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

    recordAccessor(context);
    const taggedMap = getOwnMap<string | symbol, Record<string, unknown>>(
      context.metadata,
      TAGGED_INJECT_KEY,
    );
    const existing = taggedMap.get(context.name);
    taggedMap.set(context.name, { ...existing, [key]: value });
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

    recordAccessor(context);
    const multiMap = getOwnMap<string | symbol, ServiceIdentifier>(
      context.metadata,
      MULTI_INJECT_KEY,
    );
    multiMap.set(context.name, token);
  };
}

function classDeclaresConstructor(ctor: Function): boolean {
  const source = stripLiteralsAndComments(Function.prototype.toString.call(ctor));
  return /\bconstructor\s*\(/.test(stripNestedClasses(outermostClassBody(source)));
}

function stripLiteralsAndComments(source: string): string {
  let out = "";
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i++;
      out += " ";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") i++;
        i++;
      }
      out += "''";
      continue;
    }
    out += ch;
  }
  return out;
}

function outermostClassBody(source: string): string {
  const ranges = classBodyRanges(source);
  const outer = ranges[ranges.length - 1];
  if (!outer) return source;
  return source.slice(outer.start, outer.end);
}

function stripNestedClasses(body: string): string {
  const ranges = classBodyRanges(body);
  if (ranges.length === 0) return body;
  let out = "";
  let cursor = 0;
  for (const range of ranges) {
    out += body.slice(cursor, range.classStart);
    cursor = range.end + 1;
  }
  out += body.slice(cursor);
  return out;
}

function classBodyRanges(
  source: string,
): { classStart: number; start: number; end: number }[] {
  const ranges: { classStart: number; start: number; end: number }[] = [];
  type Frame = { classStart: number; bodyStart: number; brace: number };
  const frames: Frame[] = [];
  const pendingClasses: number[] = [];
  let paren = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === "(") {
      paren++;
      continue;
    }
    if (ch === ")") {
      if (paren > 0) paren--;
      continue;
    }
    if (paren > 0) continue;
    if (isClassKeyword(source, i)) {
      pendingClasses.push(i);
      i += "class".length - 1;
      continue;
    }
    if (ch === "{") {
      const classStart = pendingClasses.pop();
      if (classStart !== undefined) {
        frames.push({ classStart, bodyStart: i + 1, brace: 1 });
      } else {
        const top = frames[frames.length - 1];
        if (top) top.brace++;
      }
      continue;
    }
    if (ch === "}") {
      const top = frames[frames.length - 1];
      if (!top) continue;
      top.brace--;
      if (top.brace === 0) {
        ranges.push({
          classStart: top.classStart,
          start: top.bodyStart,
          end: i,
        });
        frames.pop();
      }
    }
  }
  return ranges;
}

function isClassKeyword(source: string, index: number): boolean {
  if (source.slice(index, index + 5) !== "class") return false;
  const before = source[index - 1];
  const after = source[index + 5];
  return !isIdentChar(before) && !isIdentChar(after);
}

function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

