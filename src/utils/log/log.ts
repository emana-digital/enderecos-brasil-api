import chalk from "chalk";
import type { Context } from "elysia";

export const log = (logString: string) => {
  const errorDate = new Date().toLocaleString("pt-BR").split(", ").join(" ");
  return console.log(chalk.gray(`${`${errorDate} |`} ${logString}`));
};

export const requestLog = (
  logString: string,
  request: Request,
  server?: Context["server"]
) => {
  const requestIP = server?.requestIP(request)?.address;

  return log(
    `${chalk.white(request.url)}${
      requestIP ? ` | ip: ${chalk.white(`${requestIP}`)}` : ""
    } | ${logString}`
  );
};
