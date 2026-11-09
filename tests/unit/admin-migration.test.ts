import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

describe("admin overview migration", () => {
  it("adds a nullable last login timestamp to existing users", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(readFileSync(resolve("migrations", "0001_init.sql"), "utf8"));
      db.exec(readFileSync(resolve("migrations", "0008_users_last_login_at.sql"), "utf8"));
      db.exec("INSERT INTO users (id, login) VALUES ('12345', 'viewer')");

      const user = db.prepare("SELECT last_login_at FROM users WHERE id = '12345'").get() as { last_login_at: string | null };
      expect(user.last_login_at).toBeNull();
    } finally {
      db.close();
    }
  });
});
