import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import chalk from "chalk";
import { normalizeText, slugify } from "~/utils/text";

const log = console.log;

/**
 * Geração da base de dados (.sqlite) a partir do seed do CEP Aberto.
 *
 * Lê os .zip em `src/modules/integrations/cepAberto/initialSeed`:
 *   - estados.cepaberto.zip → states.csv  (id, nome, uf)
 *   - cidades.cepaberto.zip → cities.csv  (id, nome, state_id)
 *   - <uf>/<uf>.cepaberto_parte_N.zip → CSV de CEPs sem cabeçalho:
 *       cep, logradouro, complemento, bairro, city_id, state_id
 *
 * Os CSVs de CEP têm campos com vírgulas internas protegidas por aspas
 * (RFC 4180), então NÃO dá para usar split(","). O parser abaixo trata aspas.
 *
 * Saída: database/enderecos-brasil.sqlite com estados, cidades, bairros, ruas
 * (logradouros) e endereços (CEPs), além de uma tabela `metadata`.
 *
 * Requisito: o utilitário `unzip` precisa estar no PATH (Bun não lê .zip nativo).
 */

// ---- Caminhos ----------------------------------------------------------------
const ROOT = resolve(import.meta.dir, "../..");
const SEED_DIR = join(ROOT, "src/modules/integrations/cepAberto/initialSeed");
const OUTPUT_PATH = join(ROOT, "database/enderecos-brasil.sqlite");

const STATES_ZIP = join(SEED_DIR, "estados.cepaberto.zip");
const CITIES_ZIP = join(SEED_DIR, "cidades.cepaberto.zip");

// ---- Parser CSV (RFC 4180) ---------------------------------------------------
/** Faz parse de um CSV inteiro tratando aspas, aspas escapadas ("") e CRLF. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') inQuotes = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  // Último campo/linha quando o arquivo não termina com quebra de linha.
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

// ---- Leitura dos .zip --------------------------------------------------------
/** Extrai para a memória o (único) CSV de dentro de um .zip via `unzip -p`. */
async function readZipCsv(zipPath: string): Promise<string> {
  const proc = Bun.spawn(["unzip", "-p", zipPath], { stderr: "pipe" });
  const text = await new Response(proc.stdout).text();
  const code = await proc.exited;

  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Falha ao descompactar ${zipPath} (código ${code}): ${stderr}`);
  }

  return text;
}

// ---- Schema ------------------------------------------------------------------
const SCHEMA = /* sql */ `
  CREATE TABLE states (
    id   INTEGER PRIMARY KEY,
    nome TEXT NOT NULL,
    uf   TEXT NOT NULL UNIQUE,
    slug TEXT  -- preenchido depois da carga (gerarSlugs); índice UNIQUE global
  );

  CREATE TABLE cities (
    id       INTEGER PRIMARY KEY,
    nome     TEXT NOT NULL,
    state_id INTEGER NOT NULL REFERENCES states(id),
    slug     TEXT  -- UNIQUE(state_id, slug)
  );

  CREATE TABLE neighborhoods (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    nome    TEXT NOT NULL,
    city_id INTEGER NOT NULL REFERENCES cities(id),
    slug    TEXT,  -- UNIQUE(city_id, slug)
    UNIQUE (nome, city_id)
  );

  CREATE TABLE streets (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    nome            TEXT NOT NULL,
    neighborhood_id INTEGER REFERENCES neighborhoods(id),
    city_id         INTEGER NOT NULL REFERENCES cities(id),
    slug            TEXT,  -- UNIQUE(city_id, neighborhood_id, slug)
    UNIQUE (nome, neighborhood_id, city_id)
  );

  CREATE TABLE addresses (
    cep             TEXT PRIMARY KEY,
    logradouro      TEXT,
    complemento     TEXT,
    bairro          TEXT,
    street_id       INTEGER REFERENCES streets(id),
    neighborhood_id INTEGER REFERENCES neighborhoods(id),
    city_id         INTEGER NOT NULL,
    state_id        INTEGER NOT NULL
  );

  CREATE TABLE metadata (
    chave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
  );

  -- Tabela de busca: uma linha por entidade pesquisável (estado/cidade/bairro/rua).
  -- A coluna 'busca' é indexada pelo FTS5; 'peso' permite ranquear o tipo mais
  -- abrangente primeiro (estado < cidade < bairro < rua) como desempate.
  CREATE TABLE locations (
    id              INTEGER PRIMARY KEY,
    tipo            TEXT NOT NULL,
    peso            INTEGER NOT NULL,          -- estado1 cidade2 bairro3 rua/cidade4 rua/bairro5
    relevancia      INTEGER NOT NULL DEFAULT 0, -- nº de CEPs abaixo da entidade (popularidade)
    slug            TEXT,                      -- slug DA ENTIDADE (folha); preenchido em gerarSlugs
    logradouro      TEXT,                      -- nome da rua (só p/ tipo 'rua'); compõe o label
    cep             TEXT,                      -- CEP único, quando a entidade resolve p/ 1 só
    busca           TEXT NOT NULL,           -- texto indexado pelo FTS5 (com acento)
    busca_norm      TEXT NOT NULL DEFAULT '', -- mesmo texto normalizado (p/ match exato)
    uf              TEXT NOT NULL,
    state_id        INTEGER NOT NULL REFERENCES states(id),
    city_id         INTEGER REFERENCES cities(id),
    neighborhood_id INTEGER REFERENCES neighborhoods(id),
    street_id       INTEGER REFERENCES streets(id)
  );
`;

/** Índices criados só no fim, depois da carga (insert mais rápido). */
const INDEXES = /* sql */ `
  CREATE INDEX idx_cities_state       ON cities (state_id);
  CREATE INDEX idx_cities_nome        ON cities (nome);
  CREATE INDEX idx_neighborhoods_city ON neighborhoods (city_id);
  CREATE INDEX idx_streets_city       ON streets (city_id);
  CREATE INDEX idx_streets_neigh      ON streets (neighborhood_id);
  CREATE INDEX idx_streets_nome       ON streets (nome);
  CREATE INDEX idx_addresses_city     ON addresses (city_id);
  CREATE INDEX idx_addresses_state    ON addresses (state_id);
  CREATE INDEX idx_addresses_street   ON addresses (street_id);
  CREATE INDEX idx_addresses_neigh    ON addresses (neighborhood_id);
  CREATE INDEX idx_addresses_logr     ON addresses (logradouro);
`;

/**
 * Índices UNIQUE dos slugs — criados SÓ depois de `gerarSlugs` (senão os NULLs
 * iniciais e/ou colisões quebrariam a criação). Escopo de unicidade (handoff §1):
 *   state        → global
 *   city         → dentro do estado
 *   neighborhood → dentro da cidade
 *   street       → dentro da cidade E do bairro
 * (NULL em neighborhood_id conta como distinto no UNIQUE do SQLite; ruas sem
 * bairro só são acessadas pela rua agregada — ver locations peso 4.)
 */
const SLUG_INDEXES = /* sql */ `
  CREATE UNIQUE INDEX idx_states_slug        ON states (slug);
  CREATE UNIQUE INDEX idx_cities_slug        ON cities (state_id, slug);
  CREATE UNIQUE INDEX idx_neighborhoods_slug ON neighborhoods (city_id, slug);
  CREATE UNIQUE INDEX idx_streets_slug       ON streets (city_id, neighborhood_id, slug);
`;

/**
 * Atribui slugs únicos dentro de um escopo, de forma DETERMINÍSTICA e ESTÁVEL.
 * A ordem de chamada (sempre por id/inserção crescente) decide quem fica com o
 * slug "limpo"; colisões seguintes recebem sufixo `_2`, `_3`, … e são persistidas,
 * para a URL nunca mudar. `scope` separa os universos de unicidade (ex.: o id do
 * estado para cidades). Nome que vira slug vazio (raro) cai em "x".
 */
function criarSlugifier() {
  const usadosPorEscopo = new Map<string, Set<string>>();
  return (scope: string, nome: string): string => {
    const base = slugify(nome) || "x";
    let usados = usadosPorEscopo.get(scope);
    if (!usados) {
      usados = new Set();
      usadosPorEscopo.set(scope, usados);
    }
    let slug = base;
    let n = 2;
    while (usados.has(slug)) slug = `${base}_${n++}`;
    usados.add(slug);
    return slug;
  };
}

interface SlugRow {
  id: number;
  nome: string;
  scope: string;
}

/** Gera slug para uma tabela normalizada, em transação. `select` ordena por id. */
function gerarSlugsTabela(
  db: Database,
  tabela: string,
  select: string
): void {
  const rows = db.query(select).all() as SlugRow[];
  const slugFor = criarSlugifier();
  const update = db.query(`UPDATE ${tabela} SET slug = ? WHERE id = ?`);
  db.transaction(() => {
    for (const row of rows) update.run(slugFor(row.scope, row.nome), row.id);
  })();
}

/**
 * Preenche `slug` em states/cities/neighborhoods/streets e cria os índices UNIQUE.
 * Ordem por id = ordem de inserção → resultado reproduzível entre gerações.
 */
function gerarSlugs(db: Database): void {
  gerarSlugsTabela(
    db,
    "states",
    "SELECT id, nome, '' AS scope FROM states ORDER BY id"
  );
  gerarSlugsTabela(
    db,
    "cities",
    "SELECT id, nome, state_id AS scope FROM cities ORDER BY state_id, id"
  );
  gerarSlugsTabela(
    db,
    "neighborhoods",
    "SELECT id, nome, city_id AS scope FROM neighborhoods ORDER BY city_id, id"
  );
  gerarSlugsTabela(
    db,
    "streets",
    `SELECT id, nome, city_id || ':' || COALESCE(neighborhood_id, 0) AS scope
     FROM streets ORDER BY city_id, neighborhood_id, id`
  );
  db.run(SLUG_INDEXES);
}

/**
 * Preenche `locations.slug` com o slug DA ENTIDADE folha de cada linha:
 *   estado/cidade/bairro/rua-por-bairro → copiado da tabela normalizada (1 UPDATE
 *   cada). A rua AGREGADA por cidade (peso 4) não tem linha em `streets`, então o
 *   slug é gerado aqui a partir do logradouro, único dentro da cidade (desempate
 *   estável: mais popular primeiro). É esse slug que o /resolve/.../rua/:slug usa.
 */
function gerarSlugsLocations(db: Database): void {
  db.run(`
    UPDATE locations SET slug = (SELECT slug FROM states s WHERE s.id = locations.state_id)
      WHERE tipo = 'estado';
    UPDATE locations SET slug = (SELECT slug FROM cities c WHERE c.id = locations.city_id)
      WHERE tipo = 'cidade';
    UPDATE locations SET slug = (SELECT slug FROM neighborhoods n WHERE n.id = locations.neighborhood_id)
      WHERE tipo = 'bairro';
    UPDATE locations SET slug = (SELECT slug FROM streets st WHERE st.id = locations.street_id)
      WHERE tipo = 'rua' AND peso = 5;
  `);

  // Rua agregada (peso 4): slug a partir do logradouro, único na cidade.
  const aggRows = db
    .query(
      `SELECT id, city_id AS scope, logradouro AS nome
       FROM locations
       WHERE tipo = 'rua' AND peso = 4
       ORDER BY city_id, relevancia DESC, logradouro, id`
    )
    .all() as SlugRow[];
  const slugFor = criarSlugifier();
  const update = db.query("UPDATE locations SET slug = ? WHERE id = ?");
  db.transaction(() => {
    for (const row of aggRows) update.run(slugFor(row.scope, row.nome), row.id);
  })();

  // Resolve da rua agregada filtra por (city_id, slug) na tabela locations.
  db.run("CREATE INDEX idx_locations_city_slug ON locations (city_id, slug);");
}

/**
 * Popula `locations` a partir das tabelas normalizadas (uma linha por entidade).
 * O texto em `busca` mantém os acentos — o tokenizer do FTS5 (remove_diacritics)
 * cuida da normalização na indexação e na consulta.
 */
const BUILD_LOCATIONS = /* sql */ `
  -- ESTADO (peso 1)
  INSERT INTO locations_stage (tipo, peso, relevancia, busca, uf, state_id)
  SELECT 'estado', 1, (SELECT COUNT(*) FROM addresses a WHERE a.state_id = s.id),
         s.nome || ' ' || s.uf, s.uf, s.id
  FROM states s;

  -- CIDADE (peso 2)
  INSERT INTO locations_stage (tipo, peso, relevancia, cep, busca, uf, state_id, city_id)
  SELECT 'cidade', 2, COALESCE(cc.n, 0),
         CASE WHEN cc.n = 1 THEN cc.anycep END,
         c.nome || ' ' || s.nome || ' ' || s.uf, s.uf, s.id, c.id
  FROM cities c
  JOIN states s ON s.id = c.state_id
  LEFT JOIN (SELECT city_id, COUNT(*) n, MIN(cep) anycep FROM addresses GROUP BY city_id) cc
         ON cc.city_id = c.id;

  -- BAIRRO (peso 3)
  INSERT INTO locations_stage (tipo, peso, relevancia, cep, busca, uf, state_id, city_id, neighborhood_id)
  SELECT 'bairro', 3, COALESCE(nc.n, 0),
         CASE WHEN nc.n = 1 THEN nc.anycep END,
         n.nome || ' ' || c.nome || ' ' || s.nome || ' ' || s.uf,
         s.uf, s.id, c.id, n.id
  FROM neighborhoods n
  JOIN cities c ON c.id = n.city_id
  JOIN states s ON s.id = c.state_id
  LEFT JOIN (SELECT neighborhood_id, COUNT(*) n, MIN(cep) anycep FROM addresses
             WHERE neighborhood_id IS NOT NULL GROUP BY neighborhood_id) nc
         ON nc.neighborhood_id = n.id;

  -- RUA agregada por cidade — 1ª camada (peso 4): "Rua, Cidade, Estado"
  INSERT INTO locations_stage (tipo, peso, relevancia, logradouro, cep, busca, uf, state_id, city_id)
  SELECT 'rua', 4, g.n, g.logradouro,
         CASE WHEN g.n = 1 THEN g.anycep END,
         g.logradouro || ' ' || c.nome || ' ' || s.nome || ' ' || s.uf,
         s.uf, s.id, c.id
  FROM (SELECT city_id, logradouro, COUNT(*) n, MIN(cep) anycep
        FROM addresses WHERE logradouro IS NOT NULL
        GROUP BY city_id, logradouro) g
  JOIN cities c ON c.id = g.city_id
  JOIN states s ON s.id = c.state_id;

  -- RUA detalhada por bairro (peso 5): "Rua, Bairro, Cidade, Estado"
  -- só para ruas que têm bairro (sem bairro, a agregada acima já cobre).
  INSERT INTO locations_stage (tipo, peso, relevancia, logradouro, cep, busca, uf, state_id, city_id, neighborhood_id, street_id)
  SELECT 'rua', 5, COALESCE(sc.n, 0), st.nome,
         CASE WHEN sc.n = 1 THEN sc.anycep END,
         st.nome || ' ' || n.nome || ' ' || c.nome || ' ' || s.nome || ' ' || s.uf,
         s.uf, s.id, c.id, st.neighborhood_id, st.id
  FROM streets st
  JOIN neighborhoods n ON n.id = st.neighborhood_id
  JOIN cities c ON c.id = st.city_id
  JOIN states s ON s.id = c.state_id
  LEFT JOIN (SELECT street_id, COUNT(*) n, MIN(cep) anycep FROM addresses
             WHERE street_id IS NOT NULL GROUP BY street_id) sc
         ON sc.street_id = st.id;
`;

// ---- Geração -----------------------------------------------------------------
async function generate(): Promise<void> {
  const startedAt = Date.now();

  if (!existsSync(SEED_DIR)) {
    throw new Error(`Pasta de seed não encontrada: ${SEED_DIR}`);
  }

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  if (existsSync(OUTPUT_PATH)) unlinkSync(OUTPUT_PATH);

  log(chalk.blue.bold("Iniciando geração da base de dados (CEP Aberto)"));
  log(chalk.gray(`Origem:  ${SEED_DIR}`));
  log(chalk.gray(`Destino: ${OUTPUT_PATH}\n`));

  const db = new Database(OUTPUT_PATH, { create: true });
  // Build offline: prioriza velocidade em vez de durabilidade.
  db.run("PRAGMA journal_mode = MEMORY;");
  db.run("PRAGMA synchronous = OFF;");
  db.run("PRAGMA foreign_keys = OFF;");
  db.run(SCHEMA);

  // --- Estados ---------------------------------------------------------------
  const insState = db.query("INSERT INTO states (id, nome, uf) VALUES (?, ?, ?)");
  const statesRows = parseCsv(await readZipCsv(STATES_ZIP));
  let statesCount = 0;
  db.transaction(() => {
    for (const r of statesRows) {
      if (r.length < 3) continue;
      insState.run(Number(r[0]), r[1].trim(), r[2].trim());
      statesCount++;
    }
  })();
  log(chalk.green(`✓ Estados:  ${statesCount.toLocaleString("pt-BR")}`));

  // --- Cidades ---------------------------------------------------------------
  const insCity = db.query("INSERT INTO cities (id, nome, state_id) VALUES (?, ?, ?)");
  const citiesRows = parseCsv(await readZipCsv(CITIES_ZIP));
  let citiesCount = 0;
  db.transaction(() => {
    for (const r of citiesRows) {
      if (r.length < 3) continue;
      insCity.run(Number(r[0]), r[1].trim(), Number(r[2]));
      citiesCount++;
    }
  })();
  log(chalk.green(`✓ Cidades:  ${citiesCount.toLocaleString("pt-BR")}\n`));

  // --- Endereços (CEPs), bairros e ruas --------------------------------------
  const insNeigh = db.query("INSERT INTO neighborhoods (nome, city_id) VALUES (?, ?)");
  const insStreet = db.query(
    "INSERT INTO streets (nome, neighborhood_id, city_id) VALUES (?, ?, ?)"
  );
  const insAddr = db.query(
    `INSERT OR IGNORE INTO addresses
       (cep, logradouro, complemento, bairro, street_id, neighborhood_id, city_id, state_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  // Caches em memória evitam SELECTs e garantem a deduplicação de bairros/ruas.
  const neighborhoodCache = new Map<string, number>();
  const streetCache = new Map<string, number>();

  const getNeighborhoodId = (cityId: number, nome: string): number | null => {
    if (!nome) return null;
    const key = `${cityId} ${nome}`;
    const cached = neighborhoodCache.get(key);
    if (cached !== undefined) return cached;
    const id = Number(insNeigh.run(nome, cityId).lastInsertRowid);
    neighborhoodCache.set(key, id);
    return id;
  };

  const getStreetId = (
    cityId: number,
    neighborhoodId: number | null,
    nome: string
  ): number | null => {
    if (!nome) return null;
    const key = `${cityId} ${neighborhoodId ?? 0} ${nome}`;
    const cached = streetCache.get(key);
    if (cached !== undefined) return cached;
    const id = Number(insStreet.run(nome, neighborhoodId, cityId).lastInsertRowid);
    streetCache.set(key, id);
    return id;
  };

  const glob = new Bun.Glob("*/*.cepaberto_parte_*.zip");
  const partFiles = [...glob.scanSync({ cwd: SEED_DIR })].sort();

  let totalAddresses = 0;
  let ignored = 0;
  let malformed = 0;
  let lastUf = "";

  for (const relativePath of partFiles) {
    const uf = relativePath.slice(0, 2).toUpperCase();
    const rows = parseCsv(await readZipCsv(join(SEED_DIR, relativePath)));

    db.transaction(() => {
      for (const r of rows) {
        if (r.length === 1 && r[0] === "") continue; // linha em branco
        if (r.length < 6) {
          malformed++;
          continue;
        }

        const cep = r[0].trim().padStart(8, "0");
        const logradouro = r[1].trim() || null;
        const complemento = r[2].trim() || null;
        const bairro = r[3].trim() || null;
        const cityId = Number(r[4]);
        const stateId = Number(r[5]);

        if (!cep || !Number.isFinite(cityId) || !Number.isFinite(stateId)) {
          malformed++;
          continue;
        }

        const neighborhoodId = getNeighborhoodId(cityId, bairro ?? "");
        const streetId = getStreetId(cityId, neighborhoodId, logradouro ?? "");

        const result = insAddr.run(
          cep,
          logradouro,
          complemento,
          bairro,
          streetId,
          neighborhoodId,
          cityId,
          stateId
        );

        if (result.changes === 0) ignored++;
        else totalAddresses++;
      }
    })();

    if (uf !== lastUf) {
      log(chalk.gray(`  ${uf} processado…`));
      lastUf = uf;
    }
  }

  log(chalk.green(`\n✓ Bairros:    ${neighborhoodCache.size.toLocaleString("pt-BR")}`));
  log(chalk.green(`✓ Ruas:       ${streetCache.size.toLocaleString("pt-BR")}`));
  log(chalk.green(`✓ Endereços:  ${totalAddresses.toLocaleString("pt-BR")}`));
  if (ignored > 0) log(chalk.yellow(`  (${ignored} CEPs duplicados ignorados)`));
  if (malformed > 0) log(chalk.yellow(`  (${malformed} linhas malformadas ignoradas)`));

  // --- Índices + metadados ---------------------------------------------------
  log(chalk.blue("\nCriando índices…"));
  db.run(INDEXES);

  // --- Slugs (URLs semânticas) -----------------------------------------------
  log(chalk.blue("Gerando slugs (estados/cidades/bairros/ruas)…"));
  gerarSlugs(db);

  // --- Tabela de busca (locations) + índice FTS5 -----------------------------
  log(chalk.blue("Montando tabela de busca (locations)…"));
  // Monta numa staging e copia ordenando por popularidade (relevancia DESC). Assim o
  // id (= rowid do FTS) fica em ordem de relevância, e a busca usa `ORDER BY rowid
  // LIMIT k` — o caminho rápido do FTS5 (early-termination), evitando ranquear milhões.
  db.run(`
    CREATE TABLE locations_stage (
      tipo TEXT, peso INTEGER, relevancia INTEGER, logradouro TEXT, cep TEXT,
      busca TEXT, uf TEXT, state_id INTEGER, city_id INTEGER,
      neighborhood_id INTEGER, street_id INTEGER
    );
  `);
  db.run(BUILD_LOCATIONS);
  db.run(`
    INSERT INTO locations
      (tipo, peso, relevancia, logradouro, cep, busca, uf, state_id, city_id, neighborhood_id, street_id)
    SELECT tipo, peso, relevancia, logradouro, cep, busca, uf, state_id, city_id, neighborhood_id, street_id
    FROM locations_stage
    ORDER BY relevancia DESC, peso;
  `);
  db.run("DROP TABLE locations_stage;");
  db.run("CREATE INDEX idx_locations_tipo ON locations (tipo);");
  db.run("CREATE INDEX idx_locations_city ON locations (city_id);");

  // Slug folha de cada location (+ slug da rua agregada por cidade, peso 4).
  log(chalk.blue("Aplicando slugs na tabela de busca (locations)…"));
  gerarSlugsLocations(db);

  // busca_norm: versão sem acento/minúscula de `busca`, para detectar match exato
  // no ranking. (bun:sqlite não tem db.function, então normalizamos em JS.)
  log(chalk.blue("Normalizando texto de busca…"));
  const updateNorm = db.query("UPDATE locations SET busca_norm = ? WHERE id = ?");
  const rowsToNorm = db.query("SELECT id, busca FROM locations").all() as {
    id: number;
    busca: string;
  }[];
  db.transaction(() => {
    for (const row of rowsToNorm) updateNorm.run(normalizeText(row.busca), row.id);
  })();

  log(chalk.blue("Indexando busca textual (FTS5)…"));
  db.run(`
    CREATE VIRTUAL TABLE locations_fts USING fts5(
      busca,
      content = 'locations',
      content_rowid = 'id',
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);
  db.run("INSERT INTO locations_fts(locations_fts) VALUES('rebuild');");

  const locationsCount = (
    db.query("SELECT COUNT(*) AS n FROM locations").get() as { n: number }
  ).n;
  log(chalk.green(`✓ Locations:  ${locationsCount.toLocaleString("pt-BR")} (índice de busca)`));

  const orphanCities = (
    db
      .query(
        "SELECT COUNT(*) AS n FROM addresses a LEFT JOIN cities c ON c.id = a.city_id WHERE c.id IS NULL"
      )
      .get() as { n: number }
  ).n;

  const insMeta = db.query("INSERT INTO metadata (chave, valor) VALUES (?, ?)");
  const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  const meta: Record<string, string> = {
    fonte: "CEP Aberto (initialSeed)",
    gerado_em: new Date().toISOString(),
    estados: String(statesCount),
    cidades: String(citiesCount),
    bairros: String(neighborhoodCache.size),
    ruas: String(streetCache.size),
    enderecos: String(totalAddresses),
    locations_busca: String(locationsCount),
    ceps_duplicados: String(ignored),
    linhas_malformadas: String(malformed),
    cidades_orfas: String(orphanCities),
    duracao_segundos: durationSec,
  };
  db.transaction(() => {
    for (const [chave, valor] of Object.entries(meta)) insMeta.run(chave, valor);
  })();

  log(chalk.blue("Otimizando o arquivo (VACUUM)…"));
  db.run("VACUUM;");
  db.close();

  if (orphanCities > 0) {
    log(
      chalk.yellow(
        `\n⚠ ${orphanCities.toLocaleString("pt-BR")} endereços referenciam cidades fora de cities.csv`
      )
    );
  }

  log(chalk.blue.bold(`\nConcluído em ${durationSec}s → ${OUTPUT_PATH}`));
}

generate().catch((error: unknown) => {
  log(chalk.red.bold("Erro ao gerar a base de dados:"));
  log(chalk.red(error instanceof Error ? error.stack ?? error.message : String(error)));
  process.exit(1);
});
