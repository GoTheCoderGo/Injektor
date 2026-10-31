import { describe, it, expect } from "bun:test";
import {
  Container, AsyncBindingError, CircularDependencyError, Scope,
  injectable, injectConstructor, inject, named, tagged, multiInject, createToken,
} from "../index.ts";

/** Fail a deadlock promptly while clearing the watchdog on successful rejection. */
async function withDeadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("resolution timed out")), 250);
  });
  try { return await Promise.race([promise, timeout]); }
  finally { clearTimeout(timer!); }
}

describe("singleton initialization", () => {
  it("rejects synchronous access while an async resolution is initializing a sync factory", async () => {
    const c = new Container();
    const token = createToken<object>("shared");
    let calls = 0;
    c.bind(token).toFactory(() => ({ call: ++calls })).inSingletonScope();
    const pending = c.getAsync(token);
    expect(() => c.get(token)).toThrow(AsyncBindingError);
    const value = await pending;
    expect(c.get(token)).toBe(value);
    expect(calls).toBe(1);
  });

  it("does not construct a class twice when sync access races its async construction", async () => {
    let calls = 0;
    @injectable()
    class Service { constructor() { calls++; } }
    const c = new Container();
    c.bind(Service).toSelf().inSingletonScope();
    const pending = c.getAsync(Service);
    expect(() => c.get(Service)).toThrow(AsyncBindingError);
    const value = await pending;
    expect(c.get(Service)).toBe(value);
    expect(calls).toBe(1);
  });

  it("allows retrying an async singleton after failure", async () => {
    const c = new Container();
    let calls = 0;
    const token = createToken<object>("retry");
    c.bind(token).toAsyncFactory(async () => {
      if (++calls === 1) throw new Error("first attempt");
      return {};
    }).inSingletonScope();
    await expect(c.getAsync(token)).rejects.toThrow("first attempt");
    const value = await c.getAsync(token);
    expect(c.get(token)).toBe(value);
    expect(calls).toBe(2);
  });

  it("builds an inherited async singleton with its owner's factory context", async () => {
    const parent = new Container();
    const child = new Container({ parent });
    const config = createToken<string>("config");
    const service = createToken<{ config: string }>("service");
    parent.bind(config).toConstant("parent");
    child.bind(config).toConstant("child");
    parent.bind(service).toAsyncFactory(async (ctx) => {
      await Promise.resolve();
      return { config: ctx.get(config) };
    }).inSingletonScope();
    const [a, b] = await Promise.all([child.getAsync(service), parent.getAsync(service)]);
    expect(a).toBe(b);
    expect(a.config).toBe("parent");
    expect(child.get(service)).toBe(a);
  });
});

describe("parallel async dependency cycles", () => {
  for (const scope of [Scope.Singleton, Scope.Request]) {
    it(`rejects a cycle between parallel ${scope} dependencies`, async () => {
      const c = new Container();
      const A = createToken<object>("A");
      const B = createToken<object>("B");
      c.bind(A).toAsyncFactory(async (ctx) => {
        await Promise.resolve();
        return ctx.getAsync(B);
      })[scope === Scope.Singleton ? "inSingletonScope" : "inRequestScope"]();
      c.bind(B).toAsyncFactory(async (ctx) => {
        await Promise.resolve();
        return ctx.getAsync(A);
      })[scope === Scope.Singleton ? "inSingletonScope" : "inRequestScope"]();
      @injectable()
      @injectConstructor(A, B)
      class Root { constructor(public a: object, public b: object) {} }
      c.bind(Root).toSelf();
      await expect(withDeadline(c.getAsync(Root))).rejects.toBeInstanceOf(CircularDependencyError);
    });
  }

  it("detects waits between independently started singleton roots using ambient native context", async () => {
    const c = new Container();
    const A = createToken<object>("A");
    const B = createToken<object>("B");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    c.bind(A).toAsyncFactory(async () => { await gate; return c.getAsync(B); }).inSingletonScope();
    c.bind(B).toAsyncFactory(async () => { await gate; return c.getAsync(A); }).inSingletonScope();
    const a = c.getAsync(A);
    const b = c.getAsync(B);
    release();
    const results = await withDeadline(Promise.allSettled([a, b]));
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason).toBeInstanceOf(CircularDependencyError);
    }
  });

  it("shares an acyclic singleton across parallel roots", async () => {
    const c = new Container();
    const dep = createToken<object>("shared");
    const A = createToken<object>("A");
    const B = createToken<object>("B");
    let calls = 0;
    c.bind(dep).toAsyncFactory(async () => { await Promise.resolve(); calls++; return {}; }).inSingletonScope();
    c.bind(A).toAsyncFactory((ctx) => ctx.getAsync(dep));
    c.bind(B).toAsyncFactory((ctx) => ctx.getAsync(dep));
    const [a, b] = await withDeadline(Promise.all([c.getAsync(A), c.getAsync(B)]));
    expect(a).toBe(b);
    expect(calls).toBe(1);
  });

  it("detects parallel waits that cross parent and child containers", async () => {
    const parent = new Container();
    const child = new Container({ parent });
    const A = createToken<object>("parent singleton");
    const B = createToken<object>("child singleton");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    parent.bind(A).toAsyncFactory(async () => { await gate; return child.getAsync(B); }).inSingletonScope();
    child.bind(B).toAsyncFactory(async (ctx) => { await gate; return ctx.getAsync(A); }).inSingletonScope();
    const a = child.getAsync(A);
    const b = child.getAsync(B);
    release();
    const results = await withDeadline(Promise.allSettled([a, b]));
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason).toBeInstanceOf(CircularDependencyError);
    }
  });
});

describe("constructor metadata inheritance", () => {
  const dep = createToken<string>("dependency");
  @injectable()
  @injectConstructor(dep)
  class Base { constructor(public dependency: string) {} }

  it("preserves the base argument list with a generated forwarding constructor", async () => {
    const property = createToken<string>("property");
    @injectable()
    class Child extends Base { @inject(property) accessor value!: string; }
    const c = new Container();
    c.bind(dep).toConstant("injected");
    c.bind(property).toConstant("property");
    c.bind(Child).toSelf();
    for (const child of [c.get(Child), await c.getAsync(Child)]) {
      expect(child.dependency).toBe("injected");
      expect(child.value).toBe("property");
    }
  });

  it("ignores a constructor call inside an ordinary method", () => {
    @injectable()
    class Child extends Base {
      clone() {
        const self = this as unknown as { constructor: new (value: string) => Base };
        return new self.constructor(this.dependency);
      }
    }
    const c = new Container();
    c.bind(dep).toConstant("injected");
    c.bind(Child).toSelf();
    expect(c.get(Child).clone().dependency).toBe("injected");
  });

  it("retains a declared constructor with nested default expressions", () => {
    @injectable()
    class Child extends Base {
      constructor(value = (() => "own value")()) { super(value); }
    }
    const c = new Container();
    c.bind(Child).toSelf();
    expect(c.get(Child).dependency).toBe("own value");
  });
});

describe("accessor identities", () => {
  const dep = createToken<string>("value");

  it("keeps inherited private accessors and their constraints separate", async () => {
    @injectable()
    class Base {
      @inject(dep) @named("base") accessor #value!: string;
      baseValue() { return this.#value; }
    }
    @injectable()
    class Child extends Base {
      @named("child") @inject(dep) accessor #value!: string;
      childValue() { return this.#value; }
    }
    const c = new Container();
    c.bind(dep).toConstant("base").whenNamed("base");
    c.bind(dep).toConstant("child").whenNamed("child");
    c.bind(Child).toSelf();
    for (const child of [c.get(Child), await c.getAsync(Child)]) {
      expect(child.baseValue()).toBe("base");
      expect(child.childValue()).toBe("child");
    }
  });

  it("separates static, private static, and instance accessors with the same name", async () => {
    @injectable()
    class Both {
      @inject(dep) @tagged("kind", "static") static accessor value: string | undefined;
      @tagged("kind", "private") @inject(dep) static accessor #value: string | undefined;
      @inject(dep) @tagged("kind", "instance") accessor value!: string;
      static privateValue() { return this.#value; }
    }
    const c = new Container();
    for (const kind of ["static", "private", "instance"]) c.bind(dep).toConstant(kind).whenTagged("kind", kind);
    c.bind(Both).toSelf();
    for (const instance of [c.get(Both), await c.getAsync(Both)]) {
      expect(Both.value).toBe("static");
      expect(Both.privateValue()).toBe("private");
      expect(instance.value).toBe("instance");
    }
  });

  it("keeps multi-injection and names isolated on inherited private accessors", () => {
    @injectable()
    class Base {
      @multiInject(dep) @named("base") accessor #values!: string[];
      baseValues() { return this.#values; }
    }
    @injectable()
    class Child extends Base {
      @named("child") @multiInject(dep) accessor #values!: string[];
      childValues() { return this.#values; }
    }
    const c = new Container();
    c.bind(dep).toConstant("base").whenNamed("base");
    c.bind(dep).toConstant("child").whenNamed("child");
    c.bind(Child).toSelf();
    const child = c.get(Child);
    expect(child.baseValues()).toEqual(["base"]);
    expect(child.childValues()).toEqual(["child"]);
  });
});
