import { readdir, readFile } from "node:fs/promises";
import postgres from "postgres";

const url = process.env.DATABASE_URL;

if (url === undefined || url === "") {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const directory = new URL("../migrations/", import.meta.url);
const sql = postgres(url, { max: 1, onnotice: () => {} });

await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;

const applied = new Set(
  (await sql<{ name: string }[]>`select name from schema_migrations`).map((row) => row.name),
);
const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).toSorted();

for (const name of names.filter((candidate) => !applied.has(candidate))) {
  const statements = await readFile(new URL(name, directory), "utf8");

  await sql.begin(async (transaction) => {
    await transaction.unsafe(statements);
    await transaction`insert into schema_migrations (name) values (${name})`;
  });

  console.log(name);
}

await sql.end();
