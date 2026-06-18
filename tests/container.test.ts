import { describe, it, expect } from "bun:test";
import {
  Container,
  injectable,
  inject,
  injectConstructor,
  createToken,
  ServiceNotFoundError,
  CircularDependencyError,
  NotInjectableError,
  InvalidDecoratorUsageError,
  AmbiguousBindingError,
} from "../index.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

interface IWeapon {
  name: string;
}

interface IArmor {
  defense: number;
}

const WEAPON = createToken<IWeapon>("Weapon");
const ARMOR = createToken<IArmor>("Armor");
const GREETING = createToken<string>("Greeting");

@injectable()
class Katana implements IWeapon {
  name = "Katana";
}

@injectable()
class Shuriken implements IWeapon {
  name = "Shuriken";
}

@injectable()
class ChainMail implements IArmor {
  defense = 5;
}

@injectable()
@injectConstructor(WEAPON)
class ConstructorWarrior {
  weapon: IWeapon;
  constructor(weapon: IWeapon) {
    this.weapon = weapon;
  }
}

@injectable()
class PropertyWarrior {
  @inject(WEAPON) accessor weapon!: IWeapon;
}

@injectable()
@injectConstructor(WEAPON)
class MixedWarrior {
  @inject(ARMOR) accessor armor!: IArmor;

  weapon: IWeapon;
  constructor(weapon: IWeapon) {
    this.weapon = weapon;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Container", () => {
  // ── Basic binding & resolution ──

  describe("bind / get", () => {
    it("should resolve a token bound to a class", () => {
      const c = new Container();
      c.bind(WEAPON).to(Katana);

      const weapon = c.get(WEAPON);
      expect(weapon.name).toBe("Katana");
    });

    it("should resolve a class bound to itself via toSelf()", () => {
      const c = new Container();
      c.bind(Katana).toSelf();

      const katana = c.get(Katana);
      expect(katana).toBeInstanceOf(Katana);
      expect(katana.name).toBe("Katana");
    });

    it("should resolve a constant value", () => {
      const c = new Container();
      c.bind(GREETING).toConstant("Hello!");

      expect(c.get(GREETING)).toBe("Hello!");
    });

    it("should resolve a factory binding", () => {
      let callCount = 0;
      const c = new Container();
      c.bind(WEAPON).toFactory(() => {
        callCount++;
        return new Katana();
      });

      const w1 = c.get(WEAPON);
      const w2 = c.get(WEAPON);
      expect(w1.name).toBe("Katana");
      expect(callCount).toBe(2); // factory called each time (transient)
    });
  });

  // ── Constructor injection ──

  describe("@injectConstructor", () => {
    it("should inject constructor dependencies", () => {
      const c = new Container();
      c.bind(WEAPON).to(Katana);
      c.bind(ConstructorWarrior).toSelf();

      const warrior = c.get(ConstructorWarrior);
      expect(warrior.weapon.name).toBe("Katana");
    });
  });

  // ── Property injection ──

  describe("@inject (property)", () => {
    it("should inject auto-accessor properties", () => {
      const c = new Container();
      c.bind(WEAPON).to(Katana);
      c.bind(PropertyWarrior).toSelf();

      const warrior = c.get(PropertyWarrior);
      expect(warrior.weapon.name).toBe("Katana");
    });
  });

  // ── Mixed injection ──

  describe("mixed constructor + property injection", () => {
    it("should inject both constructor args and properties", () => {
      const c = new Container();
      c.bind(WEAPON).to(Katana);
      c.bind(ARMOR).to(ChainMail);
      c.bind(MixedWarrior).toSelf();

      const warrior = c.get(MixedWarrior);
      expect(warrior.weapon.name).toBe("Katana");
      expect(warrior.armor.defense).toBe(5);
    });
  });

  // ── Scopes ──

  describe("scopes", () => {
    it("transient scope should create new instances each time", () => {
      const c = new Container();
      c.bind(WEAPON).to(Katana).inTransientScope();

      const w1 = c.get(WEAPON);
      const w2 = c.get(WEAPON);
      expect(w1).not.toBe(w2);
    });

    it("singleton scope should return the same instance", () => {
      const c = new Container();
      c.bind(WEAPON).to(Katana).inSingletonScope();

      const w1 = c.get(WEAPON);
      const w2 = c.get(WEAPON);
      expect(w1).toBe(w2);
    });

    it("request scope should share instances within one get() call", () => {
      const SHARED = createToken<IWeapon>("SharedWeapon");
      const A_ID = createToken<any>("A_ID");
      const B_ID = createToken<any>("B_ID");

      @injectable()
      @injectConstructor(SHARED)
      class HolderA {
        constructor(public weapon: IWeapon) {}
      }

      @injectable()
      @injectConstructor(SHARED)
      class HolderB {
        constructor(public weapon: IWeapon) {}
      }

      @injectable()
      @injectConstructor(A_ID, B_ID)
      class RootActual {
        constructor(public a: HolderA, public b: HolderB) {}
      }

      const c = new Container();
      c.bind(SHARED).to(Katana).inRequestScope();
      c.bind(A_ID).to(HolderA);
      c.bind(B_ID).to(HolderB);
      c.bind(RootActual).toSelf();

      const root = c.get(RootActual);
      // Both holders should share the same weapon within this single get() call
      expect(root.a.weapon).toBe(root.b.weapon);

      // But a separate get() call should produce a different weapon
      const root2 = c.get(RootActual);
      expect(root2.a.weapon).not.toBe(root.a.weapon);
    });
  });

  // ── Container methods ──

  describe("isBound / unbind / rebind", () => {
    it("isBound returns true for registered bindings", () => {
      const c = new Container();
      expect(c.isBound(WEAPON)).toBe(false);
      c.bind(WEAPON).to(Katana);
      expect(c.isBound(WEAPON)).toBe(true);
    });

    it("unbind removes the binding", () => {
      const c = new Container();
      c.bind(WEAPON).to(Katana);
      c.unbind(WEAPON);
      expect(c.isBound(WEAPON)).toBe(false);
    });

    it("rebind replaces the binding", () => {
      const c = new Container();
      c.bind(WEAPON).to(Katana);
      c.rebind(WEAPON).to(Shuriken);

      const w = c.get(WEAPON);
      expect(w.name).toBe("Shuriken");
    });
  });

  // ── Error handling ──

  describe("error handling", () => {
    it("should throw ServiceNotFoundError for unknown tokens", () => {
      const c = new Container();
      expect(() => c.get(WEAPON)).toThrow(ServiceNotFoundError);
    });

    it("should throw NotInjectableError for un-decorated classes", () => {
      class PlainClass {}

      const TOKEN = createToken<PlainClass>("Plain");
      const c = new Container();
      c.bind(TOKEN).to(PlainClass);

      expect(() => c.get(TOKEN)).toThrow(NotInjectableError);
    });

    it("should throw CircularDependencyError on cycles", () => {
      const TOKEN_A = createToken("A");
      const TOKEN_B = createToken("B");

      @injectable()
      @injectConstructor(TOKEN_B)
      class A {
        constructor(public b: any) {}
      }

      @injectable()
      @injectConstructor(TOKEN_A)
      class B {
        constructor(public a: any) {}
      }

      const c = new Container();
      c.bind(TOKEN_A).to(A);
      c.bind(TOKEN_B).to(B);

      expect(() => c.get(TOKEN_A)).toThrow(CircularDependencyError);
    });

    it("should throw InvalidDecoratorUsageError for wrong decorator targets", () => {
      expect(() => {
        // @ts-expect-error — deliberately wrong usage for testing
        @inject(WEAPON)
        class Bad {}
      }).toThrow(InvalidDecoratorUsageError);
    });
  });
});
