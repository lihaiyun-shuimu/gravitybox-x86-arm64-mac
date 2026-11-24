import Cocoa
import ServiceManagement

final class PreferencesController: NSObject, NSTextFieldDelegate {
    static let refreshIntervals = [0, 5, 10, 15, 30, 60]

    unowned let app: Assistant
    var view: NSView!
    let languagePopup = DesignPopUpButton(frame: .zero, pullsDown: false)
    private weak var languageSubtitleField: NSTextField?
    let hudSwitch = DesignSwitch()
    let proxyModePopup = DesignPopUpButton(frame: .zero, pullsDown: false)
    let proxySubtitleLabel = text("", size: 11, color: Design.secondary, wrap: true)
    var proxyRelaunchBtn: NSButton!
    let proxyManualContainer = NSView()
    let proxyManualField = NSTextField()
    var proxyManualApplyBtn: NSButton!
    private weak var proxyTitleField: NSTextField?
    private var editingManualProxyMode = false
    private var proxyManualValidationError: String?
    private var renderedProxyPopupLocale = ""
    private let proxyInspectQueue = DispatchQueue(label: "local.gravitybox.proxy-inspect", qos: .utility)
    private static let proxyProbeThrottleInterval: TimeInterval = 5.0
    private var proxyInspectGeneration: UInt64 = 0
    private var proxyInspectInFlight = false
    private var lastProxyInspectTriggeredAt: Date = .distantPast
    private var lastProxyResolution: (mode: AntigravityProxyMode, manualUrl: String, resolution: ProxyResolution, sampledAt: Date)?
    private var lastInspectedProxyState: (resolution: ProxyResolution, state: RunningAntigravityProxyState)?
    let pricingSyncSwitch = DesignSwitch()
    var pricingSyncCheckBtn: InlineRefreshButton!
    let refresh = DesignPopUpButton(frame: .zero, pullsDown: false)
    let login = DesignSwitch()
    let launchAntigravityOnStartSwitch = DesignSwitch()
    let storageBadge = pillBadge("", color: Design.blue)
    static var defaultStorageSubtitle: String {
        L10n.t("settings.storage.default_subtitle", fallback: "一键释放运行缓存与超期日志，登录态与对话完好保留")
    }
    let storageSubtitleLabel = text(PreferencesController.defaultStorageSubtitle, size: 11, color: Design.secondary, wrap: true)
    var manageCacheBtn: NSButton!
    var pricingSheet: PricingSyncSheetController?
    private var lastStorageScanAt: Date = .distantPast
    private var storageScanInFlight = false

    init(app: Assistant) {
        self.app = app
        super.init()
        rebuildLanguagePopup()
        languagePopup.isEnabled = app.statusValue.mode != "unsupported"
        languagePopup.target = self
        languagePopup.action = #selector(languageChanged)
        languagePopup.setAccessibilityLabel(L10n.t("settings.language.title", fallback: "显示语言"))
        languagePopup.translatesAutoresizingMaskIntoConstraints = false

        hudSwitch.controlSize = .small
        hudSwitch.state = app.effectiveHudEnabled() ? .on : .off
        hudSwitch.isEnabled = app.reachable && app.statusValue.mode != "unsupported"
        hudSwitch.target = self; hudSwitch.action = #selector(toggleHud); hudSwitch.setAccessibilityLabel(L10n.t("settings.hud.title", fallback: "对话状态栏"))

        login.controlSize = .small
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        login.target = self; login.action = #selector(toggleLogin); login.setAccessibilityLabel(L10n.t("settings.login.title", fallback: "登录时启动"))

        launchAntigravityOnStartSwitch.controlSize = .small
        launchAntigravityOnStartSwitch.state = app.configuration.value.launchAntigravityOnStart ? .on : .off
        launchAntigravityOnStartSwitch.target = self; launchAntigravityOnStartSwitch.action = #selector(toggleLaunchAntigravityOnStart)
        launchAntigravityOnStartSwitch.setAccessibilityLabel(L10n.t("settings.launch_antigravity.title", fallback: "启动时自动打开 Antigravity"))

        refresh.addItems(withTitles: [
            L10n.t("settings.refresh.manual", fallback: "手动刷新"),
            L10n.t("settings.refresh.5m", fallback: "每 5 分钟"),
            L10n.t("settings.refresh.10m", fallback: "每 10 分钟"),
            L10n.t("settings.refresh.15m", fallback: "每 15 分钟"),
            L10n.t("settings.refresh.30m", fallback: "每 30 分钟"),
            L10n.t("settings.refresh.60m", fallback: "每 60 分钟")
        ])
        refresh.selectItem(at: Self.refreshIntervals.firstIndex(of: app.configuration.value.quotaRefreshMinutes) ?? 0)
        refresh.target = self; refresh.action = #selector(refreshChanged); refresh.setAccessibilityLabel(L10n.t("settings.refresh.title", fallback: "配额刷新间隔"))
        refresh.translatesAutoresizingMaskIntoConstraints = false

        pricingSyncSwitch.controlSize = .small
        pricingSyncSwitch.state = app.configuration.value.autoPricingSyncEnabled ? .on : .off
        pricingSyncSwitch.target = self; pricingSyncSwitch.action = #selector(togglePricingSync)
        pricingSyncSwitch.setAccessibilityLabel(L10n.t("settings.pricing_sync.title", fallback: "自动更新价格基准"))
        pricingSyncCheckBtn = InlineRefreshButton(L10n.t("settings.pricing_sync.check_now", fallback: "立即检查"), width: 104, target: self, action: #selector(checkPricingSync))
        pricingSyncCheckBtn.setAccessibilityLabel(L10n.t("settings.pricing_sync.check_a11y", fallback: "检查价格更新"))
        let pricingControlGroup = horizontal([pricingSyncCheckBtn, pricingSyncSwitch], spacing: 8)
        pricingControlGroup.alignment = .centerY

        let languageRow = settingRow(icon: "globe", tint: .systemGreen, title: L10n.t("settings.language.title", fallback: "显示语言"), subtitle: languageSubtitleText(), control: languagePopup)
        if let rowStack = languageRow as? NSStackView,
           let captionsStack = rowStack.arrangedSubviews.dropFirst().first as? NSStackView,
           let subField = captionsStack.arrangedSubviews.dropFirst().first as? NSTextField {
            languageSubtitleField = subField
        }

        rebuildProxyModePopup()
        proxyModePopup.target = self
        proxyModePopup.action = #selector(proxyModeChanged)
        proxyModePopup.setAccessibilityLabel(L10n.t("settings.proxy.title", fallback: "代理转发（免 TUN）"))
        proxyModePopup.translatesAutoresizingMaskIntoConstraints = false

        proxyRelaunchBtn = button(L10n.t("settings.proxy.relaunch_btn", fallback: "安全重启生效"), target: self, action: #selector(relaunchAntigravityForProxy))
        proxyRelaunchBtn.bezelColor = Design.blue
        proxyRelaunchBtn.isHidden = true
        let proxyControlGroup = horizontal([proxyRelaunchBtn, proxyModePopup], spacing: 8)
        proxyControlGroup.alignment = .centerY
        proxyControlGroup.detachesHiddenViews = true

        let proxyRow = settingRow(
            icon: "network",
            tint: Design.blue,
            title: L10n.t("settings.proxy.title", fallback: "代理转发（免 TUN）"),
            subtitle: "",
            control: proxyControlGroup
        )
        proxySubtitleLabel.maximumNumberOfLines = 0
        proxySubtitleLabel.lineBreakMode = .byWordWrapping
        proxySubtitleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        if let rowStack = proxyRow as? NSStackView,
           let captionsStack = rowStack.arrangedSubviews.dropFirst().first as? NSStackView {
            proxyTitleField = captionsStack.arrangedSubviews.first as? NSTextField
            captionsStack.addArrangedSubview(proxySubtitleLabel)
        }

        proxyManualField.isEditable = true
        proxyManualField.isSelectable = true
        proxyManualField.font = .systemFont(ofSize: 12)
        proxyManualField.placeholderString = "http://127.0.0.1:7890"
        proxyManualField.stringValue = app.configuration.value.antigravityProxyManualUrl
        proxyManualField.target = self
        proxyManualField.action = #selector(applyManualProxy)
        proxyManualField.delegate = self
        proxyManualField.setAccessibilityLabel(L10n.t("settings.proxy.manual_url_a11y", fallback: "手动代理地址"))
        proxyManualField.setContentHuggingPriority(.defaultLow, for: .horizontal)
        proxyManualField.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        proxyManualApplyBtn = button(L10n.t("settings.proxy.apply_btn", fallback: "应用"), target: self, action: #selector(applyManualProxy))
        proxyManualApplyBtn.setContentHuggingPriority(.required, for: .horizontal)
        proxyManualApplyBtn.setContentCompressionResistancePriority(.required, for: .horizontal)

        let manualRow = horizontal([proxyManualField, proxyManualApplyBtn], spacing: 8)
        manualRow.alignment = .centerY
        proxyManualContainer.addSubview(manualRow)
        manualRow.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            manualRow.leadingAnchor.constraint(equalTo: proxyManualContainer.leadingAnchor, constant: 39),
            manualRow.trailingAnchor.constraint(equalTo: proxyManualContainer.trailingAnchor),
            manualRow.topAnchor.constraint(equalTo: proxyManualContainer.topAnchor),
            manualRow.bottomAnchor.constraint(equalTo: proxyManualContainer.bottomAnchor)
        ])

        let proxySection = vertical([proxyRow, proxyManualContainer], spacing: 8)
        proxySection.detachesHiddenViews = true
        fillWidth(proxyRow, in: proxySection)
        fillWidth(proxyManualContainer, in: proxySection)

        let enhanceGroup = vertical([
            languageRow,
            divider(),
            settingRow(icon: "dock.rectangle", tint: .systemIndigo, title: L10n.t("settings.hud.title", fallback: "对话状态栏"), subtitle: L10n.t("settings.hud.subtitle", fallback: "在 Antigravity 输入框下方显示轮次、Token 与上下文"), control: hudSwitch),
            divider(),
            proxySection
        ], spacing: 12)
        for child in enhanceGroup.arrangedSubviews { fillWidth(child, in: enhanceGroup) }

        let dataSyncGroup = vertical([
            settingRow(icon: "timer", tint: Design.blue, title: L10n.t("settings.refresh.title", fallback: "配额刷新间隔"), subtitle: L10n.t("settings.refresh.subtitle", fallback: "定时刷新本机与 SSH 在线账号配额；备用账号令牌过期后需切换更新"), control: refresh),
            divider(),
            settingRow(icon: "tag", tint: Design.blue, title: L10n.t("settings.pricing_sync.title", fallback: "自动更新价格基准"), subtitle: L10n.t("settings.pricing_sync.subtitle", fallback: "自动同步公开模型费率，每 24 小时检查一次"), control: pricingControlGroup)
        ], spacing: 12)
        for child in dataSyncGroup.arrangedSubviews { fillWidth(child, in: dataSyncGroup) }

        storageBadge.isHidden = true
        storageBadge.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        manageCacheBtn = button(L10n.t("settings.storage.manage_btn", fallback: "管理存储…"), target: self, action: #selector(showMaintenanceSheet))
        let storageRow = settingRow(
            icon: "internaldrive",
            tint: .systemOrange,
            title: L10n.t("settings.storage.title", fallback: "存储与维护"),
            badge: storageBadge,
            subtitle: "",
            control: manageCacheBtn
        )
        storageSubtitleLabel.maximumNumberOfLines = 1
        storageSubtitleLabel.lineBreakMode = .byTruncatingTail
        storageSubtitleLabel.toolTip = nil
        if let rowStack = storageRow as? NSStackView,
           let captionsStack = rowStack.arrangedSubviews.dropFirst().first as? NSStackView {
            captionsStack.addArrangedSubview(storageSubtitleLabel)
        }
        let systemAndStorageGroup = vertical([
            settingRow(icon: "power", tint: .systemGray, title: L10n.t("settings.login.title", fallback: "登录时启动"), subtitle: L10n.t("settings.login.subtitle", fallback: "登录 macOS 时自动在菜单栏驻留"), control: login),
            divider(),
            settingRow(icon: "macwindow.badge.plus", tint: .systemTeal, title: L10n.t("settings.launch_antigravity.title", fallback: "启动时自动打开 Antigravity"), subtitle: L10n.t("settings.launch_antigravity.subtitle", fallback: "打开 GravityBox 时静默驻留菜单栏，并自动拉起带调试端口的 Antigravity"), control: launchAntigravityOnStartSwitch),
            divider(),
            storageRow
        ], spacing: 12)
        for child in systemAndStorageGroup.arrangedSubviews { fillWidth(child, in: systemAndStorageGroup) }

        let enhanceCard = group([enhanceGroup], inset: 16)
        enhanceCard.cornerRadius = Design.Radius.card
        let dataSyncCard = group([dataSyncGroup], inset: 16)
        dataSyncCard.cornerRadius = Design.Radius.card
        let systemAndStorageCard = group([systemAndStorageGroup], inset: 16)
        systemAndStorageCard.cornerRadius = Design.Radius.card

        func sectionGroup(_ title: String, card: NSView) -> NSStackView {
            let hdr = text(title, size: 11.5, weight: .semibold, color: Design.secondary)
            let grp = vertical([hdr, card], spacing: 6)
            fillWidth(hdr, in: grp)
            fillWidth(card, in: grp)
            return grp
        }

        let root = pageStack(title: L10n.t("settings.title", fallback: "设置"))
        root.spacing = 14
        root.addArrangedSubview(sectionGroup(L10n.t("settings.section.enhance", fallback: "Antigravity 增强"), card: enhanceCard))
        root.addArrangedSubview(sectionGroup(L10n.t("settings.section.quota_pricing", fallback: "配额与计价"), card: dataSyncCard))
        root.addArrangedSubview(sectionGroup(L10n.t("settings.section.system_storage", fallback: "系统与存储"), card: systemAndStorageCard))
        view = scrollPage(root); Design.applyControls(view)
        for popup in [languagePopup, proxyModePopup, refresh] {
            (popup.cell as? DesignPopUpCell)?.fitsSelectedTitleOnly = true
            Design.syncPopUpWidth(popup)
        }
        (proxyManualField.cell as? NSTextFieldCell)?.sendsActionOnEndEditing = false
        refreshProxyRowState()
    }

    var maintenanceSheet: MaintenanceSheetController?

    @objc func showMaintenanceSheet() {
        guard let window = app.window else { return }
        if let active = window.activeSheetWindow, active !== maintenanceSheet?.sheet { return }
        if maintenanceSheet == nil {
            maintenanceSheet = MaintenanceSheetController(app: app)
        }
        maintenanceSheet?.show(in: window) { [weak self, weak app = self.app] in
            self?.maintenanceSheet = nil
            if let app, app.pendingLocalizedRebuildAfterMaintenance, self?.pricingSheet == nil, app.cachePage?.busy != true {
                app.pendingLocalizedRebuildAfterMaintenance = false
                app.cachePage = nil
                app.preferencesController = nil
                if app.currentPage == 3 {
                    app.navigate(3, force: true)
                }
                return
            }
            app?.preferencesController?.refreshStorageRowState(force: true)
        }
    }

    func applyStorageScanPayload(_ value: [String: Any]) {
        let now = Date()
        lastStorageScanAt = now
        app.lastMaintenanceScanPayload = value
        app.lastMaintenanceScanAt = now
        let buckets = value["buckets"] as? [String: Any]
        let rtBucket = buckets?["runtimeCache"] as? [String: Any] ?? [:]
        let histBucket = buckets?["historyLogs"] as? [String: Any] ?? [:]
        let safeBytes = Int64(intVal(rtBucket, "clearableBytes", fallback: intVal(value, "safeBytes")))
        let statefulBytes = Int64(intVal(histBucket, "clearableBytes", fallback: intVal(value, "statefulBytes")))
        if safeBytes >= 10 * 1024 * 1024 {
            let formatted = ByteCountFormatter.string(fromByteCount: safeBytes, countStyle: .file)
            storageBadge.title = L10n.t("settings.storage.reclaimable", ["size": formatted], fallback: "可释放 \(formatted)")
            storageBadge.tint = Design.blue
            storageBadge.isHidden = false
        } else if statefulBytes >= 50 * 1024 * 1024 {
            let formatted = ByteCountFormatter.string(fromByteCount: statefulBytes, countStyle: .file)
            storageBadge.title = L10n.t("settings.storage.slimmable", ["size": formatted], fallback: "可瘦身 \(formatted)")
            storageBadge.tint = Design.secondary
            storageBadge.isHidden = false
        } else if safeBytes + statefulBytes > 0 {
            storageBadge.title = L10n.t("settings.storage.healthy", fallback: "状态良好")
            storageBadge.tint = Design.secondary
            storageBadge.isHidden = false
        } else {
            storageBadge.isHidden = true
        }
        if safeBytes > 0 && statefulBytes > 0 {
            let safeStr = ByteCountFormatter.string(fromByteCount: safeBytes, countStyle: .file)
            let statefulStr = ByteCountFormatter.string(fromByteCount: statefulBytes, countStyle: .file)
            storageSubtitleLabel.stringValue = L10n.t("settings.storage.detail_subtitle", ["safe": safeStr, "stateful": statefulStr], fallback: "运行缓存 \(safeStr)，另有 \(statefulStr) 后台日志可按需释放")
        } else {
            storageSubtitleLabel.stringValue = Self.defaultStorageSubtitle
        }
        storageSubtitleLabel.toolTip = nil
    }

    func refreshStorageRowState(force: Bool = false) {
        guard app.reachable else { return }
        guard !storageScanInFlight else { return }
        if !force && Date().timeIntervalSince(lastStorageScanAt) < 60.0 {
            return
        }
        storageScanInFlight = true
        let retentionDays = app.cachePage?.selectedRetentionDays ?? 7
        app.bridge.send(["command": "maintenance_scan", "retentionDays": retentionDays]) { [weak self] result in
            guard let self else { return }
            self.storageScanInFlight = false
            if case .success(let value) = result {
                self.applyStorageScanPayload(value)
            }
        }
    }

    private func languageSubtitleText() -> String {
        L10n.t("settings.language.subtitle", fallback: "同时决定 GravityBox 与 Antigravity 的界面语言，不改动官方应用")
    }

    private var renderedLanguagePopupKey = ""

    private func rebuildLanguagePopup() {
        guard (languagePopup.cell as? DesignPopUpCell)?.isTrackingMenu != true else { return }
        let configured = app.effectiveConfiguredLanguage()
        let localesKey = ([L10n.shared.currentLocale] + L10n.shared.supportedLocales.map(\.code)).joined(separator: "|")
        if renderedLanguagePopupKey != localesKey {
            renderedLanguagePopupKey = localesKey
            languagePopup.removeAllItems()
            let systemTitle = L10n.t("language.system", fallback: "跟随系统")
            languagePopup.addItem(withTitle: systemTitle)
            languagePopup.lastItem?.representedObject = "system"
            languagePopup.menu?.addItem(.separator())
            for meta in L10n.shared.supportedLocales {
                languagePopup.addItem(withTitle: meta.nativeName)
                languagePopup.lastItem?.representedObject = meta.code
            }
            if languagePopup.cell is DesignPopUpCell {
                Design.syncPopUpWidth(languagePopup)
            } else {
                languagePopup.invalidateIntrinsicContentSize()
            }
        }
        if let idx = languagePopup.itemArray.firstIndex(where: { ($0.representedObject as? String) == configured }) {
            if languagePopup.indexOfSelectedItem != idx { languagePopup.selectItem(at: idx) }
        } else if let idx = languagePopup.itemArray.firstIndex(where: { ($0.representedObject as? String) == L10n.shared.currentLocale }) {
            if languagePopup.indexOfSelectedItem != idx { languagePopup.selectItem(at: idx) }
        } else if languagePopup.indexOfSelectedItem != 0 {
            languagePopup.selectItem(at: 0)
        }
        if languagePopup.cell is DesignPopUpCell {
            Design.syncPopUpWidth(languagePopup)
        } else {
            languagePopup.invalidateIntrinsicContentSize()
        }
    }

    private func rebuildProxyModePopup() {
        guard (proxyModePopup.cell as? DesignPopUpCell)?.isTrackingMenu != true else { return }
        let localeKey = L10n.shared.currentLocale
        let titles: [(AntigravityProxyMode, String)] = [
            (.off, L10n.t("settings.proxy.mode.off", fallback: "关闭")),
            (.system, L10n.t("settings.proxy.mode.system", fallback: "跟随系统代理")),
            (.manual, L10n.t("settings.proxy.mode.manual", fallback: "手动指定"))
        ]
        if proxyModePopup.numberOfItems == 0 {
            renderedProxyPopupLocale = localeKey
            for (mode, title) in titles {
                proxyModePopup.addItem(withTitle: title)
                proxyModePopup.lastItem?.representedObject = mode.rawValue
            }
            if proxyModePopup.cell is DesignPopUpCell {
                Design.syncPopUpWidth(proxyModePopup)
            } else {
                proxyModePopup.invalidateIntrinsicContentSize()
            }
        } else if renderedProxyPopupLocale != localeKey {
            renderedProxyPopupLocale = localeKey
            for (idx, (_, title)) in titles.enumerated() where idx < proxyModePopup.numberOfItems {
                proxyModePopup.item(at: idx)?.title = title
            }
            if proxyModePopup.cell is DesignPopUpCell {
                Design.syncPopUpWidth(proxyModePopup)
            } else {
                proxyModePopup.invalidateIntrinsicContentSize()
            }
        }
        let displayedMode: AntigravityProxyMode = editingManualProxyMode ? .manual : app.effectiveProxyMode()
        if let idx = proxyModePopup.itemArray.firstIndex(where: { ($0.representedObject as? String) == displayedMode.rawValue }),
           proxyModePopup.indexOfSelectedItem != idx {
            proxyModePopup.selectItem(at: idx)
        }
        if proxyModePopup.cell is DesignPopUpCell {
            Design.syncPopUpWidth(proxyModePopup)
        } else {
            proxyModePopup.invalidateIntrinsicContentSize()
        }
    }

    func refreshProxyRowState(force: Bool = true) {
        proxyTitleField?.stringValue = L10n.t("settings.proxy.title", fallback: "代理转发（免 TUN）")
        proxyModePopup.setAccessibilityLabel(L10n.t("settings.proxy.title", fallback: "代理转发（免 TUN）"))
        proxyManualField.setAccessibilityLabel(L10n.t("settings.proxy.manual_url_a11y", fallback: "手动代理地址"))
        proxyManualApplyBtn?.title = L10n.t("settings.proxy.apply_btn", fallback: "应用")
        proxyManualApplyBtn?.setAccessibilityLabel(L10n.t("settings.proxy.apply_btn", fallback: "应用"))
        proxyManualApplyBtn?.invalidateIntrinsicContentSize()
        proxyRelaunchBtn?.title = L10n.t("settings.proxy.relaunch_btn", fallback: "安全重启生效")
        proxyRelaunchBtn?.setAccessibilityLabel(L10n.t("settings.proxy.relaunch_btn", fallback: "安全重启生效"))
        proxyRelaunchBtn?.invalidateIntrinsicContentSize()

        rebuildProxyModePopup()
        let displayedMode: AntigravityProxyMode = editingManualProxyMode ? .manual : app.effectiveProxyMode()
        proxyManualContainer.isHidden = (displayedMode != .manual)
        if !editingManualProxyMode && proxyManualField.currentEditor() == nil {
            let savedUrl = app.configuration.value.antigravityProxyManualUrl
            if proxyManualField.stringValue != savedUrl {
                proxyManualField.stringValue = savedUrl
            }
        }

        if editingManualProxyMode {
            if let err = proxyManualValidationError, !err.isEmpty {
                proxyInspectGeneration &+= 1
                proxyInspectInFlight = false
                lastProxyInspectTriggeredAt = .distantPast
                lastInspectedProxyState = nil
                proxySubtitleLabel.stringValue = err
                proxySubtitleLabel.textColor = .systemRed
                proxyRelaunchBtn.isHidden = true
                return
            }
            if app.effectiveProxyMode() != .manual {
                proxyInspectGeneration &+= 1
                proxyInspectInFlight = false
                lastProxyInspectTriggeredAt = .distantPast
                lastInspectedProxyState = nil
                proxySubtitleLabel.stringValue = L10n.t(
                    "settings.proxy.status.manual_prompt",
                    fallback: "请输入 HTTP/HTTPS 代理地址（如 http://127.0.0.1:7890），点击「应用」生效"
                )
                proxySubtitleLabel.textColor = Design.secondary
                proxyRelaunchBtn.isHidden = true
                return
            }
        }

        let currentMode = app.effectiveProxyMode()
        let currentManualUrl = app.configuration.value.antigravityProxyManualUrl
        let now = Date()
        let hasTestOverride = SystemProxyResolver.testSystemProxySettingsOverride != nil
            || SystemProxyResolver.testRunningProxyStateOverride != nil
        let shouldBypassThrottle = force || hasTestOverride

        let resolution: ProxyResolution
        if !shouldBypassThrottle,
           let cached = lastProxyResolution,
           cached.mode == currentMode,
           cached.manualUrl == currentManualUrl,
           now.timeIntervalSince(cached.sampledAt) < Self.proxyProbeThrottleInterval {
            resolution = cached.resolution
        } else {
            let resolved = app.currentProxyResolution()
            lastProxyResolution = (mode: currentMode, manualUrl: currentManualUrl, resolution: resolved, sampledAt: now)
            resolution = resolved
        }

        switch resolution {
        case .disabled:
            proxyInspectGeneration &+= 1
            proxyInspectInFlight = false
            lastProxyInspectTriggeredAt = .distantPast
            lastInspectedProxyState = nil
            proxySubtitleLabel.stringValue = L10n.t(
                "settings.proxy.status.disabled",
                fallback: "为 Antigravity 与 GravityBox 共享 HTTP/HTTPS 代理，无需开启 TUN 模式"
            )
            proxySubtitleLabel.textColor = Design.secondary
            proxyRelaunchBtn.isHidden = true
        case .active(_, _, _, let displayUrl):
            if SystemProxyResolver.testRunningProxyStateOverride != nil {
                proxyInspectGeneration &+= 1
                proxyInspectInFlight = false
                let runningState = app.currentRunningProxyState(resolution: resolution)
                lastInspectedProxyState = (resolution: resolution, state: runningState)
                lastProxyInspectTriggeredAt = now
                applyRunningProxyState(runningState, displayUrl: displayUrl)
                return
            }
            if let cached = lastInspectedProxyState, cached.resolution == resolution {
                applyRunningProxyState(cached.state, displayUrl: displayUrl)
                if !shouldBypassThrottle, now.timeIntervalSince(lastProxyInspectTriggeredAt) < Self.proxyProbeThrottleInterval {
                    return
                }
            } else {
                applyRunningProxyState(.notRunning, displayUrl: displayUrl)
                if !shouldBypassThrottle,
                   proxyInspectInFlight,
                   now.timeIntervalSince(lastProxyInspectTriggeredAt) < Self.proxyProbeThrottleInterval {
                    return
                }
            }
            proxyInspectGeneration &+= 1
            proxyInspectInFlight = true
            lastProxyInspectTriggeredAt = now
            let targetGeneration = proxyInspectGeneration
            let expectedResolution = resolution
            let expectedMode = currentMode
            let expectedManualUrl = currentManualUrl
            let appPath = app.targetApplication.path
            proxyInspectQueue.async { [weak self] in
                let runningState = SystemProxyResolver.inspectRunningAntigravity(
                    expected: expectedResolution,
                    appPath: appPath
                )
                DispatchQueue.main.async { [weak self] in
                    guard let self else { return }
                    if self.proxyInspectGeneration == targetGeneration {
                        self.proxyInspectInFlight = false
                    }
                    guard self.proxyInspectGeneration == targetGeneration,
                          !self.editingManualProxyMode,
                          self.app.effectiveProxyMode() == expectedMode,
                          self.app.configuration.value.antigravityProxyManualUrl == expectedManualUrl,
                          (self.lastProxyResolution?.resolution ?? expectedResolution) == expectedResolution else {
                        return
                    }
                    self.lastInspectedProxyState = (resolution: expectedResolution, state: runningState)
                    self.applyRunningProxyState(runningState, displayUrl: displayUrl)
                }
            }
        case .systemNotConfigured:
            proxyInspectGeneration &+= 1
            proxyInspectInFlight = false
            lastProxyInspectTriggeredAt = .distantPast
            lastInspectedProxyState = nil
            proxySubtitleLabel.stringValue = L10n.t(
                "settings.proxy.status.system_not_configured",
                fallback: "当前未检测到 macOS HTTP/HTTPS 系统代理，请先在代理工具开启系统代理或改用「手动指定」"
            )
            proxySubtitleLabel.textColor = accessibleWarningColor()
            proxyRelaunchBtn.isHidden = true
        case .systemUnsupported(.pac):
            proxyInspectGeneration &+= 1
            proxyInspectInFlight = false
            lastProxyInspectTriggeredAt = .distantPast
            lastInspectedProxyState = nil
            proxySubtitleLabel.stringValue = L10n.t(
                "settings.proxy.status.system_pac",
                fallback: "当前系统代理为 PAC 模式，暂不支持直接解析；建议改用「手动指定」填入本地 HTTP 端口"
            )
            proxySubtitleLabel.textColor = accessibleWarningColor()
            proxyRelaunchBtn.isHidden = true
        case .systemUnsupported(.socksOnly):
            proxyInspectGeneration &+= 1
            proxyInspectInFlight = false
            lastProxyInspectTriggeredAt = .distantPast
            lastInspectedProxyState = nil
            proxySubtitleLabel.stringValue = L10n.t(
                "settings.proxy.status.system_socks_only",
                fallback: "当前系统代理仅开启了 SOCKS5，建议开启代理工具的 HTTP 端口或改用「手动指定」"
            )
            proxySubtitleLabel.textColor = accessibleWarningColor()
            proxyRelaunchBtn.isHidden = true
        case .invalidManual(let message):
            proxyInspectGeneration &+= 1
            proxyInspectInFlight = false
            lastProxyInspectTriggeredAt = .distantPast
            lastInspectedProxyState = nil
            proxySubtitleLabel.stringValue = message.isEmpty
                ? L10n.t("settings.proxy.status.invalid_manual", fallback: "代理地址格式无效，请输入 http://host:port 或 https://host:port")
                : message
            proxySubtitleLabel.textColor = .systemRed
            proxyRelaunchBtn.isHidden = true
        }
    }

    private func applyRunningProxyState(_ runningState: RunningAntigravityProxyState, displayUrl: String) {
        switch runningState {
        case .notRunning:
            proxySubtitleLabel.stringValue = L10n.t(
                "settings.proxy.status.not_running",
                ["url": displayUrl],
                fallback: "目标代理：\(displayUrl) · 下次通过 GravityBox 启动生效"
            )
            proxySubtitleLabel.textColor = Design.secondary
            proxyRelaunchBtn.isHidden = true
        case .matched(let activeUrl):
            let shown = activeUrl.isEmpty ? displayUrl : activeUrl
            proxySubtitleLabel.stringValue = L10n.t(
                "settings.proxy.status.matched",
                ["url": shown],
                fallback: "当前生效：\(shown)（Antigravity 已走代理）"
            )
            proxySubtitleLabel.textColor = .systemGreen
            proxyRelaunchBtn.isHidden = true
        case .missing:
            if app.effectiveProxyMode() == .manual {
                proxySubtitleLabel.stringValue = L10n.t(
                    "settings.proxy.status.missing_manual",
                    ["url": displayUrl],
                    fallback: "已配置代理 \(displayUrl)，但当前 Antigravity 未加载代理，点击安全重启生效"
                )
            } else {
                proxySubtitleLabel.stringValue = L10n.t(
                    "settings.proxy.status.missing_system",
                    ["url": displayUrl],
                    fallback: "检测到系统代理 \(displayUrl)，但当前 Antigravity 未加载代理，点击安全重启生效"
                )
            }
            proxySubtitleLabel.textColor = accessibleWarningColor()
            proxyRelaunchBtn.isHidden = false
        case .mismatch(let actualUrl, let expectedUrl):
            proxySubtitleLabel.stringValue = L10n.t(
                "settings.proxy.status.mismatch",
                ["expected": expectedUrl, "actual": actualUrl],
                fallback: "代理已变更为 \(expectedUrl)（当前进程：\(actualUrl)），点击安全重启生效"
            )
            proxySubtitleLabel.textColor = accessibleWarningColor()
            proxyRelaunchBtn.isHidden = false
        case .overriddenByShell(let lsActualUrl, _, let expectedUrl):
            proxySubtitleLabel.stringValue = L10n.t(
                "settings.proxy.status.overridden_by_shell",
                ["actual": lsActualUrl, "expected": expectedUrl],
                fallback: "检测到 Shell 配置（如 ~/.zshrc）覆盖了代理：\(lsActualUrl)（期望 \(expectedUrl)）"
            )
            proxySubtitleLabel.textColor = accessibleWarningColor()
            proxyRelaunchBtn.isHidden = true
        }
    }

    func update() {
        rebuildLanguagePopup()
        languageSubtitleField?.stringValue = languageSubtitleText()
        languagePopup.setAccessibilityLabel(L10n.t("settings.language.title", fallback: "显示语言"))
        languagePopup.isEnabled = app.statusValue.mode != "unsupported"
        hudSwitch.state = app.effectiveHudEnabled() ? .on : .off
        hudSwitch.isEnabled = app.reachable && app.statusValue.mode != "unsupported"
        refreshProxyRowState(force: false)
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        launchAntigravityOnStartSwitch.state = app.configuration.value.launchAntigravityOnStart ? .on : .off
        launchAntigravityOnStartSwitch.setAccessibilityLabel(L10n.t("settings.launch_antigravity.title", fallback: "启动时自动打开 Antigravity"))
        if (refresh.cell as? DesignPopUpCell)?.isTrackingMenu != true {
            let refreshTitles = [
                L10n.t("settings.refresh.manual", fallback: "手动刷新"),
                L10n.t("settings.refresh.5m", fallback: "每 5 分钟"),
                L10n.t("settings.refresh.10m", fallback: "每 10 分钟"),
                L10n.t("settings.refresh.15m", fallback: "每 15 分钟"),
                L10n.t("settings.refresh.30m", fallback: "每 30 分钟"),
                L10n.t("settings.refresh.60m", fallback: "每 60 分钟")
            ]
            for (idx, itemTitle) in refreshTitles.enumerated() where idx < refresh.numberOfItems {
                refresh.item(at: idx)?.title = itemTitle
            }
            refresh.selectItem(at: Self.refreshIntervals.firstIndex(of: app.configuration.value.quotaRefreshMinutes) ?? 0)
            if refresh.cell is DesignPopUpCell {
                Design.syncPopUpWidth(refresh)
            } else {
                refresh.invalidateIntrinsicContentSize()
            }
        }
        manageCacheBtn?.title = L10n.t("settings.storage.manage_btn", fallback: "管理存储…")
        if let cachedScan = app.lastMaintenanceScanPayload {
            applyStorageScanPayload(cachedScan)
        } else {
            storageSubtitleLabel.stringValue = Self.defaultStorageSubtitle
        }
        refreshStorageRowState()
        pricingSyncSwitch.state = app.configuration.value.autoPricingSyncEnabled ? .on : .off
        pricingSyncSwitch.isEnabled = app.reachable
        if let checkBtn = pricingSyncCheckBtn {
            checkBtn.title = L10n.t("settings.pricing_sync.check_now", fallback: "立即检查")
            checkBtn.invalidateIntrinsicContentSize()
            checkBtn.setAccessibilityLabel(L10n.t("settings.pricing_sync.check_a11y", fallback: "检查价格更新"))
            checkBtn.setBusy(checkBtn.isBusy, available: app.reachable)
        }
    }

    @objc func languageChanged() {
        if languagePopup.cell is DesignPopUpCell {
            Design.syncPopUpWidth(languagePopup)
        }
        guard let selected = languagePopup.selectedItem?.representedObject as? String else { return }
        DispatchQueue.main.async { [weak self] in
            self?.app.setGlobalLanguage(selected)
        }
    }

    @objc func togglePricingSync() {
        let enabled = pricingSyncSwitch.state == .on
        pricingSyncSwitch.isEnabled = false
        app.bridge.send(["command": "pricing_sync_set", "enabled": enabled]) { [weak self] result in
            guard let self else { return }
            self.pricingSyncSwitch.isEnabled = true
            if case .success = result {
                self.app.configuration.value.autoPricingSyncEnabled = enabled
                try? self.app.configuration.save()
            } else {
                self.pricingSyncSwitch.state = self.app.configuration.value.autoPricingSyncEnabled ? .on : .off
                self.app.showMessage(L10n.t("settings.pricing_sync.update_failed", fallback: "未能更新自动价格同步设置"), error: true)
            }
        }
    }

    @objc func checkPricingSync() {
        guard pricingSyncCheckBtn?.isBusy != true else { return }
        pricingSyncCheckBtn?.setBusy(true, available: true)
        app.bridge.send(["command": "pricing_sync_check"]) { [weak self] result in
            guard let self else { return }
            self.pricingSyncCheckBtn?.setBusy(false, available: self.app.reachable)
            switch result {
            case .success(let payload):
                if payload["synced"] as? Bool == true {
                    self.app.invalidateUsageReportCache()
                    self.app.overview?.fetch()
                    self.app.usagePage?.fetch(force: true)
                }
                if let window = self.app.window, window.activeSheetWindow == nil || window.activeSheetWindow === self.pricingSheet?.sheet {
                    if self.pricingSheet == nil {
                        self.pricingSheet = PricingSyncSheetController(app: self.app)
                    }
                    self.pricingSheet?.show(in: window, payload: payload) { [weak self, weak app = self.app] in
                        self?.pricingSheet = nil
                        if let app, app.pendingLocalizedRebuildAfterMaintenance, self?.maintenanceSheet == nil, app.cachePage?.busy != true {
                            app.pendingLocalizedRebuildAfterMaintenance = false
                            app.cachePage = nil
                            app.preferencesController = nil
                            if app.currentPage == 3 {
                                app.navigate(3, force: true)
                            }
                        }
                    }
                } else {
                    let count = (payload["status"] as? [String: Any])?["modelCount"] as? Int
                        ?? ((payload["prices"] as? [String: Any])?.count ?? (payload["count"] as? Int ?? 0))
                    let ok = payload["synced"] as? Bool == true
                    let errStr = payload["error"] as? String ?? L10n.t("settings.pricing_sync.default_error", fallback: "未能同步远端价格")
                    self.app.showMessage(ok ? L10n.t("settings.pricing_sync.synced", ["count": count], fallback: "价格基准已同步（生效 \(count) 款模型）") : L10n.t("settings.pricing_sync.check_failed", ["error": errStr], fallback: "检查提示：\(errStr)"), error: !ok)
                }
            case .failure(let err):
                self.app.showMessage(L10n.t("settings.pricing_sync.sync_failed", ["error": err.localizedDescription], fallback: "同步失败：\(err.localizedDescription)"), error: true)
            }
        }
    }

    @objc func toggleHud() {
        let target = hudSwitch.state == .on
        app.setHudEnabled(target)
    }

    @objc func proxyModeChanged() {
        if proxyModePopup.cell is DesignPopUpCell {
            Design.syncPopUpWidth(proxyModePopup)
        }
        guard let rawMode = proxyModePopup.selectedItem?.representedObject as? String,
              let mode = AntigravityProxyMode(rawValue: rawMode) else { return }
        switch mode {
        case .off, .system:
            editingManualProxyMode = false
            proxyManualValidationError = nil
            do {
                try app.applyProxyConfiguration(mode: mode, manualUrl: app.configuration.value.antigravityProxyManualUrl)
            } catch {
                showError(error)
            }
            refreshProxyRowState(force: true)
            if view?.window != nil {
                view.layoutSubtreeIfNeeded()
            }
        case .manual:
            let candidate = proxyManualField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            if candidate.isEmpty {
                editingManualProxyMode = true
                proxyManualValidationError = nil
                refreshProxyRowState(force: true)
                if view?.window != nil {
                    view.layoutSubtreeIfNeeded()
                }
                DispatchQueue.main.async { [weak self] in
                    guard let self,
                          self.editingManualProxyMode,
                          !self.proxyManualContainer.isHidden,
                          let window = self.view?.window,
                          self.proxyManualField.window === window else { return }
                    #if NATIVE_UI_TEST
                    if !Assistant.headlessOffscreenUI {
                        window.makeFirstResponder(self.proxyManualField)
                    }
                    #else
                    window.makeFirstResponder(self.proxyManualField)
                    #endif
                }
                return
            }
            do {
                try app.applyProxyConfiguration(mode: .manual, manualUrl: candidate)
                editingManualProxyMode = false
                proxyManualValidationError = nil
                proxyManualField.stringValue = app.configuration.value.antigravityProxyManualUrl
            } catch {
                editingManualProxyMode = true
                proxyManualValidationError = error.localizedDescription
            }
            refreshProxyRowState(force: true)
            if view?.window != nil {
                view.layoutSubtreeIfNeeded()
            }
        }
    }

    @objc func applyManualProxy() {
        let raw = proxyManualField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            try app.applyProxyConfiguration(mode: .manual, manualUrl: raw)
            editingManualProxyMode = false
            proxyManualValidationError = nil
            proxyManualField.stringValue = app.configuration.value.antigravityProxyManualUrl
        } catch {
            editingManualProxyMode = true
            proxyManualValidationError = error.localizedDescription
        }
        refreshProxyRowState(force: true)
    }

    @objc func relaunchAntigravityForProxy() {
        app.safeRelaunchAntigravityForProxy()
    }

    func controlTextDidBeginEditing(_ obj: Notification) {
        if obj.object as? NSTextField === proxyManualField {
            proxyManualField.needsDisplay = true
        }
    }

    func controlTextDidEndEditing(_ obj: Notification) {
        if obj.object as? NSTextField === proxyManualField {
            proxyManualField.needsDisplay = true
        }
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        if control === proxyManualField, commandSelector == #selector(NSResponder.insertNewline(_:)) {
            applyManualProxy()
            return true
        }
        return false
    }

    @objc func toggleLaunchAntigravityOnStart() {
        let previous = app.configuration.value.launchAntigravityOnStart
        let next = launchAntigravityOnStartSwitch.state == .on
        app.configuration.value.launchAntigravityOnStart = next
        do {
            try app.configuration.save()
        } catch {
            app.configuration.value.launchAntigravityOnStart = previous
            launchAntigravityOnStartSwitch.state = previous ? .on : .off
            showError(error)
        }
    }

    @objc func refreshChanged() {
        let previous = app.configuration.value.quotaRefreshMinutes
        let idx = max(0, min(Self.refreshIntervals.count - 1, refresh.indexOfSelectedItem))
        app.configuration.value.quotaRefreshMinutes = Self.refreshIntervals[idx]
        if refresh.cell is DesignPopUpCell {
            Design.syncPopUpWidth(refresh)
        }
        do {
            try app.configuration.save()
            app.configureQuotaRefreshTimer()
            app.fetchAccountList(notifyPage: true)
            app.overview?.fetch()
            app.updateViews()
        }
        catch {
            app.configuration.value.quotaRefreshMinutes = previous
            refresh.selectItem(at: Self.refreshIntervals.firstIndex(of: previous) ?? 0)
            if refresh.cell is DesignPopUpCell {
                Design.syncPopUpWidth(refresh)
            }
            showError(error)
        }
    }

    @objc func toggleLogin() {
        do {
            if login.state == .on {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            if SMAppService.mainApp.status == .requiresApproval {
                SMAppService.openSystemSettingsLoginItems()
            }
        } catch {
            showError(error)
        }
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
    }

    private func showError(_ error: Error) { app.showMessage(error.localizedDescription, error: true) }
}
