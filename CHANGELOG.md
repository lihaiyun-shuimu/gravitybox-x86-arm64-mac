# 更新日志 (Changelog)

本项目的所有重要变更均记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本 (Semantic Versioning)](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [1.2.0] - 2026-11-23

### Added
- **SSH 远程窗口零外部 `ssh` 适配**：通过本机 CDP 通道适配 Antigravity `2.33.0+` SSH 远程窗口（不拉起外部 `ssh` 进程），提供完整双语热适配、实时 HUD（含降级状态）、与本机隔离的 `本机 / SSH: <host>` 只读配额查看及活跃 SSH 保护提醒（`src/ssh-context.ts` / `src/ssh-remote-rpc.ts`）。
- **本机 + SSH 统一多环境用量账本**：保持 `PRAGMA user_version = 2` 兼容，新增 `sync_receipts` 原子提交与同源 RPC 增量同步（按 `trajectoryId` 去重并基于时间线判定账号归属），上线合并总览、`本机 % · SSH %` 占比与 `environmentId × accountId` 筛选（`src/remote-usage-sync.ts` / `src/usage-ledger.ts`）。
- **HTTP / HTTPS 网络代理支持**：支持关闭、跟随 macOS 系统代理或手动配置 `http(s)://` 代理，为 Antigravity 注入环境变量并检测运行中进程的代理生效与 Shell 覆盖状态（`src/proxy.ts` / `native/SystemProxy.swift`）。
- **Antigravity `2.34.0` 收录、BTW 分栏与目录更新**：收录 `2.34.0` 官方指纹与词典（`ui-strings/2.34.0.json`），支持 BTW 侧边提问分栏 HUD 观测与克隆前缀去重计费；为 `gemini-2.5-pro` 补全 `> 200K` 上下文阶梯定价、移除 `gpt-oss-120b`，并放宽未来模型前缀识别与过滤非商业订阅等级标签（`src/pricing.ts` / `assets/model-catalog.json`）。

### Changed
- **启动方式重构为「启动时自动打开 Antigravity」**：因新版 Antigravity 官方应用默认不再开启调试端口（且本工具坚持不修改官方安装包），原「跟随 Antigravity 启停」已替换为 **「启动时自动打开 Antigravity」**（打开 GravityBox 时自动驻留菜单栏并拉起带调试端口的 Antigravity），同时将安全重启等待放宽至 15 秒并防止重复触发（`native/Configuration.swift` / `native/AssistantProcessLifecycle.swift` / `native/Preferences.swift`）。
- **SSH 多主机 UI 与用量展示统一**：总览页新增伴生 SSH 主机列表与下钻顶栏、菜单栏支持可展开范围切换胶囊、用量页内嵌环境占比条、账号页新增远端只读卡片，并统一主界面与菜单栏的「部分计价 / 未计价」及「缓存命中率」展示口径（`native/Presentation.swift`）。

### Fixed
- **`sqlite-worker` 稳定性修复（`#26`，致谢 `@Agonie0v0`）**：修复无活跃事务关闭连接时的句柄泄漏，并优化中等 BLOB 的单次切片读取（`src/sqlite-worker.ts`）。
- **原生交互与本地化/安全加固**：完善 `firstMouse` 首次点击响应、`NSMenu` 弹窗锚定与收起行为；隔离 IDE 内联/非内联翻译模板并新增组合式回退，同时加固切号回滚与维护进程守卫（进程探测为 `unknown` 时拒绝清理）。

## [1.1.3] - 2026-11-21

### Added
- **JSON Account Import & `0600` Backup Export (`#20`)**：由账号页头部统一「管理账号…」入口唤起三卡式 `AddAccountSheet`（「保存当前账号 + 导入账号 + 导出账号」）；后端 `importAccountsFromJson` / `exportAccountsBackup` 支持单文件、多文件与目录批量导入（单锁批量事务、按标准化邮箱去重以隔离外部 ID 碰撞），导出需经二次交互确认并由后端直接以 `0600` 权限原子落盘（IPC 零凭据返回，且禁止覆写内部状态目录文件）。

### Changed
- **Antigravity `2.34.0` Runtime Auto-Adaptation & Orchestrator Plan & Execute HUD**：支持运行期自动感知新版本宿主模型元数据与动态容量（含 `-tiered` 分级变体统一归一）、自适应高覆盖率全量翻译（含词典重载保活）及 Orchestrator + Executor 双阶段对话上下文与模型简称精准呈现（`src/hud/` / `src/model-catalog.ts` / `src/controller.ts` / `runtime/hud-*.js`）。
- **Upstream `QuotaSummaryGroup` SSOT & Future Pool Presentation**：以官方 `RetrieveUserQuotaSummary.groups[]` 为配额分组单一事实源，准确投影独立多窗口配额池并彻底隔离 `Orchestrator` 编排器元模型（`src/quota.ts` / `src/account-quota.ts` / `native/QuotaPresentation.swift` / `native/ModelIcons.swift`）。
- **Authoritative Remote Pricing Catalog & Official Host Watch**：`assets/pricing-feed.json`（保留 `schema: 1`）支持随包冷启动水合与完整生效快照接管，远端同步可直接热更新公开模型清单、别名、容量与中英定价依据（`ETag` / `304` + SHA-256 去重 + `pricingRevision` 实时联动界面与 HUD）；GitHub Actions 价格巡检改以 Antigravity 官方模型文档为权威真值源做原文精确核对与宿主过滤（忽略非宿主模型），核验通过后自动合入公开费率。
- **Thinking-Variant Usage Summary Folding**：原生主窗口用量页、总览热门模型卡片及常驻菜单栏面板（`ModelUsageFold`）自动将同一基础模型的思考程度变体（`-low`、`-medium`、`-high`、`-xhigh`、`-extra-high`、`-extra-low`、`-thinking`、`-max`、`-tiered`）合并汇总按消耗降序展示 Token、请求数与费用并同步折叠后待定价模型计数，同时保留请求明细流水原始模型标识。
- **Same-Origin `agy` CLI Credential Sync & Compliant Switching (`#19`)**：切号与回滚时按非侵入原则同步已存在的同源 CLI 凭据文件（`~/.gemini/antigravity-cli/antigravity-oauth-token` 与 `~/.gemini/jetski-standalone-oauth-token`，不主动新建且完全隔离 `@google/gemini-cli` 凭据）；无 `.env` 凭据配置时允许持有有效 `refresh_token` 但 `access_token` 已过期的账号正常切号，并将 CLI 同步隔离于桌面端 7 天回滚文件摘要锁之外，确保 CLI 外部续期后仍可完整对称回滚。
- **Three-Tier Periodic Quota Refresh & Dynamic Stale Threshold Alignment**：建立「后端过期待刷巡检（启动 5 秒 + 30 秒周期，按配置间隔冷却防离线/报错重试风暴）+ 原生 `Assistant` 定时刷新与唤醒补刷 + 手动按需刷新」三层配额刷新机制；前后端统一将配额过期阈值动态对齐所选刷新间隔（`resolveQuotaStaleSeconds` / `quotaStaleThresholdSeconds`，默认 15 分钟，间隔大于 15 分钟时自动放宽为 `interval + 2m`），覆盖后端配额概览、Argon/Carbon 独立池、主窗口账号卡片与常驻菜单栏面板并在切换刷新周期后即时生效。
- **Menu Bar Floating Panel & Keyboard Polish (`MenuFloatingPanel`)**：将菜单栏展开面板由 `NSPopover` 重构为非激活可聚焦浮窗 `MenuFloatingPanel`（顶边锚定自适应平滑伸缩，保持 `.statusBar` 窗口层级，支持全屏、跨空间与台前调度可达），并新增主窗口与菜单面板 `⌘1/2/3` 快捷键、分段控件左右键切换与焦点环重绘、状态栏微点提示、15 秒用量缓存自动刷新及过期定价页脚提醒（`Assistant` / `MenuPanelController` / `MenuPanelComponents` / `DesignControls`）。
- **Safe Relaunch Banner & Closed-Loop Trigger (`#21`)**：优化未开启调试端口提示横幅的紧凑排版，将「安全重启以连接」精简为点击后直接优雅退出重连（移除冗余二次确认弹窗）；修复 Antigravity 无调试端口运行时点击「打开 Antigravity」仅激活原窗口却忽略 `--remote-debugging-port=0` 的问题（自动转入安全重启流程）、避免外部独立/残留 `language_server` 进程导致 10 秒退出等待误超时，并在重启完成后主动校验 `DevToolsActivePort` 监听与调试参数是否真正生效（`AssistantProcessLifecycle` / `MenuPanelController` / `Pages`）。
- **Antigravity IDE Runtime Localization & Future Model Compatibility**：补充 Orchestrator / Input Box 等新增交互界面词典、上下文动态模板规则与模型名保护白名单，保留 `Orchestrator` / `Executor` 英文术语、推理档位标签（`Low` / `Medium` / `High` / `Extra` / `Max`）及 `Enter` / `Cmd+Enter` 发送快捷键，放行系统设置内 `Orchestrator/Executor Model` 设置行，并支持动态识别 Ultra Gemini 共享池模型与未来世代模型（Claude Mythos / Fable、GPT-6+ 等）归类排序（`dict/base.json` / `runtime/engine.js` / `src/bundle.ts` / `src/coverage.ts` / `PricingSyncSheetController` / `QuotaPresentation`）。
- **Standby Account Quota Tracking, Pre-Expiry Refresh & Recommendations**：针对 Antigravity `2.34.0` 环境变量本地通信与单一 macOS 钥匙串活跃会话限制下未激活备用账号访问令牌约 1 小时后无法后台续期的边界，新增备用账号自动跳过过期云端刷新、临近过期自动补采末班车快照、切入/切出时顺手同步最新登录态、已过重置时间标示「预计已重置」（底层保留原始快照不虚构满额数值），以及三层智能切号推荐与通俗易懂的双语提示（`account-quota.ts` / `accounts.ts` / `account-switch.ts` / `ipc-projections.ts` / `main.ts` / `native/` / `assets/i18n/`）。
- **Unified HUD Prior Model Context & Neutral Role Badges**：取消「Orchestrator 上下文」独立特例标题，将多模型与编排器阶段收敛为单一平铺「曾用模型上下文 / Prior Model Context」列表（仅展示非当前模型）；上下文卡片顶部微调至 `344px` 保持单行不折行，并以统一的原生磨砂中性灰胶囊标记「规划 / Plan」与「执行 / Exec」角色（`runtime/hud-instance.js` / `runtime/hud-styles.js` / `runtime/hud-i18n.js` / `assets/i18n/`）。

### Fixed
- **HUD Streaming, Subagent Attribution & Projection Accuracy**：修正独立子代理分栏 `backendIsStreaming` 门控与退出复位、`findLastSubstantiveStep` 跳过尾部透明交接步（`101`/`98`）、`isSubagentTrajectory` 排除 `trajectory_metadata_blob` 自身 UUID 引用防误判、`step_type 85/127/132` 双大字段超 64KB 时保留 `render_info` Protobuf 投影、`hasValidStartedAtField4` 未来时间戳上界校验、`resolveEffectivePricingTable` 历史账本回退 `billingPrices` 与远端清空复位，以及多子代理跨并发波次两阶段防抖保活与严格隔离父会话的同子库模型回退（`hud-instance.js` / `metrics-engine.ts` / `sqlite-worker.ts`）。
- **Account Readiness, Enterprise Boundary, Recovery & Pricing Integrity**：补齐 `quota_refresh_error_code` 四端投影并收敛非鉴权错误误报；抽取 `resolveUnsavedLiveSubscriptionTier` 防止未保存 `enterprise_vertex` 账号误判 `FREE`；补齐中断回滚恢复路径对同源 `agy` CLI 凭据的对称还原、`autoHealUnpricedHistory` 仅统计实际有效新落锁数量、`importAccountsFromJson` 非字符串字段类型清洗与换新 `refresh_token` 时重置过期 `access_token`、`MenuFloatingPanel` 淡入与异步缩放顶边锚定竞态、菜单栏单账号卡片 `QuotaPresentation.warningSummary` 渲染、`PricingSyncSheetController` 空格型 `Orchestrator <Model>` 折叠、对齐 Claude API / Gemini Developer API 最新官方定价来源与生效区间，并消除 `AppUpdateManager` Swift 6 Sendable 编译警告（`account-quota.ts` / `accounts.ts` / `account-switch.ts` / `usage.ts` / `pricing.ts` / `main.ts` / `Assistant.swift` / `AppUpdateManager.swift` / `model-catalog.json` / `pricing-feed.json`）。
- **Antigravity `2.34.0` Live Quota Probe & Current Account Save (`#24`)**：兼容 Antigravity `2.34.0` 将本地 `language_server` CSRF 令牌从命令行参数迁移至环境变量 `ANTIGRAVITY_SERVER_CSRF_TOKEN` 的变更（通过 `ps eww` 读取同 UID 进程环境并结合扩展端口与端口探测兜底，规避误退化到云端 `missing_oauth_client` 报错）；修复「保存当前账号」合并桌面 `state.vscdb` / 钥匙串凭据时保留最新 `access_token` 与过期时间，并在实时配额刷新失败时不落盘过期/空配额缓存，同时补齐未配置 `.env` 场景下禁用/过期错误码提示文案（`account-probe.ts` / `accounts.ts` / `account-quota.ts` / `assets/i18n/`）。

## [1.1.2] - 2026-11-19

### Added
- **Antigravity `2.33.0` Support & Debug-Port Safe Relaunch**：登记并验证 Google Antigravity `2.33.0` 官方包指纹与 AST 提取快照（`ui-strings/2.33.0.json`），补全 `2.33.0` 新增词条至 `dict/base.json` 及 `23` 条动态/内联 `TEMPLATE_RULES`（覆盖 `2.23.0` ~ `2.33.0`）；在 `AssistantProcessLifecycle` 全部拉起/重开路径统一传入 `--remote-debugging-port=0`，并在检测到 Antigravity 已运行但未开调试端口时通过 `debug-port-missing` 状态引导用户确认后优雅退出重连（严禁后台强杀）。
- **Gemini 4 Neon, Legacy Flash-Lite Pricing & Pricing Watch Staging**：新增 `gemini-4-neon` 正式基准费率以及 `gemini-2.5-flash-lite`、`gemini-3.5-flash-lite` 历史基准费率（`model-catalog.json` / `pricing-feed.json`），支持已定价历史 Flash-Lite 模型的目录展示与折叠归档，同时保留对 `gemini-4-hydrogen-sonar` 等未定价活跃模型的识别（`src/pricing.ts`）；远端价格巡检（`tools/auto-update-pricing.mjs` / `.github/workflows/pricing-watch.yml`）支持自动暂存已发现官方费率的新模型候选（`staged_new_count`）。

### Changed
- **Decoupled Partial Cost Badges & Family-Folded Pricing Sheet**：将主窗口总览/用量页与菜单栏面板中的「部分计价 / 部分」从金额主数值前缀解耦为独立语义徽章，并在模型明细精确标注「待定价 / 部分计价」（菜单栏简写「部分 / 待定价」）；`PricingSyncSheetController` 将未定价活跃模型按基座模型家族自动折叠归并、展示涵盖变体与统一提示横幅，并移除触发横幅时的冗余头部副标题（`Pages.swift` / `Usage.swift` / `MenuPanelController.swift` / `MenuPanelComponents.swift` / `PricingSyncSheetController.swift`）。
- **Add-Account Sheet & Account Card Layout**：移除了「添加账号」弹窗中开发遗留的「Google 授权登录…」界面入口，精简为单卡确认布局（直接展示当前账号与「保存当前账号」导入入口，后台仍保留基于 `.env` 凭据的备用账号静默续期刷新配额能力），并优化账号卡片标题与徽章的水平挤压与省略表现（`Accounts.swift` / `AddAccountSheet.swift` / `account-quota.ts`）。
- **Usage Protobuf Projection**：优化用量历史数据库解析与分块投影限制（`USAGE_PROJECTION_VERSION = 2`、`USAGE_PROTO_LIMITS`），降低超大会话记录读取开销（`protobuf-projection.ts` / `usage-scanner.ts`）。

### Fixed
- **Main App & Menu Bar Backup Account Quota Sync**：修复在主窗口刷新已过期的备用账号配额后，菜单栏面板仍残留「已过期 / 数据已过期」状态的问题；为 `fetchAccountList` 增加 `accountListPendingRefetch` 排队重拉与 `accountsRevision` 匹配校验，单账号刷新后立即就地更新 `cachedAccounts` 并同步刷新菜单栏面板，`MenuPanelController` 在打开/切入配额与账号页签时校验 15 秒新鲜度，并统一主窗口折叠摘要与菜单栏对分窗口部分过期的展示口径（`Assistant.swift` / `AssistantAccountUsage.swift` / `MenuPanelController.swift` / `MenuPanelComponents.swift` / `Accounts.swift` / `src/main.ts`）。
- **HUD Subagent Running vs. Waiting/Standing-by Accuracy**：将子智能体运行态步状态（`1=PENDING`、`2=RUNNING`、`8=GENERATING`）与轮次耗时活跃状态分离，排除 `WAITING(9)`、`swarm_wait` 待命步与兄弟并发防抖拖活，并在前端 `hud-manager.js` 排除 `waiting` / `standing_by` / `blocked` / `needs_attention` 等非运行圆点与横幅混杂数字，修复 Swarm 场景下 HUD 子智能体数量虚高的问题。
- **IDE Bilingual Inline & SVG Icon Localization**：扩展 `engine.js` `INLINE_TAGS` 以支持 `<svg>` 图标占位及 `svg + span + button + span` 提示行整句映射，补齐“项目已存在”多片段弹窗、“创建项目”重复文件夹提示与“对话已归档”含图标通知等界面汉化。

## [1.1.1] - 2026-11-18

### Added
- **Full App Localization (`简体中文` / `English`)**：新增 GravityBox 自身原生 Swift AppKit 界面（`native/L10n.swift`）、Node 后端（`src/i18n.ts`）与 IDE 会话状态栏（`runtime/hud-i18n.js`）完整中英双语支持，基于外置语言包 `assets/i18n/en.json` 与 `assets/i18n/zh-Hans.json` 实现零重启实时切换。
- **System Language Following & Packaging**：设置页新增「显示语言 / Display Language」选择器（支持「跟随系统 / Follow System」「简体中文」「English」）；`tools/package-mac.mjs` 依据语言包自动写入 `Info.plist` `CFBundleLocalizations` 并随包同步双端语言资产；新增 `test/i18n-foundation.test.mjs` 与 `test/native-i18n.test.mjs`。
- **Antigravity `2.32.2` Support**：登记并验证 Google Antigravity `2.32.2` 官方包指纹与界面串提取快照（`ui-strings/2.32.2.json`），现已覆盖 `2.23.0` ~ `2.32.2` 全系列受支持正式版。

### Changed
- **Unified Language Lifecycle**：融合 Antigravity 界面汉化开关与全局语言偏好，语言切换实时联动原生窗口、菜单栏面板、后端状态消息与嵌入式 Telemetry HUD，并同步更新版本标识、截图脚本与发布文档至 `1.1.1`。
- **Modular Refactor & Bundle Hygiene**：将超大源码拆分为职责内聚的子模块（`DesignControls`、`SidebarComponents`、`LiveStatus`、`Badges`、`Charts`、`MaintenanceComponents`、`MaintenancePopover`、`MaintenanceSheetController` 与 `pricing-catalog-runtime`），精简 `package.json` 重复版本脚本并清理未引用遗留脚本与双份打包资源副本。
- **CI & Release Hardening**：收窄 `.github/workflows/ci.yml` 变更豁免清单以覆盖 `assets/i18n/`、`model-catalog.json`、`pricing-feed.json`、`ui-extraction-manifest.json` 门禁，并将 `test/pricing-catalog-sync.test.mjs` 纳入 `pricing-watch.yml`；强化 `tools/check-docs.mjs`、`tools/release-integrity.mjs` 与 `tools/package-mac.mjs` 的校验规则与打包产物洁净度。

### Fixed
- **macOS 15.1 Motion Crash (`#15`)**：修复 `DesignMotion.cancel()` 在 `CADisplayLink.invalidate()` 后冗余调用 `remove(from:forMode:)` 导致 macOS 15.1 主线程 `EXC_BAD_ACCESS` (`SIGSEGV`) 闪退的问题，并为 `CADisplayLink` 引入弱引用 Target 代理与生命周期回归测试。
- **Cross-End Bilingual & UI Lifecycle**：修复 `controller.ts` `backend.*` 键名前缀双写、`resume`/`reapply` 从英文切回中文未持久写回、英文 HUD 流式测速误显 `0 tok/s`、收起状态菜单栏面板滞留旧语言、活动模态 Sheet（含 `AccountPolicySheet`、`AddAccountSheet`、`UsageLogController`、`PricingSyncSheetController`、`MaintenancePopover`）实时语言同步与 OAuth 取消回收、`DesignButton` 无拷贝矢量图标着色、`SidebarLaunchButton` 英文宽度约束冲突及全应用零 Tooltip 约束。
- **HUD Telemetry & Dictionary Accuracy**：修复后端重启后 HUD `metricsSequence` 归零卡死、多模型切换 `gen_metadata` 串借、子代理缓存驱逐与 `render_info > 64KB` 截断丢失、中止会话 `status=6/7` 计时器空转、上下文基线步序错位及紧凑断点对齐问题；清理 `dict/base.json` 6 个全局虚词与半句漏译，解耦设置页上下文识别，统一「侧边提问」与「对战模式」术语。
- **Usage, Pricing, Quota & Security Boundaries**：修复 `resolveDatabaseModelFullName` 别名优先级与无锚点前缀匹配、`loadRateLocksOnce`/`UsageLedger` 瞬时错误保护、Worker 线程同步 `remote_pricing.json` 元数据、防降级/防跳转/流式限流远端价格同步、缺失 `cacheWrite` 锁自愈/重估守卫与跨 inode 事件归并；修正 `mergeGroupSets` 多端点优先级、`paidTier`/`AI Premium` 解析与重授权状态复位；补强 `BackendBridge` `NSLock` 并发安全与 `main.ts` 优雅退出等待及 Socket/状态目录前置校验。

## [1.1.0] - 2026-11-14

### Added
- **In-IDE Telemetry HUD**：上线 Antigravity 输入框下方三联遥测胶囊（会话概览 / Token 消耗 / 上下文水位）及独立悬浮弹层；支持实时区分模型思考（实心蓝）与工具执行（呼吸蓝）状态、TTFT / 真实 TPS / 本轮用时与模型及工具耗时拆分、高对比度进度条及一键中英文双语独立开关。
- **HUD Popover Redesign**：会话统计卡片引入虚线分隔总平均与本轮实时数据，新增「最近一步 TTFT」与「最近一步 TPS」并统一「本轮用时」等字段为固定占位格式。
- **Storage & Maintenance v2**：新增存储与维护 v2（三分类缓存扫描、废纸篓软删除、7 天恢复点管理及账本数据维护），默认隔离核心 `state.vscdb` 与凭据。
- **Pricing / Usage**：新增模型定价同步明细弹窗（`PricingSyncSheetController`），支持查看各官方模型时序定价、执行公开定价表（GitHub Raw / jsDelivr）同步与历史用量账本重估预览/应用。
- **i18n / Dictionary**：新增对 Google Antigravity `2.31.0`、`2.31.2` 与 `2.32.1` 官方版本的指纹登记、文案抽取与分层词典适配（现已覆盖 `2.23.0` ~ `2.32.1` 全系列受支持版本）。
- **Packaging / Compliance**：DMG 安装包内补充随附项目根 `LICENSE` 副本并纳入构建完整性校验清单。

### Changed
- **About & Updater UI**：移除独立更新弹窗（`UpdateSheetController`），将自动更新开关、检查更新、安装提示与版本信息内联整合至「关于 (`⌘5`)」侧栏页面；主窗口侧栏统一精简为 5 页交互结构并同步深浅色实机截图资产。
- **Usage / Model Normalization**：统一用量看板、账本聚合与账本重估（`revalueLedger`）对 `MODEL_PLACEHOLDER_M667/668/669`、推理强度后缀（`high` / `medium` / `low`）及双阶段 Orchestrator / Worker 模型的原始机器学习模型名解析。

### Fixed
- **HUD / Duration & Clocks**：使用物理时间区间并集去重并发工具与并行子智能体的耗时统计，隔离历史轮次未闭合步与 `status=6/7` 终止态步对 `inFlight` 时长与活跃计数的污染，并将前端走表速率严格封顶为 1x 物理时间，解决并发工具/子智能体期间计时倍速快进的问题；保留真实活跃长耗时工具的占位 `end` 兼容。
- **HUD / State Recovery**：修复 HUD 在 `unavailable` / `loading` 状态恢复为 `ready` 后 `#val-tps-latest` 残留 `hidden` 导致永久不可见的缺陷，确保固定占位值正确重置为 `—`。
- **Accounts / Switch & Quota**：修复切号时 LaunchServices 退出等待与 Antigravity 重启核验重试逻辑；隔离菜单栏配额警告展示状态；将 Node 后端最大老生代内存限制提升至 256MB 以避免超大历史账本分析发生 OOM。

## [1.0.5] - 2026-11-09

### Added
- **i18n / Dictionary**：为 Antigravity 2.30.0 设置面板新增的“界面布局 (Interface Layout)”模块提供标准化汉化支持，收录“界面布局”、“知识工作”、“软件工程”及对应精简/完整界面的说明文案。

### Fixed
- **Maintenance / Cleanup**：修复在 Antigravity 运行时点击“清理选中缓存… -> 退出并清理”因应用退出刷盘改变缓存指纹而报错“缓存内容或路径已变化，请重新扫描”的问题，在应用退出静止后自动重新获取最新扫描令牌再执行清理，并引入互斥锁防止并发扫描与清理/恢复交错。
- **Updater / Lifecycle**：修复后台静默检查更新遇到非 200 响应（如 GitHub API 403 限流）时未复位状态、导致更新弹窗长期停留在 `.checking` 状态的问题；修复静默预下载进行中点击“立即更新 / 安装更新”被忽略的问题，支持预下载完成后自动衔接安装。
- **Updater / Storage**：将 `UpdateInstaller.acknowledge` 移入后台队列并与 `isConfirmed` 确认等待衔接，消除主线程全量哈希计算开销；扩展 `cleanupObsoleteUpdateArtifacts` 扫描 `updates/transactions/` 目录，清理中断的 `install-*` 目录及已确认事务中残留的暂存 `GravityBox.app` 与 `installer` 副本，保留 `install-receipt.json` 恢复凭证。
- **Accounts / State Sync**：修复 `watchState()` 提前更新 `statusValue.accountsRevision` 与 `liveAccountEmail` 导致后续 `refresh()` 漏判账号变更的问题；修复运行未保存账号时清空已配置 `activeId` 导致主窗口与菜单栏状态分裂的问题；统一 `dashboard_summary`、`status` 与 `account_list` 对本机实时配额与已保存套餐/分组的合并逻辑。
- **Accounts / Quota**：仅在存在未验证配额数据时归档 `quota-rejected` 快照并限制保留最近 20 份记录，避免定时的重复 403 错误导致目录无限堆积；在 `account_switch_preflight` 中同步检查 `Antigravity - Insiders.app` 运行态，与切号守卫保持一致。
- **i18n / Controller**：修复后台界面包探测（`inspectBundleInBackground`）在用户暂停汉化后完成时把状态误覆写回 `connected` / `adaptive` 的竞态；为窗口本地服务尚未就绪的场景增加有界延迟重同步，并消除初次注入失败时的重复错误追加；为原生 `setTranslationEnabled` 增加请求代数保护，防止快速连续拨动开关时旧回调覆写新状态。
- **i18n / Engine**：移除 `injectMicroPatch` 对 `[data-gravitybox-loc="1"], [data-gravitybox-ui]` 注入的硬编码 `font-family` 与 `-webkit-font-smoothing: antialiased` 覆盖规则，使所有汉化节点自然继承宿主的 `--font-family` 与 `--editor-font-family` 设置，并消除查看用量弹窗异步刷新前后因 GPU 合成图层切换导致的字体先粗后细跳变。
- **SQLite / IPC**：为 `SqliteReadSnapshot` 空闲 Worker 池增加 `exit` 与 `error` 守护监听，并在 `close()` 时清理在途挂起请求与定时器，防止复用已退出 Worker 导致 8 秒超时或未捕获异常；完善 `IdempotencyStore` 超时回收与容量淘汰策略，补齐 `main.ts` 早期信号锁释放与 `dashboard_summary` 的 `skippedLargeRecords` 字段透传。
- **UI / Layout**：修复菜单栏配额卡片将未标明周期的 Gemini 4 Argon 默认显示为“每周”的问题；统一主窗口账号页与菜单栏账号页中“已选记录”徽章为 `Design.inactivePill`；修复菜单栏配额空态按钮“前往账号页添加…”跳往总览页的问题；优化 880pt 最小窗口宽度下 `QuotaBarView` 间距与重置倒计时布局、弹窗头部副标题换行抗压缩及多级 Sheet 关闭顺序。

## [1.0.4] - 2026-11-08

### Added
- **i18n**：正式适配 Antigravity `2.29.0` 与 `2.29.1` 官方版本，登记新版本 `main.js` SHA-256 指纹，补齐 2.29.x 新增的语音音色专有名词（`Arlo`、`Cleo`、`Finn`、`Fola`、`Gero`、`Lora`、`Neno`、`Olin`、`Tari`）、`Google Chat` 及配额/环境限制提示词条，覆盖 2.23.0 ～ 2.29.1 官方受支持版本词典词条。
- **Updater**：更新缓存仅在新版身份校验、后台就绪及成功确认后清理；安装事务与旧版本恢复副本单独保留，避免自动清理影响失败回退。
- **Updater**：新增成功确认后的自动清理流程（`AppUpdateManager.cleanupObsoleteUpdateArtifacts`）。应用仅启动、版本变化或带有更新重启标记均不触发清理；新版确认成功后才清理 `updates/` 下版本不高于当前运行版本的历史缓存目录、中断的 `.dmg.part` 临时文件与 `install-*` 暂存目录；并在更新重启或升级完成运行验证后，自动卸载残留的 `/Volumes/GravityBox*` 磁盘映像卷；不扫描或访问用户的 `~/Downloads` 目录，杜绝系统权限弹窗与隐私越界。
- **Configuration**：配置模型新增 `lastCleanedVersion` 字段，支持跨版本手动拖拽升级成功验证后记录历史安装包清理状态。

### Fixed
- **Updater / Cleanup**：DMG 与校验文件统一延后至安装成功确认后清理；等待后台、安装失败或恢复受阻时保留安装包，移除失败路径中的提前删除。手动拖拽升级也在运行包签名验证与后台就绪后才清理。
- **Updater / Integrity**：SHA-256 校验文件缺失、无法读取、格式错误、文件名不匹配或哈希不符时停止升级；复用缓存和安装前重新核对哈希，当前 App 可继续使用。
- **Updater / Recovery**：在目标磁盘暂存并验证新 App，通过原子交换保留旧版本；新版本后台就绪后才确认安装，启动失败则恢复旧版，并保留中断恢复记录。
- **Accounts / Recovery**：撤销切号新增持久恢复事务，数据库、账号文件与钥匙串按实际提交结果对账；中途失败补偿，补偿受阻时保留材料并支持重试，避免混合账号状态。
- **i18n / UI**：连接异常（`mode == "error"`）时汉化开关显示为“关”并提示“连接异常，点击重试”，一键开启即发送 `resume` 触发重连，无需先关再开；开关命令在途期间，陈旧状态快照不再把开关短暂弹回旧状态（`pendingTranslationTarget`）。
- **Backend**：将 `processArguments` 迁入 `BackendBridge`，使 `Backend.swift` 可脱离 `Assistant.swift` 独立编译，修复 `native-repair` 测试编译失败。
- **Backend / Gatekeeper**：修复部分用户通过 Finder 右键首次打开应用时，macOS 仅解除主二进制隔离而保留 `Contents/Resources/runtime/node` 的 `com.apple.quarantine` 属性，导致内嵌 Node 后端被静默拦截、`translationSwitch` 长期灰置不可点击的问题；启动子进程前自动清理内嵌运行时与资源目录的 Quarantine 扩展属性。
- **Backend / Process Lifecycle**：启动后端前自动检测并清理遗留的旧 `backend.lock` 孤儿进程与失效 `control.sock`，重置重连计数并在用户手动拨动汉化开关时按需拉起后端；修复 `watchState` 因 `ownedPID` 时序差丢弃状态快照的问题。
- **i18n / UI**：重构原生偏好设置（`PreferencesController`）、菜单栏（`Assistant`）与后端 `Controller` 的汉化开关状态同步机制（新增 `translationEnabled` 字段与乐观状态更新），并将 `DevToolsActivePort` 陈旧端口探测降级为等待态（`waiting`）而非错误态（`error`），解决开关在 `starting` / `error` 状态下反发 `pause` 或点击后立刻弹回关闭的问题。
- **Updater**：修复预下载缓存 `.dmg` 被系统或外部清理后，更新弹窗仍残留 `readyToInstall` 状态的问题，新增 `hasDownloadedUpdateReady` 与 `validateCachedDMGState()` 实时核对磁盘文件存在性。
- **UI / Design**：统一主窗口总览页（`DashboardPage`）与状态栏快捷面板（`MenuStatusCard` / `MenuPanelController`）中 `FREE` 套餐徽标及“已选记录”中性状态胶囊为 `Design.inactivePill`，消除残留系统默认浅灰背景导致的视觉割裂。
- **UI / Design**：修复点击“检查更新”或“管理缓存”时，处于禁用/扫描态的主操作按钮（`DesignButton`，如“检查中…”与“清理选中缓存…”）因 `path.fill()` 未预设填充色而在半透明蓝色渐变底层铺满纯黑（`#000000`），导致按钮瞬间变为深藏蓝色的问题。
- **Updater / UI**：精简并重构检查更新弹窗（`UpdateSheetController`）卡片布局：移除头部“构建 1000x…”胶囊与“正在连接 GitHub Releases…”副标题，将 `GravityBox` 标题及版本号胶囊下移并与右侧 `GitHub ↗` 按钮保持水平居中对齐；移除“版本说明”右侧状态胶囊与“关闭”按钮左侧独立转圈指示器，改为在“检查中…”、“下载中…”、“正在安装…”主胶囊按钮内部内嵌白色旋转指示器。
- **Updater / Sidebar**：开启“自动更新”后后台仅检测并预下载新版本而不自动覆盖安装；检测到可用更新时，在主界面侧边栏底部“打开 Antigravity”胶囊上方动态展示视觉风格统一的“安装更新”提示胶囊，点击即可一键触发更新安装。
- **UI / Accessibility**：统一总览页（`DashboardPage`）与请求明细页（`UsageLogController`）在浅色/深色模式下的异常与预警文字颜色为高对比度语义色（`accessibleWarningColor()` / `accessibleDangerColor()`），提升浅色白底卡片上的可读性。

## [1.0.3] - 2026-11-08

### Added
- **Accounts**：原生账号中心（AccountsPage）新增配额折叠卡片特性，支持顶部全局“收起配额/展开配额”按钮与单卡独立展开/折叠控制。
- **Accounts**：卡片折叠后自动收缩高度（降低超 100pt），并以自适应胶囊徽标展示紧凑摘要（如 `Gemini 91%`、`Claude/GPT 0%`），提升多账号列表浏览效率。
- **Configuration**：原生配置数据模型新增 `accountsCollapsed` 偏好项并支持本地持久化存储，启动与切页自动保持用户视图选择。
- **UI / Design**：优化中性灰胶囊徽标（Inactive Pill Badge）与数据看板（DashboardPage）空态徽标在 macOS 亮色与暗色模式下的视觉表现。
- **Test**：新增原生 Swift Headless 界面自动化测试，完整覆盖账号卡片收起/展开、状态切换及配置持久化断言。

### Fixed
- **i18n**：全面修复 Antigravity 2.29 版本汉化失效缺陷。
- **i18n**：放宽 CDP 与运行时路由白名单正则，适配 2.29 新增的 `/chatski-connect`、`/c`、`/c/_new` 等路径，防止新会话窗口被误拦截过滤。
- **i18n**：重构 DOM Ready 页面就绪契约检测，支持大小写不敏感侧边栏选择器（`[aria-label*="Sidebar" i]`）、新版输入框（`[data-testid="agent-input-box"]`）与新版设置对话框。
- **i18n**：在页面注入链路中引入 10 次状态轮询确认与重试机制，彻底消除“新版页面结构尚未识别”报错与注入超时。
- **CI**：对齐多版本词典门禁范围，增强云端虚拟机慢速环境下的异步切号事件循环等待，根除偶发时钟抖动。

## [1.0.2] - 2026-11-07

### Fixed
- **Updater**：修复应用内点击“立即更新”时因模态 Sheet 挂载及后台串行队列阻塞导致的死锁卡顿，增加超时强杀与内核硬退出双重保底。
- **Updater**：更新脚本脱离父进程组独立运行，并增加 5 秒等待上限与 kill -9 强杀兜底，防止进程被系统连带终止。
- **Updater**：修复开机跟随启动守护进程（`--lifecycle-agent`）被误判为主程序导致更新后不自动重启的问题。
- **Lifecycle**：移除后台常驻守护进程向 AppKit 窗口系统注册交互策略的代码，修复主程序退出后因常驻实例被 LaunchServices 锁死导致 Finder 提示“已不能再打开”（错误码 -600）。
- **Updater**：格式化更新日志展示，自动剥离 Markdown 反引号代码块与标题标记；修复更新弹窗关闭按钮锁死及损坏 DMG 重复使用的问题。
- **Core**：退出前立即落盘待保存的防抖配置；修复账号列表并发拉取时偶现漏刷新视图；消除请求明细 Sheet 窗口释放相关的内存安全隐患。

## [1.0.1] - 2026-11-07

### Added
- **i18n**：补全用量统计、模型配额与多语言切换界面的汉化词条，官方支持的 2.23.0 ~ 2.28.0 各版本覆盖率均达到 100%。

### Changed
- **Channel**：仅支持 Antigravity 正式版，移除对 Insiders 通道的联动与状态跟随（PR #12）。
- **Channel**：新版启动时自动备份并迁移旧 Insiders 通道配置到正式版，保留其它设置、账号与历史数据；Insiders 历史配额不再用于正式版展示。
- **Quota**：正式版使用独立配额服务缓存与切号恢复记录；保留旧共享文件，但不自动应用来源不明的历史恢复点。
- **Target**：显式 Insiders 通道及路径请求返回不支持；切号仍保留对共享凭据应用运行状态的保护检查。

### Fixed
- **Usage**：等待用量持久化缓存写入完成；测试目录默认不触发远程价格同步。
- **Version**：价格同步请求的 User-Agent 随实际构建版本更新；打包的后端元数据保留版本号，测试缓存与日常数据隔离。
- **CI / Browser**：固定测试浏览器版本及 SHA-256，等待页面导航完成，补齐测试重启隔离与临时目录清理。
- **CI / Test**：放宽 CI 环境下 Swift 原生编译测试超时阈值并完善错误诊断输出（`e8dbd1c`）
- **CI / Test**：修复 UTC 时区环境下的单元测试差异与测试夹具清理逻辑（`b9733f2`）
- **Browser / i18n**：优化浏览器回归测试耗时预算并补充时长模板回退处理（`e4be614`）

### Maintenance
- **Tools**：优化 UI 字符串自动提取逻辑，完善覆盖率报告生成工具。
- **Test**：新增多界面本地化补充测试套件与安全防注入检查。
- **Release**：标签只构建草稿 Release，验收后手动公开原包；拒绝版本不一致、哈希不符和覆盖已有附件。
- **CI**：CI 保留验证报告，限制 TypeScript 与 Node 类型声明的自动主版本升级。

### Documentation
- 重写并完善 `README.md`、`THIRD_PARTY_NOTICES.md`，补充完整功能说明、架构图、隐私说明与使用条款提示
- 新增 `CODE_OF_CONDUCT.md`、`CHANGELOG.md` 与 GitHub PR / Issue 引导模板

---

## [1.0.0] - 2026-11-05

### Added
- **双界面原生应用**：提供基于 Swift / AppKit 构建的 macOS 主窗口工作台（总览、账号、用量、设置）与菜单栏常驻快捷面板（用量、配额、账号三标签页），原生适配浅色与深色模式。
- **非侵入式界面汉化**：通过本地回环 CDP 在 Isolated World 中实时替换 Antigravity 界面文案，不修改 `app.asar`、不破坏签名；支持即时开关还原，内置代码/终端/草稿内容保护与分层外置词典（覆盖 `2.23.0`～`2.28.0`）。
- **多维度配额监控**：支持 PRO / ULTRA 与 FREE 账号的 Gemini（5 小时 + 每周）、Claude / GPT（5 小时 + 每周）及 Gemini 4 Argon（每周）额度进度与重置倒计时展示，支持本机实时读取与云端定时同步。
- **多账号管理与智能切换**：支持一键保存本机当前登录账号或通过 Google OAuth 添加备用账号；凭据安全隔离于 macOS Keychain；提供带活跃任务检测、自动启停与 7 天恢复点回滚的原子切号流程，以及低额度智能切换推荐。
- **Token 用量统计与 API 费用估算**：只读快照解析本地 SQLite 会话数据库，支持按时间范围（今日 / 7 天 / 30 天 / 全部）统计四类 Token 与缓存命中率，内置支持时间区间的模型价格表与逐条请求明细检索导出。
- **安全缓存维护与系统联动**：按“运行加速缓存”“会话状态与应用授权”“已保护核心数据”三类扫描存储空间，清理统一移入系统废纸篓并支持一键原位恢复；支持开机自启、跟随 Antigravity 启停、正式版与 Insiders 双通道切换及在线更新校验。

### Fixed
- **Native UI**：保持菜单栏状态图标在不同翻译开关状态下的不透明度一致（`b9921e8`，已包含于 1.0.0）。

[Unreleased]: https://github.com/Enzoo404/gravitybox/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/Enzoo404/gravitybox/compare/v1.1.3...v1.2.0
[1.1.3]: https://github.com/Enzoo404/gravitybox/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/Enzoo404/gravitybox/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/Enzoo404/gravitybox/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/Enzoo404/gravitybox/compare/v1.0.5...v1.1.0
[1.0.5]: https://github.com/Enzoo404/gravitybox/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/Enzoo404/gravitybox/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/Enzoo404/gravitybox/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/Enzoo404/gravitybox/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/Enzoo404/gravitybox/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Enzoo404/gravitybox/releases/tag/v1.0.0
