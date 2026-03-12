# Agent Setup Options

Last verified: 2026-03-12

## All Setup Steps

| Step | Agents | Data Env Var | Interactive | Description |
|------|--------|-------------|-------------|-------------|
| github | ALL | GITHUB_TOKEN | No | GitHub CLI + git identity |
| reuse-api-key | ALL | - | No | Reuse saved OpenRouter key |
| browser | openclaw | - | No | Chrome browser (~400 MB) |
| telegram | openclaw | TELEGRAM_BOT_TOKEN | No | Telegram bot config |
| whatsapp | openclaw | - | Yes (QR scan) | WhatsApp linking |

## Config File Format (`--config`)

```json
{
  "model": "openai/gpt-5.3-codex",
  "steps": ["github", "browser", "telegram"],
  "name": "my-dev-box",
  "setup": {
    "telegram_bot_token": "123456:ABC-DEF...",
    "github_token": "ghp_xxxx"
  }
}
```

## Priority Order (highest wins)

1. CLI flags (`--model`, `--steps`, `--name`) — explicit overrides
2. `--config` file — bundled configuration
3. Environment variables (`MODEL_ID`, `SPAWN_ENABLED_STEPS`, etc.)
4. Agent hardcoded defaults

## Web UI Invocation Examples

```
spawn codex gcp --config /tmp/spawn-config.json --headless --output json
spawn openclaw gcp --steps github,browser --model openai/gpt-5.3-codex --headless --output json
TELEGRAM_BOT_TOKEN=xxx spawn openclaw gcp --steps telegram --headless --output json
```

## Edge Cases

- `--steps ""` → empty set → all optional steps disabled (bare provisioning)
- `whatsapp` in steps + `--headless` → warn + skip (requires interactive QR scan)
- `TELEGRAM_BOT_TOKEN` set but `telegram` not in steps → token ignored
- Unknown step names → warn + filter out, don't hard-fail
