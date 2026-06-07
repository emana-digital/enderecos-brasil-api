/**
 * Normaliza texto para busca: remove acentos, deixa minúsculo e troca tudo que
 * não for letra/número por espaço. Mesma regra usada para gerar `locations.busca_norm`
 * (no seed) e para comparar a query do usuário em runtime — precisam bater.
 */
export const normalizeText = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Monta a expressão MATCH do FTS5 a partir de texto livre. Só o ÚLTIMO token (o que
 * está sendo digitado) vira prefixo (`termo*`); os anteriores são exatos. Isso é o
 * comportamento de typeahead e é MUITO mais rápido em queries com vários termos
 * (evita expandir o prefixo de palavras comuns como "rua"). Retorna "" se vazio.
 */
export const toFtsQuery = (value: string): string => {
  const tokens = normalizeText(value).split(" ").filter(Boolean);
  return tokens
    .map((token, i) => (i === tokens.length - 1 ? `${token}*` : token))
    .join(" ");
};
