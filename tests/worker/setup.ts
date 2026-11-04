import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll } from "vitest";

type TestBindings = Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

beforeAll(async () => {
  const bindings = env as TestBindings;
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
});
