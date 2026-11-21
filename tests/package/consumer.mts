import {
  BindingBuilder, Container, CircularDependencyError, ServiceNotFoundError,
  createToken, injectable, injectConstructor, type ServiceIdentifier,
} from "@ilya_coder/injektor";
import plugin = require("./plugin.cjs");

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

// These calls are checked by the consumer's compiler.
function checkTokenTypes(c: Container) {
  const text = createToken<string>("text");
  c.bind(text).toConstant("value");
  c.bind<string>(text).toConstant("value");
  c.bind<number>(Symbol("raw")).toConstant(42);
  c.get(text).toUpperCase();
  const lookup: ServiceIdentifier<string> = text;
  c.get(lookup).toUpperCase();
  // @ts-expect-error a lookup-only identifier cannot authorize a widened registration
  c.bind<string | number>(lookup).toConstant(42);
  const emptyLookup: ServiceIdentifier<undefined> = createToken<undefined>("empty");
  // @ts-expect-error a lookup for undefined must not be accepted as a raw symbol
  c.rebind<number>(emptyLookup);
  // @ts-expect-error standalone builders also require a registration identifier
  new BindingBuilder<string | number>(lookup, () => {});
  // @ts-expect-error a numeric binding cannot write to a string token
  c.bind<number>(text);
  // @ts-expect-error widening the registration type would permit writing a number
  c.rebind<string | number>(text);
  // @ts-expect-error undefined is a typed service too
  c.bind<number>(createToken<undefined>("empty"));
  // @ts-expect-error the typed token returns a string
  c.get<number>(text);
}

@injectable()
class AppService {}

const commonContainer: Container = new plugin.runtime.Container({ autoBindInjectable: true });
const esmContainer = new Container({ autoBindInjectable: true });
check(plugin.runtime.Container === Container, "Container identity differs");
check(plugin.runtime.ServiceNotFoundError === ServiceNotFoundError, "error identity differs");
check(commonContainer.get(AppService) instanceof AppService, "CJS failed to resolve ESM class");
check(esmContainer.get(plugin.PluginService) instanceof plugin.PluginService, "ESM failed to resolve CJS class");

// A synchronous error during parallel lookup must still observe earlier rejections.
// The runner executes this process with strict unhandled-rejection handling.
@injectable()
@injectConstructor("rejects", "missing")
class Root {}

async function failLater() {
  await Promise.resolve();
  throw new Error("sibling rejected");
}
esmContainer.bind("rejects").toAsyncFactory(failLater);
try {
  await esmContainer.getAsync(Root);
  throw new Error("expected missing dependency");
} catch (error) {
  if (!(error instanceof ServiceNotFoundError)) throw error;
}

esmContainer.bind("group").toAsyncFactory(failLater);
esmContainer.bind("group").toAsyncFactory(ctx => ctx.getAllAsync("group")).whenNamed("cycle");
try {
  await esmContainer.getNamedAsync("group", "cycle");
  throw new Error("expected circular dependency");
} catch (error) {
  if (!(error instanceof CircularDependencyError)) throw error;
}

// Also exercised in a fresh Node process without process.getBuiltinModule.
const request = createToken<object>("request");
esmContainer.bind(request).toFactory(() => ({})).inRequestScope();
esmContainer.bind("ambient").toAsyncFactory(async () => {
  const first = esmContainer.get(request);
  await Promise.resolve();
  check(first === esmContainer.get(request), "native request context was lost");
});
await esmContainer.getAsync("ambient");
