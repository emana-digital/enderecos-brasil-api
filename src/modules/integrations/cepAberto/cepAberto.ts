import { db } from "./database";
import { normalizeText, toFtsQuery } from "~/utils/text";

// ---- Tipos -------------------------------------------------------------------
export type LocationTipo = "estado" | "cidade" | "bairro" | "rua";
export type ResultTipo = LocationTipo | "cep";

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
}

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
    l.id, l.tipo, l.uf,
    l.logradouro,
    n.nome AS bairro,
    c.nome AS cidade,
    s.nome AS estado,
    l.cep,
    l.state_id        AS stateId,
    l.city_id         AS cityId,
    l.neighborhood_id AS neighborhoodId,
    l.street_id       AS streetId,
    l.relevancia
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
});

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

  return rows.map((r) => ({
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
  }));
};

// ---- Lookup exato por CEP ----------------------------------------------------
const getCepStmt = db.query(`
  SELECT
    a.cep, a.logradouro, a.complemento, a.bairro,
    a.state_id        AS stateId, s.uf, s.nome AS estado,
    a.city_id         AS cityId,  c.nome AS cidade,
    a.neighborhood_id AS neighborhoodId,
    a.street_id       AS streetId
  FROM addresses a
  JOIN states s ON s.id = a.state_id
  JOIN cities c ON c.id = a.city_id
  WHERE a.cep = $cep
`);

export const getCep = (cep: string): CepDetail | null => {
  const digits = cep.replace(/\D/g, "").padStart(8, "0");
  return (getCepStmt.get({ $cep: digits }) as CepDetail | null) ?? null;
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
