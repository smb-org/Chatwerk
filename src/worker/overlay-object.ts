import { DurableObject } from "cloudflare:workers";

export class OverlayObject extends DurableObject<Env> {
  // Temporary scaffold probe; T6 replaces this implementation.
  async ping(): Promise<number> {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS ping_counter (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL)",
    );

    const current = this.ctx.storage.sql
      .exec<{ value: number }>("SELECT value FROM ping_counter WHERE id = 1")
      .toArray()[0]?.value ?? 0;
    const next = current + 1;

    this.ctx.storage.sql.exec(
      "INSERT INTO ping_counter (id, value) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET value = excluded.value",
      next,
    );

    return next;
  }
}
