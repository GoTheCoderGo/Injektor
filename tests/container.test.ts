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
  InvalidBindingError,
  Scope,
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

    it("should use the scope defined in the @injectable options", () => {
      @injectable({ scope: Scope.Singleton })
      class SingletonWeapon implements IWeapon {
        name = "SingletonWeapon";
      }

      const c = new Container();
      // No explicit scope chained, should use the decorator's scope
      c.bind(WEAPON).to(SingletonWeapon);

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

  // ── Autobinding ──

  describe("autobinding", () => {
    it("should implicitly bind @injectable classes if autoBindInjectable is true", () => {
      @injectable()
      class AutoSword implements IWeapon {
        name = "AutoSword";
      }

      const c = new Container({ autoBindInjectable: true });
      expect(c.isBound(AutoSword)).toBe(false);

      const sword = c.get(AutoSword);
      expect(sword).toBeInstanceOf(AutoSword);
      expect(sword.name).toBe("AutoSword");
      expect(c.isBound(AutoSword)).toBe(true); // Should be bound permanently
    });

    it("should respect explicit scope when autobinding", () => {
      @injectable({ scope: Scope.Singleton })
      class AutoSingleton {
        value = Math.random();
      }

      const c = new Container({ autoBindInjectable: true });
      const s1 = c.get(AutoSingleton);
      const s2 = c.get(AutoSingleton);
      expect(s1).toBe(s2);
    });

    it("should not autobind if autoBindInjectable is false", () => {
      @injectable()
      class AutoFail {}

      const c = new Container();
      expect(() => c.get(AutoFail)).toThrow(ServiceNotFoundError);
    });

    it("should throw ServiceNotFoundError if requested class lacks @injectable() even with autobinding", () => {
      class PlainSword {}

      const c = new Container({ autoBindInjectable: true });
      expect(() => c.get(PlainSword)).toThrow(ServiceNotFoundError);
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

    it("should throw InvalidBindingError when toSelf() is called on non-constructor", () => {
      const c = new Container();
      expect(() => c.bind(WEAPON).toSelf()).toThrow(InvalidBindingError);
    });
  });

  // ── Class Inheritance ──

  describe("inheritance", () => {
    it("subclass property injection should not pollute parent class metadata", () => {
      @injectable()
      class BaseWarrior {
        @inject(WEAPON) accessor weapon!: IWeapon;
      }

      @injectable()
      class SubWarrior extends BaseWarrior {
        @inject(ARMOR) accessor armor!: IArmor;
      }

      const c = new Container();
      c.bind(WEAPON).to(Katana);
      c.bind(ARMOR).to(ChainMail);
      c.bind(BaseWarrior).toSelf();
      c.bind(SubWarrior).toSelf();

      // Base warrior should only have weapon injected
      const base = c.get(BaseWarrior);
      expect(base.weapon.name).toBe("Katana");
      expect((base as any).armor).toBeUndefined();

      // Sub warrior should have both weapon (inherited) and armor injected
      const sub = c.get(SubWarrior);
      expect(sub.weapon.name).toBe("Katana");
      expect(sub.armor.defense).toBe(5);
    });
  });
});

