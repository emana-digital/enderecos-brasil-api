#!/usr/bin/env bash
#
# Deploy de produção — executado NO VPS pela GitHub Action (.github/workflows/deploy.yml),
# já com o checkout da tag feito e a partir da raiz do projeto.
#
# Passos: dependências -> build (binário único) -> (re)start no pm2.
# O Bun escuta só em 127.0.0.1 (NODE_ENV=production); o Caddy expõe com SSL.
set -euo pipefail

# Sessão SSH não-interativa costuma vir com PATH enxuto. Garante o bun (e o pm2,
# se instalado via bun) no PATH. Ajuste se a sua instalação ficar noutro lugar.
export PATH="$HOME/.bun/bin:$PATH"

echo "==> Instalando dependências (bun install)"
# --frozen-lockfile: usa exatamente o bun.lock da tag, sem resolver de novo.
bun install --frozen-lockfile

echo "==> Build de produção (binário único compilado pelo Bun)"
export NODE_ENV=production
# Compila para um arquivo temporário e troca de forma atômica: não dá pra
# sobrescrever o binário enquanto o pm2 o executa (erro ETXTBSY, "Text file busy").
# O mv troca só a entrada do diretório; o processo em execução segue com o inode antigo.
bun build \
  --compile \
  --minify-whitespace \
  --minify-syntax \
  --target bun \
  --outfile server.new \
  ./src/index.ts
chmod +x server.new
mv -f server.new server

echo "==> (Re)start no pm2"
# startOrReload: sobe na primeira vez; nas próximas reinicia pegando o novo binário.
# --update-env relê as variáveis definidas no ecosystem.config.cjs.
pm2 startOrReload ecosystem.config.cjs --update-env
# Persiste a lista de processos para sobreviver a reboot (junto com `pm2 startup`).
pm2 save

echo "==> Deploy concluído."
