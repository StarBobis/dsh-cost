# dsh-cost

[English](README.md) | 简体中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的模型计费插件：价格随插件内置（DeepSeek 官方价目 + OpenCode Zen 列表价），在对话中实时显示消耗，并保存每个会话的历史消耗。

## 功能

- **对话内实时消耗。** 输入框下方显示当前会话的累计费用，随用量实时更新；点击可查看分模型明细（请求数、输入/输出/缓存 Token、费用）。
- **每个会话的历史消耗。** 设置 → 插件 → 插件配置 → **模型计费** 列出每个会话使用的模型、Token 总量与费用，点击行可打开对应会话；展开行可查看分模型明细（请求数、分桶 Token，以及输入 / 输出 / 缓存读 / 缓存写分项费用，分项之和即小计，DeepSeek 行还会显示高峰 / 空闲时段各自的费用）。历史记录每页十条，可按模型筛选（标题合计随之变为该模型的累计），表格上方同时展示汇总费用构成。
- **价格内置，只读展示。** 卡片直接列出每 1M Token 的输入 / 输出 / 缓存读 / 缓存写价格：DeepSeek 第一方模型取[官方价目](https://api-docs.deepseek.com/quick_start/pricing)（美元），其余取 [OpenCode Zen](https://opencode.ai/docs/zen#pricing) 列表价（已忽略全免费的模型）。界面不提供改价入口。
- **峰谷计价（DeepSeek）。** DeepSeek 按**请求时间**计费：高峰时段为北京时间周一至周五 09:00–12:00、14:00–18:00（不含中国法定节假日），其余时段——含周末与法定节假日全天——按空闲时段价格（半价）计费。价格表为峰谷两行，历史按每个请求自身的时间分段累计。
- **缓存感知。** 未缓存输入、缓存命中读取、缓存写入分别计价（未单独定价时 `cacheRead` / `cacheWrite` 回退到输入价）。
- **分档价格。** 条目可声明按请求分档（如 Claude Sonnet 的 >200K 档），分档用量按每个请求自身的大小计价。

## 安装

从 GitHub 安装（pnpm 会在安装时通过 `prepare` 脚本构建本包；若 pnpm 拦截构建脚本，按 CLI 提示把 `dsh-cost` 加入 profile 目录下 `pnpm-workspace.yaml` 的 `allowBuilds` 后重跑）：

```sh
dsh plugin --profile web add github:StarBobis/dsh-cost
```

或从本地检出安装（先打包 —— Windows 上 pnpm 会把指向盘符路径的 `link:` 规格错误地链接成坏符号链接）：

```sh
cd /path/to/dsh-cost && npm pack
dsh plugin --profile web add /path/to/dsh-cost/dsh-cost-0.1.0.tgz
```

然后正常启动 Web 界面：

```sh
dsh web
```

## 价格表

价格不在这里配置：插件自带 DeepSeek 第一方价目与 OpenCode Zen 列表价，卡片的「模型价格」区按 `模型 ID → 输入 / 输出 / 缓存读 / 缓存写` 只读展示，DeepSeek 行下方多一行「空闲时段（半价）」。

两处例外可在 profile 的用户层（`%USERPROFILE%/.dsh/profiles/web/cordis.patch.yml`）或 `dsh-cost:` 设置段里声明——这是组合层配置，界面不提供入口：

```yaml
- id: cost
  config:
    models:              # 补充内置表未收录的模型，或按需覆盖同键的内置价（卡片标记「配置」）
      k3-256k:
        input: 2
        output: 8
        cacheRead: 0.5   # 省略时按输入价计——缓存读量大的模型务必显式给出
      my-provider/my-model:
        input: 2
        output: 8
        tiers:           # 可选：按请求计费输入大小分档
          - above: 200000
            input: 4
            output: 12
        offPeak:         # 可选：空闲时段价（DeepSeek 用内置规则，这里同时含 input/output）
          input: 1
          output: 4
    holidays:            # 可选：额外的中国法定节假日（北京时间 YYYY-MM-DD），全天按空闲时段计
      - 2027-01-01
```

- `provider/model` 键优先于裸 `model` 键，同一模型 ID 可按 provider 分别定价。
- 没有匹配条目的模型标记为「未配置价格」，不计入总费用。
- 省略 `cacheRead` / `cacheWrite` 时按 `input` 价计。
- 峰谷规则与节假日日历随插件内置（见 `pricing.ts`：`PEAK_WINDOWS`、`CHINA_PUBLIC_HOLIDAYS`）。日历收录 2025、2026 年国务院办公厅放假通知中的日期；国务院公布下一年安排后需要更新插件，或用上面的 `holidays` 临时补充——未收录的日期按工作日处理（即高峰时段照常计费）。

## 工作原理

Host 插件回放持久化会话日志——`request/header` 选定请求的 provider/model，`assistant/message` / `assistant/attempt` 提供 provider 上报的用量，`llm/retry-started` 结束一次重试替换窗口——把每个模型的 Token 桶折叠为一个 `cost` 会话投影（session projection）。投影缓存（projection cache）持久化折叠结果，历史记录在重启后保留，冷会话列表直接读取最近一次计算值。

早于插件安装（或安装后从未打开）的会话没有缓存折叠结果。点击历史区的「刷新」会立即触发主机全量解析——冷读所有缺检查点的会话（包括已归档会话），完成后自动重拉列表，一次点击即可看到全部历史；插件启动后也会在后台慢速逐个补齐，重复点击只会加速正在进行的扫描（单飞），不会重复折叠。补齐跨重启续跑；可在组合配置中设 `backfill: false` 关闭后台补齐（「刷新」的立即解析不受影响）。

刷新结束后卡片会在工具条下方报告本次扫描结果（新增 / 失败 / 会话总数），失败数非零时以警示色显示——Host 侧的逐条告警默认不会出现在终端，这张报告是判断「刷新到底做了什么」的唯一入口。唯一无法冷读的是 fork 继承（seeded）会话：框架的 `readSession` 会拒绝这类日志，且会话列表本身也不为未打开的 fork 会话提供缓存值，因此它们既不显示在历史里，也会计入报告的失败数。

平价（无分档）模型按当前价格表从 Token 桶实时计价；分档模型在折叠时按当时价格累计（请求的档位取决于自身大小，累计桶无法还原）；带空闲时段价的模型在折叠时按每个请求的时间把 Token 分到高峰 / 空闲两组桶，视图按各自费率合成总价——所以价格更新会立即重估历史，而峰谷归属取决于日志里每条用量事件的时间戳（跨时段边界的请求按结算时刻归属）。折叠状态版本随之升到 v3：旧的缓存检查点会在下次解析时重折。

## 兼容性

基于 DeepSeek Harness `0.1.5-rc.x` 开发与测试。peer 范围为 `@deepseek-ai/dsh-* >=0.1.5-alpha.1 <0.2.0-0`、`@deepseek-ai/cordis >=4.0.1-rc.1 <5`。

## 开发

```sh
npm install
npm run build       # tsc（host）+ tsdown（client bundle lib/client.js）
npm run typecheck
```

一个包同时携带两半：Host 插件（`lib/index.js`，由 `cordis.patch.yml` 挂载）与 Web client bundle（`lib/client.js`，由 `dsh.client` 声明，经 client-modules 的 `/plugins` 组合路由提供）。

## 许可证

[MIT](LICENSE)
