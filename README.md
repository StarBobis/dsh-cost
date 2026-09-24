# dsh-cost

English | [简体中文](README.zh-CN.md)

Model cost metering for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): bundled model pricing (DeepSeek first-party list prices plus the OpenCode Zen catalog), a live cost pill in the conversation, and per-session cost history.

## What you get

- **Live cost in the conversation.** A pill under the composer shows the current session's running cost and updates as usage streams in. Click it for the per-model breakdown (requests, input/output/cache tokens, cost).
- **Per-session cost history.** Settings → Plugins → Plugin configuration → **Model cost** lists every session with its models, token total, and cost; click a row to open the session, or expand it for the per-model breakdown (requests, per-bucket tokens, and input / output / cache-read / cache-write costs that sum to the subtotal, plus that model's peak/off-peak split when it bills by period). The history pages ten rows at a time, filters by model (the header total then sums that model's share), and reports the aggregate cost breakdown above the table.
- **Bundled prices, shown read-only.** The card lists input / output / cache-read / cache-write rates per 1M tokens: DeepSeek's first-party models at their [official list prices](https://api-docs.deepseek.com/quick_start/pricing) in USD, everything else at [OpenCode Zen](https://opencode.ai/docs/zen#pricing) list prices (free models omitted). There is no price editor in the UI.
- **Peak/off-peak billing (DeepSeek).** DeepSeek bills by *request time*: peak hours are Beijing time Monday–Friday 09:00–12:00 and 14:00–18:00 excluding Chinese public holidays, and every other hour — weekends and holidays in full — bills the off-peak rate, which is half. The price table shows both rows, and history accumulates each request under its own period.
- **Cache-aware.** Uncached input, cache reads, and cache writes are billed at their own rates (`cacheRead` / `cacheWrite` fall back to the input rate when unset).
- **Tiered pricing.** Entries may declare per-request tiers (e.g. Claude Sonnet's >200K rate); tiered usage is billed at each request's own size.

## Install

From GitHub (pnpm builds the package on install via its `prepare` script; if pnpm blocks build scripts, allow `dsh-cost` under `allowBuilds` in the profile's `pnpm-workspace.yaml` as the CLI hint suggests, then re-run):

```sh
dsh plugin --profile web add github:StarBobis/dsh-cost
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

## The price table

Prices are not configured here: the plugin ships DeepSeek's first-party list prices and the OpenCode Zen catalog, and the card's **Model prices** section shows them read-only as `model id → input / output / cache read / cache write`, with a second `↳ Off-peak (half price)` row for DeepSeek models.

Two escape hatches exist at the composition layer only (no UI entry) — the profile's user layer (`%USERPROFILE%/.dsh/profiles/web/cordis.patch.yml`) or a `dsh-cost:` settings section:

```yaml
- id: cost
  config:
    models:              # cover a model the bundle does not list, or re-price a bundled key (the card marks it "set")
      k3-256k:
        input: 2
        output: 8
        cacheRead: 0.5   # omit it and cache reads bill at the input rate — always set it for cache-heavy models
      my-provider/my-model:
        input: 2
        output: 8
        tiers:           # optional: per-request tiers by billed input size
          - above: 200000
            input: 4
            output: 12
        offPeak:         # optional: off-peak rates (both input and output required)
          input: 1
          output: 4
    holidays:            # optional: extra Chinese public holidays (Beijing YYYY-MM-DD), off-peak all day
      - 2027-01-01
```

- `provider/model` keys beat bare `model` keys, so one model id can be priced differently per provider.
- Models with no matching entry are listed as *unpriced* and contribute nothing to the total.
- `cacheRead` / `cacheWrite` default to the `input` rate when omitted.
- The peak rule and the holiday calendar are bundled (`PEAK_WINDOWS` and `CHINA_PUBLIC_HOLIDAYS` in `pricing.ts`). The calendar carries the dates from the State Council notices for 2025 and 2026; update the plugin when the next arrangement is published, or add dates through `holidays` — an unlisted date bills as an ordinary weekday (peak windows included).

## How it works

The host plugin replays the durable session log — `request/header` picks the routed provider/model, `assistant/message` / `assistant/attempt` contribute provider-reported usage, and `llm/retry-started` ends one attempt's replacement slot — into per-model token buckets as a `cost` [session projection](https://github.com/deepseek-ai/deepseek-harness). The projection cache persists the fold, so history survives restarts and cold sessions list with their last computed value.

Sessions that predate the plugin (or were never opened since) have no cached fold. The history's **Refresh** button triggers an immediate on-demand sweep — the host cold-reads every session missing a checkpoint (archived ones included), then the card re-pulls the list, so the full history lands in one click; a slower paced background sweep also runs after startup, and a click only speeds up a sweep already in flight (the sweep is single-flight, so nothing folds twice). The sweep resumes across restarts; set `backfill: false` in the composition config to disable the background sweep (Refresh's immediate parse is unaffected).

When a refresh finishes, the card reports what the sweep did (added / failed / listed) under the toolbar, in warning color when anything failed — the host's per-session warnings never reach the terminal in this profile, so that line is the only place the outcome is visible. The one thing a sweep cannot fold is a fork-seeded session: the framework's `readSession` rejects those logs, and the session list withholds cached values from an unopened fork anyway, so they are absent from history and counted as failures in the report.

Flat-rate (tier-less) models price from their token buckets against the current table; tiered models accumulate at fold time (a request's tier depends on its own size, which cumulative buckets cannot reconstruct); models with an off-peak row accumulate their peak-window buckets separately at fold time and the view combines both periods at their own rates. Price updates therefore revalue history instantly, while the period a request belongs to comes from the timestamp of each usage event in the log (a request straddling a window boundary bills the period it settled in). That split raised the fold-state version to v3, so cached checkpoints re-fold on the next parse.

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
