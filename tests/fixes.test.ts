import { describe, it, expect } from "bun:test";
import {
  Container,
  ContainerModule,
  injectable,
  inject,
  injectConstructor,
  named,
  multiInject,
  createToken,
  ServiceNotFoundError,
  CircularDependencyError,
  InvalidBindingError,
  Scope,
} from "../index.ts";

interface Weapon {
  name: string;
}

const WEAPON = createToken<Weapon>("Weapon");
const CONFIG = createToken<string>("Config");

@injectable()
class Katana implements Weapon {
  name = "Katana";
}

@injectable()
class Shuriken implements Weapon {
  name = "Shuriken";
}

describe("resolution context", () => {
  it("throws CircularDependencyError when a factory resolves itself", () => {
    const TOKEN = createToken<Weapon>("Loop");
    const c = new Container();
    c.bind(TOKEN).toFactory(() => c.get(TOKEN));
    expect(() => c.get(TOKEN)).toThrow(CircularDependencyError);
  });

  it("throws CircularDependencyError when a constructor resolves itself", () => {
    const c = new Container();
    @injectable()
    class Loop {
      constructor() {
        c.get(Loop);
      }
    }
    c.bind(Loop).toSelf().inSingletonScope();
    expect(() => c.get(Loop)).toThrow(CircularDependencyError);
  });

  it("shares request scope with factories that call back into the container", () => {
    const SHARED = createToken<Weapon>("Shared");
    const c = new Container();
    c.bind(SHARED).to(Katana).inRequestScope();

    const FACTORY = createToken<Weapon>("Factory");
    c.bind(FACTORY).toFactory(() => {
      const a = c.get(SHARED);
      const b = c.get(SHARED);
      expect(a).toBe(b);
      return a;
    });
    @injectable()
    @injectConstructor(SHARED, FACTORY)
    class Graph {
      constructor(public shared: Weapon, public fromFactory: Weapon) {}
    }
    c.bind(Graph).toSelf();

    const graph = c.get(Graph);
    expect(graph.shared).toBe(graph.fromFactory);
    expect(c.get(Graph).shared).not.toBe(graph.shared);
  });

  it("throws CircularDependencyError on async singleton reentry instead of deadlocking", async () => {
    const TOKEN = createToken<Weapon>("AsyncLoop");
    const c = new Container();
    c.bind(TOKEN)
      .toAsyncFactory(async () => {
        await Promise.resolve();
        return c.getAsync(TOKEN);
      })
      .inSingletonScope();

    const result = await Promise.race([
      c.getAsync(TOKEN).then(
        () => "resolved",
        (err) => err,
      ),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 300)),
    ]);
    expect(result).toBeInstanceOf(CircularDependencyError);
  });

  it("throws CircularDependencyError when multi-inject includes the binding being constructed", () => {
    const TOKEN = createToken<{ items: Weapon[] }>("ArsenalToken");
    @injectable()
    @injectConstructor({ token: TOKEN, multi: true })
    class Arsenal {
      constructor(public items: Weapon[]) {}
    }
    const c = new Container();
    c.bind(TOKEN).to(Arsenal);
    expect(() => c.get(TOKEN)).toThrow(CircularDependencyError);
  });

  it("allows one named binding of a token to depend on another", () => {
    @injectable()
    @injectConstructor({ token: WEAPON, named: "base" })
    class Enhanced implements Weapon {
      name: string;
      constructor(public base: Weapon) {
        this.name = `Enhanced ${base.name}`;
      }
    }
    const c = new Container();
    c.bind(WEAPON).to(Katana).whenNamed("base");
    c.bind(WEAPON).to(Enhanced).whenNamed("enhanced");

    const weapon = c.getNamed(WEAPON, "enhanced");
    expect(weapon.name).toBe("Enhanced Katana");
    expect(weapon).toBeInstanceOf(Enhanced);
  });
});

describe("async request scope", () => {
  it("shares one request-scoped instance across constructor dependencies", async () => {
    const SHARED = createToken<Weapon>("AsyncShared");
    @injectable()
    @injectConstructor(SHARED, SHARED)
    class Pair {
      constructor(public a: Weapon, public b: Weapon) {}
    }
    const c = new Container();
    c.bind(SHARED).to(Katana).inRequestScope();
    c.bind(Pair).toSelf();

    const pair = await c.getAsync(Pair);
    expect(pair.a).toBe(pair.b);

    const again = await c.getAsync(Pair);
    expect(again.a).not.toBe(pair.a);
  });

  it("runs a request-scoped async factory once per graph", async () => {
    const SHARED = createToken<Weapon>("AsyncFactoryShared");
    let calls = 0;
    @injectable()
    @injectConstructor(SHARED, SHARED)
    class Pair {
      constructor(public a: Weapon, public b: Weapon) {}
    }
    const c = new Container();
    c.bind(SHARED)
      .toAsyncFactory(async () => {
        calls++;
        await Promise.resolve();
        return new Katana();
      })
      .inRequestScope();
    c.bind(Pair).toSelf();

    const pair = await c.getAsync(Pair);
    expect(pair.a).toBe(pair.b);
    expect(calls).toBe(1);
  });

  it("shares a request-scoped dependency across getAllAsync", async () => {
    const SHARED = createToken<Weapon>("AllShared");
    @injectable()
    @injectConstructor(SHARED)
    class HolderA {
      constructor(public weapon: Weapon) {}
    }
    @injectable()
    @injectConstructor(SHARED)
    class HolderB {
      constructor(public weapon: Weapon) {}
    }
    const TOKEN = createToken<HolderA | HolderB>("Holders");
    const c = new Container();
    c.bind(SHARED).to(Katana).inRequestScope();
    c.bind(TOKEN).to(HolderA);
    c.bind(TOKEN).to(HolderB);

    const [a, b] = await c.getAllAsync(TOKEN);
    expect(a!.weapon).toBe(b!.weapon);
  });
});

describe("hierarchical singletons", () => {
  @injectable()
  @injectConstructor(CONFIG)
  class Service {
    constructor(public config: string) {}
  }

  it("builds a parent singleton with the parent's bindings", () => {
    const parent = new Container();
    parent.bind(CONFIG).toConstant("parent");
    parent.bind(Service).toSelf().inSingletonScope();

    const childA = new Container({ parent });
    childA.bind(CONFIG).toConstant("A");
    const childB = new Container({ parent });
    childB.bind(CONFIG).toConstant("B");

    expect(childA.get(Service).config).toBe("parent");
    expect(childA.get(Service)).toBe(parent.get(Service));
    expect(childB.get(Service)).toBe(parent.get(Service));
    expect(childB.get(Service).config).toBe("parent");
  });

  it("still applies child overrides to a parent transient", () => {
    const parent = new Container();
    parent.bind(CONFIG).toConstant("parent");
    parent.bind(Service).toSelf();

    const child = new Container({ parent });
    child.bind(CONFIG).toConstant("A");

    expect(child.get(Service).config).toBe("A");
    expect(parent.get(Service).config).toBe("parent");
    expect(child.get(Service)).not.toBe(parent.get(Service));
  });
});

describe("autobind and parents", () => {
  it("does not autobind over a parent singleton", () => {
    @injectable()
    class Svc {
      id = Math.random();
    }
    const parent = new Container();
    parent.bind(Svc).toSelf().inSingletonScope();
    const child = new Container({ parent, autoBindInjectable: true });

    expect(child.get(Svc)).toBe(parent.get(Svc));
    expect(child.getAll(Svc)[0]).toBe(parent.get(Svc));
  });

  it("rolls back an autobind that does not satisfy the constraint", () => {
    @injectable()
    class AutoSword implements Weapon {
      name = "Auto";
    }
    const c = new Container({ autoBindInjectable: true });
    expect(() => c.getNamed(AutoSword, "nope")).toThrow(ServiceNotFoundError);
    expect(c.isBound(AutoSword)).toBe(false);

    const sword = c.get(AutoSword);
    expect(sword).toBeInstanceOf(AutoSword);
    expect(c.isBound(AutoSword)).toBe(true);
  });
});

describe("decorator metadata inheritance", () => {
  const DEP = createToken<{ v: number }>("Dep");

  @injectable()
  @injectConstructor(DEP)
  class Base {
    constructor(public dep: { v: number }) {}
  }

  it("does not apply the base constructor list to a subclass constructor", () => {
    @injectable()
    class Child extends Base {
      constructor(public label: unknown) {
        super({ v: -1 });
      }
    }
    const c = new Container();
    c.bind(DEP).toConstant({ v: 7 });
    c.bind(Child).toSelf();

    const child = c.get(Child);
    expect(child.label).toBeUndefined();
    expect(child.dep).toEqual({ v: -1 });
  });

  it("does not require the base token for a zero-argument subclass constructor", () => {
    @injectable()
    class ChildZero extends Base {
      constructor() {
        super({ v: -1 });
      }
    }
    const c = new Container();
    c.bind(ChildZero).toSelf();
    expect(c.get(ChildZero).dep).toEqual({ v: -1 });
  });

  it("keeps the base constructor list when the subclass declares no constructor", () => {
    @injectable()
    class Child extends Base {
      log() {
        return "constructor()";
      }
    }
    const c = new Container();
    c.bind(DEP).toConstant({ v: 7 });
    c.bind(Child).toSelf();
    expect(c.get(Child).dep).toEqual({ v: 7 });
  });

  it("does not inherit @injectable scope", () => {
    @injectable({ scope: Scope.Singleton })
    class BaseScope {
      n = Math.random();
    }
    @injectable()
    class ChildScope extends BaseScope {}

    const c = new Container();
    c.bind(ChildScope).toSelf();
    expect(c.get(ChildScope)).not.toBe(c.get(ChildScope));
  });

  it("keeps an explicit builder scope when to() runs afterwards", () => {
    @injectable({ scope: Scope.Transient })
    class TransientMarked {
      n = Math.random();
    }
    const TOKEN = createToken<TransientMarked>("Marked");
    const c = new Container();
    c.bind(TOKEN).inSingletonScope().to(TransientMarked);
    expect(c.get(TOKEN)).toBe(c.get(TOKEN));
  });

  it("lets a scope method after to() override decorator scope", () => {
    @injectable({ scope: Scope.Singleton })
    class SingletonMarked {
      n = Math.random();
    }
    const TOKEN = createToken<SingletonMarked>("MarkedSingleton");
    const c = new Container();
    c.bind(TOKEN).to(SingletonMarked).inTransientScope();
    expect(c.get(TOKEN)).not.toBe(c.get(TOKEN));
  });
});

describe("accessor injection", () => {
  it("writes private auto-accessors through the generated setter", () => {
    @injectable()
    class Ninja {
      @inject(WEAPON) accessor #weapon!: Weapon;
      reveal() {
        return this.#weapon;
      }
    }
    const c = new Container();
    c.bind(WEAPON).to(Katana);
    c.bind(Ninja).toSelf();
    const ninja = c.get(Ninja);
    expect(ninja.reveal().name).toBe("Katana");
    expect((ninja as unknown as Record<string, unknown>)["#weapon"]).toBeUndefined();
  });

  it("writes static auto-accessors on the constructor", () => {
    @injectable()
    class Holder {
      @inject(WEAPON) static accessor weapon: Weapon | undefined;
    }
    const c = new Container();
    c.bind(WEAPON).to(Katana);
    c.bind(Holder).toSelf();
    const holder = c.get(Holder);
    expect(Holder.weapon?.name).toBe("Katana");
    expect((holder as unknown as { weapon?: Weapon }).weapon).toBeUndefined();
  });
});

describe("filtered multi-inject", () => {
  it("honors named constraints on constructor multi-inject", () => {
    @injectable()
    @injectConstructor({ token: WEAPON, multi: true, named: "onlyA" })
    class Arsenal {
      constructor(public weapons: Weapon[]) {}
    }
    const c = new Container();
    c.bind(WEAPON).to(Katana).whenNamed("onlyA");
    c.bind(WEAPON).to(Shuriken).whenNamed("onlyB");
    c.bind(Arsenal).toSelf();
    expect(c.get(Arsenal).weapons.map((w) => w.name)).toEqual(["Katana"]);
  });

  it("honors @named on a @multiInject field", () => {
    @injectable()
    class Arsenal {
      @multiInject(WEAPON) @named("onlyA") accessor weapons!: Weapon[];
    }
    const c = new Container();
    c.bind(WEAPON).to(Katana).whenNamed("onlyA");
    c.bind(WEAPON).to(Shuriken).whenNamed("onlyB");
    c.bind(Arsenal).toSelf();
    expect(c.get(Arsenal).weapons.map((w) => w.name)).toEqual(["Katana"]);
  });
});

describe("container modules", () => {
  it("removes bindings when registry throws", () => {
    const module = new ContainerModule((bind) => {
      bind(WEAPON).to(Katana);
      throw new Error("boom");
    });
    const c = new Container();
    expect(() => c.load(module)).toThrow("boom");
    expect(c.isBound(WEAPON)).toBe(false);
    c.unload(module);
    expect(c.isBound(WEAPON)).toBe(false);
  });

  it("rejects loading a module that is already loaded", () => {
    const module = new ContainerModule((bind) => {
      bind(WEAPON).to(Katana);
    });
    const c = new Container();
    c.load(module);
    expect(() => c.load(module)).toThrow(InvalidBindingError);
    expect(c.getAll(WEAPON)).toHaveLength(1);
    c.unload(module);
    c.load(module);
    expect(c.get(WEAPON).name).toBe("Katana");
  });
});

describe("undefined singleton cache", () => {
  it("caches a singleton factory that returns undefined", () => {
    const TOKEN = createToken<undefined>("Empty");
    let calls = 0;
    const c = new Container();
    c.bind(TOKEN)
      .toFactory(() => {
        calls++;
        return undefined;
      })
      .inSingletonScope();
    expect(c.get(TOKEN)).toBeUndefined();
    expect(c.get(TOKEN)).toBeUndefined();
    expect(calls).toBe(1);
  });

  it("caches an async singleton factory that returns undefined", async () => {
    const TOKEN = createToken<undefined>("EmptyAsync");
    let calls = 0;
    const c = new Container();
    c.bind(TOKEN)
      .toAsyncFactory(async () => {
        calls++;
        return undefined;
      })
      .inSingletonScope();
    expect(await c.getAsync(TOKEN)).toBeUndefined();
    expect(await c.getAsync(TOKEN)).toBeUndefined();
    expect(calls).toBe(1);
  });
});
