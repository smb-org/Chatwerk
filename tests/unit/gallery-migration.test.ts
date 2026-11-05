import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migration = (name: string): string => readFileSync(resolve("migrations", name), "utf8");

describe("gallery migration", () => {
  it("preserves case-colliding looks while establishing the normalized unique index", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(migration("0001_init.sql"));
      db.exec(migration("0002_overlay_channel_generation.sql"));
      db.exec(migration("0003_users_login_not_unique.sql"));
      db.exec("INSERT INTO users (id, login) VALUES ('owner', 'owner')");
      db.exec(`
        INSERT INTO themes (id, owner_id, slug, name, values_json, created_at)
        VALUES
          ('look-old', 'owner', 'slate-old', 'Slate', '{}', '2025-01-01 00:00:00'),
          ('look-new', 'owner', 'slate-new', 'slate', '{}', '2025-01-02 00:00:00'),
          ('look-existing', 'owner', 'slate-prefix', 'slate [looknew]', '{}', '2025-01-03 00:00:00'),
          ('look-existing-full', 'owner', 'slate-full', 'slate [look-new]', '{}', '2025-01-04 00:00:00')
      `);

      expect(() => db.exec(migration("0004_gallery_management.sql"))).not.toThrow();

      const looks = db.prepare("SELECT id, slug, name, name_key FROM themes ORDER BY id").all() as Array<{
        id: string;
        slug: string;
        name: string;
        name_key: string;
      }>;
      const index = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get("themes_active_owner_name") as { name: string } | undefined;

      expect(index?.name).toBe("themes_active_owner_name");
      expect(looks).toHaveLength(4);
      expect(looks.map(({ id, slug }) => [id, slug])).toEqual([
        ["look-existing", "slate-prefix"],
        ["look-existing-full", "slate-full"],
        ["look-new", "slate-new"],
        ["look-old", "slate-old"],
      ]);
      expect(new Set(looks.map((look) => look.name_key)).size).toBe(4);
      expect(looks.find((look) => look.id === "look-old")?.name).toBe("Slate");
      expect(looks.find((look) => look.id === "look-new")?.name).not.toBe("slate");
      expect(looks.find((look) => look.id === "look-new")?.name).not.toBe("slate [looknew]");
      expect(looks.find((look) => look.id === "look-new")?.name).not.toBe("slate [look-new]");
      expect(looks.find((look) => look.id === "look-existing")?.name).toBe("slate [looknew]");
      expect(looks.find((look) => look.id === "look-existing-full")?.name).toBe("slate [look-new]");
    } finally {
      db.close();
    }
  });
});
