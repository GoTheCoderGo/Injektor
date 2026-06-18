import {
  INJECTABLE_KEY,
  CONSTRUCTOR_INJECT_KEY,
  PROPERTY_INJECT_KEY,
} from "./consts.ts";
import {
  ServiceNotFoundError,
  CircularDependencyError,
  NotInjectableError,
} from "./errors.ts";
import { BindingBuilder } from "./binding.ts";
import type {
  Constructor,
  ServiceIdentifier,
  Binding,
  ConstructorInjectMetadata,
  PropertyInjectMetadata,
} from "./types.ts";
import { Scope, BindingType } from "./types.ts";

// Polyfill Symbol.metadata for runtimes that don't yet expose it natively.
// @ts-ignore
Symbol.metadata ??= Symbol.for("Symbol.metadata");

/**
 * The IoC container. Manages bindings and resolves dependencies.
 *
 * @example
 * ```ts
 * const container = new Container();
 * container.bind(WEAPON_TOKEN).to(Katana).inSingletonScope();
 * container.bind(Warrior).toSelf();
 * const warrior = container.get(Warrior);
 * ```
 */
export class Container {
  private _bindings = new Map<ServiceIdentifier, Binding>();

  /**
   * Start configuring a binding for the given service identifier.
   * Returns a fluent `BindingBuilder`.
   */
  bind<T>(id: ServiceIdentifier<T>): BindingBuilder<T> {
    return new BindingBuilder<T>(id, (binding) => {
      this._bindings.set(id, binding as Binding);
    });
  }

  /**
   * Remove the binding for the given service identifier.
   */
  unbind(id: ServiceIdentifier): void {
    this._bindings.delete(id);
  }

  /**
   * Remove any existing binding and return a new `BindingBuilder` for re-binding.
   */
  rebind<T>(id: ServiceIdentifier<T>): BindingBuilder<T> {
    this.unbind(id);
    return this.bind(id);
  }

  /**
   * Check whether a binding exists for the given service identifier.
   */
  isBound(id: ServiceIdentifier): boolean {
    return this._bindings.has(id);
  }

  /**
   * Resolve a dependency by its service identifier.
   *
   * @throws {ServiceNotFoundError} if no binding exists.
   * @throws {CircularDependencyError} if a cycle is detected.
   * @throws {NotInjectableError} if the target class lacks `@injectable()`.
   */
  get<T>(id: ServiceIdentifier<T>): T {
    // Request-scoped cache: shared across a single `get()` call graph.
    const requestCache = new Map<ServiceIdentifier, unknown>();
    return this._resolve<T>(id, [], requestCache);
  }

  // ──────────────────────── Private resolution ────────────────────────

  private _resolve<T>(
    id: ServiceIdentifier<T>,
    resolutionStack: ServiceIdentifier[],
    requestCache: Map<ServiceIdentifier, unknown>,
  ): T {
    // ── Circular dependency detection ──
    if (resolutionStack.includes(id)) {
      throw new CircularDependencyError([...resolutionStack, id]);
    }

    const binding = this._bindings.get(id) as Binding<T> | undefined;
    if (!binding) {
      throw new ServiceNotFoundError(id);
    }

    // ── Constant bindings short-circuit ──
    if (binding.type === BindingType.Constant) {
      return binding.value as T;
    }

    // ── Singleton cache hit ──
    if (binding.scope === Scope.Singleton && binding.cache !== undefined) {
      return binding.cache;
    }

    // ── Request-scope cache hit ──
    if (binding.scope === Scope.Request && requestCache.has(id)) {
      return requestCache.get(id) as T;
    }

    // ── Resolve the value ──
    const nextStack = [...resolutionStack, id];
    let instance: T;

    if (binding.type === BindingType.Factory) {
      instance = binding.factory!();
    } else {
      // BindingType.Instance
      instance = this._createInstance<T>(
        binding.implementationClass!,
        nextStack,
        requestCache,
      );
    }

    // ── Cache by scope ──
    if (binding.scope === Scope.Singleton) {
      binding.cache = instance;
    } else if (binding.scope === Scope.Request) {
      requestCache.set(id, instance);
    }

    return instance;
  }

  /**
   * Instantiate a class, resolving constructor and property dependencies.
   */
  private _createInstance<T>(
    ctor: Constructor<T>,
    resolutionStack: ServiceIdentifier[],
    requestCache: Map<ServiceIdentifier, unknown>,
  ): T {
    // Read decorator metadata from the class.
    const metadata = (ctor as any)[Symbol.metadata];

    if (!metadata || metadata[INJECTABLE_KEY] !== true) {
      throw new NotInjectableError(ctor);
    }

    // ── Resolve constructor arguments ──
    const ctorTokens =
      (metadata[CONSTRUCTOR_INJECT_KEY] as ConstructorInjectMetadata) ?? [];
    const args = ctorTokens.map((token) =>
      this._resolve(token, resolutionStack, requestCache),
    );

    // ── Instantiate ──
    const instance = new ctor(...args);

    // ── Property injection ──
    const propMap =
      (metadata[PROPERTY_INJECT_KEY] as PropertyInjectMetadata) ??
      new Map();
    for (const [fieldName, token] of propMap) {
      const value = this._resolve(token, resolutionStack, requestCache);
      // Auto-accessor fields expose a setter on the instance.
      (instance as any)[fieldName] = value;
    }

    return instance;
  }
}
