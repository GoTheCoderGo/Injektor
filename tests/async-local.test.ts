import { describe, expect, it } from "bun:test";
import { SynchronousLocalStorage } from "../src/async-local.ts";

const als = new SynchronousLocalStorage<string>();

describe("synchronous fallback context", () => {
  it("restores the outer store around a nested run", () => {
    const seen = als.run("outer", () => {
      const inner = als.run("inner", () => als.getStore());
      return { inner, outer: als.getStore() };
    });
    expect(seen).toEqual({ inner: "inner", outer: "outer" });
    expect(als.getStore()).toBeUndefined();
  });

  it("restores the store before returning a pending promise", async () => {
    const pending = als.run("A", () => Promise.resolve().then(() => als.getStore()));
    expect(als.getStore()).toBeUndefined();
    expect(await pending).toBeUndefined();
    expect(als.getStore()).toBeUndefined();
  });

  it("does not expose another overlapping callback's store after await", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const a = als.run("A", async () => {
      await gate;
      return als.run("A", () => als.getStore());
    });
    const b = als.run("B", async () => {
      await gate;
      return als.run("B", () => als.getStore());
    });
    expect(als.getStore()).toBeUndefined();
    release();
    expect(await Promise.all([a, b])).toEqual(["A", "B"]);
    expect(als.getStore()).toBeUndefined();
  });

  it("restores the outer store when a callback throws", () => {
    als.run("outer", () => {
      expect(() => als.run("inner", () => { throw new Error("failure"); })).toThrow("failure");
      expect(als.getStore()).toBe("outer");
    });
    expect(als.getStore()).toBeUndefined();
  });
});
