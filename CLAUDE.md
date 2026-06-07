# CLAUDE.md

Guia para o Claude Code trabalhar neste repositório. Português + termos técnicos em inglês, acompanhando o estilo do código (logs e comentários em PT-BR).

## O que é o projeto

API de endereços/CEPs do Brasil (`enderecos-brasil-api`). Backend em **ElysiaJS** rodando sobre o **runtime Bun**, com **PostgreSQL** como banco. A ideia é montar uma base de endereços a partir de fontes abertas (OpenAddresses, CEP Aberto) e expor consultas via HTTP.

Estágio: **início de desenvolvimento** (`1.0.0-beta`). Vários módulos ainda são stubs (seed do banco, integrações). Não há ORM nem rotas de domínio implementadas ainda — só health check e o esqueleto das integrações.

## Stack e versões

| Item        | Versão / detalhe |
|-------------|------------------|
| Runtime     | Bun (`oven/bun`), tipos via `bun-types@1.3.x` |
| Framework   | `elysia@1.4.x` |
| CORS        | `@elysiajs/cors@1.4.x` (plugin oficial, pinado) |
| Banco       | PostgreSQL 17 (via Docker Compose) |
| Linguagem   | TypeScript (strict), target ES2021 |
| Lint        | ESLint 9 (flat config) + typescript-eslint |
| Log         | `chalk` |

> ⚠️ `package.json` usa `"elysia": "latest"` e `"bun-types": "latest"`. Versões flutuantes já causaram quebra silenciosa de tipagem depois de meses parado (ver "Gotchas"). Ao tocar em deps, considere fixar versões.

## Comandos

```bash
bun run dev        # dev server com watch (src/index.ts) → http://localhost:3000
bun run db:start   # sobe só o Postgres via docker compose (serviço "database")
docker compose up  # sobe API + banco juntos
bunx tsc --noEmit  # type-check (NÃO há script "typecheck"; use este)
bunx eslint .      # lint (NÃO há script "lint")
```

Não existe suíte de testes ainda (`bun test` / script `test` é placeholder). Se for adicionar, siga o padrão de teste do Elysia (`app.handle(new Request(...))`) — ver docs de Unit Test abaixo.

## Arquitetura e convenções

- **Estrutura feature-based** dentro de `src/modules/<feature>/`, seguindo a *Best Practice* do Elysia: cada módulo tem seu arquivo principal + `index.ts` que reexporta. Ex.: [src/modules/healthCheck/](src/modules/healthCheck/).
- **Entry point**: [src/index.ts](src/index.ts) — instancia `new Elysia()`, registra rotas e `.listen(3000)`.
- **Path alias**: `~/*` → `src/*` (definido em [tsconfig.json](tsconfig.json)). Prefira `~/utils/log` a caminhos relativos longos. Hoje o código mistura os dois estilos; padronize para `~/` ao editar.
- **Utils**: [src/utils/log/](src/utils/log/) — `log()` e `requestLog()` com timestamp pt-BR e cores.
- **Integrações**: [src/modules/integrations/](src/modules/integrations/) — `openAddresses` e `cepAberto` (stubs). Dados de seed do CEP Aberto em `initialSeed/<uf>/*.zip`.
- **CORS / API pública**: tratado pelo plugin oficial `@elysiajs/cors` em [src/index.ts](src/index.ts). Hoje a API é **pública** (`origin: true`, só `GET`). Um `onRequest` loga **toda** requisição às APIs de busca (tudo menos os health checks em `HEALTH_PATHS`), com URL+query e IP, classificada por `classifyOrigin` a partir do header `Origin`: `front oficial` (verde, = `FRONTEND_ORIGIN = https://enderecosbrasil.emana.digital`), `dev local` (azul, `localhost`/`127.0.0.1`), `conexão direta` (cinza, sem `Origin` — curl/script/server-to-server) e **`origem externa`** (amarelo, browser de outro site — o caso a vigiar, consumidor além do nosso front). **Para restringir depois:** trocar `origin: true` por `origin: FRONTEND_ORIGIN` no `cors()`. Domínios: front `enderecosbrasil.emana.digital`, API `api.enderecosbrasil.emana.digital`. (Scripts/server-to-server não mandam `Origin` e caem como `conexão direta`; CORS não se aplica a eles.)
- **Deploy**: [Dockerfile](Dockerfile) faz `bun build --compile` para um binário único e roda em imagem distroless. [compose.yml](compose.yml) define `web` + `database` (Postgres). `DATABASE_URL` vem por env.

### Padrões de código (importante)

Seguir a **Best Practice do Elysia** (`docs/elysia/llms-full.txt`, seção *Best Practice*):

- **Não acoplar services ao `Context` do Elysia.** Passe para funções/services só os campos que elas realmente usam (object destructuring), não o `Context` inteiro.
- **Não digitar tipos internos do Bun/Elysia na mão.** Quando precisar do tipo de um campo do contexto, **derive do framework**: `Context["server"]` em vez de `Bun.Server<...>`. Os tipos do Elysia/Bun mudam entre versões.
- **1 instância Elysia = 1 controller.** Deixe o Elysia inferir o `Context` definindo as rotas direto na instância; evite classes de controller acopladas.
- **Models/DTOs com `Elysia.t`** (TypeBox) como fonte única de verdade para validação + tipos, em vez de `interface` separada.

## Gotchas conhecidos

- **`Bun.Server` virou genérico** no `bun-types@1.3.x` (`Server<WebSocketData>`) e passou a exigir argumento de tipo — `Bun.Server` puro dá `TS2314`. Solução idiomática: derivar de `Context["server"]` (resolve para `Bun.Server<unknown> | null`). Não use `Bun.Server<unknown>` cravado na mão.
- **Versões `latest`** no `package.json` deixam o lockfile flutuar; foi a causa raiz da quebra acima.
- **`cepAberto.tsx`** usa extensão `.tsx` num backend (e o ESLint carrega o plugin React). Provavelmente não intencional — confirme antes de seguir esse padrão em arquivos novos.
- **Nome do pacote CORS**: as docs (`llms-full.txt`) escrevem `@elysia/cors`, mas o pacote real publicado é **`@elysiajs/cors`** (scope `@elysiajs`). Use o segundo.

## 📚 Documentação do Elysia (referência principal)

As docs oficiais foram baixadas em formato LLM-friendly para consulta offline. **Consulte-as antes de cravar soluções** — especialmente em dúvidas de tipagem, lifecycle e validação:

- **[docs/elysia/llms-full.txt](docs/elysia/llms-full.txt)** — conteúdo COMPLETO de todas as páginas das docs (~450KB). Use `grep` aqui para achar a seção certa (ex.: `grep -n "Best Practice" docs/elysia/llms-full.txt`).
- **[docs/elysia/llms.txt](docs/elysia/llms.txt)** — índice com links de todas as páginas (`*.md`).

Origem: `https://elysiajs.com/llms.txt` e `https://elysiajs.com/llms-full.txt`. Para atualizar:

```bash
curl -sL https://elysiajs.com/llms.txt      -o docs/elysia/llms.txt
curl -sL https://elysiajs.com/llms-full.txt -o docs/elysia/llms-full.txt
```

### Páginas mais relevantes para este projeto

Essential
- [At Glance](https://elysiajs.com/at-glance.md) · [Quick Start](https://elysiajs.com/quick-start.md) · [Key Concept](https://elysiajs.com/key-concept.md)
- [Route](https://elysiajs.com/essential/route.md) · [Handler](https://elysiajs.com/essential/handler.md) · [Plugin](https://elysiajs.com/essential/plugin.md)
- [Lifecycle](https://elysiajs.com/essential/life-cycle.md) · [Validation](https://elysiajs.com/essential/validation.md)
- **[Best Practice](https://elysiajs.com/essential/best-practice.md)** ← padrões de estrutura/typing deste repo

Patterns
- [Configuration](https://elysiajs.com/patterns/configuration.md) · [Error Handling](https://elysiajs.com/patterns/error-handling.md) · [Extend Context](https://elysiajs.com/patterns/extends-context.md)
- [TypeScript](https://elysiajs.com/patterns/typescript.md) · [TypeBox (Elysia.t)](https://elysiajs.com/patterns/typebox.md) · [Macro](https://elysiajs.com/patterns/macro.md)
- [Cookie](https://elysiajs.com/patterns/cookie.md) · [OpenAPI](https://elysiajs.com/patterns/openapi.md) · [Deploy to Production](https://elysiajs.com/patterns/deploy.md) · [Unit Test](https://elysiajs.com/patterns/unit-test.md)

Integrações úteis aqui
- [Drizzle](https://elysiajs.com/integrations/drizzle.md) · [Prisma](https://elysiajs.com/integrations/prisma.md) (ao escolher ORM)
- [Node.js](https://elysiajs.com/integrations/node.md) · [Cheat Sheet (por exemplos)](https://elysiajs.com/integrations/cheat-sheet.md)

Plugins
- [Overview](https://elysiajs.com/plugins/overview.md) · [CORS](https://elysiajs.com/plugins/cors.md) · [JWT](https://elysiajs.com/plugins/jwt.md) · [Bearer](https://elysiajs.com/plugins/bearer.md) · [Cron](https://elysiajs.com/plugins/cron.md) · [OpenAPI](https://elysiajs.com/plugins/openapi.md) · [Static](https://elysiajs.com/plugins/static.md)

> Índice completo (Eden, todas as integrations/plugins/tutorials) em [docs/elysia/llms.txt](docs/elysia/llms.txt).
