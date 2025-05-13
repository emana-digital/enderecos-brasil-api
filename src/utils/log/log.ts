import chalk from "chalk";

export const log = (logString: string) => {
  const errorDate = new Date().toLocaleString("pt-BR").split(", ").join(" ");
  return console.log(chalk.gray(`${`${errorDate} |`} ${logString}`));
};

export const requestLog = (
  logString: string,
  request: Request,
  server?: Bun.Server | null
) => {
  const requestIP = server?.requestIP(request)?.address;

  return log(
    `${chalk.white(request.url)}${
      requestIP ? ` | ip: ${chalk.white(`${requestIP}`)}` : ""
    } | ${logString}`
  );
};
