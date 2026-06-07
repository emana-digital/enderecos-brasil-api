import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import chalk from "chalk";

// import { OpenAddressesIntegration } from "~/modules/integrations/openAddresses";
import { healthCheck } from "~/modules/healthCheck";
import { locations } from "~/modules/locations";

import { log, requestLog } from "~/utils/log";

// Origem oficial do nosso front. Por ora a API é pública; se aparecer
// consumidor externo (ver log abaixo), basta trocar `origin: true` por
// `origin: FRONTEND_ORIGIN` no cors() para restringir.
const FRONTEND_ORIGIN = "https://enderecosbrasil.emana.digital";

// Considera "nossa" a origem do front oficial e qualquer localhost (dev),
// para não poluir o log de origens externas durante o desenvolvimento.
const isOwnOrigin = (origin: string) =>
  origin === FRONTEND_ORIGIN ||
  origin.startsWith("http://localhost") ||
  origin.startsWith("http://127.0.0.1");

const app = new Elysia()
  // CORS oficial (@elysiajs/cors). API pública: aceita qualquer origem,
  // somente leitura (GET). Para restringir depois, ver FRONTEND_ORIGIN acima.
  .use(
    cors({
      origin: true,
      methods: ["GET"],
    })
  )
  // Loga consumidores além do nosso front. O browser manda o header `Origin`
  // em requisições cross-site; se vier de origem desconhecida, registramos
  // para decidir se vale restringir o CORS. (Scripts/server-to-server não
  // enviam Origin e não são afetados por CORS de qualquer forma.)
  .onRequest(({ request, server }) => {
    const origin = request.headers.get("origin");

    if (origin && !isOwnOrigin(origin)) {
      requestLog(
        `${chalk.yellowBright.bold("origem externa")} | origin: ${chalk.white(
          origin
        )}`,
        request,
        server
      );
    }
  })
  .get("/", ({ request }) => healthCheck({ request }))
  .get("/health-check", ({ request }) => healthCheck({ request }))
  .use(locations)
  // .post("/database/schedule_database_generation", ({ request }) => {
  //   requestLog(`${chalk.greenBright("Generating Database")}`, request);
  //   OpenAddressesIntegration.downloadData();

  //   return {
  //     status: "success",
  //     message: "Generating Database",
  //   };
  // })
  .onError(({ request, code }) => {
    requestLog(`${chalk.redBright.bold(code.toString())}`, request);
  })
  .listen(3000);

log(
  `${chalk.greenBright.bold("EnderecosBrasil")} ${chalk.gray(
    "backend is running at"
  )} ${chalk.blueBright.bold(
    `${app.server?.development ? "http" : "https"}://${app.server?.hostname}:${
      app.server?.port
    }`
  )}`
);
