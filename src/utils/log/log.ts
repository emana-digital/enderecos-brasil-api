import chalk from "chalk";
import type { Context } from "elysia";

export const log = (logString: string) => {
  const errorDate = new Date().toLocaleString("pt-BR").split(", ").join(" ");
  return console.log(chalk.gray(`${`${errorDate} |`} ${logString}`));
};

// O Bun entrega IP como IPv4-mapeado-em-IPv6 (ex.: ::ffff:127.0.0.1). Tiramos o
// prefixo pra sobrar só o número e mostramos loopback como "localhost".
const normalizeIP = (ip: string) => {
  const clean = ip.replace(/^::ffff:/i, "");
  return clean === "127.0.0.1" || clean === "::1" ? "localhost" : clean;
};

export const requestLog = (
  logString: string,
  request: Request,
  server?: Context["server"]
) => {
  const requestIP = server?.requestIP(request)?.address;

  return log(
    `${chalk.white(request.url)}${
      requestIP ? ` | ip: ${chalk.white(normalizeIP(requestIP))}` : ""
    } | ${logString}`
  );
};
