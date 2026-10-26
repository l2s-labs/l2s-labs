# L2S Labs

Landing institucional da L2S Labs.

Site estático enxuto (HTML/CSS/JS) servido por um processo Node mínimo, com captura de leads e imagem Docker para Railway.

## Local

```bash
npm start
```

Abra [http://localhost:3000](http://localhost:3000).

Sem `LEADS_WEBHOOK_URL` ou Resend configurados, os leads são apenas logados no terminal.

## Leads

Configure no Railway (ou `.env` local):

| Variável | Uso |
|----------|-----|
| `LEADS_WEBHOOK_URL` | POST JSON do lead (Discord/Slack/Make) |
| `RESEND_API_KEY` + `LEADS_TO_EMAIL` | Envio por e-mail via Resend |
| `LEADS_FROM_EMAIL` | Remetente (opcional; domínio precisa estar verificado no Resend) |
| `LEADS_STRICT` | `true` = falha de entrega vira 502 (padrão: aceita e loga) |

Se Resend/webhook falhar, o lead ainda aparece nos **logs do serviço** no Railway.

## Docker

```bash
docker build -t l2s-labs .
docker run --rm -p 3000:3000 -e LEADS_WEBHOOK_URL=https://... l2s-labs
```

## Railway

1. Conecte o repositório
2. O `railway.toml` usa o `Dockerfile`
3. Defina `SITE_URL` (domínio público) e as variáveis de leads
4. Publique

Health check: `GET /health`

## Buscas e assistentes de IA

O site expõe contexto legível por modelos e crawlers:

| Recurso | Função |
|---------|--------|
| `/llms.txt` | Resumo canônico ([llmstxt.org](https://llmstxt.org/)) |
| `/llms-full.txt` | Contexto estendido para agentes |
| `/organization.json` | Organization (JSON-LD) |
| `/sitemap.xml` | URLs absolutas (usa `SITE_URL` ou o host da requisição) |
| `/robots.txt` | Permite crawlers web e de IA |
| JSON-LD no HTML | `WebSite` + `Organization` + `WebPage` |
