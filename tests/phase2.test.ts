import { describe, it, expect } from "bun:test";
import {
  Container,
  ContainerModule,
  injectable,
  inject,
  injectConstructor,
  named,
  tagged,
  multiInject,
  createToken,
  ServiceNotFoundError,
  AmbiguousBindingError,
  AsyncBindingError,
} from "../index.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixtures
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
class Shuriken implements IWeapon {
  name = "Shuriken";
}

@injectable()
class Nunchaku implements IWeapon {
  name = "Nunchaku";
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 6: Container Modules
// ─────────────────────────────────────────────────────────────────────────────

describe("ContainerModule", () => {
  it("should load bindings from a module", () => {
    const weaponModule = new ContainerModule((bind) => {
      bind(WEAPON).to(Katana);
    });

    const c = new Container();
    c.load(weaponModule);

    const weapon = c.get(WEAPON);
    expect(weapon.name).toBe("Katana");
  });

  it("should unload bindings added by a module", () => {
    const weaponModule = new ContainerModule((bind) => {
      bind(WEAPON).to(Katana);
    });

    const c = new Container();
    c.load(weaponModule);
    expect(c.isBound(WEAPON)).toBe(true);

    c.unload(weaponModule);
    expect(c.isBound(WEAPON)).toBe(false);
  });

  it("should not affect bindings from other modules on unload", () => {
    const TOKEN_A = createToken<string>("A");
    const TOKEN_B = createToken<string>("B");

    const modA = new ContainerModule((bind) => {
      bind(TOKEN_A).toConstant("A");
    });
    const modB = new ContainerModule((bind) => {
      bind(TOKEN_B).toConstant("B");
    });

    const c = new Container();
    c.load(modA);
    c.load(modB);

    c.unload(modA);
    expect(c.isBound(TOKEN_A)).toBe(false);
    expect(c.get(TOKEN_B)).toBe("B");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 7: Named & Tagged Bindings
// ─────────────────────────────────────────────────────────────────────────────

describe("Named bindings", () => {
  it("should resolve by name with getNamed()", () => {
    const c = new Container();
    c.bind(WEAPON).to(Katana).whenNamed("melee");
    c.bind(WEAPON).to(Shuriken).whenNamed("ranged");

    expect(c.getNamed(WEAPON, "melee").name).toBe("Katana");
    expect(c.getNamed(WEAPON, "ranged").name).toBe("Shuriken");
  });

  it("should throw AmbiguousBindingError for get() with multiple bindings", () => {
    const c = new Container();
    c.bind(WEAPON).to(Katana).whenNamed("melee");
    c.bind(WEAPON).to(Shuriken).whenNamed("ranged");

    expect(() => c.get(WEAPON)).toThrow(AmbiguousBindingError);
  });

  it("should throw ServiceNotFoundError for non-existent name", () => {
    const c = new Container();
    c.bind(WEAPON).to(Katana).whenNamed("melee");

    expect(() => c.getNamed(WEAPON, "magic")).toThrow(ServiceNotFoundError);
  });

  it("should inject named dependencies via @named decorator", () => {
    @injectable()
    class DualWielder {
      @inject(WEAPON) @named("melee") accessor primary!: IWeapon;
      @inject(WEAPON) @named("ranged") accessor secondary!: IWeapon;
    }

    const c = new Container();
    c.bind(WEAPON).to(Katana).whenNamed("melee");
    c.bind(WEAPON).to(Shuriken).whenNamed("ranged");
    c.bind(DualWielder).toSelf();

    const wielder = c.get(DualWielder);
    expect(wielder.primary.name).toBe("Katana");
    expect(wielder.secondary.name).toBe("Shuriken");
  });
});

describe("Tagged bindings", () => {
  it("should resolve by tag with getTagged()", () => {
    const c = new Container();
    c.bind(WEAPON).to(Katana).whenTagged("tier", "common");
    c.bind(WEAPON).to(Shuriken).whenTagged("tier", "rare");

    expect(c.getTagged(WEAPON, "tier", "common").name).toBe("Katana");
    expect(c.getTagged(WEAPON, "tier", "rare").name).toBe("Shuriken");
  });

  it("should inject tagged dependencies via @tagged decorator", () => {
    @injectable()
    class TaggedWarrior {
      @inject(WEAPON) @tagged("tier", "rare") accessor weapon!: IWeapon;
    }

    const c = new Container();
    c.bind(WEAPON).to(Katana).whenTagged("tier", "common");
    c.bind(WEAPON).to(Shuriken).whenTagged("tier", "rare");
    c.bind(TaggedWarrior).toSelf();

    const warrior = c.get(TaggedWarrior);
    expect(warrior.weapon.name).toBe("Shuriken");
  });

  it("should support multiple tags on a binding", () => {
    const c = new Container();
    c.bind(WEAPON).to(Katana).whenTagged("tier", "legendary").whenTagged("type", "melee");
    c.bind(WEAPON).to(Shuriken).whenTagged("tier", "legendary").whenTagged("type", "ranged");

    expect(c.getTagged(WEAPON, "type", "melee").name).toBe("Katana");
    expect(c.getTagged(WEAPON, "type", "ranged").name).toBe("Shuriken");
  });
});

describe("Named + Tagged in @injectConstructor", () => {
  it("should resolve named constructor args via InjectDescriptor", () => {
    @injectable()
    @injectConstructor(
      { token: WEAPON, named: "melee" },
      { token: WEAPON, named: "ranged" },
    )
    class DualWielder {
      constructor(public melee: IWeapon, public ranged: IWeapon) {}
    }

    const c = new Container();
    c.bind(WEAPON).to(Katana).whenNamed("melee");
    c.bind(WEAPON).to(Shuriken).whenNamed("ranged");
    c.bind(DualWielder).toSelf();

    const wielder = c.get(DualWielder);
    expect(wielder.melee.name).toBe("Katana");
    expect(wielder.ranged.name).toBe("Shuriken");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 8: Multi-injection
// ─────────────────────────────────────────────────────────────────────────────

describe("Multi-injection", () => {
  it("should resolve all bindings with getAll()", () => {
    const c = new Container();
    c.bind(WEAPON).to(Katana);
    c.bind(WEAPON).to(Shuriken);
    c.bind(WEAPON).to(Nunchaku);

    const weapons = c.getAll(WEAPON);
    expect(weapons).toHaveLength(3);
    const names = weapons.map((w) => w.name).sort();
    expect(names).toEqual(["Katana", "Nunchaku", "Shuriken"]);
  });

  it("should inject all bindings via @multiInject decorator", () => {
    @injectable()
    class Arsenal {
      @multiInject(WEAPON) accessor weapons!: IWeapon[];
    }

    const c = new Container();
    c.bind(WEAPON).to(Katana);
    c.bind(WEAPON).to(Shuriken);
    c.bind(Arsenal).toSelf();

    const arsenal = c.get(Arsenal);
    expect(arsenal.weapons).toHaveLength(2);
    const names = arsenal.weapons.map((w) => w.name).sort();
    expect(names).toEqual(["Katana", "Shuriken"]);
  });

  it("should support multi-inject in @injectConstructor via descriptor", () => {
    @injectable()
    @injectConstructor({ token: WEAPON, multi: true })
    class Arsenal {
      constructor(public weapons: IWeapon[]) {}
    }

    const c = new Container();
    c.bind(WEAPON).to(Katana);
    c.bind(WEAPON).to(Shuriken);
    c.bind(Arsenal).toSelf();

    const arsenal = c.get(Arsenal);
    expect(arsenal.weapons).toHaveLength(2);
  });

  it("should throw ServiceNotFoundError for getAll() with no bindings", () => {
    const c = new Container();
    expect(() => c.getAll(WEAPON)).toThrow(ServiceNotFoundError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 9: Async resolution
// ─────────────────────────────────────────────────────────────────────────────

describe("Async resolution", () => {
  it("should resolve async factory bindings via getAsync()", async () => {
    const c = new Container();
    c.bind(WEAPON).toAsyncFactory(async () => {
      // Simulate async work
      await new Promise((r) => setTimeout(r, 10));
      return new Katana();
    });

    const weapon = await c.getAsync(WEAPON);
    expect(weapon.name).toBe("Katana");
  });

  it("should throw AsyncBindingError when trying to get() an async factory synchronously", () => {
    const c = new Container();
    c.bind(WEAPON).toAsyncFactory(async () => new Katana());

    expect(() => c.get(WEAPON)).toThrow(AsyncBindingError);
  });

  it("should resolve sync bindings via getAsync() too", async () => {
    const c = new Container();
    c.bind(WEAPON).to(Katana);

    const weapon = await c.getAsync(WEAPON);
    expect(weapon.name).toBe("Katana");
  });

  it("should cache async singleton", async () => {
    let callCount = 0;
    const c = new Container();
    c.bind(WEAPON)
      .toAsyncFactory(async () => {
        callCount++;
        return new Katana();
      })
      .inSingletonScope();

    const w1 = await c.getAsync(WEAPON);
    const w2 = await c.getAsync(WEAPON);
    expect(w1).toBe(w2);
    expect(callCount).toBe(1);
  });

  it("should prevent async singleton race conditions during concurrent resolutions", async () => {
    let callCount = 0;
    const c = new Container();
    c.bind(WEAPON)
      .toAsyncFactory(async () => {
        callCount++;
        await new Promise((r) => setTimeout(r, 10));
        return new Katana();
      })
      .inSingletonScope();

    // Fire 5 concurrent resolutions
    const [w1, w2, w3, w4, w5] = await Promise.all([
      c.getAsync(WEAPON),
      c.getAsync(WEAPON),
      c.getAsync(WEAPON),
      c.getAsync(WEAPON),
      c.getAsync(WEAPON),
    ]);

    expect(w1).toBe(w2);
    expect(w2).toBe(w3);
    expect(w3).toBe(w4);
    expect(w4).toBe(w5);
    expect(callCount).toBe(1);
  });

  it("should resolve getNamedAsync and getTaggedAsync", async () => {
    const c = new Container();
    c.bind(WEAPON)
      .toAsyncFactory(async () => new Katana())
      .whenNamed("melee");
    c.bind(WEAPON)
      .toAsyncFactory(async () => new Shuriken())
      .whenTagged("range", "far");

    const melee = await c.getNamedAsync(WEAPON, "melee");
    expect(melee.name).toBe("Katana");

    const ranged = await c.getTaggedAsync(WEAPON, "range", "far");
    expect(ranged.name).toBe("Shuriken");
  });

  it("should resolve getAllAsync with mixed sync and async factories", async () => {
    const c = new Container();
    c.bind(WEAPON).to(Katana);
    c.bind(WEAPON).toAsyncFactory(async () => new Shuriken());

    const all = await c.getAllAsync(WEAPON);
    expect(all).toHaveLength(2);
    const names = all.map((w) => w.name).sort();
    expect(names).toEqual(["Katana", "Shuriken"]);
  });

  it("should support @multiInject with async factories via getAsync", async () => {
    @injectable()
    class AsyncArsenal {
      @multiInject(WEAPON) accessor weapons!: IWeapon[];
    }

    const c = new Container();
    c.bind(WEAPON).to(Katana);
    c.bind(WEAPON).toAsyncFactory(async () => new Shuriken());
    c.bind(AsyncArsenal).toSelf();

    const arsenal = await c.getAsync(AsyncArsenal);
    expect(arsenal.weapons).toHaveLength(2);
    const names = arsenal.weapons.map((w) => w.name).sort();
    expect(names).toEqual(["Katana", "Shuriken"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 10: Hierarchical containers
// ─────────────────────────────────────────────────────────────────────────────

describe("Hierarchical containers", () => {
  it("child should resolve bindings from parent", () => {
    const parent = new Container();
    parent.bind(WEAPON).to(Katana);

    const child = new Container({ parent });
    const weapon = child.get(WEAPON);
    expect(weapon.name).toBe("Katana");
  });

  it("child bindings should shadow parent for get() without throwing ambiguous error", () => {
    const parent = new Container();
    parent.bind(WEAPON).to(Katana);

    const child = new Container({ parent });
    child.bind(WEAPON).to(Shuriken);

    // Child gets Shuriken (child shadows parent)
    expect(child.get(WEAPON).name).toBe("Shuriken");
    // Parent still gets Katana
    expect(parent.get(WEAPON).name).toBe("Katana");
    // Child getAll gets both
    const allWeapons = child.getAll(WEAPON);
    expect(allWeapons).toHaveLength(2);
  });

  it("child should fall back to parent for getNamed when child has no matching name", () => {
    const parent = new Container();
    parent.bind(WEAPON).to(Katana).whenNamed("melee");

    const child = new Container({ parent });
    child.bind(WEAPON).to(Shuriken).whenNamed("ranged");

    expect(child.getNamed(WEAPON, "ranged").name).toBe("Shuriken");
    expect(child.getNamed(WEAPON, "melee").name).toBe("Katana");
  });

  it("isBound should check parent chain", () => {
    const parent = new Container();
    parent.bind(WEAPON).to(Katana);

    const child = new Container({ parent });
    expect(child.isBound(WEAPON)).toBe(true);

    const TOKEN = createToken("missing");
    expect(child.isBound(TOKEN)).toBe(false);
  });

  it("child unbind should not affect parent", () => {
    const parent = new Container();
    parent.bind(WEAPON).to(Katana);

    const child = new Container({ parent });
    child.unbind(WEAPON); // Nothing to unbind locally

    // Parent still has it
    expect(parent.isBound(WEAPON)).toBe(true);
    // Child can still resolve from parent
    expect(child.get(WEAPON).name).toBe("Katana");
  });

  it("grandchild should resolve through parent chain", () => {
    const grandparent = new Container();
    grandparent.bind(WEAPON).to(Katana);

    const parent = new Container({ parent: grandparent });
    const child = new Container({ parent });

    expect(child.get(WEAPON).name).toBe("Katana");
  });
});
