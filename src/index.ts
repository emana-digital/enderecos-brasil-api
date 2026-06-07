import { Elysia } from "elysia";
import chalk from "chalk";

// import { OpenAddressesIntegration } from "~/modules/integrations/openAddresses";
import { healthCheck } from "./modules/healthCheck";

import { log, requestLog } from "./utils/log";

const app = new Elysia()
  .get("/", ({ request }) => healthCheck({ request }))
  .get("/health-check", ({ request }) => healthCheck({ request }))
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
