# dsh-cost

English | [简体中文](README.zh-CN.md)

Model cost metering for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): per-model token pricing, a live cost pill in the conversation, and per-session cost history — driven entirely by the prices you configure.

## What you get

- **Live cost in the conversation.** A pill under the composer shows the current session's running cost and updates as usage streams in. Click it for the per-model breakdown (requests, input/output/cache tokens, cost).
- **Per-session cost history.** Settings → Plugins → Plugin configuration → **Model cost** lists every session with its token total and cost; click a row to open the session.
- **Your prices, your currency.** Cost accrues only for models you priced. A bundled [OpenCode Zen](https://opencode.ai/docs/zen#pricing) preset table (USD per 1M tokens, free models omitted) covers common models out of the box; your entries override it per key.
- **Cache-aware.** Uncached input, cache reads, and cache writes are billed at their own rates (`cacheRead` / `cacheWrite` fall back to the input rate when unset).
- **Tiered pricing.** Entries may declare per-request tiers (e.g. Claude Sonnet's >200K rate); tiered usage is billed at each request's own size.

## Install

From GitHub (pnpm builds the package on install via its `prepare` script; if pnpm blocks build scripts, allow `dsh-cost` under `allowBuilds` in the profile's `pnpm-workspace.yaml` as the CLI hint suggests, then re-run):

```sh
dsh plugin --profile web add github:<owner>/dsh-cost
```

or from a local checkout (pack first — a Windows pnpm quirk mis-links `link:` specs pointing at drive-letter paths):

```sh
cd /path/to/dsh-cost && npm pack
dsh plugin --profile web add /path/to/dsh-cost/dsh-cost-0.1.0.tgz
```

Then start the web UI as usual:

```sh
dsh web
```

## Configure prices

Open **Settings → Plugins → Plugin configuration → Model cost**, or edit the profile's user layer (`%USERPROFILE%/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- id: cost
  config:
    currency: USD        # display label; the preset table is USD list prices
    presets: true        # include the bundled OpenCode Zen prices
    models:              # per 1M tokens; key = model id or provider/model
      deepseek-chat:
        input: 0.27
        output: 1.10
        cacheRead: 0.07
      my-provider/my-model:
        input: 2
        output: 8
        cacheRead: 0.5
        cacheWrite: 10
        tiers:           # optional: per-request tiers by billed input size
          - above: 200000
            input: 4
            output: 12
```

- `provider/model` keys beat bare `model` keys, so one model id can be priced differently per provider.
- Models with no matching entry are listed as *unpriced* and contribute nothing to the total.
- `cacheRead` / `cacheWrite` default to the `input` rate when omitted.

## How it works

The host plugin replays the durable session log — `request/header` picks the routed provider/model, `assistant/message` / `assistant/attempt` contribute provider-reported usage, and `llm/retry-started` ends one attempt's replacement slot — into per-model token buckets as a `cost` [session projection](https://github.com/deepseek-ai/deepseek-harness). The projection cache persists the fold, so history survives restarts and cold sessions list with their last computed value.

Flat-rate rows are priced from the buckets against the live table, so editing a flat price revalues history instantly. Tiered rows accumulate at fold time (a request's tier depends on its own size, which cumulative buckets cannot reconstruct), so editing a tiered price applies to new requests only.

## Compatibility

Built and tested against DeepSeek Harness `0.1.5-rc.x`. The plugin declares peer ranges `@deepseek-ai/dsh-* >=0.1.5-alpha.1 <0.2.0-0` and `@deepseek-ai/cordis >=4.0.1-rc.1 <5`.

## Development

```sh
npm install
npm run build       # tsc (host) + tsdown (client bundle lib/client.js)
npm run typecheck
```

The package carries both halves: the host plugin (`lib/index.js`, mounted by `cordis.patch.yml`) and the web client bundle (`lib/client.js`, declared by `dsh.client` and served through the client-modules `/plugins` combo route).

## License

[MIT](LICENSE)
