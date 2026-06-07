# Deploy (produção)

Deploy **baseado apenas em tags**: dar push numa tag `v*` dispara a GitHub Action
[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml), que conecta no
VPS via SSH e roda [`scripts/deploy.sh`](../scripts/deploy.sh) (deps → build → pm2).

```
git tag v1.0.0
git push origin v1.0.0
   │
   └─► GitHub Action ──ssh──► VPS:
          git checkout da tag → bun install → bun build --compile → pm2 startOrReload
```

No VPS o Bun roda **nativamente** escutando só em `127.0.0.1:3145`. O **Caddy** faz
o reverse-proxy com SSL para `api.enderecosbrasil.emana.digital`. O **pm2** mantém
o processo online (restart on crash + start no boot).

## 1. Secrets no GitHub

`Settings > Secrets and variables > Actions > New repository secret`:

| Secret     | Conteúdo |
|------------|----------|
| `SSH_HOST` | IP ou hostname do VPS |
| `SSH_USER` | usuário SSH dono de `/var/www/api.enderecosbrasil.emana.digital` |
| `SSH_KEY`  | chave **privada** SSH completa (ex.: conteúdo de `~/.ssh/id_ed25519`) |
| `SSH_PORT` | porta SSH (opcional; default `22`) |

Gere um par de chaves dedicado ao deploy e autorize a pública no VPS:

```bash
# na sua máquina
ssh-keygen -t ed25519 -C "github-deploy" -f deploy_key
# copie deploy_key.pub para ~/.ssh/authorized_keys do usuário no VPS
# cole o conteúdo de deploy_key (privada) no secret SSH_KEY
```

## 2. Setup único do VPS

Feito **uma vez**, antes do primeiro deploy.

```bash
# 1) bun, pm2 e git instalados e no PATH do usuário do deploy
curl -fsSL https://bun.sh/install | bash      # instala em ~/.bun
bun install -g pm2                              # ou: npm i -g pm2

# 2) clonar o projeto na pasta de produção
sudo mkdir -p /var/www/api.enderecosbrasil.emana.digital
sudo chown "$USER" /var/www/api.enderecosbrasil.emana.digital
git clone <URL_DO_REPO> /var/www/api.enderecosbrasil.emana.digital

# 3) primeiro build + subir no pm2 (a partir da pasta do projeto)
cd /var/www/api.enderecosbrasil.emana.digital
bash scripts/deploy.sh   # ou faça o primeiro deploy empurrando uma tag

# 4) pm2 sobe no boot do servidor
pm2 startup    # rode o comando que ele imprimir (com sudo)
pm2 save
```

> Repositório privado? O VPS precisa conseguir `git fetch` do GitHub — configure
> uma deploy key (read-only) no usuário ou use clone via HTTPS com token.

> `bun` e `pm2` precisam estar no `PATH` da sessão SSH **não-interativa**. O
> `scripts/deploy.sh` já adiciona `~/.bun/bin`; se o `pm2` ficar noutro lugar,
> ajuste o `PATH` lá.

## 3. Caddy

`/etc/caddy/Caddyfile`:

```caddy
api.enderecosbrasil.emana.digital {
    reverse_proxy 127.0.0.1:3145
}
```

```bash
sudo systemctl reload caddy
```

## 4. Fazer um deploy

```bash
git tag v1.0.1
git push origin v1.0.1
```

Acompanhe em `Actions` no GitHub. Para reverter, dê push numa tag que aponte para
um commit anterior. Logs do serviço no VPS: `pm2 logs enderecos-brasil-api`.
