import { describe, expect, it } from "bun:test";
import {
  AsyncBindingError, Container, ContainerModule, InvalidBindingError,
  NotInjectableError, Scope, ServiceNotFoundError, createToken, inject,
  injectConstructor, injectable, multiInject, named, tagged,
} from "../index.ts";
import type { BindFunction, BindingBuilder } from "../index.ts";

describe("request scope across container owners", () => {
  for (const asyncLookup of [false, true]) {
    it(`shares one parent cache across siblings (async = ${asyncLookup})`, async () => {
      const parent = new Container();
      const child = new Container({ parent });
      const request = createToken<object>("request");
      const service = createToken<object>("service");
      parent.bind(request).toFactory(() => ({})).inRequestScope();
      child.bind(request).toConstant({ child: true });
      const first = parent.bind(service).toFactory(ctx => ctx.get(request)).inSingletonScope();
      const second = parent.bind(service).toFactory(ctx => ctx.get(request)).inSingletonScope();

      const resolve = () => asyncLookup ? child.getAllAsync(service) : child.getAll(service);
      const pair = await resolve();
      expect(pair[0]).toBe(pair[1]);
      expect(pair[0]).not.toBe(child.get(request));

      first.toFactory(ctx => ctx.get(request));
      second.toFactory(ctx => ctx.get(request));
      const next = await resolve();
      expect(next[0]).toBe(next[1]);
      expect(next[0]).not.toBe(pair[0]);
    });

    it(`autobinds in an ancestor on the first multi-lookup (async = ${asyncLookup})`, async () => {
      @injectable({ scope: Scope.Singleton })
      class Service {}
      const parent = new Container({ autoBindInjectable: true });
      const child = new Container({ parent });
      const services = asyncLookup ? await child.getAllAsync(Service) : child.getAll(Service);
      expect(services).toHaveLength(1);
      expect(services[0]).toBe(parent.get(Service));
    });
  }
});

describe("inherited injection metadata", () => {
  it("uses only the overriding accessor's injection mode", async () => {
    @injectable()
    class Base {
      @multiInject("previousMulti") accessor first: string[] = [];
      @inject("previousSingle") accessor second: string[] = [];
      @inject("inherited") accessor inherited!: string;
    }
    @injectable()
    class Child extends Base {
      @inject("single") override accessor first: string[] = [];
      @multiInject("multi") override accessor second: string[] = [];
    }
    const c = new Container({ autoBindInjectable: true });
    c.bind("single").toConstant(["a"]);
    c.bind("multi").toConstant("b");
    c.bind("multi").toConstant("c");
    c.bind("inherited").toConstant("base");
    for (const child of [c.get(Child), await c.getAsync(Child)]) {
      expect([child.first, child.second, child.inherited]).toEqual([["a"], ["b", "c"], "base"]);
    }
    c.bind("previousMulti").toConstant("old");
    c.bind("previousSingle").toConstant(["old"]);
    const base = c.get(Base);
    expect([base.first, base.second]).toEqual([["old"], ["old"]]);
  });

  it("replaces inherited qualifiers and keeps the qualifiers on the override in either order", async () => {
    @injectable()
    class Base {
      @inject("base") @named("old") @tagged("obsolete", true) accessor plain!: string;
      @multiInject("base") @named("old") @tagged("obsolete", true) accessor many!: string[];
    }
    @injectable()
    class Child extends Base {
      @inject("plain") override accessor plain = "";
      @named("new") @multiInject("group") @tagged("keep", true) override accessor many: string[] = [];
    }
    const c = new Container({ autoBindInjectable: true });
    c.bind("plain").toConstant("plain");
    c.bind("group").toConstant("ok").whenNamed("new").whenTagged("keep", true);
    c.bind("group").toConstant("wrong").whenNamed("new");
    c.bind("group").toConstant("other name").whenTagged("keep", true);
    c.bind("base").toConstant("original").whenNamed("old").whenTagged("obsolete", true);
    c.bind("base").toConstant("unqualified");
    for (const child of [c.get(Child), await c.getAsync(Child)]) {
      expect(child.plain).toBe("plain");
      expect(child.many).toEqual(["ok"]);
    }
    expect(c.get(Base).plain).toBe("original");
    expect(c.get(Base).many).toEqual(["original"]);
  });

  it("inherits constructor tokens only through a chain of forwarding constructors", async () => {
    @injectable()
    @injectConstructor("dep")
    class Base { constructor(readonly value: string) {} }
    class SuppliesValue extends Base { constructor() { super("local"); } }
    @injectable()
    class Leaf extends SuppliesValue {}

    let traced = 0;
    class Forwarder extends Base {
      constructor(...args: ConstructorParameters<typeof Base>) { traced++; super(...args); }
    }
    @injectable()
    class TracedLeaf extends Forwarder {}

    const c = new Container({ autoBindInjectable: true });
    expect(c.get(Leaf).value).toBe("local");
    expect((await c.getAsync(Leaf)).value).toBe("local");
    c.bind("dep").toConstant("injected");
    expect(c.get(TracedLeaf).value).toBe("injected");
    expect((await c.getAsync(TracedLeaf)).value).toBe("injected");
    expect(traced).toBe(2);
  });

  it("requires an own injectable marker even with other Stage 3 metadata", async () => {
    @injectable({ scope: Scope.Singleton })
    class Base {}
    class Plain extends Base {}
    class PropertyOnly extends Base { @inject("missing") accessor dep!: string; }

    for (const child of [Plain, PropertyOnly]) {
      const c = new Container({ autoBindInjectable: true });
      expect(() => c.get(child)).toThrow(ServiceNotFoundError);
      expect(c.isBound(child)).toBe(false);
      c.bind(child).toSelf();
      expect(() => c.get(child)).toThrow(NotInjectableError);
      await expect(c.getAsync(child)).rejects.toBeInstanceOf(NotInjectableError);
    }
  });

  it("recognizes an explicit constructor after regex literals and division", async () => {
    @injectable()
    @injectConstructor("unbound")
    class Base { constructor(readonly value: string) {} }

    @injectable()
    class Child extends Base {
      static pattern = /\{[/]/;
      static ratio = 12 / 4 / 3;
      check(value: string) {
        if (value) /\{/.test(value);
      }
      constructor() { super("child"); }
    }
    const c = new Container({ autoBindInjectable: true });
    expect(c.get(Child).value).toBe("child");
    expect((await c.getAsync(Child)).value).toBe("child");
  });
});

describe("binding targets", () => {
  for (const asyncFirst of [false, true]) {
    it(`retains the promise returned by a sync singleton factory (async first = ${asyncFirst})`, async () => {
      const token = createToken<Promise<number>>("promise");
      const original = Promise.resolve(42);
      const c = new Container();
      let calls = 0;
      c.bind(token).toFactory(() => { calls++; return original; }).inSingletonScope();
      if (!asyncFirst) expect(c.get(token)).toBe(original);
      expect(await c.getAsync(token)).toBe(42);
      expect(c.get(token)).toBe(original);
      expect(calls).toBe(1);
    });
  }

  it("injects the promise itself during parallel class and multi-resolution", async () => {
    const token = createToken<Promise<number>>("pending service");
    @injectable()
    @injectConstructor(token, token, { token, multi: true })
    class Consumer {
      constructor(readonly a: Promise<number>, readonly b: Promise<number>, readonly all: Promise<number>[]) {}
      @inject(token) accessor field!: Promise<number>;
    }
    const c = new Container({ autoBindInjectable: true });
    const service = Promise.withResolvers<number>();
    c.bind(token).toFactory(() => service.promise).inSingletonScope();
    // Construction must finish while the injected promise is still pending.
    const consumer = await c.getAsync(Consumer);
    for (const actual of [consumer.a, consumer.b, consumer.field, ...consumer.all, ...await c.getAllAsync(token)]) {
      expect(actual).toBe(service.promise);
    }
    service.resolve(42);
    expect(await c.getAsync(token)).toBe(42);
  });

  it("keeps pending completions and warm caches on the target that produced them", async () => {
    const c = new Container();
    const old = Promise.withResolvers<string>();
    const next = Promise.withResolvers<string>();
    const target = c.bind<string>("value").toAsyncFactory(() => old.promise).inSingletonScope();
    const firstLookup = c.getAsync<string>("value");
    target.toAsyncFactory(() => next.promise);
    const nextLookup = c.getAsync<string>("value");
    old.resolve("old");
    expect(await firstLookup).toBe("old");
    expect(() => c.get<string>("value")).toThrow(AsyncBindingError);
    next.resolve("next");
    expect(await nextLookup).toBe("next");
    target.toConstant("final");
    expect(c.get<string>("value")).toBe("final");
    expect(c.getAll("value")).toEqual(["final"]);
    expect(await c.getAsync<string>("value")).toBe("final");
  });

  it("matches explicit undefined tags and accepts arbitrary tag names", async () => {
    const c = new Container();
    c.bind("item").toConstant("other").whenTagged("region", "west");
    expect(() => c.getTagged<string>("item", "stage", undefined)).toThrow(ServiceNotFoundError);
    c.bind("item").toConstant("selected").whenTagged("stage", undefined).whenTagged("__proto__", "ok");
    expect(c.getTagged<string>("item", "stage", undefined)).toBe("selected");
    expect(await c.getTaggedAsync<string>("item", "__proto__", "ok")).toBe("selected");
  });
});

describe("module registration", () => {
  it("rolls back a reentrant load and supports a clean retry", () => {
    const c = new Container();
    let reenter = true;
    const mod = new ContainerModule(bind => {
      bind("a").toConstant(1);
      if (reenter) c.load(mod);
    });
    expect(() => c.load(mod)).toThrow(InvalidBindingError);
    expect(c.isBound("a")).toBe(false);
    reenter = false;
    c.load(mod);
    expect(c.getAll("a")).toEqual([1]);
    c.unload(mod);
    expect(c.isBound("a")).toBe(false);
  });

  it("rejects an async registry, rolls it back, and closes its continuation", async () => {
    const c = new Container();
    const gate = Promise.withResolvers<void>();
    let continued = false;
    const mod = new ContainerModule(async bind => {
      bind("early").toConstant(1);
      const builder = bind("late");
      await gate.promise;
      continued = true;
      builder.toConstant(2);
    });
    expect(() => c.load(mod)).toThrow(InvalidBindingError);
    expect(c.isBound("early")).toBe(false);
    c.unload(mod);
    gate.resolve();
    await gate.promise;
    expect(continued).toBe(true);
    expect(c.isBound("late")).toBe(false);
  });

  it("unloads only live module bindings after unbind and rebind", () => {
    const c = new Container();
    let stale!: BindingBuilder<number>;
    let live!: BindingBuilder<string>;
    const a = new ContainerModule(bind => {
      stale = bind<number>("replace").toConstant(1);
      live = bind<string>("shared").toConstant("a");
    });
    const b = new ContainerModule(bind => {
      bind("replace").toConstant(2);
      bind("shared").toConstant("b");
    });
    c.load(a);
    c.load(b);
    c.rebind("replace").toConstant(3);
    stale.toConstant(4);
    live.toConstant("updated");
    expect(c.getAll("shared")).toEqual(["updated", "b"]);
    c.unload(a);
    expect(c.getAll("shared")).toEqual(["b"]);
    c.unload(b);
    expect(c.isBound("shared")).toBe(false);
    expect(c.getAll("replace")).toEqual([3]);
  });

  it("tracks retargeted bindings and prevents late registration after unload", () => {
    const c = new Container();
    let register!: BindFunction;
    let bound!: BindingBuilder<number>;
    let unbound!: BindingBuilder<number>;
    const mod = new ContainerModule(bind => {
      register = bind;
      bound = bind<number>("owned").toConstant(1);
      unbound = bind<number>("late");
    });
    c.load(mod);
    bound.toConstant(2);
    expect(c.get<number>("owned")).toBe(2);
    c.unload(mod);
    expect(() => register("late")).toThrow(InvalidBindingError);
    expect(() => unbound.toConstant(3)).toThrow(InvalidBindingError);
    bound.toConstant(4);
    expect(c.isBound("owned")).toBe(false);
    expect(c.isBound("late")).toBe(false);
  });
});
