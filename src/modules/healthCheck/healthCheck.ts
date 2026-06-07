import chalk from "chalk";
import { requestLog } from "../../utils/log";

export const healthCheck = ({ request }: { request: Request }) => {
  const uptime = process.uptime();
  const seconds = Math.floor(uptime);

  requestLog(
    `${chalk.blue("Health Check")} | ${chalk.gray(
      "uptime:"
    )} ${chalk.bold.white(seconds)} ${seconds > 1 ? "seconds" : "second"}`,
    request
  );

  return {
    up: true,
    uptime: {
      seconds,
    },
  };
};
