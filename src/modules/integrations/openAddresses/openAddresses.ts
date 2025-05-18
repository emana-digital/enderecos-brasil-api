/**

  Integração base:
  https://openaddresses.io/

  OpenAddresses é um projeto open-source com contribuintes pagantes.
  Por ter recursos financeiros, é um projeto com mais chances de longevidade.
  Por isso, utilizei como base inicial da nossa base de dados.
  OpenAddresses usa dados abertos do governo (IBGE e outros institutos locais).
 */
import chalk from "chalk";
import { log } from "~/utils/log";

export class OpenAddressesIntegration {
  private async checkIntegrationCache() {}

  private async getAvailableDatasets() {
    const response = await fetch(
      // source="br/"
      "https://batch.openaddresses.io/api/data?source=br%2F",
      { method: "GET" }
    );

    const availabeDatasets: {
      id: number;
      updated: number;
      source: string;
      layer: string;
    }[] = await response.json();

    return availabeDatasets;
  }

  private async downloadDatased() {}

  static async downloadData() {
    log("Iniciando download da base de dados");
  }
}
