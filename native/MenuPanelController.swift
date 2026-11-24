import Cocoa

final class MenuPanelController: NSViewController {
    static let panelWidth: CGFloat = 424
    static let defaultPanelHeight: CGFloat = 535
    static let periods = ["today", "7d", "30d", "all"]
    static var periodLabels: [String] {
        [
            L10n.t("menu_panel.period.today", fallback: "今日"),
            L10n.t("menu_panel.period.7d", fallback: "近 7 天"),
            L10n.t("menu_panel.period.30d", fallback: "近 30 天"),
            L10n.t("menu_panel.period.all", fallback: "全部")
        ]
    }

    unowned let app: Assistant

    // Top Chrome
    let brandLabel = text("GravityBox", size: 15, weight: .semibold, color: .labelColor)
    let headerContextDivider = MenuHeaderVerticalDividerView()
    let contextPill = EnvironmentContextPill(style: .menuHeaderPill, compact: true, minWidth: 68, maxWidth: 154, height: 24)
    let headerRefreshButton: InlineRefreshButton
    let moreButton: DesignButton
    let tabSelector: MenuSegmentedTabsView
    private var contextPillTransitionEpoch: Int = 0
    private var isTransitioningTab: Bool = false

    // Scrollable Content Host
    let contentScroll = MenuSilentScrollView()
    let documentContainer = TopAlignedDocument()
    let usageRoot = NSStackView()
    let quotaRoot = NSStackView()
    let accountsRoot = NSStackView()

    // Tab 0: Usage Controls
    let periodSelector: MenuSegmentedTabsView
    private var lastKnownUsageEnvironments: [[String: Any]] = []
    private var lastKnownUsageBreakdown: [String: Any]? = nil
    let usageScopeLabel = text(L10n.t("menu_panel.usage_scope_default", fallback: "全部环境用量汇总"), size: 11, color: Design.secondary, wrap: true)
    let tokensTile: MenuMetricTileView
    let requestsTile: MenuMetricTileView
    let costTile: MenuMetricTileView
    let cacheTile: MenuMetricTileView
    let trendTitleLabel = text(L10n.t("menu_panel.trend.today", fallback: "今日趋势"), size: 12.5, weight: .semibold, color: .labelColor)
    let trendCoverageLabel = text("", size: 10.5, color: Design.secondary)
    let chartDimensionToggle: MenuSegmentedTabsView
    let trendChart = MenuTrendChartView()
    let modelsHeaderCountLabel = text("", size: 11, color: Design.secondary)
    let modelsListStack = NSStackView()
    private var modelRowViewsByName: [String: MenuModelUsageItemView] = [:]
    private var modelDividerViewsByName: [String: NSView] = [:]
    private var renderedModelNames: [String] = []
    let toggleModelsButton = button(L10n.t("menu_panel.expand_other_models", fallback: "展开其余模型"), target: nil, action: #selector(toggleAllModelsPressed))
    let usageFooterLabel = text("", size: 11, color: Design.secondary, wrap: true)

    // Tab 1: Quota Controls
    private var showHistoricalQuotaFallbackNotice = false
    let quotaAccountNameLabel = text(L10n.t("menu_panel.quota.loading", fallback: "正在读取账号…"), size: 15, weight: .semibold, color: .labelColor)
    let quotaTierBadge = tierBadge("", scale: .regular)
    let quotaStatusBadge = pillBadge("", color: Design.blue)
    let quotaEmailLabel = text("", size: 11, color: .secondaryLabelColor, wrap: true)
    /// @testonly 保留供 native-ui 单测读取首个配额进度条快照，生产界面统一通过 quotaGroupsContainer 渲染。
    private(set) var quotaGemini5h = MenuMeterRow(title: L10n.t("common.period.5h", fallback: "5 小时"))
    private(set) var quotaGeminiWeekly = MenuMeterRow(title: L10n.t("common.period.weekly", fallback: "每周"))
    private(set) var quotaClaude5h = MenuMeterRow(title: L10n.t("common.period.5h", fallback: "5 小时"))
    private(set) var quotaClaudeWeekly = MenuMeterRow(title: L10n.t("common.period.weekly", fallback: "每周"))
    let quotaUnifiedContentStack = NSStackView()
    let quotaWarningLabel = text("", size: 11, color: accessibleWarningColor(), wrap: true)
    let quotaFooterLabel = text("", size: 11, color: .secondaryLabelColor, wrap: true)
    let quotaGroupsContainer = NSStackView()
    let quotaEmptyButton = button(L10n.t("menu_panel.quota.go_add_account", fallback: "前往账号页添加…"), target: nil, action: #selector(openAccountsFromQuotaEmpty))

    // Tab 2: Accounts Controls
    let accountsCountLabel = text(L10n.t("menu_panel.accounts.count", ["count": 0], fallback: "0 个账号"), size: 11, color: Design.secondary)
    let accountsCardsStack = NSStackView()
    let accountsRemoteSectionStack = NSStackView()
    let accountsRemoteMoreHostsButton = MenuRemoteMoreHostsButton()
    let accountsLocalOnlyNoteLabel = text("", size: 10.5, color: Design.secondary, wrap: false)
    private var accountCardsById: [String: MenuExpandableAccountCardView] = [:]
    private var renderedAccountIds: [String] = []
    private var remoteJumpRowsByEnvId: [String: MenuRemoteHostJumpRow] = [:]
    private var renderedRemoteJumpVisibleIds: [String] = []
    private var renderedRemoteJumpHasMore: Bool = false
    private var renderedRemoteJumpFingerprint: String = ""
    private var remoteJumpHeaderLabel: NSTextField?
    private var remoteJumpCountLabel: NSTextField?
    private var remoteJumpHeaderRow: NSView?
    private var remoteJumpMoreRow: NSView?

    // Debug-Port-Missing Guidance Banner
    let debugPortTitleLabel = text(L10n.t("status.debug_port_missing", fallback: "未开启调试端口"), size: 12, weight: .semibold, color: .labelColor)
    let debugPortBodyLabel = text(L10n.t("debug_port_missing.banner_body", fallback: "未带调试端口运行，请安全重启以连接；建议通过 GravityBox 启动 Antigravity。"), size: 11, color: Design.secondary, wrap: true)
    let safeRelaunchBtn = button(L10n.t("assistant.safe_relaunch_btn", fallback: "安全重启以连接"), target: nil, action: #selector(safeRelaunchAntigravityFromBanner))
    let debugPortBannerBox: NSBox

    // Bottom Bar
    let openAntigravityBtn = button(L10n.t("sidebar.open_antigravity", fallback: "打开 Antigravity"), target: nil, action: #selector(openAntigravityFromFooter))
    let openMainBtn = button(L10n.t("menu_panel.footer.open_main", fallback: "打开主界面 ↗"), target: nil, action: #selector(openMainFromFooter))

    // State
    private(set) var measuredPanelSize = NSSize(width: MenuPanelController.panelWidth, height: MenuPanelController.defaultPanelHeight)
    private(set) var selectedTab: Int = 0
    private(set) var selectedPeriod: Int = 0
    private(set) var selectedEnvironmentId: String = "all"
    private(set) var selectedChartDimension: MenuTrendChartView.Dimension = .tokens
    private(set) var showAllModels: Bool = false
    private(set) var expandedAccountIds: Set<String> = []
    private var hasInitializedExpandedAccount = false
    private var renderedUsageSnapshotKey = ""
    private var renderedUsageModelKey = ""
    private var renderedQuotaTabKey = ""
    private var lastMeasuredContentFingerprint = ""
    private var quotaHeaderEmail: String = ""

    private static let timeFormatter: DateFormatter = InterfaceText.shortTimeFormatter
    private static let dateTimeFormatter: DateFormatter = InterfaceText.shortDateTimeFormatter

    static func usageCacheKey(period: String, environmentId: String) -> String {
        let trimmed = environmentId.trimmingCharacters(in: .whitespacesAndNewlines)
        let env = trimmed.isEmpty ? "all" : trimmed
        return env == "all" ? period : "\(period)|env=\(env)|acc=all"
    }

    var currentUsageCacheKey: String {
        Self.usageCacheKey(period: Self.periods[selectedPeriod], environmentId: selectedEnvironmentId)
    }

    init(app: Assistant) {
        self.app = app
        let initialTab = max(0, min(2, app.configuration?.value.menuSelectedTab ?? 0))
        let initialPeriod = max(0, min(3, app.configuration?.value.menuUsagePeriod ?? 0))
        let initialEnvRaw = (app.configuration?.value.menuUsageEnvironmentId ?? app.usageFilterScope.rawEnvironmentId).trimmingCharacters(in: .whitespacesAndNewlines)
        let initialDim: MenuTrendChartView.Dimension = (app.configuration?.value.menuTrendMetric == "requests") ? .requests : .tokens
        self.selectedTab = initialTab
        self.selectedPeriod = initialPeriod
        let resolvedEnv = initialEnvRaw.isEmpty ? "all" : initialEnvRaw
        self.selectedEnvironmentId = resolvedEnv
        self.selectedChartDimension = initialDim
        app.setUsageFilterScope(EnvironmentScope(rawEnvironmentId: resolvedEnv), persist: false, syncOverview: false, syncUsagePage: false, syncMenuPanel: false)

        self.headerRefreshButton = InlineRefreshButton(L10n.t("common.refresh", fallback: "刷新"), width: 78, target: nil, action: #selector(refreshPressed))
        self.moreButton = DesignButton(title: "", target: nil, action: #selector(morePressed))
        self.moreButton.image = NSImage(systemSymbolName: "ellipsis", accessibilityDescription: L10n.t("menu.more_actions", fallback: "更多操作"))
        self.moreButton.imagePosition = .imageOnly
        self.tabSelector = MenuSegmentedTabsView(
            items: [
                L10n.t("menu_panel.tab.usage", fallback: "用量"),
                L10n.t("menu_panel.tab.quota", fallback: "配额"),
                L10n.t("menu_panel.tab.accounts", fallback: "账号")
            ],
            style: .primaryTabs,
            selected: initialTab,
            accessibilityLabel: L10n.t("menu_panel.tabs_a11y", fallback: "菜单栏一级分页")
        )
        self.periodSelector = MenuSegmentedTabsView(items: Self.periodLabels, style: .secondaryRange, selected: initialPeriod, accessibilityLabel: L10n.t("menu_panel.period_a11y", fallback: "用量统计时间范围"))
        self.chartDimensionToggle = MenuSegmentedTabsView(
            items: [
                L10n.t("menu_panel.dim.tokens", fallback: "Token"),
                L10n.t("menu_panel.dim.requests", fallback: "请求")
            ],
            style: .compactToggle,
            selected: initialDim == .requests ? 1 : 0,
            accessibilityLabel: L10n.t("menu_panel.dim_a11y", fallback: "趋势图统计维度")
        )

        self.tokensTile = MenuMetricTileView(key: "tokens", title: L10n.t("menu_panel.tile.tokens", fallback: "Token 用量"))
        self.requestsTile = MenuMetricTileView(key: "requests", title: L10n.t("menu_panel.tile.requests", fallback: "请求数"))
        self.costTile = MenuMetricTileView(key: "cost", title: L10n.t("menu_panel.tile.cost", fallback: "API 费用估算"))
        self.cacheTile = MenuMetricTileView(key: "cache", title: L10n.t("menu_panel.tile.cache", fallback: "缓存命中率"))

        let warnTint = accessibleWarningColor()
        let warnIconBox = tintedIconBox(
            size: 26,
            cornerRadius: 7,
            tint: warnTint,
            darkFillAlpha: 0.18,
            lightFillAlpha: 0.11,
            darkBorderAlpha: 0.30,
            lightBorderAlpha: 0.16
        )
        let warnIcon = symbol("exclamationmark.triangle.fill", size: 12.5, color: warnTint)
        warnIcon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 12, weight: .semibold)
        warnIconBox.addSubview(warnIcon)
        NSLayoutConstraint.activate([
            warnIcon.centerXAnchor.constraint(equalTo: warnIconBox.centerXAnchor),
            warnIcon.centerYAnchor.constraint(equalTo: warnIconBox.centerYAnchor)
        ])
        debugPortTitleLabel.lineBreakMode = .byTruncatingTail
        debugPortBodyLabel.maximumNumberOfLines = 2
        debugPortBodyLabel.lineBreakMode = .byTruncatingTail
        debugPortBodyLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let debugTextCol = vertical([debugPortTitleLabel, debugPortBodyLabel], spacing: 1.5)
        debugTextCol.alignment = .leading
        debugTextCol.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let debugRow = horizontal([warnIconBox, debugTextCol, flexibleSpace(), safeRelaunchBtn], spacing: 9)
        debugRow.alignment = .centerY
        let bannerBox = group([debugRow], inset: 10)
        bannerBox.cornerRadius = Design.Radius.popover
        bannerBox.borderWidth = 1
        bannerBox.borderColor = Design.dynamicAlpha(warnTint, 0.26, 0.34)
        bannerBox.fillColor = Design.dynamicAlpha(warnTint, 0.065, 0.12)
        bannerBox.isHidden = true
        self.debugPortBannerBox = bannerBox

        super.init(nibName: nil, bundle: nil)

        headerRefreshButton.target = self
        headerRefreshButton.refusesFirstResponder = false
        headerRefreshButton.toolTip = nil
        headerRefreshButton.setAccessibilityLabel(L10n.t("common.refresh", fallback: "刷新"))
        headerRefreshButton.setContentHuggingPriority(.required, for: .horizontal)
        headerRefreshButton.setContentCompressionResistancePriority(.required, for: .horizontal)
        headerRefreshButton.setContentHuggingPriority(.required, for: .vertical)
        headerRefreshButton.setContentCompressionResistancePriority(.required, for: .vertical)
        headerRefreshButton.wantsLayer = true
        moreButton.target = self
        moreButton.refusesFirstResponder = false
        moreButton.setAccessibilityLabel(L10n.t("menu.more_actions", fallback: "更多操作"))
        moreButton.toolTip = nil
        moreButton.wantsLayer = true
        moreButton.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            moreButton.widthAnchor.constraint(equalToConstant: 28),
            moreButton.heightAnchor.constraint(equalToConstant: 28)
        ])

        toggleModelsButton.target = self
        toggleModelsButton.controlSize = .small
        quotaEmptyButton.target = self
        quotaEmptyButton.controlSize = .small
        safeRelaunchBtn.target = self
        safeRelaunchBtn.controlSize = .small
        safeRelaunchBtn.font = .systemFont(ofSize: 11, weight: .medium)
        safeRelaunchBtn.image = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: nil)
        safeRelaunchBtn.imagePosition = .imageLeading
        safeRelaunchBtn.setContentHuggingPriority(.required, for: .horizontal)
        safeRelaunchBtn.setContentCompressionResistancePriority(.required, for: .horizontal)
        safeRelaunchBtn.toolTip = nil
        safeRelaunchBtn.setAccessibilityLabel(L10n.t("assistant.safe_relaunch_btn", fallback: "安全重启以连接"))
        openAntigravityBtn.title = L10n.t("sidebar.open_antigravity", fallback: "打开 Antigravity")
        openAntigravityBtn.target = self
        openAntigravityBtn.controlSize = .small
        openMainBtn.target = self
        openMainBtn.controlSize = .small

        tabSelector.onSelect = { [weak self] idx in self?.selectTab(idx, persist: true) }
        periodSelector.onSelect = { [weak self] idx in self?.selectPeriod(idx, persist: true) }
        chartDimensionToggle.onSelect = { [weak self] idx in
            self?.selectChartDimension(idx == 1 ? .requests : .tokens, persist: true)
        }
        trendChart.onHoverBucket = { [weak self] bucket in
            guard let self else { return }
            if let b = bucket {
                if b.isFuture {
                    self.trendCoverageLabel.stringValue = L10n.t("menu_panel.hover.future", ["label": b.tooltipLabel], fallback: "\(b.tooltipLabel) · 尚未到达")
                } else if self.selectedChartDimension == .tokens {
                    self.trendCoverageLabel.stringValue = L10n.t("menu_panel.hover.tokens", ["label": b.tooltipLabel, "tokens": InterfaceText.formatCompactTokens(b.value, formatSmallWithLocale: true)], fallback: "\(b.tooltipLabel) · \(InterfaceText.formatCompactTokens(b.value, formatSmallWithLocale: true)) Token")
                } else {
                    self.trendCoverageLabel.stringValue = L10n.t("menu_panel.hover.requests", ["label": b.tooltipLabel, "count": InterfaceText.formatInteger(b.value)], fallback: "\(b.tooltipLabel) · \(InterfaceText.formatInteger(b.value)) 次请求")
                }
                self.trendCoverageLabel.alphaValue = 1.0
            } else {
                self.trendCoverageLabel.stringValue = ""
                self.trendCoverageLabel.alphaValue = 0.0
            }
        }
    }
    required init?(coder: NSCoder) { fatalError() }

    private func resolvedActiveScreen() -> NSScreen? {
        if app.isMenuPanelShown, let panelScreen = app.menuPanel?.screen {
            return panelScreen
        }
        return app.item?.button?.window?.screen ?? viewIfLoaded?.window?.screen ?? NSScreen.main
    }

    private func resolvedTargetHeight() -> CGFloat {
        let activeScreen = resolvedActiveScreen()
        let screenMax = (activeScreen?.visibleFrame.height ?? 780) - 48
        return min(Self.defaultPanelHeight, max(480, screenMax))
    }

    override func loadView() {
        let fixedHeight = resolvedTargetHeight()
        let rootSurface = MenuPanelRootView()
        rootSurface.frame = NSRect(x: 0, y: 0, width: Self.panelWidth, height: fixedHeight)
        let initialSize = NSSize(width: Self.panelWidth, height: fixedHeight)
        self.measuredPanelSize = initialSize
        self.preferredContentSize = initialSize

        // 1. Header Bar
        let brandIcon: NSImageView = {
            if let markImg = Design.brandMarkImage() {
                let iv = NSImageView(image: markImg)
                iv.imageScaling = .scaleProportionallyUpOrDown
                iv.translatesAutoresizingMaskIntoConstraints = false
                NSLayoutConstraint.activate([
                    iv.widthAnchor.constraint(equalToConstant: 17),
                    iv.heightAnchor.constraint(equalToConstant: 17)
                ])
                iv.setAccessibilityElement(false)
                return iv
            }
            let fallback = symbol("app.fill", size: 13.5, color: Design.blue)
            fallback.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 13, weight: .semibold)
            return fallback
        }()
        brandLabel.setContentHuggingPriority(.required, for: .horizontal)
        brandLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
        headerContextDivider.isHidden = true
        contextPill.setAccessibilityLabel(L10n.t("ssh.scope.a11y", fallback: "切换环境"))
        contextPill.onSelectScope = { [weak self] scope in
            guard let self else { return }
            switch self.selectedTab {
            case 0:
                self.selectUsageEnvironment(scope.rawEnvironmentId, persist: true)
            case 1:
                self.showHistoricalQuotaFallbackNotice = false
                self.app.setActiveNodeScope(scope, userInitiated: true, notifyUI: true)
            default:
                break
            }
        }

        let topBar = NSView()
        topBar.translatesAutoresizingMaskIntoConstraints = false
        for sub in [brandIcon, brandLabel, headerContextDivider, contextPill, headerRefreshButton, moreButton] {
            sub.translatesAutoresizingMaskIntoConstraints = false
            topBar.addSubview(sub)
        }
        NSLayoutConstraint.activate([
            topBar.heightAnchor.constraint(equalToConstant: 28),
            brandIcon.leadingAnchor.constraint(equalTo: topBar.leadingAnchor),
            brandIcon.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),
            brandLabel.leadingAnchor.constraint(equalTo: brandIcon.trailingAnchor, constant: 6),
            brandLabel.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),
            headerContextDivider.leadingAnchor.constraint(equalTo: brandLabel.trailingAnchor, constant: 8),
            headerContextDivider.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),
            headerContextDivider.widthAnchor.constraint(equalToConstant: 1),
            headerContextDivider.heightAnchor.constraint(equalToConstant: 14),
            contextPill.leadingAnchor.constraint(equalTo: headerContextDivider.trailingAnchor, constant: 8),
            contextPill.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),
            contextPill.trailingAnchor.constraint(lessThanOrEqualTo: headerRefreshButton.leadingAnchor, constant: -6),
            moreButton.trailingAnchor.constraint(equalTo: topBar.trailingAnchor),
            moreButton.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),
            headerRefreshButton.trailingAnchor.constraint(equalTo: moreButton.leadingAnchor, constant: -6),
            headerRefreshButton.centerYAnchor.constraint(equalTo: topBar.centerYAnchor)
        ])

        let headerStack = vertical([topBar, tabSelector], spacing: 8)
        fillWidth(topBar, in: headerStack)
        fillWidth(tabSelector, in: headerStack)
        let headerHost = NSView()
        let headerBottomLine = DesignDividerView()
        headerHost.translatesAutoresizingMaskIntoConstraints = false
        headerHost.setContentCompressionResistancePriority(.required, for: .vertical)
        headerHost.setContentHuggingPriority(.required, for: .vertical)
        headerHost.addSubview(headerStack)
        headerHost.addSubview(headerBottomLine)
        headerStack.translatesAutoresizingMaskIntoConstraints = false
        headerBottomLine.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            headerHost.heightAnchor.constraint(equalToConstant: 86),
            headerStack.leadingAnchor.constraint(equalTo: headerHost.leadingAnchor, constant: 14),
            headerStack.trailingAnchor.constraint(equalTo: headerHost.trailingAnchor, constant: -14),
            headerStack.topAnchor.constraint(equalTo: headerHost.topAnchor, constant: 10),
            headerStack.bottomAnchor.constraint(equalTo: headerHost.bottomAnchor, constant: -8),
            headerBottomLine.leadingAnchor.constraint(equalTo: headerHost.leadingAnchor, constant: 14),
            headerBottomLine.trailingAnchor.constraint(equalTo: headerHost.trailingAnchor, constant: -14),
            headerBottomLine.bottomAnchor.constraint(equalTo: headerHost.bottomAnchor),
            headerBottomLine.heightAnchor.constraint(equalToConstant: 1)
        ])

        // 2. Build Tab 0 (Usage)
        buildUsageTab()

        // 3. Build Tab 1 (Quota)
        buildQuotaTab()

        // 4. Build Tab 2 (Accounts)
        buildAccountsTab()

        // 5. Middle Scrollable Host
        contentScroll.wantsLayer = true
        contentScroll.contentView.wantsLayer = true
        contentScroll.drawsBackground = false
        contentScroll.hasVerticalScroller = true
        contentScroll.autohidesScrollers = true
        contentScroll.automaticallyAdjustsContentInsets = false
        contentScroll.translatesAutoresizingMaskIntoConstraints = false
        contentScroll.setContentHuggingPriority(.defaultLow, for: .vertical)
        contentScroll.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
        documentContainer.wantsLayer = true
        documentContainer.translatesAutoresizingMaskIntoConstraints = false
        contentScroll.documentView = documentContainer

        let contentStack = vertical([debugPortBannerBox, usageRoot, quotaRoot, accountsRoot], spacing: 8)
        contentStack.detachesHiddenViews = true
        documentContainer.addSubview(contentStack)
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        for pageView in [debugPortBannerBox, usageRoot, quotaRoot, accountsRoot] {
            fillWidth(pageView, in: contentStack)
        }
        NSLayoutConstraint.activate([
            documentContainer.widthAnchor.constraint(equalTo: contentScroll.contentView.widthAnchor),
            contentStack.leadingAnchor.constraint(equalTo: documentContainer.leadingAnchor, constant: 14),
            contentStack.trailingAnchor.constraint(equalTo: documentContainer.trailingAnchor, constant: -14),
            contentStack.topAnchor.constraint(equalTo: documentContainer.topAnchor, constant: 10),
            contentStack.bottomAnchor.constraint(equalTo: documentContainer.bottomAnchor, constant: -10)
        ])

        // 6. Footer Bar
        openAntigravityBtn.image = NSImage(systemSymbolName: "arrow.up.forward.app", accessibilityDescription: nil)
        openAntigravityBtn.imagePosition = .imageLeading
        let footerRow = horizontal([openAntigravityBtn, flexibleSpace(), openMainBtn], spacing: 10)
        footerRow.alignment = .centerY
        let footerHost = MenuPanelFooterHostView()
        footerHost.translatesAutoresizingMaskIntoConstraints = false
        footerHost.setContentCompressionResistancePriority(.required, for: .vertical)
        footerHost.setContentHuggingPriority(.required, for: .vertical)
        footerHost.addSubview(footerRow)
        footerRow.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            footerHost.heightAnchor.constraint(equalToConstant: 42),
            footerRow.leadingAnchor.constraint(equalTo: footerHost.leadingAnchor, constant: 14),
            footerRow.trailingAnchor.constraint(equalTo: footerHost.trailingAnchor, constant: -14),
            footerRow.centerYAnchor.constraint(equalTo: footerHost.centerYAnchor)
        ])

        for sub in [headerHost, contentScroll, footerHost] {
            rootSurface.addSubview(sub)
        }
        NSLayoutConstraint.activate([
            headerHost.topAnchor.constraint(equalTo: rootSurface.topAnchor),
            headerHost.leadingAnchor.constraint(equalTo: rootSurface.leadingAnchor),
            headerHost.trailingAnchor.constraint(equalTo: rootSurface.trailingAnchor),

            contentScroll.topAnchor.constraint(equalTo: headerHost.bottomAnchor),
            contentScroll.leadingAnchor.constraint(equalTo: rootSurface.leadingAnchor),
            contentScroll.trailingAnchor.constraint(equalTo: rootSurface.trailingAnchor),
            contentScroll.bottomAnchor.constraint(equalTo: footerHost.topAnchor),

            footerHost.leadingAnchor.constraint(equalTo: rootSurface.leadingAnchor),
            footerHost.trailingAnchor.constraint(equalTo: rootSurface.trailingAnchor),
            footerHost.bottomAnchor.constraint(equalTo: rootSurface.bottomAnchor)
        ])
        rootSurface.installRimOverlay()
        self.view = rootSurface
        syncDebugPortBanner()
        syncTopContextPill(animate: false)
        applyActiveTabVisibility()
    }

    override func viewDidLayout() {
        super.viewDidLayout()
        Self.clearTooltips(in: contextPill)
    }

    private static func clearTooltips(in root: NSView) {
        if root.toolTip != nil { root.toolTip = nil }
        for sub in root.subviews {
            clearTooltips(in: sub)
        }
    }

    private func buildUsageTab() {
        usageRoot.orientation = .vertical
        usageRoot.alignment = .leading
        usageRoot.spacing = 6
        usageRoot.detachesHiddenViews = true

        let row1 = horizontal([tokensTile, requestsTile], spacing: 7)
        row1.distribution = .fillEqually
        let row2 = horizontal([costTile, cacheTile], spacing: 7)
        row2.distribution = .fillEqually

        let trendTitleCol = vertical([trendTitleLabel, trendCoverageLabel], spacing: 2)
        trendTitleCol.alignment = .leading
        trendCoverageLabel.alphaValue = 0.0
        trendCoverageLabel.lineBreakMode = .byTruncatingTail
        trendCoverageLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let trendHeader = horizontal([trendTitleCol, flexibleSpace(), chartDimensionToggle], spacing: 8)
        trendHeader.alignment = .centerY
        trendHeader.translatesAutoresizingMaskIntoConstraints = false
        trendHeader.heightAnchor.constraint(equalToConstant: 32).isActive = true
        let trendContent = vertical([trendHeader, trendChart], spacing: 4)
        trendContent.detachesHiddenViews = true
        fillWidth(trendHeader, in: trendContent)
        fillWidth(trendChart, in: trendContent)
        let trendCard = group([trendContent], inset: 9)
        trendCard.cornerRadius = Design.Radius.popover
        trendCard.fillColor = Design.popoverCardBackground
        trendCard.borderColor = Design.popoverCardBorder

        modelsHeaderCountLabel.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        let modelsHeader = horizontal([text(L10n.t("menu_panel.models_header", fallback: "模型用量"), size: 12.5, weight: .semibold, color: .labelColor), flexibleSpace(), modelsHeaderCountLabel], spacing: 8)
        modelsHeader.alignment = .centerY
        modelsListStack.orientation = .vertical
        modelsListStack.alignment = .leading
        modelsListStack.spacing = 4
        modelsListStack.detachesHiddenViews = true
        toggleModelsButton.isHidden = true

        let modelsContent = vertical([modelsHeader, divider(), modelsListStack, toggleModelsButton], spacing: 4)
        modelsContent.detachesHiddenViews = true
        fillWidth(modelsHeader, in: modelsContent)
        fillWidth(modelsListStack, in: modelsContent)
        let modelsCard = group([modelsContent], inset: 9)
        modelsCard.cornerRadius = Design.Radius.popover
        modelsCard.fillColor = Design.popoverCardBackground
        modelsCard.borderColor = Design.popoverCardBorder

        usageScopeLabel.font = .monospacedDigitSystemFont(ofSize: 10.5, weight: .regular)
        usageScopeLabel.lineBreakMode = .byTruncatingTail
        usageScopeLabel.maximumNumberOfLines = 2
        usageScopeLabel.isHidden = true

        usageFooterLabel.font = .monospacedDigitSystemFont(ofSize: 10.5, weight: .regular)
        usageFooterLabel.alignment = .right
        usageFooterLabel.textColor = Design.secondary

        for section in [periodSelector, usageScopeLabel, row1, row2, trendCard, modelsCard, usageFooterLabel] {
            usageRoot.addArrangedSubview(section)
            fillWidth(section, in: usageRoot)
        }
        usageRoot.setCustomSpacing(6, after: modelsCard)
    }

    private func buildQuotaTab() {
        quotaRoot.orientation = .vertical
        quotaRoot.alignment = .leading
        quotaRoot.spacing = 10
        quotaRoot.detachesHiddenViews = true

        quotaAccountNameLabel.lineBreakMode = .byTruncatingTail
        quotaAccountNameLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        quotaTierBadge.setContentCompressionResistancePriority(.required, for: .horizontal)
        quotaStatusBadge.setContentCompressionResistancePriority(.required, for: .horizontal)
        quotaEmailLabel.font = .systemFont(ofSize: 11.5, weight: .regular)
        quotaEmailLabel.lineBreakMode = .byTruncatingMiddle

        let copyMenu = NSMenu()
        let copyItem = NSMenuItem(title: L10n.t("common.copy_full_email", fallback: "复制完整邮箱"), action: #selector(copyQuotaHeaderEmail), keyEquivalent: "")
        copyItem.target = self
        copyMenu.addItem(copyItem)
        quotaEmailLabel.menu = copyMenu

        let nameRow = horizontal([quotaAccountNameLabel, quotaTierBadge, quotaStatusBadge, flexibleSpace()], spacing: 6)
        nameRow.alignment = .centerY
        nameRow.detachesHiddenViews = true
        let identityStack = vertical([nameRow, quotaEmailLabel], spacing: 4)
        fillWidth(nameRow, in: identityStack)
        fillWidth(quotaEmailLabel, in: identityStack)
        let identityCard = group([identityStack], inset: 12)
        identityCard.cornerRadius = Design.Radius.medium
        identityCard.fillColor = Design.popoverCardBackground
        identityCard.borderColor = Design.popoverCardBorder

        quotaUnifiedContentStack.orientation = .vertical
        quotaUnifiedContentStack.alignment = .leading
        quotaUnifiedContentStack.spacing = 8
        quotaUnifiedContentStack.detachesHiddenViews = true

        let quotaUnifiedCard = group([quotaUnifiedContentStack], inset: 12)
        quotaUnifiedCard.cornerRadius = Design.Radius.medium
        quotaUnifiedCard.fillColor = Design.popoverCardBackground
        quotaUnifiedCard.borderColor = Design.popoverCardBorder

        quotaGroupsContainer.orientation = .vertical
        quotaGroupsContainer.alignment = .leading
        quotaGroupsContainer.spacing = 0
        quotaGroupsContainer.addArrangedSubview(quotaUnifiedCard)
        fillWidth(quotaUnifiedCard, in: quotaGroupsContainer)

        quotaWarningLabel.isHidden = true
        quotaEmptyButton.isHidden = true
        quotaFooterLabel.font = .monospacedDigitSystemFont(ofSize: 10.5, weight: .regular)
        quotaFooterLabel.alignment = .right
        quotaFooterLabel.textColor = Design.secondary

        for section in [identityCard, quotaGroupsContainer, quotaEmptyButton, quotaWarningLabel, quotaFooterLabel] {
            quotaRoot.addArrangedSubview(section)
            fillWidth(section, in: quotaRoot)
        }
    }

    private func buildAccountsTab() {
        accountsRoot.orientation = .vertical
        accountsRoot.alignment = .leading
        accountsRoot.spacing = 8
        accountsRoot.detachesHiddenViews = true

        accountsCountLabel.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        accountsCountLabel.setContentHuggingPriority(.required, for: .horizontal)
        accountsCountLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
        accountsLocalOnlyNoteLabel.font = .systemFont(ofSize: 10.5, weight: .regular)
        accountsLocalOnlyNoteLabel.maximumNumberOfLines = 1
        accountsLocalOnlyNoteLabel.lineBreakMode = .byTruncatingTail
        accountsLocalOnlyNoteLabel.setContentHuggingPriority(.required, for: .horizontal)
        accountsLocalOnlyNoteLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        accountsLocalOnlyNoteLabel.isHidden = true

        let sectionTitleLabel = text(L10n.t("menu_panel.accounts.section_title", fallback: "已保存账号"), size: 12.5, weight: .semibold, color: .labelColor)
        sectionTitleLabel.setContentHuggingPriority(.required, for: .horizontal)
        sectionTitleLabel.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)

        let countCluster = horizontal([accountsCountLabel, accountsLocalOnlyNoteLabel], spacing: 4)
        countCluster.alignment = .firstBaseline
        countCluster.detachesHiddenViews = true
        let topRow = horizontal([sectionTitleLabel, flexibleSpace(), countCluster], spacing: 8)
        topRow.alignment = .centerY

        accountsCardsStack.orientation = .vertical
        accountsCardsStack.alignment = .leading
        accountsCardsStack.spacing = 8
        accountsCardsStack.detachesHiddenViews = true

        accountsRemoteSectionStack.orientation = .vertical
        accountsRemoteSectionStack.alignment = .leading
        accountsRemoteSectionStack.spacing = 4
        accountsRemoteSectionStack.detachesHiddenViews = true
        accountsRemoteSectionStack.isHidden = true
        accountsRemoteMoreHostsButton.onSelect = { [weak self] envId in
            guard let self else { return }
            self.app.setActiveNodeScope(.remote(environmentId: envId), userInitiated: true, notifyUI: false)
            self.selectTab(1, persist: true)
        }

        for section in [topRow, accountsCardsStack, accountsRemoteSectionStack] {
            accountsRoot.addArrangedSubview(section)
            fillWidth(section, in: accountsRoot)
        }
    }

    private func performWithoutAnimation(updateSize: Bool = true, animateSize: Bool = false, _ block: () -> Void) {
        let savedOrigin = contentScroll.contentView.bounds.origin
        NSAnimationContext.beginGrouping()
        NSAnimationContext.current.duration = 0
        NSAnimationContext.current.allowsImplicitAnimation = false
        block()
        if updateSize {
            updatePreferredPanelSize(animate: animateSize)
        }
        let maxY = max(0, documentContainer.bounds.height - contentScroll.contentView.bounds.height)
        let clampedY = max(0, min(savedOrigin.y, maxY))
        if abs(contentScroll.contentView.bounds.origin.y - clampedY) > 0.5 {
            contentScroll.contentView.scroll(to: NSPoint(x: 0, y: clampedY))
            contentScroll.reflectScrolledClipView(contentScroll.contentView)
        }
        NSAnimationContext.endGrouping()
    }

    // MARK: - Lifecycle & Tab Switching

    func panelWillOpen() {
        let _ = self.view
        trendChart.resetHoverState()
        showHistoricalQuotaFallbackNotice = false
        let cfgTab = max(0, min(2, app.configuration?.value.menuSelectedTab ?? selectedTab))
        let cfgPeriod = max(0, min(3, app.configuration?.value.menuUsagePeriod ?? selectedPeriod))
        let cfgEnvRaw = (app.configuration?.value.menuUsageEnvironmentId ?? app.usageFilterScope.rawEnvironmentId).trimmingCharacters(in: .whitespacesAndNewlines)
        let cfgDim: MenuTrendChartView.Dimension = (app.configuration?.value.menuTrendMetric == "requests") ? .requests : .tokens
        selectedTab = cfgTab
        selectedPeriod = cfgPeriod
        let resolvedEnv = cfgEnvRaw.isEmpty ? "all" : cfgEnvRaw
        selectedEnvironmentId = resolvedEnv
        app.setUsageFilterScope(EnvironmentScope(rawEnvironmentId: resolvedEnv), persist: false, syncOverview: false, syncUsagePage: false, syncMenuPanel: false)
        selectedChartDimension = cfgDim
        tabSelector.setSelected(selectedTab)
        periodSelector.setSelected(selectedPeriod)
        chartDimensionToggle.setSelected(selectedChartDimension == .requests ? 1 : 0)
        trendChart.dimension = selectedChartDimension
        applyActiveTabVisibility(resetScroll: true)
        performWithoutAnimation(updateSize: true, animateSize: false) {
            syncFromAssistant(updateSize: false)
        }
        ensureDataForActiveTab(force: false)
    }

    func panelDidClose() {
        showHistoricalQuotaFallbackNotice = false
        trendChart.stopAnimation()
    }

    func selectTab(_ index: Int, persist: Bool = true) {
        let prevTab = selectedTab
        let clamped = max(0, min(2, index))
        selectedTab = clamped
        tabSelector.setSelected(clamped)
        trendChart.resetHoverState()
        if persist, app.configuration?.value.menuSelectedTab != clamped {
            app.configuration?.value.menuSelectedTab = clamped
            app.scheduleConfigurationSave()
        }
        if prevTab != clamped {
            isTransitioningTab = true
            let fellBackFromHistorical = app.syncMenuTabEnvironmentTransition(from: prevTab, to: clamped)
            showHistoricalQuotaFallbackNotice = (clamped == 1) && fellBackFromHistorical
            if clamped == 0 {
                let syncedEnv = app.usageFilterScope.rawEnvironmentId
                if syncedEnv != selectedEnvironmentId {
                    selectedEnvironmentId = syncedEnv
                    renderedUsageSnapshotKey = ""
                    renderedUsageModelKey = ""
                }
            }
            isTransitioningTab = false
        }
        let shouldAnimate = Design.shouldAnimate(in: view) && app.isMenuPanelShown
        if shouldAnimate {
            applyActiveTabVisibility(resetScroll: true)
            syncFromAssistant(updateSize: false, animateContextPill: true)
            updatePreferredPanelSize(animate: true)
            let activeRoot: NSView = selectedTab == 0 ? usageRoot : (selectedTab == 1 ? quotaRoot : accountsRoot)
            activeRoot.wantsLayer = true
            let slideOffset: CGFloat = clamped > prevTab ? 16.0 : (clamped < prevTab ? -16.0 : 0.0)
            activeRoot.alphaValue = 0.0
            activeRoot.layer?.transform = CATransform3DMakeTranslation(slideOffset, 0, 0)
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.20
                ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
                activeRoot.animator().alphaValue = 1.0
                activeRoot.layer?.transform = CATransform3DIdentity
            }
        } else {
            applyActiveTabVisibility(resetScroll: true)
            performWithoutAnimation(updateSize: true, animateSize: false) {
                syncFromAssistant(updateSize: false)
                let activeRoot: NSView = selectedTab == 0 ? usageRoot : (selectedTab == 1 ? quotaRoot : accountsRoot)
                activeRoot.alphaValue = 1.0
                activeRoot.layer?.transform = CATransform3DIdentity
            }
        }
        ensureDataForActiveTab(force: false)
    }

    func selectPeriod(_ index: Int, persist: Bool = true) {
        let clamped = max(0, min(3, index))
        selectedPeriod = clamped
        periodSelector.setSelected(clamped)
        if persist, app.configuration?.value.menuUsagePeriod != clamped {
            app.configuration?.value.menuUsagePeriod = clamped
            app.scheduleConfigurationSave()
        }
        renderedUsageSnapshotKey = ""
        renderedUsageModelKey = ""
        performWithoutAnimation(updateSize: true, animateSize: app.isMenuPanelShown) {
            syncUsageTabFromCache()
        }
        let periodKey = Self.periods[clamped]
        app.fetchUsageSummary(period: periodKey, environmentId: selectedEnvironmentId, force: false)
    }

    func selectUsageEnvironment(_ environmentId: String, persist: Bool = true) {
        applyUsageEnvironmentSelection(environmentId, persist: persist, fetchAndSync: true)
    }

    private func applyUsageEnvironmentSelection(_ environmentId: String, persist: Bool, fetchAndSync: Bool) {
        let trimmed = environmentId.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalized = trimmed.isEmpty ? "all" : trimmed
        let scope = EnvironmentScope(rawEnvironmentId: normalized)
        app.setUsageFilterScope(scope, persist: persist, syncOverview: false, syncUsagePage: false, syncMenuPanel: false)
        guard normalized != selectedEnvironmentId else { return }
        selectedEnvironmentId = normalized
        renderedUsageSnapshotKey = ""
        renderedUsageModelKey = ""
        guard fetchAndSync else { return }
        performWithoutAnimation(updateSize: true, animateSize: app.isMenuPanelShown) {
            syncUsageTabFromCache()
            syncHeaderRefreshState()
            syncTopContextPill(animate: false)
        }
        let periodKey = Self.periods[selectedPeriod]
        app.fetchUsageSummary(period: periodKey, environmentId: normalized, force: false)
    }

    func selectChartDimension(_ dimension: MenuTrendChartView.Dimension, persist: Bool = true) {
        selectedChartDimension = dimension
        chartDimensionToggle.setSelected(dimension == .requests ? 1 : 0)
        trendChart.dimension = dimension
        if persist, app.configuration?.value.menuTrendMetric != dimension.rawValue {
            app.configuration?.value.menuTrendMetric = dimension.rawValue
            app.scheduleConfigurationSave()
        }
        renderedUsageSnapshotKey = ""
        performWithoutAnimation(updateSize: true, animateSize: app.isMenuPanelShown) {
            syncUsageTabFromCache()
        }
    }

    @objc func toggleAllModelsPressed() {
        showAllModels.toggle()
        renderedUsageModelKey = ""
        if Design.shouldAnimate(in: view) && app.isMenuPanelShown {
            performWithoutAnimation(updateSize: false) {
                syncUsageTabFromCache()
            }
            updatePreferredPanelSize(animate: true)
        } else {
            performWithoutAnimation(updateSize: true, animateSize: false) {
                syncUsageTabFromCache()
            }
        }
    }

    private func applyActiveTabVisibility(resetScroll: Bool = false) {
        usageRoot.isHidden = (selectedTab != 0)
        quotaRoot.isHidden = (selectedTab != 1)
        accountsRoot.isHidden = (selectedTab != 2)
        if headerRefreshButton.iconOnly {
            if !headerRefreshButton.title.isEmpty {
                headerRefreshButton.title = ""
            }
            headerRefreshButton.setAccessibilityLabel(L10n.t("common.refresh", fallback: "刷新"))
        } else {
            headerRefreshButton.title = L10n.t("common.refresh", fallback: "刷新")
        }
        headerRefreshButton.toolTip = nil
        switch selectedTab {
        case 0:
            openMainBtn.title = L10n.t("menu_panel.footer.open_usage", fallback: "打开用量页 ↗")
        case 1:
            openMainBtn.title = L10n.t("menu_panel.footer.open_overview", fallback: "打开总览页 ↗")
        default:
            openMainBtn.title = L10n.t("menu_panel.footer.open_accounts", fallback: "打开账号页 ↗")
        }
        if resetScroll {
            contentScroll.contentView.scroll(to: .zero)
            contentScroll.reflectScrolledClipView(contentScroll.contentView)
        }
    }

    private func ensureDataForActiveTab(force: Bool) {
        guard app.reachable else { return }
        let revisionChanged = !app.statusValue.accountsRevision.isEmpty && app.statusValue.accountsRevision != app.lastFetchedAccountsRevision
        let accountListStale = app.lastAccountListFetchAt != .distantPast && Date().timeIntervalSince(app.lastAccountListFetchAt) >= 15.0
        let needsAccountSync = app.cachedAccounts.isEmpty || app.bootstrappedAccounts || revisionChanged || accountListStale
        switch selectedTab {
        case 0:
            let periodKey = Self.periods[selectedPeriod]
            app.fetchUsageSummary(period: periodKey, environmentId: selectedEnvironmentId, force: force)
        case 1:
            if let host = app.selectedMenuQuotaHost() {
                if force {
                    let key = host.primaryRemoteKey.isEmpty ? nil : host.primaryRemoteKey
                    app.refreshRemoteQuota(remoteKey: key, environmentId: host.environmentId)
                }
            } else if app.cachedAccounts.isEmpty || app.bootstrappedAccounts {
                app.fetchAccountList(notifyPage: true)
            } else if force {
                if let active = app.resolvedMenuAccount(), let id = active["id"] as? String, !id.isEmpty {
                    app.refreshSingleAccountQuota(id: id)
                } else {
                    app.refreshAccountQuotas()
                }
            } else {
                if needsAccountSync {
                    app.fetchAccountList(notifyPage: true)
                }
                if let active = app.resolvedMenuAccount(), QuotaPresentation.contract(active).hasOverdueKnownWindow() {
                    app.triggerResetOverdueRefreshIfNeeded(for: active)
                }
            }
        default:
            if app.cachedAccounts.isEmpty || app.bootstrappedAccounts {
                app.fetchAccountList(notifyPage: true)
            } else if force {
                app.refreshAccountQuotas()
            } else if needsAccountSync {
                app.fetchAccountList(notifyPage: true)
            }
            app.refreshRecommendedAccountIfNeeded(force: force)
        }
    }

    func refreshCurrentTab() {
        ensureDataForActiveTab(force: true)
    }

    @objc private func refreshPressed() {
        refreshCurrentTab()
    }

    @objc private func morePressed() {
        if let panel = view.window as? MenuFloatingPanel, !panel.isKeyWindow {
            panel.makeKey()
        }
        let menu = app.buildMoreMenu()
        Design.popUpMenu(menu, below: moreButton)
    }

    @objc private func openAntigravityFromFooter() {
        app.closeMenuPopover()
        app.openAntigravity()
    }

    @objc private func safeRelaunchAntigravityFromBanner() {
        app.closeMenuPopover()
        app.safeRelaunchAntigravityForDebug()
    }

    func syncDebugPortBanner() {
        let showBanner = app.statusValue.mode == "debug-port-missing"
        let inFlight = app.isSafeRelaunchInFlight
        debugPortTitleLabel.stringValue = L10n.t("status.debug_port_missing", fallback: "未开启调试端口")
        debugPortBodyLabel.stringValue = L10n.t("debug_port_missing.banner_body", fallback: "未带调试端口运行，请安全重启以连接；建议通过 GravityBox 启动 Antigravity。")
        let btnTitle = inFlight
            ? L10n.t("assistant.safe_relaunch_busy", fallback: "正在安全重启…")
            : L10n.t("assistant.safe_relaunch_btn", fallback: "安全重启以连接")
        safeRelaunchBtn.title = btnTitle
        safeRelaunchBtn.setAccessibilityLabel(btnTitle)
        safeRelaunchBtn.isEnabled = !inFlight
        safeRelaunchBtn.toolTip = nil
        debugPortBannerBox.isHidden = !showBanner
        safeRelaunchBtn.isHidden = !showBanner
    }

    @objc private func openMainFromFooter() {
        let scope: EnvironmentScope = selectedTab == 1
            ? app.activeNodeScope
            : EnvironmentScope(rawEnvironmentId: selectedEnvironmentId)
        app.openMainWindowFromMenuPanel(
            tab: selectedTab,
            scope: scope,
            usagePeriod: selectedPeriod
        )
    }

    private func setTopContextControlsVisible(_ visible: Bool, animated: Bool) {
        contextPillTransitionEpoch += 1
        let epoch = contextPillTransitionEpoch
        let shouldAnimate = animated && Design.shouldAnimate(in: view) && app.isMenuPanelShown
        if visible {
            headerContextDivider.isHidden = false
            contextPill.isHidden = false
            contextPill.isEnabled = true
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0
                ctx.allowsImplicitAnimation = false
                headerContextDivider.animator().alphaValue = 1.0
                contextPill.animator().alphaValue = 1.0
            }
            headerContextDivider.alphaValue = 1.0
            contextPill.alphaValue = 1.0
        } else {
            if shouldAnimate && (!headerContextDivider.isHidden || !contextPill.isHidden) {
                NSAnimationContext.runAnimationGroup({ ctx in
                    ctx.duration = 0.12
                    ctx.timingFunction = CAMediaTimingFunction(name: .easeIn)
                    self.headerContextDivider.animator().alphaValue = 0.0
                    self.contextPill.animator().alphaValue = 0.0
                }, completionHandler: { [weak self] in
                    DispatchQueue.main.async {
                        guard let self, self.contextPillTransitionEpoch == epoch else { return }
                        self.headerContextDivider.isHidden = true
                        self.contextPill.isHidden = true
                        self.headerContextDivider.alphaValue = 1.0
                        self.contextPill.alphaValue = 1.0
                    }
                })
            } else {
                NSAnimationContext.runAnimationGroup { ctx in
                    ctx.duration = 0
                    ctx.allowsImplicitAnimation = false
                    headerContextDivider.animator().alphaValue = 1.0
                    contextPill.animator().alphaValue = 1.0
                }
                headerContextDivider.alphaValue = 1.0
                contextPill.alphaValue = 1.0
                headerContextDivider.isHidden = true
                contextPill.isHidden = true
            }
        }
    }

    private func syncTopContextPill(animate: Bool = false) {
        guard isViewLoaded else { return }
        switch selectedTab {
        case 0:
            let periodKey = Self.periods[selectedPeriod]
            let report = app.cachedUsageReportsByPeriod[currentUsageCacheKey] ?? app.cachedUsageReportsByPeriod[periodKey]
            let reportEnvs = report.map { UsageFilterSupport.extractAvailableEnvironments(from: $0) } ?? []
            let envs = reportEnvs.isEmpty ? lastKnownUsageEnvironments : reportEnvs
            let breakdown = report.flatMap { UsageFilterSupport.extractEnvironmentBreakdown(from: $0) } ?? lastKnownUsageBreakdown
            let hasUsageSsh = UsageFilterSupport.hasSshEnvironment(environments: envs, breakdown: breakdown)

            var items = app.buildContextPillItems(includeAll: true, includeHistorical: true, includeSharePct: true)
            let existingRemoteIds = Set(items.filter { $0.kind == .ssh }.map(\.id))
            if !envs.isEmpty {
                let hosts = app.canonicalRemoteHosts()
                var hostById: [String: CanonicalHostEnvironment] = [:]
                for h in hosts { hostById[h.environmentId] = h }
                let sshCountInEnvs = envs.filter {
                    let id = ($0["id"] as? String) ?? ""
                    let kind = ($0["kind"] as? String) ?? ""
                    return id != "all" && id != "local" && (kind == "ssh" || id.hasPrefix("ssh:") || id.hasPrefix("host:"))
                }.count
                for env in envs {
                    guard let rawId = env["id"] as? String else { continue }
                    let id = rawId.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !id.isEmpty, id != "all", id != "local", !existingRemoteIds.contains(id) else { continue }
                    let kindStr = (env["kind"] as? String) ?? ""
                    guard kindStr == "ssh" || id.hasPrefix("ssh:") || id.hasPrefix("host:") else { continue }
                    let rawHost = ((env["host_label"] as? String)
                        ?? (env["hostLabel"] as? String)
                        ?? (env["label"] as? String)
                        ?? id).trimmingCharacters(in: .whitespacesAndNewlines)
                    let cleanHost = SshEnvironmentResolver.cleanHostLabel(rawHost)
                    let liveHost = hostById[id]
                    let online = (env["online"] as? Bool) ?? true
                    let rawState = env["state"] as? String
                    let state: SshHostState = liveHost?.state
                        ?? (rawState.map { SshHostState(rawSessionState: $0) } ?? (online ? .online : .historicalOnly))
                    let shareText = UsageFilterSupport.sshSharePercentText(
                        for: id,
                        environments: envs,
                        breakdown: breakdown,
                        sshCount: max(1, sshCountInEnvs)
                    )
                    items.append(EnvironmentContextPill.Item(
                        scope: .remote(environmentId: id),
                        hostLabel: cleanHost.isEmpty ? id : cleanHost,
                        state: state,
                        windowCount: liveHost?.windowCount ?? ((env["windowCount"] as? Int) ?? 1),
                        email: liveHost?.email.isEmpty == false ? liveHost?.email : nil,
                        secondaryText: shareText
                    ))
                }
            }
            let currentScope = EnvironmentScope(rawEnvironmentId: selectedEnvironmentId)
            if case .remote(let envId) = currentScope,
               !items.contains(where: { $0.scope == currentScope }) {
                let cleanSel = SshEnvironmentResolver.cleanHostLabel(envId)
                items.append(EnvironmentContextPill.Item(
                    scope: currentScope,
                    hostLabel: cleanSel.isEmpty ? envId : cleanSel,
                    state: .offlineRecent,
                    windowCount: 0
                ))
            }
            let hasAnySsh = items.contains { $0.kind == .ssh } || hasUsageSsh || currentScope.isRemote
            if hasAnySsh {
                contextPill.update(items: items, selectedScope: currentScope, isActive: !currentScope.isAll)
                setTopContextControlsVisible(!contextPill.isHidden, animated: animate)
            } else {
                contextPill.update(items: items, selectedScope: .all, isActive: false)
                setTopContextControlsVisible(false, animated: animate)
            }

        case 1:
            let items = app.buildContextPillItems(includeAll: false, includeHistorical: false, includeSharePct: false)
            let selectedScope: EnvironmentScope = app.selectedMenuQuotaHost().map { .remote(environmentId: $0.environmentId) } ?? .local
            contextPill.update(items: items, selectedScope: selectedScope, isActive: selectedScope.isRemote)
            setTopContextControlsVisible(!contextPill.isHidden, animated: animate)

        default:
            setTopContextControlsVisible(false, animated: animate)
        }
    }

    @objc private func openAccountsFromQuotaEmpty() {
        app.showAccountsFromMenuCard()
    }

    @objc private func copyQuotaHeaderEmail() {
        guard !quotaHeaderEmail.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(quotaHeaderEmail, forType: .string)
    }

    // MARK: - Synchronization with Assistant Data Domains

    func onUsageReportUpdated(period: String, environmentId: String = "all", result: Result<[String: Any], Error>) {
        guard isViewLoaded else { return }
        let currentPeriodKey = Self.periods[selectedPeriod]
        let trimmedEnv = environmentId.trimmingCharacters(in: .whitespacesAndNewlines)
        let effectiveEnv = trimmedEnv.isEmpty ? "all" : trimmedEnv
        performWithoutAnimation(updateSize: true, animateSize: app.isMenuPanelShown) {
            if period == currentPeriodKey && effectiveEnv == selectedEnvironmentId && selectedTab == 0 {
                syncUsageTabFromCache()
            }
            syncHeaderRefreshState()
        }
    }

    func syncFromAssistant(updateSize: Bool = true, animateContextPill: Bool = false) {
        guard isViewLoaded, !isTransitioningTab else { return }
        let ssotUsageEnv = app.usageFilterScope.rawEnvironmentId
        if ssotUsageEnv != selectedEnvironmentId {
            selectedEnvironmentId = ssotUsageEnv
            renderedUsageSnapshotKey = ""
            renderedUsageModelKey = ""
        }
        performWithoutAnimation(updateSize: updateSize, animateSize: app.isMenuPanelShown) {
            syncDebugPortBanner()
            syncHeaderRefreshState()
            switch selectedTab {
            case 0:
                syncUsageTabFromCache()
                if !renderedQuotaTabKey.isEmpty { syncQuotaTab() }
                if !accountCardsById.isEmpty { syncAccountsTab() }
            case 1:
                syncQuotaTab()
                if !accountCardsById.isEmpty { syncAccountsTab() }
            default:
                syncAccountsTab()
                if !renderedQuotaTabKey.isEmpty { syncQuotaTab() }
            }
        }
        syncTopContextPill(animate: animateContextPill)
        if app.reachable && (app.menuTracking || app.isMenuPanelShown) && selectedTab == 0 {
            let periodKey = Self.periods[selectedPeriod]
            let cacheKey = currentUsageCacheKey
            let lastFetch = app.usageLastFetchTimeByPeriod[cacheKey] ?? .distantPast
            let hasError = !(app.usageFetchErrorsByPeriod[cacheKey]?.isEmpty ?? true)
            let nextRetry = app.usageNextRetryAtByPeriod[cacheKey] ?? .distantPast
            let isStale = Date().timeIntervalSince(lastFetch) >= 15.0 || (hasError && Date() >= nextRetry)
            let needsUsageRefresh = app.cachedUsageReportsByPeriod[cacheKey] == nil
                || app.bootstrappedUsagePeriods.contains(cacheKey)
                || isStale
                || hasError
            let canRetryNow = !hasError || Date() >= nextRetry
            if needsUsageRefresh && app.usageInFlightByPeriod[cacheKey] != true && canRetryNow {
                app.fetchUsageSummary(period: periodKey, environmentId: selectedEnvironmentId, force: false)
            }
        }
    }

    func syncHeaderRefreshState() {
        guard isViewLoaded else { return }
        headerRefreshButton.toolTip = nil
        headerRefreshButton.isHidden = false
        headerRefreshButton.alphaValue = 1.0
        moreButton.isHidden = false
        moreButton.isEnabled = true
        moreButton.alphaValue = 1.0
        if headerRefreshButton.iconOnly {
            if !headerRefreshButton.title.isEmpty {
                headerRefreshButton.title = ""
            }
        } else {
            let refreshTitle = L10n.t("common.refresh", fallback: "刷新")
            if headerRefreshButton.title != refreshTitle {
                headerRefreshButton.title = refreshTitle
            }
        }
        switch selectedTab {
        case 0:
            let cacheKey = currentUsageCacheKey
            let busy = app.usageManualRefreshPeriods.contains(cacheKey)
            headerRefreshButton.setBusy(busy, available: app.reachable)
        case 1:
            if app.selectedMenuQuotaHost() != nil {
                headerRefreshButton.setBusy(app.remoteQuotaRefreshing, available: app.reachable)
            } else {
                let active = app.resolvedMenuAccount()
                let activeId = active?["id"] as? String ?? app.activeAccountId
                let busy = app.quotaRefreshing || (!activeId.isEmpty && app.refreshingAccountIds.contains(activeId))
                headerRefreshButton.setBusy(busy, available: app.reachable && (!activeId.isEmpty || !app.cachedAccounts.isEmpty))
            }
        default:
            let busy = app.quotaRefreshing
            headerRefreshButton.setBusy(busy, available: app.reachable && !app.cachedAccounts.isEmpty)
        }
    }

    // MARK: - Tab 0 Rendering (Usage)

    private func cacheUsageEnvironmentMetadata(from report: [String: Any]?) {
        if let report {
            let envs = UsageFilterSupport.extractAvailableEnvironments(from: report)
            if !envs.isEmpty || selectedEnvironmentId == "all" {
                lastKnownUsageEnvironments = envs
            }
            if selectedEnvironmentId == "all" {
                lastKnownUsageBreakdown = UsageFilterSupport.extractEnvironmentBreakdown(from: report)
            } else if let breakdown = UsageFilterSupport.extractEnvironmentBreakdown(from: report) {
                lastKnownUsageBreakdown = breakdown
            }
            if selectedEnvironmentId == "all" || app.usageAvailableEnvironments.isEmpty {
                app.syncUsageEnvironmentsFromReport(report)
            }
        }
    }

    private func syncUsageTabFromCache() {
        let periodKey = Self.periods[selectedPeriod]
        let cacheKey = currentUsageCacheKey
        let periodLabel = Self.periodLabels[selectedPeriod]
        if selectedPeriod == 0 {
            trendTitleLabel.stringValue = L10n.t("menu_panel.trend.today", fallback: "今日趋势")
        } else if selectedPeriod == 3 {
            trendTitleLabel.stringValue = L10n.t("menu_panel.trend.all", fallback: "全部趋势")
        } else {
            trendTitleLabel.stringValue = L10n.t("menu_panel.trend.period", ["period": periodLabel], fallback: "\(periodLabel)趋势")
        }

        guard let report = app.cachedUsageReportsByPeriod[cacheKey] else {
            cacheUsageEnvironmentMetadata(from: app.cachedUsageReportsByPeriod[periodKey])
            syncTopContextPill(animate: false)
            clearMenuUsageChartsAndModels()
            if let err = app.usageFetchErrorsByPeriod[cacheKey], !err.isEmpty {
                usageScopeLabel.stringValue = L10n.t("menu_panel.usage.read_failed", ["error": err], fallback: "读取失败：\(err)")
                usageScopeLabel.textColor = accessibleWarningColor()
                usageScopeLabel.isHidden = false
                for tile in [tokensTile, requestsTile, costTile, cacheTile] { tile.setValueText("—") }
                usageFooterLabel.stringValue = L10n.t("menu_panel.usage.retry_footer", fallback: "无法读取统计 · 点击右上角「刷新」重试")
                usageFooterLabel.textColor = accessibleWarningColor()
            } else if !app.reachable {
                usageScopeLabel.stringValue = L10n.t("menu_panel.usage.waiting_service", fallback: "正在等待本机服务…")
                usageScopeLabel.textColor = Design.secondary
                usageScopeLabel.isHidden = false
                for tile in [tokensTile, requestsTile, costTile, cacheTile] { tile.setValueText("—") }
                usageFooterLabel.stringValue = L10n.t("menu_panel.usage.service_offline", fallback: "本机服务离线")
                usageFooterLabel.textColor = accessibleWarningColor()
            } else {
                for tile in [tokensTile, requestsTile, costTile, cacheTile] { tile.setValueText("—") }
                usageScopeLabel.stringValue = L10n.t("menu_panel.usage.loading", fallback: "正在读取统计…")
                usageScopeLabel.textColor = Design.secondary
                usageScopeLabel.isHidden = false
                usageFooterLabel.stringValue = L10n.t("menu_panel.usage.loading_footer", fallback: "正在同步最新用量数据…")
                usageFooterLabel.textColor = Design.secondary
            }
            return
        }

        let summary = report["summary"] as? [String: Any] ?? [:]
        let availability = summary["availability"] as? String ?? "complete"
        let envs = UsageFilterSupport.extractAvailableEnvironments(from: report)
        let breakdown = UsageFilterSupport.extractEnvironmentBreakdown(from: report)
        let hasSsh = UsageFilterSupport.hasSshEnvironment(environments: envs, breakdown: breakdown)
        if availability != "unavailable",
           !envs.isEmpty,
           !hasSsh,
           selectedEnvironmentId != "all",
           !envs.contains(where: { ($0["id"] as? String) == selectedEnvironmentId }) {
            selectedEnvironmentId = "all"
            app.setUsageFilterScope(.all, persist: true, syncOverview: false, syncUsagePage: false, syncMenuPanel: false)
            app.syncUsageEnvironmentsFromReport(report)
            lastKnownUsageEnvironments = envs
            lastKnownUsageBreakdown = breakdown
            renderedUsageSnapshotKey = ""
            renderedUsageModelKey = ""
            if let oldAll = app.cachedUsageReportsByPeriod[periodKey],
               UsageFilterSupport.hasSshEnvironment(
                   environments: UsageFilterSupport.extractAvailableEnvironments(from: oldAll),
                   breakdown: UsageFilterSupport.extractEnvironmentBreakdown(from: oldAll)
               ) {
                app.cachedUsageReportsByPeriod.removeValue(forKey: periodKey)
            }
            syncUsageTabFromCache()
            if app.reachable {
                app.fetchUsageSummary(period: periodKey, environmentId: "all", force: false, allowCached: false)
            }
            return
        }
        cacheUsageEnvironmentMetadata(from: report)
        syncTopContextPill(animate: false)
        if availability == "unavailable" {
            usageScopeLabel.stringValue = L10n.t("menu_panel.usage.db_unavailable", fallback: "所选会话数据库均读取失败")
            usageScopeLabel.textColor = accessibleWarningColor()
            usageScopeLabel.isHidden = false
            for tile in [tokensTile, requestsTile, costTile, cacheTile] { tile.setValueText("—", warning: true) }
            clearMenuUsageChartsAndModels()
            usageFooterLabel.stringValue = L10n.t("menu_panel.usage.stats_unavailable", fallback: "统计暂不可用 · 可打开主界面查看诊断详情")
            usageFooterLabel.textColor = accessibleWarningColor()
            return
        }

        let total = intVal(summary, "totalTokens")
        let requests = intVal(summary, "requestCount")
        let usd = doubleVal(summary, "estimatedUsd")
        let prompt = intVal(summary, "promptTokens")
        let cached = intVal(summary, "cachedTokens")
        let cacheWrite = intVal(summary, "cacheWriteTokens", fallback: intVal(summary, "cache_write_tokens"))
        let denom = prompt + cached + cacheWrite
        let cacheHit = doubleVal(summary, "cacheHitRate", fallback: denom > 0 ? (Double(cached) / Double(denom)) * 100.0 : 0.0)
        let pricedCount = intVal(summary, "pricedModels", fallback: intVal(summary, "priced_models", fallback: intVal(report, "pricedModels")))
        let unpricedCount = intVal(summary, "unpricedModels", fallback: intVal(summary, "unpriced_models", fallback: intVal(report, "unpricedModels")))
        let models = ModelUsageFold.sortByUsage(ModelUsageFold.foldThinkingVariants((report["byModel"] as? [[String: Any]]) ?? (report["models"] as? [[String: Any]]) ?? []))
        let costSummary = UsageMetricsPresentation.evaluateCost(
            foldedModels: models,
            pricedCount: pricedCount,
            unpricedCount: unpricedCount,
            usd: usd
        )
        let displayUnpricedCount = costSummary.displayUnpricedCount

        let effectiveEnvs = envs.isEmpty ? lastKnownUsageEnvironments : envs
        let effectiveBreakdown = breakdown ?? lastKnownUsageBreakdown

        let scanned = intVal(summary, "databasesScanned")
        let discovered = intVal(summary, "databasesDiscovered", fallback: scanned)
        let failed = intVal(summary, "failedDatabasesCount")
        let skipped = intVal(summary, "skippedLargeRecords")
        let unknown = intVal(summary, "unknownTimeRecords")
        if failed > 0 || skipped > 0 || unknown > 0 || (discovered > 0 && scanned < discovered) {
            let warnText = InterfaceText.usageScope(scanned: scanned, discovered: discovered, failed: failed, skipped: skipped, unknown: unknown)
            usageScopeLabel.stringValue = warnText
            usageScopeLabel.textColor = accessibleWarningColor()
            usageScopeLabel.isHidden = false
        } else {
            usageScopeLabel.stringValue = ""
            usageScopeLabel.isHidden = true
        }

        tokensTile.setValueText(InterfaceText.formatCompactTokens(total, formatSmallWithLocale: true))
        tokensTile.toolTip = nil
        requestsTile.setValueText(InterfaceText.formatInteger(requests))
        costTile.setValueText(
            costSummary.isAllUnpriced ? L10n.t("menu_panel.usage.unpriced", fallback: "未计价") : InterfaceText.formatUsd(usd),
            badgeText: costSummary.isPartialCost ? L10n.t("menu_panel.cost.partial_badge", fallback: "部分") : nil,
            badgeTint: accessibleWarningColor()
        )
        cacheTile.setValueText(UsageMetricsPresentation.formatCacheHitRate(denom: denom, cacheHitRate: cacheHit))

        let hourSuffix = selectedPeriod == 0 ? ":\(Calendar.current.component(.hour, from: Date()))" : ""
        let snapKey = "\(selectedEnvironmentId):\(report["snapshotId"] ?? ""):\(periodKey)\(hourSuffix):\(selectedChartDimension.rawValue):\(total):\(requests):\(failed):\(unknown)"
        if snapKey != renderedUsageSnapshotKey {
            renderedUsageSnapshotKey = snapKey
            updateMenuTrendBuckets(report: report, summary: summary)
        }

        let modelKey = "\(L10n.shared.currentLocale):\(selectedEnvironmentId):\(report["snapshotId"] ?? ""):\(periodKey):\(models.count):\(pricedCount):\(displayUnpricedCount):\(showAllModels):\(total)"
        if modelKey != renderedUsageModelKey {
            renderedUsageModelKey = modelKey
            rebuildMenuModelList(models: models, totalTokens: total)
        }

        let lastScan = doubleVal(summary, "lastScannedAt", fallback: doubleVal(summary, "generated_at"))
        let timeStr = lastScan > 0 ? Self.timeFormatter.string(from: Date(timeIntervalSince1970: lastScan)) : L10n.t("common.just_now", fallback: "刚刚")
        var footerParts: [String] = [L10n.t("common.updated_at", ["time": timeStr], fallback: "更新于 \(timeStr)")]
        if let fetchErr = app.usageFetchErrorsByPeriod[cacheKey], !fetchErr.isEmpty {
            footerParts.append(L10n.t("menu_panel.usage.refresh_failed_cached", fallback: "刷新失败 · 沿用上次记录"))
        } else if availability == "cached" {
            footerParts.append(L10n.t("menu_panel.usage.cached_snapshot", fallback: "沿用缓存快照"))
        } else if failed > 0 {
            footerParts.append(L10n.t("menu_panel.usage.failed_dbs", ["count": failed], fallback: "\(failed) 个会话库异常"))
        }
        if displayUnpricedCount > 0 {
            footerParts.append(L10n.t("menu_panel.usage.unpriced_footer", ["count": displayUnpricedCount], fallback: "\(displayUnpricedCount) 款模型待定价"))
        }
        let expiredCount = models.filter { ($0["pricingStatus"] as? String ?? "") == "expired" }.count
        if expiredCount > 0 {
            footerParts.append(L10n.t("usage.cost.outdated_models", ["count": expiredCount], fallback: "\(expiredCount) 款模型定价已过期"))
        }
        if selectedEnvironmentId == "all",
           let shareNote = UsageFilterSupport.environmentShareNote(breakdown: effectiveBreakdown, selectedEnvironmentId: "all") {
            footerParts.append(shareNote)
        } else if selectedEnvironmentId != "all" && selectedEnvironmentId != "local" {
            let selectedEnvObj = effectiveEnvs.first { ($0["id"] as? String) == selectedEnvironmentId }
            let remoteHost = app.usageRemoteEnvironments().first { $0.environmentId == selectedEnvironmentId }
            if (selectedEnvObj?["online"] as? Bool) == false || remoteHost?.state.isOfflineLike == true {
                footerParts.append(L10n.t("menu_panel.env.offline_hint", fallback: "离线快照"))
            }
        }
        usageFooterLabel.stringValue = footerParts.joined(separator: " · ")
        usageFooterLabel.textColor = (app.usageFetchErrorsByPeriod[cacheKey] != nil || failed > 0 || availability == "cached")
            ? accessibleWarningColor()
            : Design.secondary
    }

    private func clearMenuUsageChartsAndModels() {
        renderedUsageSnapshotKey = ""
        renderedUsageModelKey = ""
        trendChart.buckets = []
        trendCoverageLabel.stringValue = ""
        trendCoverageLabel.alphaValue = 0.0
        modelsListStack.arrangedSubviews.forEach {
            modelsListStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        modelRowViewsByName.removeAll()
        modelDividerViewsByName.removeAll()
        renderedModelNames.removeAll()
        modelsHeaderCountLabel.stringValue = ""
        toggleModelsButton.isHidden = true
    }

    private func updateMenuTrendBuckets(report: [String: Any], summary: [String: Any]) {
        let isTokens = (selectedChartDimension == .tokens)
        if selectedPeriod == 0 {
            let hourly = (report["todayHourly"] as? [[String: Any]]) ?? (summary["today_hourly"] as? [[String: Any]]) ?? []
            var hourValMap: [String: Int] = [:]
            for h in hourly {
                if let hourStr = h["hour"] as? String, let suffix = hourStr.split(separator: " ").last {
                    let v = isTokens
                        ? (intVal(h, "total_tokens", fallback: intVal(h, "totalTokens")))
                        : (intVal(h, "request_count", fallback: intVal(h, "requestCount")))
                    hourValMap[String(suffix), default: 0] += v
                }
            }
            let currentHour = Calendar.current.component(.hour, from: Date())
            var pts: [MenuTrendChartView.Bucket] = []
            for hr in 0..<24 {
                let key = String(format: "%02d:00", locale: Locale(identifier: "en_US_POSIX"), hr)
                let rawVal = hourValMap[key] ?? 0
                let isFuture = (rawVal == 0 && hr > currentHour)
                let hourLbl = L10n.t("menu_panel.trend.hour_label", ["hour": String(format: "%02d", locale: Locale(identifier: "en_US_POSIX"), hr)], fallback: String(format: "%02d时", locale: Locale(identifier: "en_US_POSIX"), hr))
                let tipLbl = L10n.t("menu_panel.trend.today_key", ["time": key], fallback: "今日 \(key)")
                pts.append(.init(label: hourLbl, tooltipLabel: tipLbl, value: rawVal, isFuture: isFuture))
            }
            trendChart.buckets = pts
            trendCoverageLabel.stringValue = ""
            trendCoverageLabel.alphaValue = 0.0
            return
        }

        let daily = (report["dailyTrends"] as? [[String: Any]]) ?? (summary["daily_trends"] as? [[String: Any]]) ?? []
        let targetSlice: ArraySlice<[String: Any]>
        if selectedPeriod == 1 {
            targetSlice = daily.suffix(7)
        } else if selectedPeriod == 2 {
            targetSlice = daily.suffix(30)
        } else {
            targetSlice = daily[...]
        }

        if selectedPeriod == 3 && targetSlice.count > 90 {
            // 按自然月 (yyyy-MM) 聚合
            var monthOrder: [String] = []
            var monthTotals: [String: Int] = [:]
            for d in targetSlice {
                let dateStr = (d["date"] as? String) ?? ""
                let monthKey = dateStr.count >= 7 ? String(dateStr.prefix(7)) : dateStr
                guard !monthKey.isEmpty else { continue }
                if monthTotals[monthKey] == nil { monthOrder.append(monthKey) }
                let v = isTokens
                    ? intVal(d, "total_tokens", fallback: intVal(d, "totalTokens"))
                    : intVal(d, "request_count", fallback: intVal(d, "requestCount"))
                monthTotals[monthKey, default: 0] += v
            }
            trendChart.buckets = monthOrder.map { m in
                let shortLbl = m.count >= 7 ? String(m.suffix(5)) : m
                return .init(label: shortLbl, tooltipLabel: L10n.t("menu_panel.trend.month_summary", ["month": m], fallback: "\(m) 月汇总"), value: monthTotals[m] ?? 0, isFuture: false)
            }
        } else if selectedPeriod == 3 && targetSlice.count > 31 {
            // 按 7 天周桶聚合
            let items = Array(targetSlice)
            var buckets: [MenuTrendChartView.Bucket] = []
            var idx = 0
            while idx < items.count {
                let endIdx = min(items.count, idx + 7)
                let chunk = items[idx..<endIdx]
                let startD = (chunk.first?["date"] as? String) ?? ""
                let endD = (chunk.last?["date"] as? String) ?? ""
                let shortStart = startD.count >= 10 ? String(startD.suffix(5)) : startD
                let sumVal = chunk.reduce(0) { acc, item in
                    let v = isTokens
                        ? intVal(item, "total_tokens", fallback: intVal(item, "totalTokens"))
                        : intVal(item, "request_count", fallback: intVal(item, "requestCount"))
                    return acc + v
                }
                buckets.append(.init(label: shortStart, tooltipLabel: L10n.t("menu_panel.trend.date_range", ["start": startD, "end": endD], fallback: "\(startD) 至 \(endD)"), value: sumVal, isFuture: false))
                idx = endIdx
            }
            trendChart.buckets = buckets
        } else {
            trendChart.buckets = targetSlice.map { d in
                let dateStr = (d["date"] as? String) ?? ""
                let shortDate = dateStr.count >= 10 ? String(dateStr.suffix(5)) : dateStr
                let v = isTokens
                    ? intVal(d, "total_tokens", fallback: intVal(d, "totalTokens"))
                    : intVal(d, "request_count", fallback: intVal(d, "requestCount"))
                return .init(label: shortDate, tooltipLabel: dateStr, value: v, isFuture: false)
            }
        }
        trendCoverageLabel.stringValue = ""
        trendCoverageLabel.alphaValue = 0.0
    }

    private func rebuildMenuModelList(models: [[String: Any]], totalTokens: Int) {
        modelsHeaderCountLabel.stringValue = models.isEmpty ? L10n.t("menu_panel.models_none", fallback: "暂无记录") : L10n.t("menu_panel.models_count", ["count": models.count], fallback: "\(models.count) 个模型")

        guard !models.isEmpty else {
            modelRowViewsByName.removeAll()
            modelDividerViewsByName.removeAll()
            renderedModelNames.removeAll()
            modelsListStack.arrangedSubviews.forEach {
                modelsListStack.removeArrangedSubview($0)
                $0.removeFromSuperview()
            }
            let emptyLbl = text(L10n.t("menu_panel.models_empty", fallback: "当前时间范围暂无模型调用记录"), size: 11.5, color: Design.secondary)
            modelsListStack.addArrangedSubview(emptyLbl)
            toggleModelsButton.isHidden = true
            return
        }

        var seenKeys = Set<String>()
        var keyedItems: [(key: String, rawId: String, displayName: String, item: [String: Any])] = []
        keyedItems.reserveCapacity(models.count)
        for (idx, item) in models.enumerated() {
            let rawId = (item["model"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let displayName = InterfaceText.localizedModelLabel(item["model"] as? String)
            let baseKey = rawId.isEmpty ? "model_idx_\(idx)" : rawId
            let uniqueKey = seenKeys.insert(baseKey).inserted ? baseKey : "\(baseKey)#\(idx)"
            keyedItems.append((key: uniqueKey, rawId: rawId, displayName: displayName, item: item))
        }

        let allKeys = keyedItems.map(\.key)
        let validKeys = Set(allKeys)
        modelRowViewsByName = modelRowViewsByName.filter { validKeys.contains($0.key) }
        modelDividerViewsByName = modelDividerViewsByName.filter { validKeys.contains($0.key) }

        for entry in keyedItems {
            let mTokens = intVal(entry.item, "totalTokens", fallback: intVal(entry.item, "total_tokens"))
            let ratio = totalTokens > 0 ? CGFloat(mTokens) / CGFloat(totalTokens) : 0
            let tokensStr = InterfaceText.formatCompactTokens(mTokens, formatSmallWithLocale: true)
            let isPriced = UsageMetricsPresentation.isModelRowPriced(entry.item)
            let isPartialModel = (entry.item["partiallyPriced"] as? Bool) ?? false
            let badgeText: String
            let badgeTint: NSColor
            if !isPriced && !isPartialModel && mTokens > 0 {
                badgeText = L10n.t("menu_panel.model.unpriced_badge", fallback: "待定价")
                badgeTint = accessibleWarningColor()
            } else if isPartialModel {
                badgeText = L10n.t("menu_panel.model.partial_badge", fallback: "部分")
                badgeTint = accessibleWarningColor()
            } else {
                badgeText = ""
                badgeTint = Design.blue
            }

            if let existing = modelRowViewsByName[entry.key] {
                existing.update(displayName: entry.displayName, tokensText: tokensStr, shareFraction: ratio, badgeText: badgeText, badgeTint: badgeTint)
            } else {
                let rowView = MenuModelUsageItemView(
                    model: entry.displayName,
                    rawModelKey: entry.rawId.isEmpty ? entry.displayName : entry.rawId,
                    tokensText: tokensStr,
                    shareFraction: ratio,
                    badgeText: badgeText,
                    badgeTint: badgeTint
                )
                modelRowViewsByName[entry.key] = rowView
            }
        }

        if allKeys != renderedModelNames {
            renderedModelNames = allKeys
            modelsListStack.arrangedSubviews.forEach {
                modelsListStack.removeArrangedSubview($0)
                $0.removeFromSuperview()
            }
            for (idx, key) in allKeys.enumerated() {
                guard let rowView = modelRowViewsByName[key] else { continue }
                if idx > 0 {
                    let line = modelDividerViewsByName[key] ?? {
                        let d = divider()
                        modelDividerViewsByName[key] = d
                        return d
                    }()
                    modelsListStack.addArrangedSubview(line)
                    fillWidth(line, in: modelsListStack)
                }
                modelsListStack.addArrangedSubview(rowView)
                fillWidth(rowView, in: modelsListStack)
            }
        }

        let visibleCount = showAllModels ? allKeys.count : min(3, allKeys.count)
        for (idx, key) in allKeys.enumerated() {
            let shouldHide = idx >= visibleCount
            if let rowView = modelRowViewsByName[key], rowView.isHidden != shouldHide {
                rowView.isHidden = shouldHide
            }
            if idx > 0, let divView = modelDividerViewsByName[key], divView.isHidden != shouldHide {
                divView.isHidden = shouldHide
            }
        }

        if models.count > 3 {
            toggleModelsButton.title = showAllModels ? L10n.t("menu_panel.collapse_other_models", fallback: "收起其余模型") : L10n.t("menu_panel.expand_n_models", ["count": models.count - 3], fallback: "展开其余 \(models.count - 3) 个模型")
            toggleModelsButton.isHidden = false
        } else {
            toggleModelsButton.isHidden = true
        }
    }

    // MARK: - Tab 1 Rendering (Quota)

    private func renderUnifiedQuotaRows(contract: QuotaPresentation.Contract, keyPrefix: String, standbyMode: String? = nil, forceStale: Bool = false) {
        let now = Date()
        let unknownText = L10n.t("common.unknown", fallback: "未知")
        let unavailableText = L10n.t("common.unavailable", fallback: "不可用")
        let modelQuotaText = L10n.t("quota.model_quota", fallback: "模型配额")
        let quotaRowsFingerprint = [
            L10n.shared.currentLocale,
            keyPrefix,
            standbyMode ?? "",
            forceStale ? "1" : "0",
            contract.displayGroups.map { g in
                let ws = g.windows.map { "\($0.localizedLabel):\($0.percentage.map(String.init) ?? "-"):\($0.placeholder(availability: g.availability)):\($0.effectiveResetText(at: now, standbyMode: standbyMode, compact: true)):\($0.effectiveStale(at: now) || forceStale)" }.joined(separator: ",")
                return "\(g.key)|\(g.displayName)|\(g.availability)|\(ws)"
            }.joined(separator: ";")
        ].joined(separator: "#")

        guard quotaRowsFingerprint != renderedQuotaTabKey else { return }
        renderedQuotaTabKey = quotaRowsFingerprint
        quotaUnifiedContentStack.arrangedSubviews.forEach {
            quotaUnifiedContentStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        var assignedG5 = false
        var assignedGW = false
        var assignedC5 = false
        var assignedCW = false

        for (groupIdx, quotaGroup) in contract.displayGroups.enumerated() {
            if groupIdx > 0 {
                let div = divider()
                quotaUnifiedContentStack.addArrangedSubview(div)
                fillWidth(div, in: quotaUnifiedContentStack)
            }
            let brands = quotaGroup.brands.isEmpty ? ModelIcons.brands(for: quotaGroup.displayName) : quotaGroup.brands
            let header = MenuQuotaHelpers.groupHeader(quotaGroup.displayName, brands: brands, fontSize: 11.5, iconSize: 13)
            var groupViews: [NSView] = [header]
            var rowsForGroup: [MenuMeterRow] = []

            if quotaGroup.windows.isEmpty {
                let row = MenuMeterRow(title: modelQuotaText)
                row.accessibilityGroupName = quotaGroup.displayName
                let ph = quotaGroup.availability == "disabled" ? unavailableText : unknownText
                row.apply(percentage: nil, placeholder: ph, reset: "", stale: false)
                groupViews.append(row)
                rowsForGroup.append(row)
            } else {
                for win in quotaGroup.windows {
                    let row = MenuMeterRow(title: win.localizedLabel)
                    row.accessibilityGroupName = quotaGroup.displayName
                    let effStale = win.effectiveStale(at: now) || forceStale
                    row.apply(
                        percentage: win.percentage,
                        placeholder: win.placeholder(availability: quotaGroup.availability),
                        reset: win.percentage == nil ? "" : win.effectiveResetText(at: now, standbyMode: standbyMode, compact: true),
                        stale: effStale
                    )
                    groupViews.append(row)
                    rowsForGroup.append(row)
                }
            }

            let groupStack = vertical(groupViews, spacing: 6)
            groupStack.alignment = .leading
            for v in groupViews { fillWidth(v, in: groupStack) }
            quotaUnifiedContentStack.addArrangedSubview(groupStack)
            fillWidth(groupStack, in: quotaUnifiedContentStack)

            let normalizedKey = quotaGroup.key.lowercased()
            if normalizedKey == "gemini" {
                if let first = rowsForGroup.first { quotaGemini5h = first; assignedG5 = true }
                if rowsForGroup.count > 1 { quotaGeminiWeekly = rowsForGroup[1]; assignedGW = true }
            } else if normalizedKey == "claude" || normalizedKey == "claude_gpt" {
                if let first = rowsForGroup.first { quotaClaude5h = first; assignedC5 = true }
                if rowsForGroup.count > 1 { quotaClaudeWeekly = rowsForGroup[1]; assignedCW = true }
            }
        }
        if !assignedG5 { quotaGemini5h = MenuMeterRow(title: L10n.t("common.period.5h", fallback: "5 小时")) }
        if !assignedGW { quotaGeminiWeekly = MenuMeterRow(title: L10n.t("common.period.weekly", fallback: "每周")) }
        if !assignedC5 { quotaClaude5h = MenuMeterRow(title: L10n.t("common.period.5h", fallback: "5 小时")) }
        if !assignedCW { quotaClaudeWeekly = MenuMeterRow(title: L10n.t("common.period.weekly", fallback: "每周")) }
    }

    private func syncQuotaTab() {
        let now = Date()
        if let host = app.selectedMenuQuotaHost() {
            let remote = host.rawSession
            let remoteKey = host.primaryRemoteKey
            let email = host.email
            let tier = host.tier
            let lastErr = host.lastError
            let freshness = app.quotaFreshness(forHost: host, now: now)

            let hostDisplay = host.cleanHostLabel
            quotaAccountNameLabel.stringValue = email.isEmpty
                ? hostDisplay
                : AccountIdentity.displayName(name: host.name, email: email)
            quotaEmailLabel.stringValue = email.isEmpty
                ? L10n.t("ssh.context.remote_switch_hint", fallback: "远程主机账号由远端独立管理，此处仅供只读查看与刷新。")
                : email
            quotaEmailLabel.toolTip = nil
            quotaHeaderEmail = email
            quotaTierBadge.title = tier
            quotaTierBadge.isHidden = email.isEmpty || tier.isEmpty
            // 顶栏 EnvironmentContextPill 已明确指出当前主机时，移除卡内冗余「远程只读」胶囊
            quotaStatusBadge.title = ""
            quotaStatusBadge.isHidden = true
            quotaEmptyButton.isHidden = true

            let contract = QuotaPresentation.contract(remote)
            if contract.displayGroups.isEmpty {
                quotaGroupsContainer.isHidden = true
                renderedQuotaTabKey = "remote_empty:\(host.environmentId):\(remoteKey):\(app.statusValue.remoteObservedVersion):\(freshness.rawValue):\(L10n.shared.currentLocale)"
            } else {
                quotaGroupsContainer.isHidden = false
                renderUnifiedQuotaRows(
                    contract: contract,
                    keyPrefix: "remote:\(host.environmentId):\(remoteKey):\(app.statusValue.remoteObservedVersion):\(freshness.rawValue)",
                    forceStale: freshness.isStaleOrDegraded
                )
            }

            var warnings: [String] = []
            switch host.state {
            case .offlineRecent, .historicalOnly:
                warnings.append(L10n.t("ssh.context.remote_disconnected", fallback: "SSH 连接已断开（暂示上次快照）"))
            case .authExpired:
                warnings.append(L10n.t("ssh.context.remote_auth_expired", fallback: "远端登录态已过期，请在 SSH 窗口重新登录"))
            case .online:
                if !lastErr.isEmpty {
                    warnings.append(L10n.t("ssh.context.remote_probe_error", fallback: "远端配额刷新失败，暂示上次快照"))
                }
            }
            if contract.displayGroups.isEmpty {
                warnings.append(L10n.t("ssh.context.remote_no_quota", fallback: "暂未获取到远端配额"))
            }
            let contractWarn = QuotaPresentation.warningSummary(contract, excluding: warnings)
            if !contractWarn.isEmpty {
                warnings.append(contractWarn)
            }
            quotaWarningLabel.stringValue = warnings.joined(separator: L10n.shared.isEnglish ? "; " : "；")
            quotaWarningLabel.textColor = accessibleWarningColor()
            quotaWarningLabel.isHidden = warnings.isEmpty

            var footerParts: [String] = []
            let localEmail = (app.resolvedMenuAccount()?["email"] as? String ?? app.statusValue.liveAccountEmail).trimmingCharacters(in: .whitespacesAndNewlines)
            if let sameAsLocal = SshEnvironmentResolver.isSameAccountAsLocal(host: host, localEmail: localEmail) {
                footerParts.append(sameAsLocal
                    ? L10n.t("ssh.context.same_as_local", fallback: "与本机同一账号")
                    : L10n.t("ssh.context.diff_from_local", fallback: "与本机不同账号"))
            } else if !email.isEmpty, host.matchedLocalAccountId == nil {
                footerParts.append(L10n.t("ssh.context.diff_from_local", fallback: "与本机不同账号"))
            }
            if host.windowCount > 1 {
                footerParts.append(L10n.t("accounts.ssh.remote_window_count", ["count": host.windowCount], fallback: "\(host.windowCount) 个窗口"))
            }
            let stamp = host.effectiveQuotaTimestamp
            let isStale = freshness.isStaleOrDegraded
            if app.remoteQuotaRefreshing {
                footerParts.append(L10n.t("menu_panel.quota.refreshing", fallback: "正在刷新配额…"))
            } else if stamp > 0 {
                let date = Date(timeIntervalSince1970: stamp)
                let fmt = Calendar.current.isDateInToday(date) ? Self.timeFormatter : Self.dateTimeFormatter
                let updatedStr = L10n.t("common.updated_at", ["time": fmt.string(from: date)], fallback: "更新于 \(fmt.string(from: date))")
                footerParts.append(updatedStr + (isStale ? L10n.t("menu_panel.quota.stale_suffix", fallback: " · 待刷新") : ""))
            } else {
                footerParts.append(L10n.t("ssh.presence.remote_read_only", fallback: "远程只读"))
            }
            if app.isMenuQuotaFollowingFocus {
                footerParts.append(L10n.t("menu_panel.ssh.following_focus_footer", fallback: "跟随当前窗口"))
            }
            quotaFooterLabel.stringValue = footerParts.joined(separator: " · ")
            quotaFooterLabel.textColor = (!app.remoteQuotaRefreshing && isStale) ? accessibleWarningColor() : .secondaryLabelColor
            quotaFooterLabel.toolTip = nil
            quotaFooterLabel.setAccessibilityHelp(nil)
            return
        }

        let active = app.resolvedMenuAccount()
        guard let account = active else {
            let liveUnsaved = !app.statusValue.liveAccountEmail.isEmpty
            quotaAccountNameLabel.stringValue = !app.reachable ? L10n.t("menu_panel.usage.waiting_service", fallback: "正在等待本机服务…") : (liveUnsaved ? L10n.t("menu_panel.quota.unsaved_live", fallback: "运行中账号尚未保存") : L10n.t("menu_panel.quota.no_saved", fallback: "尚未保存账号"))
            quotaEmailLabel.stringValue = liveUnsaved ? L10n.t("menu_panel.quota.detected_unsaved", ["email": app.statusValue.liveAccountEmail], fallback: "检测到 \(app.statusValue.liveAccountEmail)，请前往账号页保存") : L10n.t("menu_panel.quota.empty_hint", fallback: "点击下方按钮前往账号页，保存当前账号或从 JSON 导入")
            quotaHeaderEmail = app.statusValue.liveAccountEmail
            quotaTierBadge.isHidden = true
            quotaStatusBadge.isHidden = true
            quotaGroupsContainer.isHidden = true
            quotaEmptyButton.isHidden = false
            if showHistoricalQuotaFallbackNotice {
                quotaWarningLabel.stringValue = L10n.t("usage.env.historical_fallback_notice", fallback: "历史主机暂无实时配额，已切回本机配额。")
                quotaWarningLabel.textColor = .secondaryLabelColor
                quotaWarningLabel.isHidden = false
            } else {
                quotaWarningLabel.isHidden = true
            }
            quotaFooterLabel.stringValue = app.reachable ? L10n.t("menu_panel.quota.empty_footer", fallback: "保存账号后即可在菜单栏实时查看各模型周期配额") : L10n.t("menu_panel.usage.service_offline", fallback: "本机服务离线")
            quotaFooterLabel.textColor = .secondaryLabelColor
            quotaFooterLabel.toolTip = nil
            quotaFooterLabel.setAccessibilityHelp(nil)
            return
        }

        quotaGroupsContainer.isHidden = false
        quotaEmptyButton.isHidden = true

        let id = account["id"] as? String ?? ""
        let email = account["email"] as? String ?? ""
        quotaHeaderEmail = email
        let display = AccountIdentity.displayName(name: account["name"] as? String, email: email)
        let tier = AccountIdentity.normalizeTier(account["subscription_tier"] as? String)
        quotaAccountNameLabel.stringValue = display
        quotaEmailLabel.stringValue = email
        quotaEmailLabel.toolTip = nil
        quotaTierBadge.title = tier
        quotaTierBadge.isHidden = tier.isEmpty

        let liveEmail = app.statusValue.liveAccountEmail.trimmingCharacters(in: .whitespacesAndNewlines)
        let isLiveMatch = !liveEmail.isEmpty && liveEmail.caseInsensitiveCompare(email) == .orderedSame
        if !liveEmail.isEmpty && !isLiveMatch {
            quotaStatusBadge.title = L10n.t("menu_panel.quota.not_live", fallback: "非运行账号")
            quotaStatusBadge.tint = accessibleWarningColor()
            quotaStatusBadge.isHidden = false
        } else {
            quotaStatusBadge.title = ""
            quotaStatusBadge.isHidden = true
        }

        let quota = account["quota"] as? [String: Any]
        let rawStamp = QuotaPresentation.number(quota?["last_updated"]) ?? QuotaPresentation.number(account["quota_last_updated"]) ?? 0
        let stamp = rawStamp > 10_000_000_000 ? rawStamp / 1000.0 : rawStamp
        let freshness = app.quotaFreshness(forAccount: account, now: now)
        let explicitAccountFreshness = QuotaFreshness(rawValueOrNil: (account["quotaFreshness"] as? String) ?? (quota?["quotaFreshness"] as? String))
        let forceAllStale = (freshness == .offlineSnapshot || freshness == .errorFallback || freshness == .authExpired || explicitAccountFreshness == .stale || (stamp > 0 && now.timeIntervalSince1970 - stamp > app.quotaStaleThresholdSeconds))

        let sourceHost = app.quotaSourceEnvironment(forAccount: account)
        let matchingSshHosts = SshEnvironmentResolver.matchingHosts(forAccount: account, hosts: app.canonicalRemoteHosts())
        let hasOnlineSshHost = matchingSshHosts.contains(where: { $0.state == .online })
        let isRemoteActive = sourceHost != nil || hasOnlineSshHost
        let standbyMode = isRemoteActive ? nil : app.standbyRefreshMode(account)
        let contractInput: [String: Any]
        if isRemoteActive, account["standbyRefreshStatus"] != nil {
            var sanitized = account
            sanitized.removeValue(forKey: "standbyRefreshStatus")
            contractInput = sanitized
        } else {
            contractInput = account
        }
        let contract = QuotaPresentation.contract(contractInput)
        renderUnifiedQuotaRows(
            contract: contract,
            keyPrefix: "\(id)|\(email)|\(freshness.rawValue)",
            standbyMode: standbyMode,
            forceStale: forceAllStale
        )

        var warnings: [String] = []
        if let readiness = account["credentialReadiness"] as? [String: Any], readiness["state"] as? String == "needs_authorization" {
            warnings.append(L10n.t("menu_panel.quota.reauth_needed", fallback: "登录授权已失效，请前往主界面重新授权"))
        }
        if let singleErr = app.singleAccountRefreshErrors[id], !singleErr.isEmpty {
            warnings.append(InterfaceText.quotaMessage(singleErr))
        } else if let refreshErr = account["quota_refresh_error"] as? String, !refreshErr.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !InterfaceText.isInternalDualWindowError(refreshErr) {
            warnings.append(InterfaceText.quotaMessage(refreshErr))
        } else if let globalErr = app.quotaRefreshError, !globalErr.isEmpty, !InterfaceText.isMultiAccountSummary(globalErr) {
            warnings.append(InterfaceText.quotaMessage(globalErr))
        }
        if let staleGroups = quota?["stale_groups"] as? [[String: Any]], !staleGroups.isEmpty {
            let names = staleGroups.compactMap { $0["name"] as? String }.filter { !$0.isEmpty }
            let sep = L10n.shared.isEnglish ? ", " : "、"
            let namesStr = names.isEmpty ? L10n.t("menu_panel.quota.partial_groups", fallback: "部分分组") : names.joined(separator: sep)
            warnings.append(L10n.t("menu_panel.quota.stale_groups", ["names": namesStr], fallback: "部分分组沿用上次记录：\(namesStr)"))
        }
        let contractWarn = QuotaPresentation.warningSummary(contract, excluding: warnings)
        if !contractWarn.isEmpty {
            warnings.append(contractWarn)
        }
        if !warnings.isEmpty {
            quotaWarningLabel.stringValue = warnings.joined(separator: L10n.shared.isEnglish ? "; " : "；")
            quotaWarningLabel.textColor = accessibleWarningColor()
            quotaWarningLabel.isHidden = false
        } else if let singleNotice = app.singleAccountRefreshNotices[id]?.trimmingCharacters(in: .whitespacesAndNewlines), !singleNotice.isEmpty {
            quotaWarningLabel.stringValue = singleNotice
            quotaWarningLabel.textColor = .secondaryLabelColor
            quotaWarningLabel.isHidden = false
        } else if showHistoricalQuotaFallbackNotice {
            quotaWarningLabel.stringValue = L10n.t("usage.env.historical_fallback_notice", fallback: "历史主机暂无实时配额，已切回本机配额。")
            quotaWarningLabel.textColor = .secondaryLabelColor
            quotaWarningLabel.isHidden = false
        } else {
            quotaWarningLabel.stringValue = ""
            quotaWarningLabel.isHidden = true
        }

        let offlinePrefix = !app.reachable ? L10n.t("menu_panel.quota.offline_prefix", fallback: "本机服务离线 · ") : ""
        if app.quotaRefreshing || (!id.isEmpty && app.refreshingAccountIds.contains(id)) {
            quotaFooterLabel.stringValue = L10n.t("menu_panel.quota.refreshing", fallback: "正在刷新配额…")
            quotaFooterLabel.textColor = .secondaryLabelColor
            quotaFooterLabel.toolTip = nil
            quotaFooterLabel.setAccessibilityHelp(nil)
        } else if standbyMode == "snapshot_cooldown_elapsed" {
            quotaFooterLabel.stringValue = offlinePrefix + L10n.t("accounts.standby.reset_passed", fallback: "已到重置时间 · 切换后更新")
            quotaFooterLabel.textColor = Design.blue
            quotaFooterLabel.toolTip = nil
            quotaFooterLabel.setAccessibilityHelp(L10n.t("accounts.standby.multi_device_hint"))
        } else if standbyMode == "snapshot_cooling", stamp > 0 {
            let date = Date(timeIntervalSince1970: stamp)
            let fmt = Calendar.current.isDateInToday(date) ? Self.timeFormatter : Self.dateTimeFormatter
            quotaFooterLabel.stringValue = offlinePrefix + L10n.t("accounts.standby.recorded_at", ["time": fmt.string(from: date)], fallback: "记录于 \(fmt.string(from: date)) · 切换后更新")
            quotaFooterLabel.textColor = .secondaryLabelColor
            quotaFooterLabel.toolTip = nil
            quotaFooterLabel.setAccessibilityHelp(L10n.t("accounts.standby.multi_device_hint"))
        } else if stamp > 0 {
            let date = Date(timeIntervalSince1970: stamp)
            let fmt = Calendar.current.isDateInToday(date) ? Self.timeFormatter : Self.dateTimeFormatter
            let isStale = freshness.isStaleOrDegraded
            let timeStr = fmt.string(from: date)
            let baseText: String
            if let sourceHost {
                let syncNote = L10n.t("accounts.ssh.quota_from_remote", ["host": sourceHost.cleanHostLabel], fallback: "同步自 \(sourceHost.cleanHostLabel)")
                baseText = "\(syncNote) · \(timeStr)"
            } else {
                baseText = L10n.t("common.updated_at", ["time": timeStr], fallback: "更新于 \(timeStr)")
            }
            quotaFooterLabel.stringValue = offlinePrefix + baseText + (isStale ? L10n.t("menu_panel.quota.stale_suffix", fallback: " · 待刷新") : "")
            quotaFooterLabel.textColor = isStale ? accessibleWarningColor() : .secondaryLabelColor
            quotaFooterLabel.toolTip = nil
            quotaFooterLabel.setAccessibilityHelp(nil)
        } else {
            quotaFooterLabel.stringValue = L10n.t("menu_panel.quota.no_record", fallback: "尚未取得配额记录")
            quotaFooterLabel.textColor = .secondaryLabelColor
            quotaFooterLabel.toolTip = nil
            quotaFooterLabel.setAccessibilityHelp(standbyMode == "snapshot_cooling" ? L10n.t("accounts.standby.multi_device_hint") : nil)
        }
    }

    // MARK: - Tab 2 Rendering (Accounts)

    func toggleAccountExpanded(_ id: String) {
        if expandedAccountIds.contains(id) {
            expandedAccountIds.remove(id)
        } else {
            expandedAccountIds.insert(id)
        }
        if Design.shouldAnimate(in: view) && app.isMenuPanelShown {
            performWithoutAnimation(updateSize: false) {
                syncAccountsTab()
            }
            updatePreferredPanelSize(animate: true)
        } else {
            performWithoutAnimation(updateSize: true, animateSize: false) {
                syncAccountsTab()
            }
        }
    }

    private func syncAccountsTab() {
        let accounts = app.fusedAccountsForDisplay()
        let hosts = app.canonicalRemoteHosts()
        let hasSshHosts = !hosts.isEmpty
        accountsCountLabel.stringValue = L10n.t("menu_panel.accounts.count", ["count": accounts.count], fallback: "\(accounts.count) 个账号")
        if hosts.isEmpty {
            accountsLocalOnlyNoteLabel.isHidden = true
            accountsLocalOnlyNoteLabel.stringValue = ""
            accountsLocalOnlyNoteLabel.toolTip = nil
        } else {
            accountsLocalOnlyNoteLabel.stringValue = L10n.t("menu_panel.accounts.local_only_note", fallback: "· 切换仅作用于本机")
            accountsLocalOnlyNoteLabel.toolTip = nil
            accountsLocalOnlyNoteLabel.isHidden = false
        }

        syncAccountsRemoteJumpSection(accounts: accounts, hosts: hosts)

        guard !accounts.isEmpty else {
            accountCardsById.removeAll()
            renderedAccountIds.removeAll()
            accountsCardsStack.arrangedSubviews.forEach {
                accountsCardsStack.removeArrangedSubview($0)
                $0.removeFromSuperview()
            }
            let emptyLbl = text(app.reachable ? L10n.t("menu_panel.accounts.empty", fallback: "暂无账号，请前往主界面添加") : L10n.t("menu_panel.accounts.waiting_list", fallback: "正在等待本机服务读取账号列表…"), size: 11.5, color: Design.secondary, wrap: true)
            let box = group([emptyLbl], inset: 12)
            accountsCardsStack.addArrangedSubview(box)
            fillWidth(box, in: accountsCardsStack)
            return
        }

        let resolvedActive = app.resolvedMenuAccount()
        let activeId = (resolvedActive?["id"] as? String) ?? app.activeAccountId
        if !hasInitializedExpandedAccount, !activeId.isEmpty {
            expandedAccountIds.insert(activeId)
            hasInitializedExpandedAccount = true
        }

        let ordered = accounts.enumerated().sorted { lhs, rhs in
            let l = (lhs.element["id"] as? String) == activeId
            let r = (rhs.element["id"] as? String) == activeId
            return l == r ? lhs.offset < rhs.offset : l
        }.map(\.element)

        let nextIds = ordered.compactMap { $0["id"] as? String }
        let validSet = Set(nextIds)
        accountCardsById = accountCardsById.filter { validSet.contains($0.key) }

        let liveEmail = app.statusValue.liveAccountEmail.trimmingCharacters(in: .whitespacesAndNewlines)
        let recommendedId = app.cachedRecommendedAccountId

        for item in ordered {
            guard let id = item["id"] as? String, !id.isEmpty else { continue }
            let card = accountCardsById[id] ?? {
                let c = MenuExpandableAccountCardView(accountId: id)
                c.onToggleExpand = { [weak self] accId in self?.toggleAccountExpanded(accId) }
                c.onSwitchAccount = { [weak self] accId in self?.app.switchAccountByIdFromMenu(accId) }
                c.onRefreshSingle = { [weak self] accId in self?.app.refreshSingleAccountQuota(id: accId) }
                accountCardsById[id] = c
                return c
            }()
            let email = item["email"] as? String ?? ""
            let isCurrent = (id == activeId)
            let isLiveVerified = isCurrent && !liveEmail.isEmpty && liveEmail.caseInsensitiveCompare(email) == .orderedSame
            let matchingHosts = SshEnvironmentResolver.matchingHosts(forAccount: item, hosts: hosts)
            card.apply(
                account: item,
                isCurrent: isCurrent,
                isLiveVerified: isLiveVerified,
                isRecommended: id == recommendedId,
                isExpanded: expandedAccountIds.contains(id),
                reachable: app.reachable,
                switchInFlight: app.accountSwitchInFlight,
                globalBusy: app.quotaRefreshing,
                singleBusy: app.refreshingAccountIds.contains(id),
                singleError: app.singleAccountRefreshErrors[id],
                singleNotice: app.singleAccountRefreshNotices[id],
                matchingSshHosts: matchingHosts,
                hasSshHosts: hasSshHosts,
                staleThresholdSeconds: app.quotaStaleThresholdSeconds
            )
        }

        if nextIds != renderedAccountIds {
            renderedAccountIds = nextIds
            accountsCardsStack.arrangedSubviews.forEach {
                accountsCardsStack.removeArrangedSubview($0)
                $0.removeFromSuperview()
            }
            for id in nextIds {
                guard let card = accountCardsById[id] else { continue }
                accountsCardsStack.addArrangedSubview(card)
                fillWidth(card, in: accountsCardsStack)
            }
        }
    }

    private func syncAccountsRemoteJumpSection(accounts: [[String: Any]], hosts: [CanonicalHostEnvironment]) {
        let unmanaged = SshEnvironmentResolver.unmanagedHosts(accounts: accounts, hosts: hosts)
        guard !unmanaged.isEmpty else {
            if !accountsRemoteSectionStack.isHidden || !renderedRemoteJumpVisibleIds.isEmpty || !renderedRemoteJumpFingerprint.isEmpty {
                accountsRemoteSectionStack.arrangedSubviews.forEach {
                    accountsRemoteSectionStack.removeArrangedSubview($0)
                    $0.removeFromSuperview()
                }
                remoteJumpRowsByEnvId.removeAll()
                renderedRemoteJumpVisibleIds.removeAll()
                renderedRemoteJumpHasMore = false
                renderedRemoteJumpFingerprint = ""
                accountsRemoteMoreHostsButton.update(extraHosts: [])
                accountsRemoteSectionStack.isHidden = true
            }
            return
        }

        let hostSpecs = unmanaged.map { host -> String in
            let contract = QuotaPresentation.contract(host.rawSession)
            let preferredGroup = contract.displayGroups.first(where: { $0.key.lowercased() == "gemini" })
                ?? contract.displayGroups.first
            let primaryPct = preferredGroup?.windows.compactMap(\.percentage).first
                ?? contract.displayGroups.flatMap(\.windows).compactMap(\.percentage).first
            return "\(host.environmentId)|\(host.cleanHostLabel)|\(host.state.rawValue)|\(host.email)|\(host.windowCount)|\(primaryPct.map(String.init) ?? "-")"
        }.joined(separator: ";")
        let nextFingerprint = "\(L10n.shared.currentLocale)#\(unmanaged.count)#\(hostSpecs)"
        if nextFingerprint == renderedRemoteJumpFingerprint && !accountsRemoteSectionStack.isHidden {
            return
        }
        renderedRemoteJumpFingerprint = nextFingerprint
        accountsRemoteSectionStack.isHidden = false

        let headerText = L10n.t("accounts.ssh.remote_section_title", fallback: "SSH 远端活跃账号（只读）")
        let countText = L10n.t("accounts.ssh.remote_section_count", ["count": unmanaged.count], fallback: "\(unmanaged.count) 台主机")
        let headerRow: NSView
        if let existingHeader = remoteJumpHeaderRow,
           let existingTitle = remoteJumpHeaderLabel,
           let existingCount = remoteJumpCountLabel {
            if existingTitle.stringValue != headerText { existingTitle.stringValue = headerText }
            if existingCount.stringValue != countText { existingCount.stringValue = countText }
            headerRow = existingHeader
        } else {
            let headerLabel = text(headerText, size: 11, weight: .semibold, color: Design.secondary)
            let countLabel = text(countText, size: 10.5, color: Design.secondary)
            let row = horizontal([headerLabel, flexibleSpace(), countLabel], spacing: 6)
            row.alignment = .centerY
            remoteJumpHeaderLabel = headerLabel
            remoteJumpCountLabel = countLabel
            remoteJumpHeaderRow = row
            headerRow = row
        }

        let visibleHosts = Array(unmanaged.prefix(2))
        let visibleIds = visibleHosts.map(\.environmentId)
        let validVisibleSet = Set(visibleIds)
        remoteJumpRowsByEnvId = remoteJumpRowsByEnvId.filter { validVisibleSet.contains($0.key) }

        for host in visibleHosts {
            let jumpRow = remoteJumpRowsByEnvId[host.environmentId] ?? {
                let row = MenuRemoteHostJumpRow(frame: .zero)
                row.onSelect = { [weak self] envId in
                    guard let self else { return }
                    self.app.setActiveNodeScope(.remote(environmentId: envId), userInitiated: true, notifyUI: false)
                    self.selectTab(1, persist: true)
                }
                remoteJumpRowsByEnvId[host.environmentId] = row
                return row
            }()
            jumpRow.apply(host: host)
        }

        let extraHosts = Array(unmanaged.dropFirst(2))
        accountsRemoteMoreHostsButton.update(extraHosts: extraHosts)
        let hasMore = !extraHosts.isEmpty
        if hasMore && remoteJumpMoreRow == nil {
            let moreRow = horizontal([flexibleSpace(), accountsRemoteMoreHostsButton], spacing: 6)
            moreRow.alignment = .centerY
            remoteJumpMoreRow = moreRow
        }

        let needsStructureRebuild = visibleIds != renderedRemoteJumpVisibleIds
            || hasMore != renderedRemoteJumpHasMore
            || accountsRemoteSectionStack.arrangedSubviews.isEmpty
        if needsStructureRebuild {
            renderedRemoteJumpVisibleIds = visibleIds
            renderedRemoteJumpHasMore = hasMore
            accountsRemoteSectionStack.arrangedSubviews.forEach {
                accountsRemoteSectionStack.removeArrangedSubview($0)
                $0.removeFromSuperview()
            }
            accountsRemoteSectionStack.addArrangedSubview(headerRow)
            fillWidth(headerRow, in: accountsRemoteSectionStack)
            for envId in visibleIds {
                guard let jumpRow = remoteJumpRowsByEnvId[envId] else { continue }
                accountsRemoteSectionStack.addArrangedSubview(jumpRow)
                fillWidth(jumpRow, in: accountsRemoteSectionStack)
            }
            if hasMore, let moreRow = remoteJumpMoreRow {
                accountsRemoteSectionStack.addArrangedSubview(moreRow)
                fillWidth(moreRow, in: accountsRemoteSectionStack)
            }
        }
    }

    // MARK: - Dynamic Content-Fitted Panel Height (Zero bottom blank gap, smooth micro-interpolation)

    func updatePreferredPanelSize(force: Bool = false, animate: Bool? = nil) {
        guard isViewLoaded else { return }
        let activeScreen = resolvedActiveScreen()
        let screenMax = (activeScreen?.visibleFrame.height ?? 820) - 48
        let tabFingerprint: String
        switch selectedTab {
        case 0:
            let visibleCount = showAllModels ? renderedModelNames.count : min(3, renderedModelNames.count)
            let visibleLabels = renderedModelNames.prefix(visibleCount).compactMap { modelRowViewsByName[$0]?.nameLabel.stringValue }.joined(separator: "|")
            tabFingerprint = "u:\(selectedEnvironmentId):\(contextPill.isHidden):\(usageScopeLabel.isHidden):\(usageScopeLabel.stringValue):\(modelsListStack.arrangedSubviews.count):\(renderedModelNames.count):\(showAllModels):\(visibleLabels):\(toggleModelsButton.isHidden):\(toggleModelsButton.title):\(usageFooterLabel.stringValue)"
        case 1:
            let selectedHost = app.selectedMenuQuotaHost()
            tabFingerprint = "q:\(contextPill.isHidden):\(selectedHost?.environmentId ?? "local"):\(selectedHost?.windowCount ?? 0):\(app.selectedContextKey):\(app.isMenuQuotaFollowingFocus):\(app.statusValue.remoteObservedVersion):\(quotaAccountNameLabel.stringValue):\(quotaTierBadge.isHidden):\(quotaStatusBadge.isHidden):\(quotaEmailLabel.stringValue):\(quotaGroupsContainer.isHidden):\(renderedQuotaTabKey):\(quotaEmptyButton.isHidden):\(quotaWarningLabel.isHidden):\(quotaWarningLabel.stringValue):\(quotaFooterLabel.stringValue)"
        default:
            let cardsSummary = renderedAccountIds.map { id -> String in
                guard let card = accountCardsById[id] else { return id }
                let statusTag = card.statusBadge.isHidden ? "" : card.statusBadge.title
                let sshTag = card.sshPresenceBadge.isHidden ? "" : "\(card.sshPresenceBadge.title):\(card.sshPresenceBadge.state.rawValue)"
                guard expandedAccountIds.contains(id) else { return "\(id):0:\(statusTag):\(sshTag)" }
                let rowsKey = card.quotaRowViews.map(\.lastAppliedKey).joined(separator: ",")
                return "\(id):1:\(statusTag):\(sshTag):\(card.quotaRowsStack.arrangedSubviews.count):\(rowsKey):\(card.warningLabel.isHidden ? "" : card.warningLabel.stringValue):\(card.timestampLabel.isHidden ? "" : card.timestampLabel.stringValue)"
            }.joined(separator: "|")
            let remoteJumpKey = accountsRemoteSectionStack.isHidden ? "hidden" : "\(accountsRemoteSectionStack.arrangedSubviews.count)"
            tabFingerprint = "a:\(accountsCardsStack.arrangedSubviews.count):\(app.reachable):\(accountsLocalOnlyNoteLabel.isHidden):\(accountsLocalOnlyNoteLabel.stringValue):\(remoteJumpKey):\(cardsSummary)"
        }
        let measureFingerprint = "\(selectedTab):\(L10n.shared.currentLocale):\(Int(screenMax)):\(debugPortBannerBox.isHidden):\(tabFingerprint)"
        if !force && measureFingerprint == lastMeasuredContentFingerprint {
            let sizeInSync: Bool
            if let panel = app.menuPanel, app.isMenuPanelShown {
                let referenceSize = app.menuPanelTargetSize ?? panel.frame.size
                sizeInSync = abs(referenceSize.height - measuredPanelSize.height) <= 0.5 && abs(referenceSize.width - measuredPanelSize.width) <= 0.5
            } else {
                sizeInSync = abs(view.frame.height - measuredPanelSize.height) <= 0.5 && abs(view.frame.width - measuredPanelSize.width) <= 0.5
            }
            if sizeInSync {
                return
            }
        }
        lastMeasuredContentFingerprint = measureFingerprint

        let contentWidth = Self.panelWidth - 28
        documentContainer.frame.size.width = Self.panelWidth
        let activeRoot: NSView = selectedTab == 0 ? usageRoot : (selectedTab == 1 ? quotaRoot : accountsRoot)
        if !debugPortBannerBox.isHidden {
            debugPortBodyLabel.preferredMaxLayoutWidth = max(1, contentWidth - 20)
            debugPortBannerBox.frame.size.width = contentWidth
            debugPortBannerBox.layoutSubtreeIfNeeded()
        }
        activeRoot.frame.size.width = contentWidth
        activeRoot.layoutSubtreeIfNeeded()
        documentContainer.layoutSubtreeIfNeeded()
        let bannerHeight: CGFloat = debugPortBannerBox.isHidden ? 0 : (ceil(debugPortBannerBox.fittingSize.height) + 8)
        let contentHeight = ceil(activeRoot.fittingSize.height) + bannerHeight + 20 // 10pt top + 10pt bottom inset
        let chromeHeight: CGFloat = 86 + 42 // header (86pt) + footer (42pt)
        let rawTotal = chromeHeight + contentHeight
        let targetHeight = min(max(300, rawTotal), min(686, screenMax))
        let newSize = NSSize(width: Self.panelWidth, height: targetHeight)
        measuredPanelSize = newSize
        let hostedInFloatingPanel = (app.menuPanel != nil && view.window === app.menuPanel)
        if hostedInFloatingPanel {
            if preferredContentSize != .zero {
                preferredContentSize = .zero
            }
        } else {
            preferredContentSize = newSize
        }
        let shouldAnimate = (animate ?? true) && Design.shouldAnimate(in: view) && app.isMenuPanelShown
        var sizeDidChange = false
        if let panel = app.menuPanel, app.isMenuPanelShown {
            let currentMatches = abs(panel.frame.height - newSize.height) <= 0.5 && abs(panel.frame.width - newSize.width) <= 0.5
            let targetMatches = app.menuPanelTargetSize.map {
                abs($0.height - newSize.height) <= 0.5 && abs($0.width - newSize.width) <= 0.5
            } ?? currentMatches
            if !currentMatches || !targetMatches {
                sizeDidChange = true
                app.resizeMenuPanel(to: newSize, animate: shouldAnimate)
            }
        } else if abs(view.frame.height - newSize.height) > 0.5 || abs(view.frame.width - newSize.width) > 0.5 {
            sizeDidChange = true
            view.frame.size = newSize
        }
        if sizeDidChange || view.needsLayout {
            view.layoutSubtreeIfNeeded()
        }
    }
}

