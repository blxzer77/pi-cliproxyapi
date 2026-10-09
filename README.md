# @blxzer77/pi-cliproxyapi

A [pi](https://github.com/earendil-works/pi) provider for [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI).

It discovers models from the proxy, lets you correct the metadata the proxy reports, pins models that keep flapping out of the catalog, and reports real token usage. It replaces [`@router-for-me/pi-cliproxyapi-provider`](https://github.com/router-for-me/pi-cliproxyapi-provider) — see [Differences from the upstream provider](#differences-from-the-upstream-provider).

## Install

```bash
pi install npm:@blxzer77/pi-cliproxyapi
```

Installing from GitHub Packages needs a registry entry and a token with `read:packages`:

```ini
# .npmrc
@blxzer77:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

For local development, load the checkout directly:

```bash
pi -e /path/to/pi-cliproxyapi
```

## Configure

Either run the login flow:

```text
/login CLIProxyAPI
```

…and enter the base URL (`http://127.0.0.1:8317` or whatever your proxy listens on) and the API key, or write `~/.pi/agent/cliproxyapi.json`:

```json
{
  "baseUrl": "http://127.0.0.1:8317",
  "apiKey": "sk-...",
  "fast": false,
  "pause": false
}
```

| Field | Default | Meaning |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:8317` | Proxy address. `host:port`, `/v1`, `/backend-api`, or the exact inference URL all work. |
| `apiKey` | — | Bearer token for the proxy. |
| `providerId` | `cliproxyapi` | Provider id in `/model`. Change it to migrate without touching `settings.json`. |
| `providerName` | `CLIProxyAPI` | Display name in `/login` and the UI. |
| `fast` | `false` | Persisted Fast preference. |
| `pause` | `false` | Persisted request-pause preference. |
| `overridesFile` | `cliproxyapi-overrides.json` | Alternative overrides path, absolute or relative to the agent dir. |

Environment overrides, in resolution order **env → config file → `/login` credential → default**:

| Variable | Overrides |
|---|---|
| `CLIPROXYAPI_BASE_URL` | `baseUrl` |
| `CLIPROXYAPI_API_KEY` | `apiKey` |
| `CLIPROXYAPI_PROVIDER_ID` | `providerId` |
| `CLIPROXYAPI_PROVIDER_NAME` | `providerName` |
| `CLIPROXYAPI_FAST` / `CLIPROXYAPI_PAUSE` | `fast` / `pause` |
| `CLIPROXYAPI_OVERRIDES_FILE` | `overridesFile` |
| `CLIPROXYAPI_DEBUG` | `1` enables debug logging |
| `CLIPROXYAPI_QUIET` | `1` silences all non-warning logging |

## Model overrides

This is the reason the provider exists. The catalog at `GET /v1/models?client_version=pi` returns whatever upstream client metadata the operator configured, and it is often wrong for the route behind it: a missing output limit, a context window copied from a generic default, or a reasoning ladder the model does not accept. Overrides are applied on every refresh, so a correction is permanent and nothing needs patching.

`~/.pi/agent/cliproxyapi-overrides.json`:

```json
{
  "defaults": {
    "contextWindowSource": "context_window",
    "unlistedGraceMs": 86400000,
    "unlistedPolicy": "drop",
    "pricing": true
  },
  "models": {
    "deepseek-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000,
      "pin": true,
      "thinkingLevels": ["low", "high"]
    },
    "space-bunny": {
      "contextWindow": 1048576,
      "maxTokens": 524288,
      "pin": true,
      "cost": { "input": 0.5, "output": 2 }
    }
  },
  "patterns": [
    { "match": "^claude-", "contextWindow": 1000000, "maxTokens": 128000 }
  ]
}
```

Precedence is `models[id]` → last matching entry of `patterns` → catalog value. Matching is case-insensitive. `/cpa-overrides init` writes a starter file that pins every currently listed model.

### `defaults`

| Field | Default | Meaning |
|---|---|---|
| `contextWindowSource` | `context_window` | Which catalog field feeds pi's `contextWindow`. The other field is reported as drift in `/cpa-models`. |
| `contextWindow` | `128000` | Used when the catalog has no usable context window. |
| `maxTokens` | `16384` | Used when the catalog has no usable output limit. |
| `respectVisibility` | `true` | Honor `visibility: "hide"`. |
| `unlistedGraceMs` | `86400000` | How long a model that vanished from the catalog is kept. `0` drops immediately. |
| `unlistedPolicy` | `drop` | What happens after the grace period. `retain` keeps it forever. |
| `pricing` | `true` | Fetch models.dev rates. |

### Model fields

| Field | Meaning |
|---|---|
| `name` | Display name in the picker. |
| `contextWindow`, `maxTokens` | Absolute limits, in tokens. |
| `reasoning` | Force the reasoning flag. |
| `thinkingLevels` | pi thinking levels the model actually accepts. Other levels are hidden. |
| `thinkingLevelMap` | Raw escape hatch mapping pi levels to provider values (`null` = unsupported). |
| `input` | `["text"]`, `["text","image"]`, etc. |
| `cost` | USD per million tokens: `input`, `output`, `cacheRead`, `cacheWrite`, optional `tiers[]`. |
| `pricingModelId` | Look the price up under a different models.dev id. |
| `fast` | Whether the proxy advertises a priority service tier for this model. |
| `pin` | Never drop the model when it leaves the catalog, and never warn about it. |
| `hidden` | Hide from the picker. |
| `show` | Surface a model the catalog marks hidden. |
| `headers` | Extra request headers for this model. |
| `samplingParams` | Extra sampling parameters. |

## Catalog state and pinning

A model missing from an HTTP 200 catalog is either a real catalog change or a transient upstream blip, and one sample cannot tell them apart. Instead of hiding models for days and warning on every refresh, each model carries an explicit state:

| State | Meaning |
|---|---|
| `listed` | The catalog lists it. |
| `pinned` | An override pins it. Kept regardless of the catalog, never warned about. |
| `unlisted` | Missing from the catalog but inside the grace period. Still selectable. |
| `hidden` | An override hides it. |

Pins and `unlistedSince` are persisted to `~/.pi/agent/cliproxyapi-catalog.json`, so pinning works across restarts, including when the very first fetch of a new process no longer lists the model. That file also lets the picker survive a restart while the proxy is briefly unreachable. It holds no credentials.

`/cpa-models` shows the state, and marks the catalog value when it differs from the resolved one. `/cpa-refresh` forces a fetch.

## Cost and usage

CLIProxyAPI reports exact token counts per response, so accounting uses those. Rates come from models.dev, cached for 24 hours, and never guess a price: when several providers publish conflicting rates for the same id, the lookup returns zero instead of picking one arbitrarily.

Cost is an **estimate**. It reflects catalog list prices, not the proxy's own markup or your bill.

Throughput is output tokens over the generation window — first upstream event to settle — and never `output / total_latency`, which would fold in queueing and tool time. Time spent paused is excluded.

- A summary appears when a run settles: `1m 4s • ttft 0.82s • out 1.2k • in 34.5k • cache r 512.0k • 18.4 tok/s • ~$0.0142`
- `/cpa-usage` shows session totals and the last run.
- The footer shows `fast` and `paused` labels while they apply.

## Commands

| Command | Purpose |
|---|---|
| `/cpa-refresh` | Force a catalog fetch and re-register models. |
| `/cpa-models` | List models with limits, state, Fast capability and cost source. |
| `/cpa-doctor` | Show configuration, credential source, catalog state, override problems and the last CPA trace id. |
| `/cpa-usage` | Session and last-run token usage. |
| `/cpa-overrides` | Show the overrides file, or `init` to seed one. |
| `/fast` | Toggle OpenAI priority processing. |
| `/pause`, `/continue` | Gate provider requests, persisted across restarts. |

Fast is off by default: priority processing bills at a higher rate. It only changes the request for models whose catalog entry advertises a non-empty `service_tiers` array; the other models are left untouched and `/fast` says so.

## Differences from the upstream provider

The upstream provider patches pi-ai's bundled `openai-codex-responses.js` at runtime with four regular expressions, writes the result to a temp file and imports it. That approach breaks whenever pi changes that file, needs eighteen hardcoded install-path probes, and prevents any model metadata correction from being expressed as configuration.

This provider instead uses pi-ai's built-in `openai-responses` implementation against the proxy's Codex-compatible endpoint. Not patching is a deliberate architectural choice, and it removes the failure modes rather than guarding them:

| Upstream | Here |
|---|---|
| Regex patch of the bundled Codex stream module | `api: "openai-responses"`, no custom `streamSimple` |
| 18 hardcoded module-path probes, temp `.mjs` cache | Nothing to resolve; pi-ai's implementation is used directly |
| `extractAccountId` must be patched to accept plain keys | The Responses implementation has no account-id concept |
| Codex WebSocket reuse, server-side context | SSE with the full request body, so nothing is cached server-side |
| Proactive compaction, WebSocket reset on `/compact` | pi's own compaction decides, using native per-model `reserveTokens` |
| Model corrections patched into the source | `cliproxyapi-overrides.json` |
| Pinned models impossible; missing models hidden for 7 days and warned about repeatedly | Explicit `pinned` / `unlisted` state persisted across restarts |
| Monkeys patched footer, local TPS guess | Official status row; TPS over the generation window |

It trades the Codex WebSocket transport away for the Responses transport. Verified working against a live proxy: catalog discovery, plain responses, tool calls and tool-result round-trips, exact usage, and Fast payload injection. Not verified here: image input, abort behaviour, context overflow, and WebSocket-only proxies.

## Status

Usable and covered by 111 tests, but young: the overrides schema and the catalog cache schema can still change, and a cache version mismatch discards the file, costing one refresh.

Requirements: pi `>=1.0.0`, Node `>=22.19.0`.

## License

MIT
