# codex-router

Proxy Node.js qui convertit le format API Anthropic (Claude Code) vers le format OpenAI (Scaleway Generative APIs) et inversement, en streaming SSE.

## Architecture

```
Claude Code (format Anthropic)
    ↓ HTTP
codex-router (localhost:8787) — conversion Anthropic ↔ OpenAI
    ↓ HTTPS
Scaleway Generative APIs
```

## Prérequis

- Node.js ≥ 18
- Zéro dépendance npm

## Quick start

```bash
# Lancer le router
UPSTREAM_BASE_URL=https://api.scaleway.ai node server.js

# Avec logs détaillés (bodies JSON)
UPSTREAM_BASE_URL=https://api.scaleway.ai LOG_REQUESTS=true node server.js
```

## Configurer Claude Code

```bash
export ANTHROPIC_BASE_URL=http://localhost:8787
export ANTHROPIC_MODEL=qwen3.5-397b-a17b
```

Le modèle est passé tel quel au backend — changer `ANTHROPIC_MODEL` suffit pour switcher de modèle.

## Variables d'environnement

| Variable | Requis | Défaut | Description |
|---|---|---|---|
| `UPSTREAM_BASE_URL` | ✅ | — | URL de base Scaleway (ex: `https://api.scaleway.ai`) |
| `PORT` | | `8787` | Port d'écoute |
| `LOG_REQUESTS` | | `false` | Log les bodies JSON complets (tronqués à 3000 chars) |

## Endpoints

| Path | Méthode | Description |
|---|---|---|
| `/v1/messages` | POST | API Messages Anthropic → converti et proxifié vers l'upstream |
| `/health` | GET | Health check (retourne l'URL upstream) |

## Ce que fait le proxy

1. Reçoit les requêtes au format Anthropic depuis Claude Code
2. Convertit messages, tools et system prompts au format OpenAI
3. Forward vers Scaleway Generative APIs
4. Convertit la réponse OpenAI en format Anthropic (streaming SSE et non-streaming)
5. Retourne à Claude Code dans le format attendu

## Logs

Les logs sont toujours actifs et affichent pour chaque requête :
- Modèle entrant et sortant
- Nombre de messages et tools
- Flow des messages
- Status upstream et temps de réponse
- Stats de streaming (chunks, bytes, durée totale)

`LOG_REQUESTS=true` ajoute en plus les bodies JSON complets.