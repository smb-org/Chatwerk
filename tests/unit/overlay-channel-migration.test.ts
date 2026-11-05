import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migration = (name: string): string => readFileSync(resolve("migrations", name), "utf8");

describe("overlay channel migration", () => {
  it("fills empty channels, keeps configured channels, and is safe to reapply", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(migration("0001_init.sql"));
      db.exec(migration("0002_overlay_channel_generation.sql"));
      db.exec(migration("0003_users_login_not_unique.sql"));
      db.exec(migration("0004_gallery_management.sql"));
      db.exec("INSERT INTO users (id, login) VALUES ('owner-a', 'alice'), ('owner-b', 'bob')");
      db.exec(`
        INSERT INTO overlays (id, owner_id, link_token, name, channel) VALUES
          ('empty-main', 'owner-a', 'token-a', 'Renamed Main', ''),
          ('empty-second', 'owner-b', 'token-b', 'Second', ''),
          ('set-channel', 'owner-a', 'token-c', 'Third', 'custom_room')
      `);

      db.exec(migration("0005_fill_overlay_channels.sql"));
      db.exec(migration("0005_fill_overlay_channels.sql"));

      const channels = db.prepare("SELECT id, channel FROM overlays ORDER BY id").all() as Array<{ id: string; channel: string }>;
      expect(channels).toEqual([
        { id: "empty-main", channel: "alice" },
        { id: "empty-second", channel: "bob" },
        { id: "set-channel", channel: "custom_room" },
      ]);
    } finally {
      db.close();
    }
  });
});
