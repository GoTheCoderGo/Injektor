import { describe, it, expect } from "bun:test";
import {
  Container,
  injectable,
  injectConstructor,
  createToken,
  CircularDependencyError,
  SetResolutionStack,
  ArrayResolutionStack,
} from "../index.ts";
import type { ResolutionStack, ResolutionStrategy } from "../index.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for ResolutionStack implementations
// ─────────────────────────────────────────────────────────────────────────────

describe.each([
  ["SetResolutionStack", () => new SetResolutionStack()],
  ["ArrayResolutionStack", () => new ArrayResolutionStack()],
])("%s", (_name, factory) => {
  it("should start empty with has() returning false", () => {
    const stack = factory();
    expect(stack.has("A")).toBe(false);
    expect(stack.toArray()).toEqual([]);
  });

  it("should contain items after fork()", () => {
    const stack = factory().fork("A").fork("B");
    expect(stack.has("A")).toBe(true);
    expect(stack.has("B")).toBe(true);
    expect(stack.has("C")).toBe(false);
  });

  it("should preserve insertion order in toArray()", () => {
    const stack = factory().fork("A").fork("B").fork("C");
    expect(stack.toArray()).toEqual(["A", "B", "C"]);
  });

  it("fork() should not mutate the original stack", () => {
    const original = factory().fork("A");
    const forked = original.fork("B");

    expect(original.has("B")).toBe(false);
    expect(original.toArray()).toEqual(["A"]);

    expect(forked.has("A")).toBe(true);
    expect(forked.has("B")).toBe(true);
  });

  it("should isolate sibling branches", () => {
    const root = factory().fork("A");
    const branchB = root.fork("B");
    const branchC = root.fork("C");

    expect(branchB.has("C")).toBe(false);
    expect(branchC.has("B")).toBe(false);
    expect(branchB.toArray()).toEqual(["A", "B"]);
    expect(branchC.toArray()).toEqual(["A", "C"]);
  });

  it("should work with symbol identifiers", () => {
    const sym = Symbol("test");
    const stack = factory().fork(sym);
    expect(stack.has(sym)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: Container with resolutionStrategy option
// ─────────────────────────────────────────────────────────────────────────────

interface IWeapon {
  name: string;
}

const WEAPON = createToken<IWeapon>("Weapon");

@injectable()
class Katana implements IWeapon {
  name = "Katana";
}

@injectable()
@injectConstructor(WEAPON)
class Warrior {
  weapon: IWeapon;
  constructor(weapon: IWeapon) {
    this.weapon = weapon;
  }
}

describe.each(["set", "array"] as ResolutionStrategy[])(
  'Container with resolutionStrategy: "%s"',
  (strategy) => {
    it("should resolve dependencies normally", () => {
      const container = new Container({ resolutionStrategy: strategy });
      container.bind(WEAPON).to(Katana);
      container.bind(Warrior).toSelf();

      const warrior = container.get(Warrior);
      expect(warrior).toBeInstanceOf(Warrior);
      expect(warrior.weapon.name).toBe("Katana");
    });

    it("should detect circular dependencies", () => {
      const tokenA = createToken("CycleA");
      const tokenB = createToken("CycleB");

      @injectable()
      @injectConstructor(tokenB)
      class A {
        constructor(_b: any) {}
      }

      @injectable()
      @injectConstructor(tokenA)
      class B {
        constructor(_a: any) {}
      }

      const container = new Container({ resolutionStrategy: strategy });
      container.bind(tokenA).to(A);
      container.bind(tokenB).to(B);

      expect(() => container.get(tokenA)).toThrow(CircularDependencyError);
    });
  },
);

describe("Container defaults", () => {
  it('should default to "array" strategy when no option is provided', () => {
    const container = new Container();
    container.bind(WEAPON).to(Katana);

    // If it resolves, the default strategy works.
    const weapon = container.get(WEAPON);
    expect(weapon.name).toBe("Katana");
  });
});
