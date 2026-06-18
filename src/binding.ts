import type { Constructor, ServiceIdentifier, Binding } from "./types.ts";
import { Scope, BindingType } from "./types.ts";

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
  private readonly _binding: Binding<T>;
  private _committed = false;

  constructor(
    id: ServiceIdentifier<T>,
    private readonly _onComplete: (binding: Binding<T>) => void,
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
    this._binding.type = BindingType.Instance;
    this._binding.implementationClass = impl;
    this._commitOnce();
    return this;
  }

  /**
   * Bind the identifier to itself (the identifier must be a class constructor).
   */
  toSelf(): this {
    const id = this._binding.id;
    if (typeof id !== "function") {
      throw new Error(
        `toSelf() can only be used when the service identifier is a class constructor.`
      );
    }
    return this.to(id as Constructor<T>);
  }

  /**
   * Bind the identifier to a constant value. Always singleton-scoped.
   */
  toConstant(value: T): this {
    this._binding.type = BindingType.Constant;
    this._binding.scope = Scope.Singleton;
    this._binding.value = value;
    this._commitOnce();
    return this;
  }

  /**
   * Bind the identifier to a synchronous factory function.
   */
  toFactory(factory: () => T): this {
    this._binding.type = BindingType.Factory;
    this._binding.factory = factory;
    this._commitOnce();
    return this;
  }

  /**
   * Bind the identifier to an asynchronous factory function.
   * Must be resolved via `container.getAsync()`.
   */
  toAsyncFactory(factory: () => Promise<T>): this {
    this._binding.type = BindingType.AsyncFactory;
    this._binding.asyncFactory = factory;
    this._commitOnce();
    return this;
  }

  // ─────────────────────── Scope methods ────────────────────────

  /**
   * Set the binding scope to Singleton.
   * The same instance is reused for every resolution.
   */
  inSingletonScope(): this {
    this._binding.scope = Scope.Singleton;
    return this;
  }

  /**
   * Set the binding scope to Transient (default).
   * A new instance is created for every resolution.
   */
  inTransientScope(): this {
    this._binding.scope = Scope.Transient;
    return this;
  }

  /**
   * Set the binding scope to Request.
   * A single instance is shared within one `container.get()` call graph.
   */
  inRequestScope(): this {
    this._binding.scope = Scope.Request;
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
    this._binding.tags ??= {};
    this._binding.tags[key] = value;
    return this;
  }

  // ─────────────────────── Internal ─────────────────────────────

  /**
   * Register the binding with the container exactly once.
   * Subsequent mutations (scope, name, tags) act on the same binding
   * object by reference — no re-registration needed.
   */
  private _commitOnce(): void {
    if (!this._committed) {
      this._onComplete(this._binding);
      this._committed = true;
    }
  }
}
