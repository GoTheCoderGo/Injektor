import { Container, createToken } from "@ilya_coder/injektor";
import plugin from "./plugin.cjs";

if (Container !== plugin.runtime.Container) throw new Error("browser runtime identity differs");
const c = new Container({ autoBindInjectable: true });
if (!(c.get(plugin.PluginService) instanceof plugin.PluginService)) throw new Error("CJS decorator failed");
const request = createToken<object>("request");
c.bind(request).toFactory(() => ({})).inRequestScope();
c.bind("root").toAsyncFactory(async ctx => {
  const first = ctx.get(request);
  await Promise.resolve();
  if (first !== ctx.get(request)) throw new Error("browser request scope was lost");
});
await c.getAsync("root");
