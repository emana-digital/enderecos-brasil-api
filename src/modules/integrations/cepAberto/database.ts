import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Conexão (somente leitura) com a base gerada pelo seed do CEP Aberto.
 * Caminho padrão: <cwd>/database/enderecos-brasil.sqlite (override via SQLITE_PATH).
 *
 * Em produção o binário é compilado (`bun build --compile`), então `import.meta.dir`
 * aponta para o filesystem virtual do Bun e não serve para localizar arquivos no disco.
 * Por isso resolvemos a partir do cwd e deixamos produção setar SQLITE_PATH explícito.
 */
const DEFAULT_DB_PATH = resolve(
  process.cwd(),
  "database/enderecos-brasil.sqlite"
);

const DB_PATH = process.env.SQLITE_PATH ?? DEFAULT_DB_PATH;

if (!existsSync(DB_PATH)) {
  throw new Error(
    `Base SQLite não encontrada em ${DB_PATH}. Gere com: bun run db:seed:generate`
  );
}

export const db = new Database(DB_PATH, { readonly: true });
