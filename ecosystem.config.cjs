// Configuração do pm2 para a API em produção no VPS.
//
// O pm2 é o responsável por manter o serviço online (restart on crash, start no
// boot via `pm2 startup` + `pm2 save`). O deploy roda `pm2 startOrReload` neste
// arquivo (ver scripts/deploy.sh).
//
// `server` é o binário único gerado por `bun build --compile`. Como é um
// executável nativo, usamos interpreter "none" (o pm2 não passa por node).
// A API escuta só em 127.0.0.1 (NODE_ENV=production); o Caddy faz o
// reverse-proxy com SSL para api.enderecosbrasil.emana.digital.
module.exports = {
  apps: [
    {
      name: "enderecos-brasil-api",
      script: "./server",
      cwd: "/var/www/api.enderecosbrasil.emana.digital",
      interpreter: "none",
      instances: 1,
      autorestart: true,
      env: {
        NODE_ENV: "production",
        PORT: "3145",
        // Base SQLite gerada offline (database-generation.ts) e copiada UMA VEZ
        // para o VPS (rsync). É ~930MB e está no .gitignore, então não vem pelo
        // git checkout — mas por isso mesmo o `git checkout --force` do deploy
        // também não a apaga: persiste entre deploys neste caminho.
        SQLITE_PATH:
          "/var/www/api.enderecosbrasil.emana.digital/database/enderecos-brasil.sqlite",
      },
    },
  ],
};
