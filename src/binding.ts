import type { Constructor, ServiceIdentifier, Binding, ResolutionContext } from "./types.ts";
import { Scope, BindingType } from "./types.ts";
import { getInjectableMetadata, SCOPE_KEY } from "./consts.ts";
import { InvalidBindingError } from "./errors.ts";

type BindingTarget<T> = Pick<Binding<T>, "type" | "implementationClass" | "value" | "factory" | "asyncFactory">;

/**
 * Fluent API builder for configuring a binding.
 * Returned by `container.bind()`.
 *
 * @example
 * ```ts
 * container.bind(WEAPON_TOKEN).to(Katana).inSingletonScope();
 * container.bind(CONFIG).toConstant({ debug: true });
 * container.bind(WEAPON_TOKEN).toFactory(() => new Katana());
 * container.bind(WEAPON_TOKEN).toAsyncFactory(async () => new Katana());
 * container.bind(Katana).toSelf();
 * container.bind(WEAPON_TOKEN).to(Katana).whenNamed("katana");
 * container.bind(WEAPON_TOKEN).to(Katana).whenTagged("tier", "legendary");
 * ```
 */
export class BindingBuilder<T> {
  private _binding: Binding<T>;
  private _committed = false;
  /** Set when the caller picks a scope, so a later `to()` does not replace it. */
  private _scopeExplicit = false;

  constructor(
    id: ServiceIdentifier<T>,
    private readonly _onComplete: (binding: Binding<T>) => void,
    private readonly _onReplace?: (previous: Binding<T>, next: Binding<T>) => void,
  ) {
    this._binding = {
      id,
      type: BindingType.Instance,
      scope: Scope.Transient,
    };
  }

  // ─────────────────────── Target methods ───────────────────────

  /**
   * Bind the identifier to a concrete implementation class.
   */
  to(impl: Constructor<T>): this {
    const metadata = this._scopeExplicit ? undefined : getInjectableMetadata(impl);
    const scope = metadata && Object.hasOwn(metadata, SCOPE_KEY) ? metadata[SCOPE_KEY] as Scope : undefined;
    return this._setTarget({ type: BindingType.Instance, implementationClass: impl }, scope);
  }

  /**
   * Bind the identifier to itself (the identifier must be a class constructor).
   */
  toSelf(): this {
    const id = this._binding.id;
    if (typeof id !== "function") {
      throw new InvalidBindingError(
        `toSelf() can only be used when the service identifier is a class constructor.`
      );
    }
    return this.to(id as Constructor<T>);
  }

  /**
   * Bind the identifier to a constant value. Always singleton-scoped.
   */
  toConstant(value: T): this {
    return this._setTarget({ type: BindingType.Constant, value }, Scope.Singleton);
  }

  /**
   * Bind the identifier to a synchronous factory function.
   * The provided resolver shares the current dependency graph.
   */
  toFactory(factory: (context: ResolutionContext) => T): this {
    return this._setTarget({ type: BindingType.Factory, factory });
  }

  /**
   * Bind the identifier to an asynchronous factory function.
   * Must be resolved via `container.getAsync()`.
   * Use the provided resolver for dependency lookups after `await` in browsers.
   */
  toAsyncFactory(factory: (context: ResolutionContext) => Promise<T>): this {
    return this._setTarget({ type: BindingType.AsyncFactory, asyncFactory: factory });
  }

  // ─────────────────────── Scope methods ────────────────────────

  /**
   * Set the binding scope to Singleton.
   * The same instance is reused for every resolution.
   */
  inSingletonScope(): this {
    this._binding.scope = Scope.Singleton;
    this._scopeExplicit = true;
    return this;
  }

  /**
   * Set the binding scope to Transient (default).
   * A new instance is created for every resolution.
   */
  inTransientScope(): this {
    this._binding.scope = Scope.Transient;
    this._scopeExplicit = true;
    return this;
  }

  /**
   * Set the binding scope to Request.
   * A single instance is shared within one `container.get()` call graph.
   */
  inRequestScope(): this {
    this._binding.scope = Scope.Request;
    this._scopeExplicit = true;
    return this;
  }

  // ─────────────────────── Constraint methods ───────────────────

  /**
   * Assign a name to this binding for disambiguation.
   * Resolve via `container.getNamed()` or `@named()` decorator.
   */
  whenNamed(name: string): this {
    this._binding.name = name;
    return this;
  }

  /**
   * Assign a tag to this binding for conditional resolution.
   * Resolve via `container.getTagged()` or `@tagged()` decorator.
   */
  whenTagged(key: string, value: unknown): this {
    const tags: Record<string, unknown> = this._binding.tags ??= Object.create(null);
    tags[key] = value;
    return this;
  }

  // ─────────────────────── Internal ─────────────────────────────

  /** Publish a complete target. Old resolutions keep their original binding and cache. */
  private _setTarget(target: BindingTarget<T>, scope = this._binding.scope): this {
    const previous = this._binding;
    const { id, name, tags } = previous;
    const next: Binding<T> = { id, scope, name, tags, ...target };
    if (!this._committed) {
      this._binding = next;
      this._onComplete(next);
      this._committed = true;
    } else if (this._onReplace) {
      this._onReplace(previous, next);
      this._binding = next;
    } else {
      // A standalone builder's one-argument callback retains the original object.
      delete previous.implementationClass;
      delete previous.value;
      delete previous.factory;
      delete previous.asyncFactory;
      delete previous.cache;
      delete previous.cached;
      delete previous.pendingPromise;
      Object.assign(previous, next);
    }
    return this;
  }
}
