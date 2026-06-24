import type { ServiceIdentifier } from "./types.ts";

// ─── Interface ──────────────────────────────────────────────────────────────

/**
 * An immutable stack of service identifiers used during dependency resolution.
 *
 * Tracks the current resolution path for circular-dependency detection.
 * Every call to `fork()` returns a **new** stack, leaving the original unmodified
 * so that sibling branches in the dependency graph are isolated.
 */
export interface ResolutionStack {
  /**
   * Check whether the given identifier is already on the stack.
   * Used for circular-dependency detection.
   */
  has(id: ServiceIdentifier): boolean;

  /**
   * Create a new `ResolutionStack` that contains all entries of this stack
   * plus `id` appended at the end.
   */
  fork(id: ServiceIdentifier): ResolutionStack;

  /**
   * Return the stack contents as an ordered array.
   * Useful for building error messages (e.g. `CircularDependencyError`).
   */
  toArray(): ServiceIdentifier[];
}

// ─── Resolution Stack Strategy ──────────────────────────────────────────────

/**
 * Identifies which `ResolutionStack` implementation the container should use.
 *
 * - `"set"` — backed by a `Set`; O(1) `has()` lookups, slightly heavier fork cost.
 * - `"array"` — backed by an array; O(n) `has()` lookups, lighter fork cost.
 */
export type ResolutionStrategy = "set" | "array";

// ─── Set Implementation ─────────────────────────────────────────────────────

/**
 * `ResolutionStack` backed by a `Set<ServiceIdentifier>`.
 *
 * Provides **O(1)** cycle detection via `Set.has()`.
 * Preserves insertion order (guaranteed by the ES spec) for error-path output.
 */
export class SetResolutionStack implements ResolutionStack {
  private readonly _set: Set<ServiceIdentifier>;

  constructor(set?: Set<ServiceIdentifier>) {
    this._set = set ?? new Set();
  }

  /** @inheritdoc */
  has(id: ServiceIdentifier): boolean {
    return this._set.has(id);
  }

  /** @inheritdoc */
  fork(id: ServiceIdentifier): SetResolutionStack {
    return new SetResolutionStack(new Set(this._set).add(id));
  }

  /** @inheritdoc */
  toArray(): ServiceIdentifier[] {
    return [...this._set];
  }
}

// ─── Array Implementation ───────────────────────────────────────────────────

/**
 * `ResolutionStack` backed by a plain `ServiceIdentifier[]`.
 *
 * Uses **O(n)** `Array.includes()` for cycle detection but has a marginally
 * cheaper fork cost since it avoids the `Set` constructor overhead.
 */
export class ArrayResolutionStack implements ResolutionStack {
  private readonly _arr: ServiceIdentifier[];

  constructor(arr?: ServiceIdentifier[]) {
    this._arr = arr ?? [];
  }

  /** @inheritdoc */
  has(id: ServiceIdentifier): boolean {
    return this._arr.includes(id);
  }

  /** @inheritdoc */
  fork(id: ServiceIdentifier): ArrayResolutionStack {
    return new ArrayResolutionStack([...this._arr, id]);
  }

  /** @inheritdoc */
  toArray(): ServiceIdentifier[] {
    return [...this._arr];
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a fresh, empty `ResolutionStack` for the chosen strategy.
 */
export function createResolutionStack(
  strategy: ResolutionStrategy,
): ResolutionStack {
  switch (strategy) {
    case "set":
      return new SetResolutionStack();
    case "array":
      return new ArrayResolutionStack();
  }
}
