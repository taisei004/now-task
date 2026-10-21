import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
export function database() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(new URL("../../migrations/", import.meta.url))
    .filter((file) => file.endsWith(".sql"))
    .sort())
    db.exec(
      readFileSync(
        new URL(`../../migrations/${file}`, import.meta.url),
        "utf8",
      ),
    );
  const prepare = (sql: string) => {
    let args: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) {
        args = values;
        return statement;
      },
      async first() {
        return db.prepare(sql).get(...(args as never[])) ?? null;
      },
      async all() {
        return { results: db.prepare(sql).all(...(args as never[])) };
      },
      async run() {
        return db.prepare(sql).run(...(args as never[]));
      },
    };
    return statement;
  };
  return {
    db,
    binding: {
      prepare,
      async batch(statements: { run: () => unknown }[]) {
        db.exec("BEGIN");
        try {
          const result = [];
          for (const s of statements) result.push(await s.run());
          db.exec("COMMIT");
          return result;
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      },
    } as unknown as D1Database,
  };
}
