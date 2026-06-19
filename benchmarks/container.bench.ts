import { run, bench, group } from "mitata";
import { Container, injectable, injectConstructor, Scope } from "../index.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Setup Fixtures
// ─────────────────────────────────────────────────────────────────────────────

@injectable()
class Config {
  port = 8080;
}

@injectable()
@injectConstructor(Config)
class Database {
  constructor(public config: Config) {}
}

@injectable()
@injectConstructor(Database)
class Repository {
  constructor(public db: Database) {}
}

@injectable()
@injectConstructor(Repository)
class Service {
  constructor(public repo: Repository) {}
}

@injectable()
@injectConstructor(Service, Config)
class Controller {
  constructor(public service: Service, public config: Config) {}
}

const container = new Container();
container.bind(Config).toSelf().inSingletonScope();
container.bind(Database).toSelf().inSingletonScope();
container.bind(Repository).toSelf().inTransientScope();
container.bind(Service).toSelf().inTransientScope();
container.bind(Controller).toSelf().inTransientScope();

// ─────────────────────────────────────────────────────────────────────────────
// Benchmarks
// ─────────────────────────────────────────────────────────────────────────────

group("Injektor Container Resolution", () => {
  bench("Singleton Resolution (Config)", () => {
    container.get(Config);
  });

  bench("Transient Resolution (Repository)", () => {
    container.get(Repository);
  });

  bench("Complex Dependency Graph (Controller)", () => {
    container.get(Controller);
  });
});

group("Injektor Container Lifecycle", () => {
  bench("Create empty Container", () => {
    new Container();
  });

  bench("Bind 5 services", () => {
    const c = new Container();
    c.bind(Config).toSelf().inSingletonScope();
    c.bind(Database).toSelf().inSingletonScope();
    c.bind(Repository).toSelf().inTransientScope();
    c.bind(Service).toSelf().inTransientScope();
    c.bind(Controller).toSelf().inTransientScope();
  });
});

await run();
