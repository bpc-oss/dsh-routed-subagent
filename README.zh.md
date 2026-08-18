# dsh-routed-subagent

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 全局插件：让**任意会话**都能派一个**完整挂载到任意 agent preset** 的一次性（one-shot）子代理，支持**按次指定模型/provider** 和**模型可用性预检**。

官方 `subagent` / `subagent_fork` 工具强制子代理**继承父方 preset**。本插件用自定义 subagent provider 替代：其 **async 子代理 setup** 调用 `agentPresets.mount(childCtx, <preset>)`——子代理获得**目标 preset 的完整组装**（persona、提示词段、技能目录、工具），而不是 persona 拷贝。

## 特性

- **任意 preset、任意会话**：注册在 host 平面（全局层），所有 preset 的会话都有该工具；**新增 preset 零配置**。
- **完整挂载**：子代理运行在目标 preset 的 standing 组装下（身份、使命段、技能、工具全用目标 preset 的）。
- **按次指定模型**：`model` / `provider` 参数把子代理的 LLM 调用路由到与当前会话不同的模型（走官方 `resolveChildAgentOptions` 通道）。
- **模型预检**：无效模型**快速失败**并列出该 provider 的候选模型，而不是等到子代理晦涩地失败。
- **官方子代理生态**：one-shot 生命周期事件、UI 行、轨迹可见；返回子代理最终输出。
- **provider 注册幂等**：多 preset 并存不会重复注册 host 平面 provider。

## 分发

**仅 GitHub**。本插件**不发布到 npm**，通过挂载包目录安装（见下）。`peerDependencies` 以真实 semver 声明、仅作元数据，不参与 npm 解析。

**兼容性**：在 DeepSeek Harness **rc.7+** 验证（本插件依赖的 async 子代理 setup 是较新的 harness 行为）。

## 安装

纯 ESM 包，带 `cordis.patch.yml` bundle 声明。

### 1. 把包链接进 harness 安装

插件静态 import `@deepseek-ai/*` 包（Node ESM 按 realpath 解析）。在包目录创建指向 harness 安装的 `node_modules` junction/软链：

```bat
:: Windows
mklink /J "<plugin-dir>\node_modules" "<harness>\resources\host\node_modules"
```

```sh
# POSIX (Linux/macOS)
ln -s "<harness>/resources/host/node_modules" "<plugin-dir>/node_modules"
```

### 2. 把 bundle 加进 profile

把包加进 profile 的 `dsh.profile.bundles` 列表（如 `<dshHome>/profiles/web/package.json`）：

```json
{
  "dependencies": { "dsh-routed-subagent": "link:<plugin-dir>" },
  "dsh": { "profile": { "bundles": ["...", "dsh-routed-subagent"] } }
}
```

仓库里的 `cordis.patch.yml` 就是注册插件的 bundle 层；包被列入 `bundles` 时自动应用。

> 若使用 [dsh-super-injector](https://github.com/liustack/dsh-super-injector)，快捷方式为 `dev_install_package(dir=<plugin-dir>)`（热装配免重启）、改后 `dev_reload_package(dsh-routed-subagent)`。重启后两种方式都由 `bundles` 列表自动装配。

## 用法

```
subagent_routed(
  prompt="用 dev 工程师标准审查这个仓库",
  preset="dev",                    # roster 中的任意 preset id
  description="dev 审查",          # 显示名
  max_depth=2,                     # 递归预算（默认 3，须 >= 0）
  model="deepseek-v4-flash-free",  # 可选：子代理本次使用的模型
  provider="opencode",             # 可选：该模型所属 provider
)
```

| 输入 | 行为 |
|---|---|
| `preset` 无效/无法解析 | 报错并透传 roster 可用 preset id |
| `model` 在 provider 下无效 | 快速失败，列出该 provider 的候选模型（原始错误保留在 `cause`） |
| `model` 省略 | 子代理继承当前会话模型（向后兼容） |
| `max_depth` 负数/非有限 | 工具层校验报错 |
| 正常调用 | 子代理完整挂载目标 preset，跑一轮，返回最终输出 |

## 原理

1. 自定义 subagent provider（`routed-mount`）复刻官方 one-shot 进程内驱动（`dsh-subagent-in-process-driver` 的 `startInProcessRun`），**唯一关键改动**：子代理 setup 改为 `async` 并 `await agentPresets.mount(childCtx, targetPreset)`（替代认父）。
2. `agents.create` 会 await setup（`dsh-agent-loop` 已确认）——async mount 在未发布的创建窗口内执行，失败整体回滚。
3. 子代理会话 header 记录 `agentPreset: <目标>`（覆盖父方值）——冷读按真实运行的组装重建。
4. 工具分两段顺序收尾：**先 result 后 dispose**（与官方 `settleForegroundRun` 一致）——若并行会把 dispose 的取消标志抢先，导致子代理"一启动就 aborted"。

## 已知限制

- **仅 one-shot**：子代理是单轮专家调用（适合审查/审计/调研）。continuable（`send_message`）子代理仍继承父方 preset——这是平台约束。
- **模型错误以 `error` 呈现**：与官方一致，返回 `stopReason`；底层 LLM 错误细节不内嵌在工具结果里（可见于子代理会话日志）。
- **预检是有条件的**：仅当 harness 暴露 `llm` 服务**且**存在 provider 路由（显式 `provider` 或继承父方）时才执行预检；否则跳过、直接派发。
- **provider 可用性取决于环境**：预检只校验模型目录；真正调用仍需 provider 可达且 key 有效。

## 开发

```bash
node --check lib/index.js   # 语法检查
```

插件为单个 ~330 行文件、零构建。CI 每次推送执行 `node --check`。

## License

MIT
