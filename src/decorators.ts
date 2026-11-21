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

const accessorKeys = new WeakMap<object, Map<string, Map<string | symbol, symbol>>>();

/** Remember the setter under an identity shared by decorators on this accessor. */
function recordAccessor(context: ClassAccessorDecoratorContext): string | symbol {
  // Public instance accessors retain name-based overriding. Private accessors
  // and static accessors need an identity local to their declaring class.
  let key = context.name;
  if (context.private || context.static) {
    let kinds = accessorKeys.get(context.metadata);
    if (!kinds) accessorKeys.set(context.metadata, kinds = new Map());
    const kind = `${context.static ? "static" : "instance"}:${context.private}`;
    let keys = kinds.get(kind);
    if (!keys) kinds.set(kind, keys = new Map());
    let identity = keys.get(context.name);
    if (!identity) keys.set(context.name, identity = Symbol(String(context.name)));
    key = identity;
  }
  const map = getOwnMap<string | symbol, AccessorInjectInfo>(
    context.metadata,
    ACCESSOR_INJECT_KEY,
  );
  const info: AccessorInjectInfo = {
    set: context.access.set,
    static: context.static,
  };
  if (context.static) {
    context.addInitializer(function (this: unknown) {
      info.home = this as Function;
    });
  }
  map.set(key, info);
  return key;
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
      // Default constructors, including compiler-generated forwarding
      // constructors for decorated fields, reuse the base argument list.
      if (inherited?.length) {
        context.metadata[CONSTRUCTOR_INJECT_KEY] = hasNonForwardingConstructor(ctor) ? [] : [...inherited];
      }
    }
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

    const key = recordAccessor(context);
    const propMap = getOwnMap<string | symbol, ServiceIdentifier>(
      context.metadata,
      PROPERTY_INJECT_KEY,
    );
    if (context.metadata[MULTI_INJECT_KEY]) {
      getOwnMap(context.metadata, MULTI_INJECT_KEY).delete(key);
    }
    propMap.set(key, token);
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

    const key = recordAccessor(context);
    const namedMap = getOwnMap<string | symbol, string>(
      context.metadata,
      NAMED_INJECT_KEY,
    );
    namedMap.set(key, name);
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

    const identity = recordAccessor(context);
    const taggedMap = getOwnMap<string | symbol, Record<string, unknown>>(
      context.metadata,
      TAGGED_INJECT_KEY,
    );
    const existing = taggedMap.get(identity);
    taggedMap.set(identity, { ...existing, [key]: value });
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

    const key = recordAccessor(context);
    const multiMap = getOwnMap<string | symbol, ServiceIdentifier>(
      context.metadata,
      MULTI_INJECT_KEY,
    );
    if (context.metadata[PROPERTY_INJECT_KEY]) {
      getOwnMap(context.metadata, PROPERTY_INJECT_KEY).delete(key);
    }
    multiMap.set(key, token);
  };
}

function hasNonForwardingConstructor(ctor: Function): boolean {
  const source = stripLiteralsAndComments(Function.prototype.toString.call(ctor));
  const body = outermostClassBody(source);
  let brace = 0;
  let paren = 0;
  let bracket = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (brace === 0 && paren === 0 && bracket === 0 &&
        body.startsWith("constructor", i) && /^constructor\s*\(/.test(body.slice(i))) {
      const prefix = body.slice(0, i);
      // Ignore calls in field initializers and static methods named constructor.
      if (/(?:^|[;}\n])\s*$/.test(prefix) && !/\bstatic\s*$/.test(prefix)) {
        const open = body.indexOf("(", i);
        const close = closingDelimiter(body, open, "(", ")");
        const params = body.slice(open + 1, close).trim();
        const rest = params.match(/^\.\.\.\s*([\w$]+)$/)?.[1];
        const forwarded = params === "" ? "arguments" : rest;
        const start = body.slice(close + 1).match(/^\s*\{\s*super\s*\(\s*\.\.\.\s*([\w$]+)\s*\)/);
        return !forwarded || start?.[1] !== forwarded;
      }
    }
    if (ch === "{") brace++;
    else if (ch === "}") brace--;
    else if (ch === "(") paren++;
    else if (ch === ")") paren--;
    else if (ch === "[") bracket++;
    else if (ch === "]") bracket--;
  }
  return false;
}

function closingDelimiter(source: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === open) depth++;
    else if (source[i] === close && --depth === 0) return i;
  }
  return source.length;
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
    if (ch === "/" && canStartRegex(out)) {
      const end = regexLiteralEnd(source, i);
      if (end !== undefined) {
        i = end;
        out += "0";
        continue;
      }
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

/** A slash following an operand is division. Literals and comments are already masked. */
function canStartRegex(prefix: string): boolean {
  const before = prefix.trimEnd();
  if (before.endsWith("++") || before.endsWith("--")) return false;
  if (before.endsWith(")")) {
    const preceding = beforeDelimiter(before, "(", ")");
    return /(?:^|[^\w$.])(?:if|while|for|with)\s*$/.test(preceding);
  }
  if (before.endsWith("}")) {
    const preceding = beforeDelimiter(before, "{", "}").trimEnd();
    return /(?:[;{}):]|\b(?:else|try|finally|do))$/.test(preceding);
  }
  return !before || /[=({\[!,:;?&|+*%^~<>\/-]$/.test(before) ||
    /\b(?:return|throw|case|yield|await|void|typeof|delete|instanceof|in|of|else|do)$/.test(before);
}

/** Return the text before the opening delimiter matching the final character. */
function beforeDelimiter(source: string, open: string, close: string): string {
  let depth = 1;
  for (let i = source.length - 2; i >= 0; i--) {
    if (source[i] === close) depth++;
    if (source[i] === open && --depth === 0) return source.slice(0, i);
  }
  return "";
}

function regexLiteralEnd(source: string, start: number): number | undefined {
  let inClass = false;
  for (let i = start + 1; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\n" || ch === "\r") return undefined;
    if (ch === "\\") i++;
    else if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) return i;
  }
  return undefined;
}

function outermostClassBody(source: string): string {
  const ranges = classBodyRanges(source);
  const outer = ranges[ranges.length - 1];
  if (!outer) return source;
  return source.slice(outer.start, outer.end);
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

