import { db } from "./database";
import { normalizeText, toFtsQuery } from "~/utils/text";

// ---- Tipos -------------------------------------------------------------------
export type LocationTipo = "estado" | "cidade" | "bairro" | "rua";
export type ResultTipo = LocationTipo | "cep";

/** Nível de uma página semântica (estado → cidade → bairro → rua). */
export type PathLevel = LocationTipo;

/**
 * Um segmento do caminho de slugs, do topo até o nível. `href` é o caminho
 * absoluto JÁ PRONTO até este segmento (o front não monta nada): para a rua
 * agregada a nível de cidade o `href` carrega o namespace literal `/rua/`.
 */
export interface PathSegment {
  level: PathLevel;
  nome: string;
  slug: string;
  href: string;
}

export interface LocationResult {
  id: number | null; // id da tabela locations; null quando o resultado vem de um CEP
  tipo: ResultTipo;
  label: string; // nomes por extenso: "Rua Tal, Bairro, Cidade, Estado"
  logradouro: string | null;
  bairro: string | null;
  cidade: string | null;
  estado: string;
  uf: string;
  stateId: number;
  cityId: number | null;
  neighborhoodId: number | null;
  streetId: number | null;
  cep: string | null;
  relevancia: number;
  path: PathSegment[] | null; // caminho de slugs (null em resultados tipo 'cep')
  href: string; // destino pronto: rua/bairro/cidade/estado ou /cep/:cep
}

export interface CepDetail {
  cep: string;
  logradouro: string | null;
  complemento: string | null;
  bairro: string | null;
  stateId: number;
  uf: string;
  estado: string;
  cityId: number;
  cidade: string;
  neighborhoodId: number | null;
  streetId: number | null;
  path: PathSegment[]; // caminho de slugs até a rua (ou até onde houver)
  href: string; // "/cep/:cep"
}

// ---- Caminho de slugs (href cumulativo) -------------------------------------
/**
 * Nó de uma cadeia topo→folha usada para montar `PathSegment[]`. `aggregated`
 * marca a rua a nível de cidade, que vive sob o namespace literal `/rua/` para
 * não colidir com bairro no 3º segmento da URL.
 */
interface ChainNode {
  level: PathLevel;
  nome: string;
  slug: string;
  aggregated?: boolean;
}

/** Transforma a cadeia em segmentos, acumulando o href (com namespace `/rua/`). */
const buildSegments = (chain: ChainNode[]): PathSegment[] => {
  let href = "";
  return chain.map((node) => {
    if (node.level === "rua" && node.aggregated) href += "/rua";
    href += `/${node.slug}`;
    return { level: node.level, nome: node.nome, slug: node.slug, href };
  });
};

// ---- Helpers -----------------------------------------------------------------
const clampLimit = (limit: number | undefined, max: number, fallback: number): number =>
  Math.min(Math.max(limit ?? fallback, 1), max);

const formatCep = (cep: string): string =>
  cep.length === 8 ? `${cep.slice(0, 5)}-${cep.slice(5)}` : cep;

/** Junta os nomes não-nulos com vírgula: ["Rua X", null, "Cidade", "Estado"] → "Rua X, Cidade, Estado". */
const composeLabel = (parts: (string | null)[]): string =>
  parts.filter((part): part is string => Boolean(part)).join(", ");

/** Query "é um CEP?" — só dígitos e separadores, com pelo menos 3 dígitos. */
const isCepQuery = (q: string): boolean =>
  /^[\s\d.-]+$/.test(q) && q.replace(/\D/g, "").length >= 3;

// ---- Busca principal (nome OU CEP) ------------------------------------------
interface NameRow {
  id: number;
  tipo: LocationTipo;
  peso: number; // 4 = rua agregada por cidade; 5 = rua por bairro
  logradouro: string | null;
  bairro: string | null;
  cidade: string | null;
  estado: string;
  cep: string | null;
  uf: string;
  stateId: number;
  cityId: number | null;
  neighborhoodId: number | null;
  streetId: number | null;
  relevancia: number;
  estadoSlug: string;
  cidadeSlug: string | null;
  bairroSlug: string | null;
  leafSlug: string | null; // slug da própria entidade (locations.slug)
}

interface CepRow {
  cep: string;
  logradouro: string | null;
  bairro: string | null;
  stateId: number;
  uf: string;
  estado: string;
  cityId: number;
  cidade: string;
  neighborhoodId: number | null;
  streetId: number | null;
}

// Pega os K candidatos mais POPULARES que casam no FTS. Como o id da locations foi
// gravado em ordem de popularidade (no seed), `ORDER BY rowid LIMIT k` é o caminho
// rápido do FTS5 (early-termination) — não calcula bm25 sobre milhões de matches.
// Depois re-ranqueia esses K por exatidão (tier) > popularidade (id) > peso (camada).
const SEARCH_CANDIDATES = 300;

const searchNameStmt = db.query(`
  WITH hits AS (
    SELECT l.id AS id
    FROM locations_fts f
    JOIN locations l ON l.id = f.rowid
    WHERE f.busca MATCH $match
      AND ($tipo IS NULL OR l.tipo = $tipo)
      AND ($uf   IS NULL OR l.uf   = $uf)
    ORDER BY f.rowid
    LIMIT ${SEARCH_CANDIDATES}
  )
  SELECT
    l.id, l.tipo, l.peso, l.uf,
    l.logradouro,
    n.nome AS bairro,
    c.nome AS cidade,
    s.nome AS estado,
    l.cep,
    l.state_id        AS stateId,
    l.city_id         AS cityId,
    l.neighborhood_id AS neighborhoodId,
    l.street_id       AS streetId,
    l.relevancia,
    s.slug AS estadoSlug,
    c.slug AS cidadeSlug,
    n.slug AS bairroSlug,
    l.slug AS leafSlug
  FROM hits h
  JOIN locations l       ON l.id = h.id
  JOIN states s          ON s.id = l.state_id
  LEFT JOIN cities c        ON c.id = l.city_id
  LEFT JOIN neighborhoods n ON n.id = l.neighborhood_id
  ORDER BY
    CASE WHEN l.busca_norm = $qn      THEN 0   -- igualdade total
         WHEN l.busca_norm LIKE $prefix THEN 1 -- começa com o que foi digitado
         ELSE 2 END,
    l.id,    -- popularidade (id menor = mais popular)
    l.peso   -- rua agregada (4) antes da rua por bairro (5)
  LIMIT $limit
`);

const searchCepStmt = db.query(`
  SELECT
    a.cep, a.logradouro, a.bairro,
    a.state_id        AS stateId, s.uf, s.nome AS estado,
    a.city_id         AS cityId,  c.nome AS cidade,
    a.neighborhood_id AS neighborhoodId,
    a.street_id       AS streetId
  FROM addresses a
  JOIN states s ON s.id = a.state_id
  JOIN cities c ON c.id = a.city_id
  WHERE a.cep BETWEEN $lo AND $hi
  ORDER BY a.cep
  LIMIT $limit
`);

const cepRowToResult = (r: CepRow): LocationResult => ({
  id: null,
  tipo: "cep",
  label: `${formatCep(r.cep)} — ${composeLabel([r.logradouro, r.bairro, r.cidade, r.estado])}`,
  logradouro: r.logradouro,
  bairro: r.bairro,
  cidade: r.cidade,
  estado: r.estado,
  uf: r.uf,
  stateId: r.stateId,
  cityId: r.cityId,
  neighborhoodId: r.neighborhoodId,
  streetId: r.streetId,
  cep: r.cep,
  relevancia: 0,
  // Resultado de CEP linka direto pra página de CEP (a página resolve o caminho).
  path: null,
  href: `/cep/${r.cep}`,
});

/**
 * Monta a cadeia de slugs (topo→folha) a partir de uma linha de busca por nome.
 * A rua tem dois casos: peso 4 = agregada por cidade (sob `/rua/`); peso 5 = por
 * bairro (caminho de 4 níveis). Os slugs de pai vêm dos JOINs; a folha, de `leafSlug`.
 */
const nameRowToChain = (r: NameRow): ChainNode[] => {
  const chain: ChainNode[] = [
    { level: "estado", nome: r.estado, slug: r.estadoSlug },
  ];
  if (r.tipo === "estado") return chain;

  chain.push({ level: "cidade", nome: r.cidade ?? "", slug: r.cidadeSlug ?? "" });
  if (r.tipo === "cidade") return chain;

  if (r.tipo === "bairro") {
    chain.push({ level: "bairro", nome: r.bairro ?? "", slug: r.bairroSlug ?? "" });
    return chain;
  }

  // tipo === "rua"
  if (r.peso === 4) {
    chain.push({
      level: "rua",
      nome: r.logradouro ?? "",
      slug: r.leafSlug ?? "",
      aggregated: true,
    });
    return chain;
  }
  chain.push({ level: "bairro", nome: r.bairro ?? "", slug: r.bairroSlug ?? "" });
  chain.push({ level: "rua", nome: r.logradouro ?? "", slug: r.leafSlug ?? "" });
  return chain;
};

/**
 * Busca de locations aceitando nome (rua/bairro/cidade/estado) OU CEP.
 * - Texto: FTS5 com match exato priorizado (tiers) e ranqueado por popularidade.
 * - CEP (só dígitos): retorna os endereços com rua/bairro/cidade completos.
 */
export const searchLocations = (params: {
  q: string;
  tipo?: LocationTipo;
  uf?: string;
  limit?: number;
}): LocationResult[] => {
  const limit = clampLimit(params.limit, 50, 5);

  if (isCepQuery(params.q)) {
    const digits = params.q.replace(/\D/g, "").slice(0, 8);
    const rows = searchCepStmt.all({
      $lo: digits.padEnd(8, "0"),
      $hi: digits.padEnd(8, "9"),
      $limit: limit,
    }) as CepRow[];
    return rows.map(cepRowToResult);
  }

  const match = toFtsQuery(params.q);
  if (!match) return [];
  const qn = normalizeText(params.q);

  const rows = searchNameStmt.all({
    $match: match,
    $qn: qn,
    $prefix: `${qn}%`,
    $tipo: params.tipo ?? null,
    $uf: params.uf ? params.uf.toUpperCase() : null,
    $limit: limit,
  }) as NameRow[];

  return rows.map((r) => {
    const path = buildSegments(nameRowToChain(r));
    return {
      id: r.id,
      tipo: r.tipo,
      label: composeLabel([r.logradouro, r.bairro, r.cidade, r.estado]),
      logradouro: r.logradouro,
      bairro: r.bairro,
      cidade: r.cidade,
      estado: r.estado,
      uf: r.uf,
      stateId: r.stateId,
      cityId: r.cityId,
      neighborhoodId: r.neighborhoodId,
      streetId: r.streetId,
      cep: r.cep,
      relevancia: r.relevancia,
      path,
      href: path[path.length - 1].href,
    };
  });
};

// ---- Lookup exato por CEP ----------------------------------------------------
interface CepDetailRow {
  cep: string;
  logradouro: string | null;
  complemento: string | null;
  bairro: string | null;
  stateId: number;
  uf: string;
  estado: string;
  estadoSlug: string;
  cityId: number;
  cidade: string;
  cidadeSlug: string;
  neighborhoodId: number | null;
  bairroSlug: string | null;
  streetId: number | null;
  ruaSlug: string | null; // slug da rua POR BAIRRO (caminho de 4 níveis)
  ruaAggSlug: string | null; // slug da rua AGREGADA (quando o CEP não tem bairro)
}

const getCepStmt = db.query(`
  SELECT
    a.cep, a.logradouro, a.complemento, a.bairro,
    a.state_id        AS stateId, s.uf, s.nome AS estado, s.slug AS estadoSlug,
    a.city_id         AS cityId,  c.nome AS cidade, c.slug AS cidadeSlug,
    a.neighborhood_id AS neighborhoodId, n.slug AS bairroSlug,
    a.street_id       AS streetId, st.slug AS ruaSlug,
    (SELECT l.slug FROM locations l
       WHERE l.tipo = 'rua' AND l.peso = 4
         AND l.city_id = a.city_id AND l.logradouro = a.logradouro) AS ruaAggSlug
  FROM addresses a
  JOIN states s ON s.id = a.state_id
  JOIN cities c ON c.id = a.city_id
  LEFT JOIN neighborhoods n ON n.id = a.neighborhood_id
  LEFT JOIN streets st       ON st.id = a.street_id
  WHERE a.cep = $cep
`);

export const getCep = (cep: string): CepDetail | null => {
  const digits = cep.replace(/\D/g, "").padStart(8, "0");
  const row = getCepStmt.get({ $cep: digits }) as CepDetailRow | null;
  if (!row) return null;

  // Caminho de slugs até onde houver dado. Com bairro → rua é o caminho de 4
  // níveis (rua por bairro); sem bairro mas com rua → cai na rua agregada (`/rua/`).
  const chain: ChainNode[] = [
    { level: "estado", nome: row.estado, slug: row.estadoSlug },
    { level: "cidade", nome: row.cidade, slug: row.cidadeSlug },
  ];
  const temBairro = row.neighborhoodId !== null && row.bairroSlug !== null;
  if (temBairro) {
    chain.push({ level: "bairro", nome: row.bairro ?? "", slug: row.bairroSlug! });
  }
  if (row.logradouro) {
    if (temBairro && row.ruaSlug) {
      chain.push({ level: "rua", nome: row.logradouro, slug: row.ruaSlug });
    } else if (row.ruaAggSlug) {
      chain.push({
        level: "rua",
        nome: row.logradouro,
        slug: row.ruaAggSlug,
        aggregated: true,
      });
    }
  }

  return {
    cep: row.cep,
    logradouro: row.logradouro,
    complemento: row.complemento,
    bairro: row.bairro,
    stateId: row.stateId,
    uf: row.uf,
    estado: row.estado,
    cityId: row.cityId,
    cidade: row.cidade,
    neighborhoodId: row.neighborhoodId,
    streetId: row.streetId,
    path: buildSegments(chain),
    href: `/cep/${row.cep}`,
  };
};

// ---- Navegação / filtros (para o front montar visualizações) ----------------
const listStatesStmt = db.query(`
  SELECT
    s.id, s.nome, s.uf,
    (SELECT COUNT(*) FROM cities    c WHERE c.state_id = s.id) AS cidades,
    (SELECT COUNT(*) FROM addresses a WHERE a.state_id = s.id) AS ceps
  FROM states s
  ORDER BY s.nome
`);

export const listStates = () => listStatesStmt.all();

const listCitiesStmt = db.query(`
  SELECT
    c.id, c.nome, c.state_id AS stateId, s.uf,
    (SELECT COUNT(*) FROM addresses a WHERE a.city_id = c.id) AS ceps
  FROM cities c
  JOIN states s ON s.id = c.state_id
  WHERE ($uf IS NULL OR s.uf = $uf)
    AND ($stateId IS NULL OR c.state_id = $stateId)
  ORDER BY c.nome
  LIMIT $limit OFFSET $offset
`);

export const listCities = (params: {
  uf?: string;
  stateId?: number;
  limit?: number;
  offset?: number;
}) =>
  listCitiesStmt.all({
    $uf: params.uf ? params.uf.toUpperCase() : null,
    $stateId: params.stateId ?? null,
    $limit: clampLimit(params.limit, 5000, 200),
    $offset: params.offset ?? 0,
  });

const listNeighborhoodsStmt = db.query(`
  SELECT
    n.id, n.nome, n.city_id AS cityId,
    (SELECT COUNT(*) FROM addresses a WHERE a.neighborhood_id = n.id) AS ceps
  FROM neighborhoods n
  WHERE n.city_id = $cityId
  ORDER BY n.nome
  LIMIT $limit OFFSET $offset
`);

export const listNeighborhoods = (params: {
  cityId: number;
  limit?: number;
  offset?: number;
}) =>
  listNeighborhoodsStmt.all({
    $cityId: params.cityId,
    $limit: clampLimit(params.limit, 5000, 500),
    $offset: params.offset ?? 0,
  });

const listStreetsStmt = db.query(`
  SELECT
    st.id, st.nome, st.city_id AS cityId, st.neighborhood_id AS neighborhoodId,
    (SELECT COUNT(*) FROM addresses a WHERE a.street_id = st.id) AS ceps
  FROM streets st
  WHERE ($cityId IS NULL OR st.city_id = $cityId)
    AND ($neighborhoodId IS NULL OR st.neighborhood_id = $neighborhoodId)
  ORDER BY st.nome
  LIMIT $limit OFFSET $offset
`);

export const listStreets = (params: {
  cityId?: number;
  neighborhoodId?: number;
  limit?: number;
  offset?: number;
}) => {
  // Sem nenhum filtro seria um sort de 1M+ ruas — exige cidade ou bairro.
  if (params.cityId === undefined && params.neighborhoodId === undefined) return [];
  return listStreetsStmt.all({
    $cityId: params.cityId ?? null,
    $neighborhoodId: params.neighborhoodId ?? null,
    $limit: clampLimit(params.limit, 5000, 500),
    $offset: params.offset ?? 0,
  });
};

const listCepsStmt = db.query(`
  SELECT
    a.cep, a.logradouro, a.complemento, a.bairro,
    a.city_id         AS cityId,
    a.neighborhood_id AS neighborhoodId,
    a.street_id       AS streetId
  FROM addresses a
  WHERE ($cityId IS NULL OR a.city_id = $cityId)
    AND ($neighborhoodId IS NULL OR a.neighborhood_id = $neighborhoodId)
    AND ($streetId IS NULL OR a.street_id = $streetId)
  ORDER BY a.cep
  LIMIT $limit OFFSET $offset
`);

export const listCeps = (params: {
  cityId?: number;
  neighborhoodId?: number;
  streetId?: number;
  limit?: number;
  offset?: number;
}) =>
  listCepsStmt.all({
    $cityId: params.cityId ?? null,
    $neighborhoodId: params.neighborhoodId ?? null,
    $streetId: params.streetId ?? null,
    $limit: clampLimit(params.limit, 5000, 200),
    $offset: params.offset ?? 0,
  });

// ---- Estatísticas (dashboard) -----------------------------------------------
const statsTopCitiesStmt = db.query(`
  SELECT c.nome AS cidade, s.nome AS estado, l.uf, l.relevancia AS ceps
  FROM locations l
  JOIN cities c ON c.id = l.city_id
  JOIN states s ON s.id = l.state_id
  WHERE l.tipo = 'cidade'
  ORDER BY l.relevancia DESC LIMIT 10
`);

const statsByStateStmt = db.query(`
  SELECT s.uf, s.nome AS estado, l.relevancia AS ceps
  FROM locations l
  JOIN states s ON s.id = l.state_id
  WHERE l.tipo = 'estado'
  ORDER BY l.relevancia DESC
`);

export const getStats = () => {
  const meta = db.query("SELECT chave, valor FROM metadata").all() as {
    chave: string;
    valor: string;
  }[];

  return {
    totais: Object.fromEntries(meta.map((m) => [m.chave, m.valor])),
    topCidades: statsTopCitiesStmt.all(),
    porEstado: statsByStateStmt.all(),
  };
};

// ---- Resolução por caminho de slugs -----------------------------------------
// Peça central do front semântico: resolve /{estado}/{cidade?}/{bairro?}/{rua?}
// (e /{estado}/{cidade}/rua/{rua}) → nó + breadcrumb + filhos (+ CEPs na folha).

/** Teto de CEPs retornados na folha do resolve (rua). Acima disso, trunca. */
const RESOLVE_CEPS_LIMIT = 5000;

interface NodeRow {
  id: number;
  nome: string;
  slug: string;
  ceps: number;
}

interface RawChild {
  nome: string;
  slug: string;
  ceps: number;
}

interface RawTrecho {
  bairro_nome: string;
  bairro_slug: string;
  rua_slug: string;
  ceps: number;
}

export interface ResolveChild extends RawChild {
  href: string;
}

export interface ResolveTrecho extends RawTrecho {
  href: string;
}

export interface ResolveCep {
  cep: string;
  complemento: string | null;
}

export interface ResolveResult {
  level: PathLevel;
  node: { id: number; nivel: PathLevel; nome: string; slug: string; ceps: number };
  breadcrumb: PathSegment[];
  children: (ResolveChild | ResolveTrecho)[];
  ceps: ResolveCep[];
}

// --- Nós (resolução por slug, usando os índices UNIQUE) ---
const getStateBySlug = db.query(`
  SELECT s.id, s.nome, s.slug,
    COALESCE((SELECT l.relevancia FROM locations l
              WHERE l.tipo = 'estado' AND l.state_id = s.id), 0) AS ceps
  FROM states s WHERE s.slug = $slug
`);

const getCityBySlug = db.query(`
  SELECT c.id, c.nome, c.slug,
    COALESCE((SELECT l.relevancia FROM locations l
              WHERE l.tipo = 'cidade' AND l.city_id = c.id), 0) AS ceps
  FROM cities c WHERE c.state_id = $stateId AND c.slug = $slug
`);

const getNeighborhoodBySlug = db.query(`
  SELECT n.id, n.nome, n.slug,
    COALESCE((SELECT l.relevancia FROM locations l
              WHERE l.tipo = 'bairro' AND l.neighborhood_id = n.id), 0) AS ceps
  FROM neighborhoods n WHERE n.city_id = $cityId AND n.slug = $slug
`);

const getStreetBySlug = db.query(`
  SELECT st.id, st.nome, st.slug,
    COALESCE((SELECT l.relevancia FROM locations l
              WHERE l.tipo = 'rua' AND l.peso = 5 AND l.street_id = st.id), 0) AS ceps
  FROM streets st
  WHERE st.city_id = $cityId AND st.neighborhood_id = $neighborhoodId AND st.slug = $slug
`);

// Rua agregada a nível de cidade: vem direto da tabela de busca (peso 4).
const getAggStreetBySlug = db.query(`
  SELECT l.id, l.logradouro AS nome, l.slug, l.relevancia AS ceps
  FROM locations l
  WHERE l.tipo = 'rua' AND l.peso = 4 AND l.city_id = $cityId AND l.slug = $slug
`);

// --- Filhos (drill-down do próximo nível) ---
const stateChildrenStmt = db.query(`
  SELECT c.nome, c.slug, l.relevancia AS ceps
  FROM locations l JOIN cities c ON c.id = l.city_id
  WHERE l.tipo = 'cidade' AND l.state_id = $stateId
  ORDER BY c.nome
`);

const cityChildrenStmt = db.query(`
  SELECT n.nome, n.slug, l.relevancia AS ceps
  FROM locations l JOIN neighborhoods n ON n.id = l.neighborhood_id
  WHERE l.tipo = 'bairro' AND l.city_id = $cityId
  ORDER BY n.nome
`);

const neighborhoodChildrenStmt = db.query(`
  SELECT st.nome, st.slug, l.relevancia AS ceps
  FROM locations l JOIN streets st ON st.id = l.street_id
  WHERE l.tipo = 'rua' AND l.peso = 5 AND l.neighborhood_id = $neighborhoodId
  ORDER BY st.nome
`);

// Trechos por bairro de uma rua agregada (mesmo logradouro na cidade).
const aggStreetTrechosStmt = db.query(`
  SELECT n.nome AS bairro_nome, n.slug AS bairro_slug, st.slug AS rua_slug,
    COALESCE((SELECT l.relevancia FROM locations l
              WHERE l.tipo = 'rua' AND l.peso = 5 AND l.street_id = st.id), 0) AS ceps
  FROM streets st JOIN neighborhoods n ON n.id = st.neighborhood_id
  WHERE st.city_id = $cityId AND st.nome = $logradouro
  ORDER BY n.nome
`);

// --- CEPs da folha ---
const streetCepsStmt = db.query(`
  SELECT cep, complemento FROM addresses
  WHERE street_id = $streetId ORDER BY cep LIMIT $limit
`);

const aggStreetCepsStmt = db.query(`
  SELECT cep, complemento FROM addresses
  WHERE city_id = $cityId AND logradouro = $logradouro ORDER BY cep LIMIT $limit
`);

/** Anexa o href de cada filho (caminho do pai + slug do filho). */
const childrenWithHref = (parentHref: string, rows: RawChild[]): ResolveChild[] =>
  rows.map((r) => ({ ...r, href: `${parentHref}/${r.slug}` }));

/** Monta a resposta: breadcrumb a partir da cadeia + filhos (com href) + CEPs. */
const buildResolve = (
  level: PathLevel,
  node: NodeRow,
  chain: ChainNode[],
  makeChildren: (parentHref: string, cityHref: string) => (ResolveChild | ResolveTrecho)[],
  ceps: ResolveCep[]
): ResolveResult => {
  const breadcrumb = buildSegments(chain);
  const parentHref = breadcrumb[breadcrumb.length - 1].href;
  const cityHref = breadcrumb.find((s) => s.level === "cidade")?.href ?? parentHref;
  return {
    level,
    node: { id: node.id, nivel: level, nome: node.nome, slug: node.slug, ceps: node.ceps },
    breadcrumb,
    children: makeChildren(parentHref, cityHref),
    ceps,
  };
};

const noChildren = (): never[] => [];

/**
 * Resolve um caminho de slugs no nível mais profundo informado. Retorna `null`
 * (→ 404 no controller) se qualquer segmento não casar. O 3º segmento literal
 * `rua` ativa a rua agregada a nível de cidade (`/estado/cidade/rua/{slug}`),
 * que não colide com bairro.
 */
export const resolvePath = (segments: string[]): ResolveResult | null => {
  if (segments.length === 0 || segments.length > 4) return null;

  // 1. Estado (sempre presente)
  const estado = getStateBySlug.get({ $slug: segments[0] }) as NodeRow | null;
  if (!estado) return null;
  const chain: ChainNode[] = [
    { level: "estado", nome: estado.nome, slug: estado.slug },
  ];
  if (segments.length === 1) {
    return buildResolve(
      "estado",
      estado,
      chain,
      (p) => childrenWithHref(p, stateChildrenStmt.all({ $stateId: estado.id }) as RawChild[]),
      []
    );
  }

  // 2. Cidade
  const cidade = getCityBySlug.get({ $stateId: estado.id, $slug: segments[1] }) as NodeRow | null;
  if (!cidade) return null;
  chain.push({ level: "cidade", nome: cidade.nome, slug: cidade.slug });
  if (segments.length === 2) {
    return buildResolve(
      "cidade",
      cidade,
      chain,
      (p) => childrenWithHref(p, cityChildrenStmt.all({ $cityId: cidade.id }) as RawChild[]),
      []
    );
  }

  // Rua agregada a nível de cidade: /estado/cidade/rua/{slug}
  if (segments.length === 4 && segments[2] === "rua") {
    const agg = getAggStreetBySlug.get({ $cityId: cidade.id, $slug: segments[3] }) as NodeRow | null;
    if (!agg) return null;
    chain.push({ level: "rua", nome: agg.nome, slug: agg.slug, aggregated: true });
    const ceps = aggStreetCepsStmt.all({
      $cityId: cidade.id,
      $logradouro: agg.nome,
      $limit: RESOLVE_CEPS_LIMIT,
    }) as ResolveCep[];
    return buildResolve(
      "rua",
      agg,
      chain,
      (_parentHref, cityHref) =>
        (aggStreetTrechosStmt.all({ $cityId: cidade.id, $logradouro: agg.nome }) as RawTrecho[]).map(
          (t) => ({ ...t, href: `${cityHref}/${t.bairro_slug}/${t.rua_slug}` })
        ),
      ceps
    );
  }

  // 3. Bairro
  const bairro = getNeighborhoodBySlug.get({ $cityId: cidade.id, $slug: segments[2] }) as NodeRow | null;
  if (!bairro) return null;
  chain.push({ level: "bairro", nome: bairro.nome, slug: bairro.slug });
  if (segments.length === 3) {
    return buildResolve(
      "bairro",
      bairro,
      chain,
      (p) =>
        childrenWithHref(
          p,
          neighborhoodChildrenStmt.all({ $neighborhoodId: bairro.id }) as RawChild[]
        ),
      []
    );
  }

  // 4. Rua por bairro (folha) — traz a lista de CEPs do trecho
  const rua = getStreetBySlug.get({
    $cityId: cidade.id,
    $neighborhoodId: bairro.id,
    $slug: segments[3],
  }) as NodeRow | null;
  if (!rua) return null;
  chain.push({ level: "rua", nome: rua.nome, slug: rua.slug });
  const ceps = streetCepsStmt.all({ $streetId: rua.id, $limit: RESOLVE_CEPS_LIMIT }) as ResolveCep[];
  return buildResolve("rua", rua, chain, noChildren, ceps);
};
