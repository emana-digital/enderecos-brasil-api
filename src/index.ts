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

// Classifica a origem da requisição pra sabermos QUEM está usando a API.
// `origem externa` (amarelo) é o caso a vigiar: browser de outro site.
const classifyOrigin = (origin: string | null) => {
  if (!origin)
    // Sem header Origin: curl/script/server-to-server ou URL digitada no browser.
    return { label: "conexão direta", color: chalk.gray };
  if (origin === FRONTEND_ORIGIN)
    return { label: "front oficial", color: chalk.greenBright };
  if (origin.startsWith("http://localhost") || origin.startsWith("http://127.0.0.1"))
    return { label: "dev local", color: chalk.blueBright };
  return { label: "origem externa", color: chalk.yellowBright.bold };
};

// Health checks são ruído de infra (uptime/load balancer); não logamos.
const HEALTH_PATHS = new Set(["/", "/health-check"]);

const app = new Elysia()
  // CORS oficial (@elysiajs/cors). API pública: aceita qualquer origem,
  // somente leitura (GET). Para restringir depois, ver FRONTEND_ORIGIN acima.
  .use(
    cors({
      origin: true,
      methods: ["GET"],
    })
  )
  // Loga TODA requisição às APIs de busca (tudo menos health check), com URL
  // (já inclui a query) + IP, classificada por origem (ver classifyOrigin):
  // `front oficial` / `dev local` / `conexão direta` / `origem externa`
  // (amarelo, o caso a vigiar — consumidor além do nosso front).
  .onRequest(({ request, server }) => {
    const { pathname } = new URL(request.url);
    if (HEALTH_PATHS.has(pathname)) return;

    const origin = request.headers.get("origin");
    const { label, color } = classifyOrigin(origin);

    requestLog(
      `${color(label)}${origin ? ` | origin: ${chalk.white(origin)}` : ""}`,
      request,
      server
    );
  })
  .get("/", ({ request }) => healthCheck({ request }))
  .get("/health-check", ({ request }) => healthCheck({ request }))
  .use(locations)
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
