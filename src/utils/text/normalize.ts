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
 * Gera um slug ASCII estável a partir de um nome, para compor as URLs semânticas
 * (`/{estado}/{cidade}/{bairro}/{rua}`). É a FONTE ÚNICA do algoritmo — o front
 * pode precisar espelhar (ver docs/frontend-integration.md). Passos:
 *   1. NFD + remove diacríticos (acentos): "São" → "Sao"
 *   2. toLowerCase
 *   3. troca toda sequência fora de [a-z0-9] por "_" (já colapsa repetidos)
 *   4. remove "_" das pontas
 * Ex.: "Avenida Dom João VI" → "avenida_dom_joao_vi"; "Zona 07" → "zona_07".
 *
 * O DESEMPATE de colisão (sufixo `_2`, `_3`…) é responsabilidade de quem chama,
 * por escopo de unicidade (estado global, cidade no estado, etc.) — ver o seed.
 */
export const slugify = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

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
