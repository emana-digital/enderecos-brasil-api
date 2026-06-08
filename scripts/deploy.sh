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

# Node instalado via nvm NÃO entra no PATH de sessão SSH não-interativa: o nvm
# carrega via .bashrc, que o bash pula quando não é interativo. Como o pm2
# precisa do node, carregamos o nvm explicitamente aqui (usa o `nvm alias
# default`). Se você usar node system-wide (ex.: NodeSource em /usr/bin), o
# arquivo não existe e este bloco vira no-op.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  set +u            # nvm.sh referencia variáveis não definidas; -u quebraria
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
  set -u
fi

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
# O pm2 é uma app Node: o binário dele tem shebang `#!/usr/bin/env node`, então
# precisa de um `node` no PATH para rodar — mesmo com interpreter:"none" no
# ecosystem (esse controla só como o pm2 executa o NOSSO binário, não o próprio
# pm2). Sem node, o pm2 morre com "/usr/bin/env: 'node'..." e exit 127. Checamos
# antes para falhar com uma mensagem acionável em vez do erro críptico.
command -v node >/dev/null 2>&1 || {
  echo "ERRO: 'node' não encontrado no PATH — o pm2 precisa de Node instalado no VPS." >&2
  echo "      Instale o Node (ver docs/deploy.md, seção 2) e refaça o deploy." >&2
  exit 1
}
# startOrReload: sobe na primeira vez; nas próximas reinicia pegando o novo binário.
# --update-env relê as variáveis definidas no ecosystem.config.cjs.
pm2 startOrReload ecosystem.config.cjs --update-env
# Persiste a lista de processos para sobreviver a reboot (junto com `pm2 startup`).
pm2 save

echo "==> Deploy concluído."
