import { Elysia, t } from "elysia";

import {
  searchLocations,
  getCep,
  listStates,
  listCities,
  listNeighborhoods,
  listStreets,
  listCeps,
  getStats,
} from "~/modules/integrations/cepAberto";

const uf = t.String({ minLength: 2, maxLength: 2 });
const tipo = t.Union([
  t.Literal("estado"),
  t.Literal("cidade"),
  t.Literal("bairro"),
  t.Literal("rua"),
]);

/**
 * Controller de locations: busca textual/CEP + navegação pela base
 * (estados → cidades → bairros → ruas → CEPs) e estatísticas para o front.
 */
export const locations = new Elysia({ prefix: "/locations" })
  // Busca principal: aceita nome (rua/bairro/cidade/estado) OU CEP.
  .get("/search", ({ query }) => searchLocations(query), {
    query: t.Object({
      q: t.String({ minLength: 1 }),
      tipo: t.Optional(tipo),
      uf: t.Optional(uf),
      limit: t.Optional(t.Numeric({ minimum: 1, maximum: 50 })),
    }),
  })
  // Lookup exato por CEP → rua/bairro/cidade/estado completos.
  .get(
    "/cep/:cep",
    ({ params, set }) => {
      const result = getCep(params.cep);
      if (!result) {
        set.status = 404;
        return { error: "CEP não encontrado" };
      }
      return result;
    },
    { params: t.Object({ cep: t.String() }) }
  )
  .get("/states", () => listStates())
  .get("/cities", ({ query }) => listCities(query), {
    query: t.Object({
      uf: t.Optional(uf),
      stateId: t.Optional(t.Numeric()),
      limit: t.Optional(t.Numeric({ minimum: 1, maximum: 5000 })),
      offset: t.Optional(t.Numeric({ minimum: 0 })),
    }),
  })
  .get("/neighborhoods", ({ query }) => listNeighborhoods(query), {
    query: t.Object({
      cityId: t.Numeric(),
      limit: t.Optional(t.Numeric({ minimum: 1, maximum: 5000 })),
      offset: t.Optional(t.Numeric({ minimum: 0 })),
    }),
  })
  .get("/streets", ({ query }) => listStreets(query), {
    query: t.Object({
      cityId: t.Optional(t.Numeric()),
      neighborhoodId: t.Optional(t.Numeric()),
      limit: t.Optional(t.Numeric({ minimum: 1, maximum: 5000 })),
      offset: t.Optional(t.Numeric({ minimum: 0 })),
    }),
  })
  .get("/ceps", ({ query }) => listCeps(query), {
    query: t.Object({
      cityId: t.Optional(t.Numeric()),
      neighborhoodId: t.Optional(t.Numeric()),
      streetId: t.Optional(t.Numeric()),
      limit: t.Optional(t.Numeric({ minimum: 1, maximum: 5000 })),
      offset: t.Optional(t.Numeric({ minimum: 0 })),
    }),
  })
  .get("/stats", () => getStats());
