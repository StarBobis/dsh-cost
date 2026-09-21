# dsh-cost

[English](README.md) | 简体中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的模型计费插件：按模型配置 Token 单价，在对话中实时显示消耗，并保存每个会话的历史消耗——所有计费完全由你配置的价格驱动。

## 功能

- **对话内实时消耗。** 输入框下方显示当前会话的累计费用，随用量实时更新；点击可查看分模型明细（请求数、输入/输出/缓存 Token、费用）。
- **每个会话的历史消耗。** 设置 → 插件 → 插件配置 → **模型计费** 列出每个会话的 Token 总量与费用，点击行可打开对应会话。
- **价格由你配置。** 只有配置过价格的模型才计费。内置 [OpenCode Zen](https://opencode.ai/docs/zen#pricing) 价格预设（美元 / 每 1M Token，已忽略全免费的模型），你的条目按键覆盖预设。
- **缓存感知。** 未缓存输入、缓存读取、缓存写入分别计价（未设置时 `cacheRead` / `cacheWrite` 回退到输入价）。
- **分档价格。** 条目可声明按请求分档（如 Claude Sonnet 的 >200K 档），分档用量按每个请求自身的大小计价。

## 安装

从 GitHub 安装（pnpm 会在安装时通过 `prepare` 脚本构建本包；若 pnpm 拦截构建脚本，按 CLI 提示把 `dsh-cost` 加入 profile 目录下 `pnpm-workspace.yaml` 的 `allowBuilds` 后重跑）：

```sh
dsh plugin --profile web add github:<owner>/dsh-cost
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

## 配置价格

打开 **设置 → 插件 → 插件配置 → 模型计费**，或编辑 profile 的用户层（`%USERPROFILE%/.dsh/profiles/web/cordis.patch.yml`）：

```yaml
- id: cost
  config:
    currency: CNY        # 展示用货币标签；预设表为美元标价
    presets: true        # 启用内置 OpenCode Zen 预设
    models:              # 每 1M Token 价格；键 = 模型 ID 或 provider/model
      deepseek-chat:
        input: 0.27
        output: 1.10
        cacheRead: 0.07
      my-provider/my-model:
        input: 2
        output: 8
        cacheRead: 0.5
        cacheWrite: 10
        tiers:           # 可选：按请求计费输入大小分档
          - above: 200000
            input: 4
            output: 12
```

- `provider/model` 键优先于裸 `model` 键，同一模型 ID 可按 provider 分别定价。
- 没有匹配条目的模型标记为「未配置价格」，不计入总费用。
- 省略 `cacheRead` / `cacheWrite` 时按 `input` 价计。

## 工作原理

Host 插件回放持久化会话日志——`request/header` 选定请求的 provider/model，`assistant/message` / `assistant/attempt` 提供 provider 上报的用量，`llm/retry-started` 结束一次重试替换窗口——把每个模型的 Token 桶折叠为一个 `cost` 会话投影（session projection）。投影缓存（projection cache）持久化折叠结果，历史记录在重启后保留，冷会话列表直接读取最近一次计算值。

平价（无分档）模型按当前价格表从 Token 桶实时计价，所以修改平价会立即重估历史；分档模型在折叠时按当时价格累计（请求的档位取决于自身大小，累计桶无法还原），所以修改分档价格只影响新请求。

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
