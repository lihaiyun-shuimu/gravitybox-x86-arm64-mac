import Cocoa
import ServiceManagement
import Carbon

/// G03: 侧栏与内容区之间的 1px 分隔线。NSSplitViewController 系统分隔线在深色下仅约 1.1:1，
/// 这里在侧栏 trailing 叠一条随外观更新的语义色线（深色白 8%、浅色黑 9%），不改变侧栏宽度/布局。
private final class SidebarSeparatorView: NSView {
    override var isOpaque: Bool { false }
    override func draw(_ dirtyRect: NSRect) {
        let color: NSColor = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor.white.withAlphaComponent(0.13)
            : NSColor.black.withAlphaComponent(0.09)
        color.setFill()
        bounds.fill()
    }
    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }
}

extension NSWindow {
    var activeSheetWindow: NSWindow? {
        attachedSheet ?? NSApp.windows.first { $0.sheetParent === self }
    }
}

#if NATIVE_UI_TEST
extension Assistant {
    /// 非交互原生 UI 测试默认静默全透明运行，禁止任何窗口、Sheet 或 Popover 出现在桌面屏幕；
    /// 仅当显式传入 `--interactive` 时才正常展示窗口。
    static var headlessOffscreenUI: Bool = !CommandLine.arguments.contains("--interactive")

    static func configureHeadlessWindowIfNeeded(_ window: NSWindow) {
        guard headlessOffscreenUI else { return }
        window.alphaValue = 0
        window.hasShadow = false
        window.ignoresMouseEvents = true
        window.animationBehavior = .none
        window.sharingType = .none
        window.collectionBehavior.insert([.transient, .ignoresCycle, .stationary])
    }
}
#endif

final class MenuFloatingPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    override func sendEvent(_ event: NSEvent) {
        switch event.type {
        case .leftMouseDown, .rightMouseDown, .otherMouseDown:
            if !isKeyWindow {
                makeKey()
            }
        default:
            break
        }
        super.sendEvent(event)
    }
}

final class Assistant: NSObject, NSApplicationDelegate, NSWindowDelegate, NSTableViewDataSource, NSTableViewDelegate {
    var names: [String] {
        [
            L10n.t("nav.overview"),
            L10n.t("nav.accounts"),
            L10n.t("nav.usage"),
            L10n.t("nav.settings"),
            L10n.t("nav.about")
        ]
    }
    var bridge: BackendBridge!
    var configuration: ConfigurationStore!
    var item: NSStatusItem!
    var menuPanel: MenuFloatingPanel?
    private var isClosingMenuPanel = false
    private var menuPanelVisibilityGeneration = 0
    private var menuPanelAnchorMaxY: CGFloat?
    private(set) var menuPanelTargetSize: NSSize?
    private var menuPanelResizeMotion: DesignMotion?
    private var menuPanelFadeMotion: DesignMotion?
    var isMenuPanelShown: Bool { menuPanel?.isVisible == true && !isClosingMenuPanel }
    var menuPanelController: MenuPanelController?
    private var activeSheetControllers: [ObjectIdentifier: AnyObject] = [:]
    var window: NSWindow?
    var sidebar = NSTableView()
    let pillSelectionView = PillSelectionView()
    var pageHost = NSView()
    var contentVisible: Bool { window?.isVisible == true && window?.isMiniaturized != true && window?.occlusionState.contains(.visible) == true }
    var currentPage = 0
    var dashboardPage: DashboardPage? { overview }
    var overview: DashboardPage?
    var accountsPage: AccountsPage?
    var usageSelectedPeriod = 0
    var usageSelectedEnvironment: String = "all"
    var usageSelectedAccount: String = "all"
    var usageScrollOrigin = NSPoint.zero
    var usagePage: UsagePage?
    var cachePage: CachePage?
    var preferencesController: PreferencesController?
    var aboutPage: AboutPage?
    var cachedDashboardBootstrapSummary: [String: Any]?
    var cachedAccountsBootstrapPayload: [String: Any]?
    var bootstrappedAccounts = false
    var bootstrappedUsagePeriods = Set<String>()
    var lastMaintenanceScanPayload: [String: Any]?
    var lastMaintenanceScanAt: Date = .distantPast
    let uiBootstrapQueue = DispatchQueue(label: "local.gravitybox.ui-bootstrap", qos: .utility)
    var uiBootstrapSaveWorkItem: DispatchWorkItem?
    var cachedAccounts: [[String: Any]] = []
    var activeAccountId: String = ""
    var cachedRecommendedAccountId: String? = nil
    var recommendationPreviewInFlight = false
    var lastRecommendedAccountsFingerprint = ""
    var pendingAccountTaskId: String?
    var accountSwitchInFlight = false
    var menuTracking = false
    var cachedUsageReportsByPeriod: [String: [String: Any]] = [:]
    var usageLastFetchTimeByPeriod: [String: Date] = [:]
    var usageLastSuccessAtByPeriod: [String: Date] = [:]
    var usageNextRetryAtByPeriod: [String: Date] = [:]
    var usageRemoteSyncRevisionByPeriod: [String: Int] = [:]
    var usageInFlightByPeriod: [String: Bool] = [:]
    var usageGenerationByPeriod: [String: Int] = [:]
    var usagePendingForceByPeriod = Set<String>()
    var usageManualRefreshPeriods = Set<String>()
    var usageFetchErrorsByPeriod: [String: String] = [:]
    var usageWaitersByPeriod: [String: [(Result<[String: Any], Error>) -> Void]] = [:]
    var usageAutoHealAttemptsByPeriod: [String: Int] = [:]
    var usageAutoHealPendingPeriods = Set<String>()
    var singleAccountRefreshErrors: [String: String] = [:]
    var singleAccountRefreshNotices: [String: String] = [:]
    private var popoverGlobalClickMonitor: Any?
    private var popoverLocalClickMonitor: Any?
    private var popoverLocalKeyMonitor: Any?
    private var popoverWorkspaceObservers: [NSObjectProtocol] = []
    private var popoverAppObservers: [NSObjectProtocol] = []
    var quotaRefreshStartedAt: Date?
    var recoveryAttempts = 0
    var autoRestartAttempts = 0
    var lastAutoRestartAt = Date.distantPast
    var selfHealingPending = false
    var pendingLanguageTarget: String?
    var languageCommandGeneration = 0
    var pendingHudTarget: Bool?
    var hudCommandGeneration = 0
    var pendingLocalizedRebuildAfterMaintenance = false
    var nextRecoveryAt = Date.distantPast
    #if NATIVE_UI_TEST
    var confirmSwitchForTesting: ((String, @escaping (Bool) -> Void) -> Void)?
    #endif
    var quotaRefreshing = false
    var refreshingAccountIds = Set<String>()
    var quotaRefreshError: String?
    var quotaRefreshPollTimer: Timer?
    var selectedContextKey: String = "local"
    var userPinnedContext = false
    var overviewEnvironmentKey: String = "all"
    var remoteSessions: [[String: Any]] = []
    var remoteQuotaRefreshing = false
    private(set) var environmentsRevision: Int = 0
    private(set) var focusedEnvironmentId: String = "local"
    private(set) var backendEnvironmentNodes: [CanonicalHostEnvironment] = []
    private(set) var hasAuthoritativeEnvironmentsPayload: Bool = false
    private(set) var activeNodeScope: EnvironmentScope = .local
    var activeNodeFollowFocus: Bool { !userPinnedContext }
    private(set) var usageFilterScope: EnvironmentScope = .all
    private(set) var usageAvailableEnvironments: [[String: Any]] = []
    private(set) var usageEnvironmentShareById: [String: Double] = [:]
    private(set) var isBreathing = false
    private var breathingMotion: DesignMotion?
    var lastTaskRevision = -1
    var statusValue = LiveStatus()
    var taskRows: [[String: Any]] = []
    var reachable = false
    var quotaRefreshTimer: Timer?
    var lastAutoQuotaRefreshTriggerAt: Date = .distantPast
    var nextScheduledQuotaRefreshAt: Date?
    var pendingAutoQuotaRefresh = false
    var workspaceWakeObserver: NSObjectProtocol?
    var appBecomeActiveObserver: NSObjectProtocol?
    private var pendingViewUpdateAfterPopUpMenu = false
    private var popUpMenuCloseObserver: NSObjectProtocol?
    var lastResetOverdueRefreshByAccount: [String: (signature: String, at: Date)] = [:]
    var quotaStaleThresholdSeconds: TimeInterval {
        let minutes = configuration?.value.quotaRefreshMinutes ?? 0
        return minutes > 15 ? TimeInterval(minutes * 60 + 120) : TimeInterval(15 * 60)
    }
    var autoUpdateTimer: Timer?
    lazy var updateManager = AppUpdateManager(app: self)
    var timer: Timer?
    var directorySource: DispatchSourceFileSystemObject?
    var refreshInFlight = false
    var pendingRefreshRequested = false
    var pendingTaskPollRequested = false
    var quitting = false
    let serviceFootnoteLabel = text("", size: 10.5, color: Design.secondary)
    var configSaveWorkItem: DispatchWorkItem?
    private(set) var lastOperationError: String?
    private var presentedError: String?
    var lastAccountListFetchAt: Date = .distantPast
    var lastFetchedAccountsRevision = ""
    var lastObservedPricingRevision = ""
    var lastFetchedLiveEmail = ""
    var accountListInFlight = false
    var accountListPendingRefetch = false
    var accountListPendingNotifyPage = false
    var accountListGeneration = 0
    var hasLoadedAccountsOnce = false
    var accountListInFlightRevision = ""
    var accountListInFlightLiveEmail = ""
    var accountListWaiters: [(Result<[String: Any], Error>) -> Void] = []
    private let stateWatchQueue = DispatchQueue(label: "local.gravitybox.state-watch", qos: .utility)
    private var stateWatchWorkItem: DispatchWorkItem?
    var suppressLifecycleAutoQuitUntil: Date = .distantPast
    static var applicationChannel = "stable"
    static var selectedTarget: DesktopApplicationTarget { DesktopApplicationTarget(channel: applicationChannel) }
    var targetApplication: DesktopApplicationTarget { Self.selectedTarget }
    weak var installUpdateButton: SidebarLaunchButton?
    weak var launchApplicationButton: SidebarLaunchButton?
    let state: URL
    init(state: URL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/GravityBox")) { self.state = state; super.init() }
    var resources: URL {
        #if NATIVE_UI_TEST
        if let path = ProcessInfo.processInfo.environment["GRAVITYBOX_UI_RESOURCES"] { return URL(fileURLWithPath: path) }
        #endif
        return Bundle.main.resourceURL!
    }
    #if NATIVE_UI_TEST
    var openedApplications = 0
    #endif

    static func processArguments(for pid: pid_t) -> [String] {
        BackendBridge.processArguments(for: pid)
    }

    static func isMainPeerApplication(_ app: NSRunningApplication, excludingPid myPid: pid_t) -> Bool {
        let pid = app.processIdentifier
        guard pid > 0, pid != myPid, !app.isTerminated, app.activationPolicy != .prohibited else { return false }
        let args = processArguments(for: pid)
        if args.contains("--lifecycle-agent") { return false }
        return true
    }

    static func findExistingMainPeer(excludingPid myPid: pid_t = getpid()) -> NSRunningApplication? {
        let bundleId = Bundle.main.bundleIdentifier ?? "local.gravitybox.app"
        return NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first {
            isMainPeerApplication($0, excludingPid: myPid)
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let restartedAfterUpdate = CommandLine.arguments.contains("--restarted-after-update")
        if restartedAfterUpdate {
            for _ in 0..<25 {
                if Self.findExistingMainPeer() == nil { break }
                RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.1))
            }
        }
        if Self.findExistingMainPeer() != nil {
            if !CommandLine.arguments.contains("--launched-by-antigravity") {
                DistributedNotificationCenter.default().postNotificationName(NSNotification.Name("local.gravitybox.show-panel"), object: nil, userInfo: nil, deliverImmediately: true)
            }
            quitting = true; NSApp.terminate(nil); return
        }
        NSApp.setActivationPolicy(.accessory)
        do { configuration = try ConfigurationStore(state: state) }
        catch { let alert = NSAlert(error: error); alert.runModal(); NSApp.terminate(nil); return }
        let effectiveChannel = DesktopApplicationTarget.effectiveChannel(configured: configuration.value.applicationChannel)
        if effectiveChannel != configuration.value.applicationChannel {
            configuration.value.applicationChannel = effectiveChannel
            try? configuration.save()
        }
        Self.applicationChannel = effectiveChannel
        let configuredLanguage = resolveAndPersistInitialLanguage()
        bridge = BackendBridge(resources: resources, state: state)
        bridge.preferredLocale = configuredLanguage
        bridge.onExit = { [weak self] message in
            guard let self, !self.quitting else { return }
            self.reachable = false; self.failPendingQuotaRefresh(message); self.updateViews()
            self.scheduleSelfHealingRestart(reason: message)
        }
        if configuration.value.navigationVersion != 5 {
            configuration.value.migrateNavigation(); try? configuration.save()
        }
        syncUsageFilterScopeFromConfiguration()
        loadUIBootstrapSnapshot()
        installApplicationMenu()
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = baseMenuConnectedIcon()
        item.button?.setAccessibilityLabel("GravityBox")
        item.button?.target = self
        item.button?.action = #selector(statusItemClicked(_:))
        item.button?.sendAction(on: [.leftMouseDown, .rightMouseDown])
        updateStatusItemState()
        DistributedNotificationCenter.default().addObserver(self, selector: #selector(handleAppIconReopen), name: NSNotification.Name("local.gravitybox.show-panel"), object: nil)
        bridge.launch { [weak self] result in
            guard let self else { return }
            switch result {
            case .success:
                self.syncBackendProxyConfiguration()
                self.refresh()
            case .failure(let error):
                self.showMessage(error.localizedDescription, error: true)
            }
        }
        watchState()
        let data = NSAppleEventManager.shared().currentAppleEvent?.paramDescriptor(forKeyword: AEKeyword(keyAEPropData))
        let loginLaunch = data?.enumCodeValue == OSType(keyAELaunchedAsLogInItem)
        let launchedByAntigravity = CommandLine.arguments.contains("--launched-by-antigravity")
        switch Self.startupLaunchAction(
            launchAntigravityOnStart: configuration.value.launchAntigravityOnStart,
            loginLaunch: loginLaunch,
            restartedAfterUpdate: restartedAfterUpdate,
            launchedByAntigravity: launchedByAntigravity
        ) {
        case .launchAntigravityInBackground:
            launchAntigravityDirectly()
        case .stayInMenuBar:
            break
        case .showMainPanel:
            showPanel()
        }
        installQuotaScheduleObservers()
        cleanupLegacyLifecycleAgent()
        // 登录项启动时没有窗口，历史上因此从未创建定时器，菜单栏配额永远不更新。
        configureRefreshTimer()
        if quotaRefreshTimer == nil { configureQuotaRefreshTimer() }
        configureAutoUpdateTimer()
        refresh()
    }
    func resolveAndPersistInitialLanguage() -> String {
        let i18nDir = resources.appendingPathComponent("i18n", isDirectory: true)
        if FileManager.default.fileExists(atPath: i18nDir.path) {
            L10n.shared.reloadPacks(directory: i18nDir)
        } else {
            L10n.shared.reloadPacks()
        }
        if let configured = configuration.value.appLanguage?.trimmingCharacters(in: .whitespacesAndNewlines),
           !configured.isEmpty {
            _ = L10n.shared.setLanguage(configured, notify: false)
            return configured
        }
        var migrated = "system"
        let runtimePrefsURL = state.appendingPathComponent("runtime-preferences.json")
        if let data = try? Data(contentsOf: runtimePrefsURL),
           let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let lang = raw["language"] as? String, !lang.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                migrated = lang.trimmingCharacters(in: .whitespacesAndNewlines)
            } else if let enabled = raw["translationEnabled"] as? Bool {
                migrated = enabled ? "zh-Hans" : "en"
            }
        }
        configuration.value.appLanguage = migrated
        try? configuration.save()
        _ = L10n.shared.setLanguage(migrated, notify: false)
        return migrated
    }

    func installApplicationMenu() {
        let main = NSMenu()
        let app = NSMenu(); let appItem = NSMenuItem(); appItem.submenu = app; main.addItem(appItem)
        add(app, L10n.t("menu.about"), #selector(about), "")
        add(app, L10n.t("menu.check_updates"), #selector(checkForUpdatesFromMenu), "")
        app.addItem(.separator()); add(app, L10n.t("menu.settings"), #selector(showSettings), ",")
        app.addItem(.separator()); add(app, L10n.t("menu.hide"), #selector(NSApplication.hide(_:)), "h", target: NSApp)
        add(app, L10n.t("menu.quit"), #selector(quit), "q")
        let editTitle = L10n.t("menu.edit")
        let edit = NSMenu(title: editTitle); let editItem = NSMenuItem(title: editTitle, action: nil, keyEquivalent: ""); editItem.submenu = edit; main.addItem(editItem)
        for (title, selector, key) in [(L10n.t("menu.undo"), Selector(("undo:")), "z"), (L10n.t("menu.cut"), #selector(NSText.cut(_:)), "x"), (L10n.t("menu.copy"), #selector(NSText.copy(_:)), "c"), (L10n.t("menu.paste"), #selector(NSText.paste(_:)), "v"), (L10n.t("menu.select_all"), #selector(NSText.selectAll(_:)), "a")] { let value = NSMenuItem(title: title, action: selector, keyEquivalent: key); edit.addItem(value) }
        let viewTitle = L10n.t("menu.view")
        let view = NSMenu(title: viewTitle); let viewItem = NSMenuItem(title: viewTitle, action: nil, keyEquivalent: ""); viewItem.submenu = view; main.addItem(viewItem)
        for (index, name) in names.enumerated() { let value = add(view, name, #selector(menuNavigate(_:)), String(index + 1)); value.tag = index }
        let windowTitle = L10n.t("menu.window")
        let windows = NSMenu(title: windowTitle); let windowItem = NSMenuItem(title: windowTitle, action: nil, keyEquivalent: ""); windowItem.submenu = windows; main.addItem(windowItem)
        add(windows, L10n.t("menu.close_window"), #selector(NSWindow.performClose(_:)), "w", target: nil)
        add(windows, L10n.t("menu.minimize"), #selector(NSWindow.performMiniaturize(_:)), "m", target: nil)
        add(windows, L10n.t("menu.zoom"), #selector(NSWindow.performZoom(_:)), "", target: nil)
        NSApp.windowsMenu = windows
        NSApp.mainMenu = main
    }
    @discardableResult func add(_ menu: NSMenu, _ title: String, _ action: Selector, _ key: String = "", target: AnyObject? = nil) -> NSMenuItem {
        let entry = NSMenuItem(title: title, action: action, keyEquivalent: key); entry.target = target ?? self
        // Responder-chain window commands must not target the application delegate.
        if action == #selector(NSWindow.performClose(_:))
            || action == #selector(NSWindow.performMiniaturize(_:))
            || action == #selector(NSWindow.performZoom(_:)) {
            entry.target = nil
        }
        menu.addItem(entry); return entry
    }
    func resolvedActiveAccount() -> [String: Any]? {
        let pool = !cachedAccounts.isEmpty ? cachedAccounts : (accountsPage?.accounts ?? [])
        guard !pool.isEmpty else { return nil }
        if !statusValue.liveAccountEmail.isEmpty,
           let matched = pool.first(where: { ($0["email"] as? String ?? "").caseInsensitiveCompare(statusValue.liveAccountEmail) == .orderedSame }) {
            return fusedAccount(matched)
        }
        let targetId = !activeAccountId.isEmpty ? activeAccountId : (accountsPage?.activeId ?? "")
        if !targetId.isEmpty,
           let matched = pool.first(where: { $0["id"] as? String == targetId }) {
            return fusedAccount(matched)
        }
        return pool.first.map { fusedAccount($0) }
    }

    func resolvedMenuAccount() -> [String:Any]? {
        if !statusValue.liveAccountEmail.isEmpty,
           let matched = cachedAccounts.first(where: { ($0["email"] as? String ?? "").caseInsensitiveCompare(statusValue.liveAccountEmail) == .orderedSame }) {
            return fusedAccount(matched)
        }
        if !activeAccountId.isEmpty,
           let matched = cachedAccounts.first(where: { $0["id"] as? String == activeAccountId }) {
            return fusedAccount(matched)
        }
        return cachedAccounts.first.map { fusedAccount($0) }
    }

    private var cachedBaseMenuIcon: NSImage?
    private weak var statusItemAttentionBadgeView: StatusItemAttentionDotView?

    private final class StatusItemAttentionDotView: NSView {
        override var isOpaque: Bool { false }
        override var allowsVibrancy: Bool { false }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        override func viewDidChangeEffectiveAppearance() {
            super.viewDidChangeEffectiveAppearance()
            needsDisplay = true
        }

        override func draw(_ dirtyRect: NSRect) {
            let dotSize: CGFloat = 4.0
            let originX = bounds.width - dotSize - 2.0
            let originY = isFlipped ? 2.5 : (bounds.height - dotSize - 2.5)
            let dotRect = NSRect(x: originX, y: originY, width: dotSize, height: dotSize)
            let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let dotColor = isDark
                ? NSColor(srgbRed: 1.0, green: 0.624, blue: 0.039, alpha: 1.0)
                : NSColor(srgbRed: 0.945, green: 0.455, blue: 0.045, alpha: 1.0)
            dotColor.setFill()
            NSBezierPath(ovalIn: dotRect).fill()
        }
    }

    func baseMenuConnectedIcon() -> NSImage? {
        if let cached = cachedBaseMenuIcon { return cached }
        guard let base = NSImage(contentsOf: resources.appendingPathComponent("icons/menu-connected.png")) else { return nil }
        base.size = NSSize(width: 20, height: 20)
        base.isTemplate = true
        cachedBaseMenuIcon = base
        return base
    }

    private func ensureStatusItemAttentionBadge(in button: NSButton) -> StatusItemAttentionDotView {
        if let existing = button.subviews.compactMap({ $0 as? StatusItemAttentionDotView }).first {
            if existing.frame != button.bounds {
                existing.frame = button.bounds
            }
            return existing
        }
        let dotView = StatusItemAttentionDotView(frame: button.bounds)
        dotView.identifier = NSUserInterfaceItemIdentifier("status-item-attention-dot")
        dotView.autoresizingMask = [.width, .height]
        dotView.isHidden = true
        dotView.setAccessibilityElement(false)
        button.addSubview(dotView)
        if button === item?.button {
            statusItemAttentionBadgeView = dotView
        }
        return dotView
    }

    func updateStatusItemState(buttonOverride: NSButton? = nil) {
        guard let button = buttonOverride ?? item?.button else { return }
        let baseIcon = baseMenuConnectedIcon()
        if button.image !== baseIcon {
            button.image = baseIcon
        }

        let needsDebugPortAttention = reachable && statusValue.mode == "debug-port-missing"
        let dotView = ensureStatusItemAttentionBadge(in: button)
        if dotView.isHidden == needsDebugPortAttention {
            dotView.isHidden = !needsDebugPortAttention
            dotView.needsDisplay = true
        }

        let targetAlpha: CGFloat = reachable ? 1.0 : 0.50
        #if NATIVE_UI_TEST
        button.alphaValue = targetAlpha
        #else
        if quotaRefreshing && reachable && Design.shouldAnimate(in: button) {
            if !isBreathing {
                isBreathing = true
                startBreathingPulse(baseAlpha: targetAlpha, buttonOverride: buttonOverride)
            }
        } else {
            if isBreathing {
                isBreathing = false
                breathingMotion?.cancel()
                breathingMotion = nil
                button.alphaValue = targetAlpha
            } else if abs(button.alphaValue - targetAlpha) > 0.02 {
                button.alphaValue = targetAlpha
            }
        }
        #endif
    }

    func startBreathingPulse(baseAlpha: CGFloat, buttonOverride: NSButton? = nil) {
        guard isBreathing, let button = buttonOverride ?? item?.button else { return }
        guard Design.shouldAnimate(in: button) else {
            isBreathing = false
            breathingMotion?.cancel()
            breathingMotion = nil
            button.alphaValue = baseAlpha
            return
        }
        breathingMotion?.cancel()
        let motion = DesignMotion()
        breathingMotion = motion
        let lowAlpha = max(0.35, baseAlpha * 0.55)
        motion.animate(in: button, from: baseAlpha, to: lowAlpha, curve: .breathe, threshold: 0.01) { [weak button] p in
            button?.alphaValue = p
        } completion: { [weak self, weak button] in
            guard let self, self.isBreathing, let button else { return }
            guard Design.shouldAnimate(in: button) else {
                self.isBreathing = false
                self.breathingMotion?.cancel()
                self.breathingMotion = nil
                button.alphaValue = baseAlpha
                return
            }
            self.breathingMotion?.animate(in: button, from: lowAlpha, to: baseAlpha, curve: .breathe, threshold: 0.01) { [weak button] p in
                button?.alphaValue = p
            } completion: { [weak self, weak button] in
                guard let self, self.isBreathing else { return }
                DispatchQueue.main.async { [weak self, weak button] in
                    guard let self, self.isBreathing else { return }
                    self.startBreathingPulse(baseAlpha: baseAlpha, buttonOverride: button)
                }
            }
        }
    }
    #if NATIVE_UI_TEST
    func triggerBreathingPulseForTesting(baseAlpha: CGFloat, button: NSButton) {
        isBreathing = true
        startBreathingPulse(baseAlpha: baseAlpha, buttonOverride: button)
    }
    #endif
    func scheduleConfigurationSave() {
        configSaveWorkItem?.cancel()
        let saveWork = DispatchWorkItem { [weak self] in try? self?.configuration.save() }
        configSaveWorkItem = saveWork
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: saveWork)
    }

    @objc func statusItemClicked(_ sender: Any?) {
        toggleMenuPopover()
    }

    func toggleMenuPopover() {
        if isMenuPanelShown {
            closeMenuPopover()
        } else {
            openMenuPopover()
        }
    }

    func ensureMenuPanelController() -> MenuPanelController {
        if let existing = menuPanelController { return existing }
        let controller = MenuPanelController(app: self)
        menuPanelController = controller
        return controller
    }

    private func attachMenuPanelContent(_ controller: MenuPanelController, to panel: MenuFloatingPanel) {
        let view = controller.view
        if controller.preferredContentSize != .zero {
            controller.preferredContentSize = .zero
        }
        view.translatesAutoresizingMaskIntoConstraints = true
        view.autoresizingMask = [.width, .height]
        let contentSize = panel.contentRect(forFrameRect: panel.frame).size
        if abs(view.frame.width - contentSize.width) > 0.5 || abs(view.frame.height - contentSize.height) > 0.5 || view.frame.origin != .zero {
            view.frame = NSRect(origin: .zero, size: contentSize)
        }
        if panel.contentView !== view {
            panel.contentView = view
        }
    }

    func ensureMenuPanel(hosting controller: MenuPanelController) -> MenuFloatingPanel {
        if let existing = menuPanel {
            attachMenuPanelContent(controller, to: existing)
            return existing
        }
        let panel = MenuFloatingPanel(
            contentRect: NSRect(x: 0, y: 0, width: MenuPanelController.panelWidth, height: MenuPanelController.defaultPanelHeight),
            styleMask: [.nonactivatingPanel, .borderless],
            backing: .buffered,
            defer: false
        )
        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = false
        panel.worksWhenModal = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        // Match NSPopover/statusBar layer (25) so screenshot window pickers (e.g. WeChat) can snap to the card while NSMenu popups (.popUpMenu) remain above it.
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .canJoinAllApplications, .ignoresCycle]
        #if NATIVE_UI_TEST
        Assistant.configureHeadlessWindowIfNeeded(panel)
        #endif
        attachMenuPanelContent(controller, to: panel)
        menuPanel = panel
        return panel
    }

    func resizeMenuPanel(to newSize: NSSize, animate: Bool) {
        menuPanelResizeMotion?.cancel()
        menuPanelResizeMotion = nil
        if let fade = menuPanelFadeMotion {
            fade.cancel()
            menuPanelFadeMotion = nil
            menuPanel?.alphaValue = 1.0
        }
        menuPanelTargetSize = newSize
        guard let panel = menuPanel else { return }
        let current = panel.frame
        let anchorMaxY = menuPanelAnchorMaxY ?? current.maxY
        let screenFrame = (panel.screen ?? item?.button?.window?.screen ?? NSScreen.main)?.visibleFrame
            ?? NSScreen.screens.first?.visibleFrame
        var nextX = current.origin.x
        if let screenFrame {
            nextX = min(max(screenFrame.minX + 8, nextX), screenFrame.maxX - newSize.width - 8)
        }
        let minAllowedY = screenFrame.map { $0.minY + 8 } ?? -CGFloat.greatestFiniteMagnitude
        let maxAllowedH = screenFrame.map { max(300, anchorMaxY - ($0.minY + 8)) } ?? CGFloat.greatestFiniteMagnitude
        let frameForHeight: (CGFloat) -> NSRect = { rawH in
            let clampedH = round(min(rawH, maxAllowedH))
            let nextY = max(minAllowedY, round(anchorMaxY - clampedH))
            return NSRect(x: nextX, y: nextY, width: newSize.width, height: clampedH)
        }
        let targetFrame = frameForHeight(newSize.height)
        if abs(current.width - targetFrame.width) <= 0.5
            && abs(current.height - targetFrame.height) <= 0.5
            && abs(current.origin.x - targetFrame.origin.x) <= 0.5
            && abs(current.origin.y - targetFrame.origin.y) <= 0.5 {
            return
        }
        guard animate, Design.shouldAnimate(in: panel.contentView), panel.isVisible else {
            panel.setFrame(targetFrame, display: true)
            panel.invalidateShadow()
            return
        }
        let motion = DesignMotion()
        menuPanelResizeMotion = motion
        motion.animate(in: panel.contentView, from: current.height, to: targetFrame.height, curve: .slide, threshold: 0.5) { [weak panel] h in
            guard let panel else { return }
            panel.setFrame(frameForHeight(h), display: true)
        } completion: { [weak self, weak panel] in
            self?.menuPanelResizeMotion = nil
            guard let panel else { return }
            panel.setFrame(targetFrame, display: true)
            panel.invalidateShadow()
        }
    }

    func retainSheetController(_ controller: AnyObject, for sheetWindow: NSWindow) {
        activeSheetControllers[ObjectIdentifier(sheetWindow)] = controller
    }

    func releaseSheetController(for sheetWindow: NSWindow) {
        activeSheetControllers.removeValue(forKey: ObjectIdentifier(sheetWindow))
    }

    func presentRetainedSheet(
        controller: AnyObject,
        sheet sheetWindow: NSWindow,
        in parent: NSWindow,
        completionHandler: ((NSApplication.ModalResponse) -> Void)? = nil
    ) {
        if isMenuPanelShown {
            closeMenuPopover(animated: false)
        }
        retainSheetController(controller, for: sheetWindow)
        #if NATIVE_UI_TEST
        Assistant.configureHeadlessWindowIfNeeded(parent)
        Assistant.configureHeadlessWindowIfNeeded(sheetWindow)
        #else
        if !NSApp.isActive {
            Design.activateApplicationForcingFront()
        }
        #endif
        parent.beginSheet(sheetWindow) { [weak self, weak sheetWindow] response in
            if let sheetWindow {
                self?.releaseSheetController(for: sheetWindow)
            }
            completionHandler?(response)
        }
    }

    func openMenuPopover() {
        guard let button = item?.button else { return }
        menuPanelVisibilityGeneration &+= 1
        let openGen = menuPanelVisibilityGeneration
        isClosingMenuPanel = false
        menuPanelResizeMotion?.cancel()
        menuPanelResizeMotion = nil
        menuPanelFadeMotion?.cancel()
        menuPanelFadeMotion = nil

        let controller = ensureMenuPanelController()
        let panel = ensureMenuPanel(hosting: controller)
        menuTracking = true
        configureRefreshTimer()
        controller.panelWillOpen()

        let desiredSize = controller.measuredPanelSize
        var finalFrame = NSRect(origin: panel.frame.origin, size: desiredSize)
        var resolvedTopY: CGFloat?
        if let btnWin = button.window {
            let btnRect = btnWin.convertToScreen(button.convert(button.bounds, to: nil))
            let screenFrame = (btnWin.screen ?? NSScreen.main)?.visibleFrame
                ?? NSScreen.screens.first?.visibleFrame
                ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
            let topY = min(round(btnRect.minY - 5), round(screenFrame.maxY - 4))
            let maxAvailableH = max(300, topY - (screenFrame.minY + 8))
            let finalSize = NSSize(width: desiredSize.width, height: min(desiredSize.height, maxAvailableH))
            let x = min(max(screenFrame.minX + 8, round(btnRect.midX - finalSize.width / 2)), screenFrame.maxX - finalSize.width - 8)
            let y = max(screenFrame.minY + 8, round(topY - finalSize.height))
            finalFrame = NSRect(origin: NSPoint(x: x, y: y), size: finalSize)
            resolvedTopY = topY
        }
        menuPanelAnchorMaxY = resolvedTopY
        menuPanelTargetSize = finalFrame.size

        #if !NATIVE_UI_TEST
        let shouldFade = !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        if panel.isVisible {
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0
                ctx.allowsImplicitAnimation = false
                panel.animator().alphaValue = shouldFade ? 0.0 : 1.0
            }
        }
        if shouldFade {
            panel.alphaValue = 0.0
            panel.setFrame(NSRect(x: finalFrame.origin.x, y: finalFrame.origin.y + 4, width: finalFrame.width, height: finalFrame.height), display: true)
            panel.orderFrontRegardless()
            panel.makeKey()
            panel.invalidateShadow()
            let fadeMotion = DesignMotion()
            menuPanelFadeMotion = fadeMotion
            fadeMotion.animate(in: panel.contentView, from: 0.0, to: 1.0, curve: .press, threshold: 0.005) { [weak self, weak panel] t in
                guard let self, self.menuPanelVisibilityGeneration == openGen, let panel else { return }
                panel.alphaValue = t
                panel.setFrameOrigin(NSPoint(x: finalFrame.origin.x, y: round(finalFrame.origin.y + 4.0 * (1.0 - t))))
            } completion: { [weak self, weak panel] in
                guard let self, self.menuPanelVisibilityGeneration == openGen else { return }
                self.menuPanelFadeMotion = nil
                guard let panel else { return }
                panel.alphaValue = 1.0
                panel.setFrameOrigin(finalFrame.origin)
                panel.invalidateShadow()
            }
        } else {
            panel.alphaValue = 1.0
            panel.setFrame(finalFrame, display: true)
            panel.orderFrontRegardless()
            panel.makeKey()
            panel.invalidateShadow()
        }
        button.highlight(true)
        DispatchQueue.main.async { [weak self] in
            guard let self, self.menuPanelVisibilityGeneration == openGen, self.isMenuPanelShown else { return }
            self.item?.button?.highlight(true)
        }
        #else
        panel.setFrame(finalFrame, display: false)
        panel.alphaValue = Assistant.headlessOffscreenUI ? 0.0 : 1.0
        #endif

        controller.view.window?.makeFirstResponder(nil)
        installPopoverMonitors()
        refresh()
        checkAndTriggerOverdueQuotaRefreshIfNeeded()
    }

    func closeMenuPopover(animated: Bool = true) {
        menuPanelVisibilityGeneration &+= 1
        let closeGen = menuPanelVisibilityGeneration
        menuPanelResizeMotion?.cancel()
        menuPanelResizeMotion = nil
        menuPanelFadeMotion?.cancel()
        menuPanelFadeMotion = nil
        menuPanelAnchorMaxY = nil
        menuPanelTargetSize = nil
        removePopoverMonitors()
        item?.button?.highlight(false)
        if menuTracking {
            menuTracking = false
            configureRefreshTimer()
            menuPanelController?.panelDidClose()
        }
        guard let panel = menuPanel, panel.isVisible else {
            isClosingMenuPanel = false
            return
        }
        #if !NATIVE_UI_TEST
        if animated && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            isClosingMenuPanel = true
            NSAnimationContext.runAnimationGroup({ ctx in
                ctx.duration = 0.10
                ctx.timingFunction = CAMediaTimingFunction(name: .easeIn)
                panel.animator().alphaValue = 0.0
            }, completionHandler: { [weak self, weak panel] in
                DispatchQueue.main.async {
                    guard let self, self.menuPanelVisibilityGeneration == closeGen else { return }
                    self.isClosingMenuPanel = false
                    panel?.orderOut(nil)
                    panel?.alphaValue = 1.0
                }
            })
            return
        }
        #endif
        isClosingMenuPanel = false
        panel.orderOut(nil)
        #if NATIVE_UI_TEST
        panel.alphaValue = Assistant.headlessOffscreenUI ? 0.0 : 1.0
        #else
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0
            ctx.allowsImplicitAnimation = false
            panel.animator().alphaValue = 1.0
        }
        panel.alphaValue = 1.0
        #endif
    }

    static func shouldSuppressMenuPopoverDismiss(isTrackingPopUpMenu: Bool = Design.isTrackingPopUpMenu) -> Bool {
        isTrackingPopUpMenu
    }

    private func installPopoverMonitors() {
        removePopoverMonitors()
        popoverGlobalClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self] _ in
            guard let self, self.isMenuPanelShown else { return }
            if Self.shouldSuppressMenuPopoverDismiss() { return }
            if NSApp.windows.contains(where: { $0.isVisible && $0.level.rawValue >= NSWindow.Level.popUpMenu.rawValue }) { return }
            let mouseLoc = NSEvent.mouseLocation
            if let popWin = self.menuPanel, popWin.frame.contains(mouseLoc) { return }
            if let btnWin = self.item?.button?.window, btnWin.frame.contains(mouseLoc) { return }
            self.closeMenuPopover()
        }
        popoverLocalClickMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self] event in
            guard let self, self.isMenuPanelShown else { return event }
            if Self.shouldSuppressMenuPopoverDismiss() { return event }
            if event.window === self.menuPanel { return event }
            if let btnWin = self.item?.button?.window, event.window === btnWin { return event }
            if let win = event.window, win.level.rawValue >= NSWindow.Level.popUpMenu.rawValue { return event }
            self.closeMenuPopover()
            return event
        }
        popoverLocalKeyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, self.isMenuPanelShown,
                  let popWin = self.menuPanel,
                  event.window === popWin else { return event }
            if event.keyCode == 53 { // Escape
                self.closeMenuPopover()
                return nil
            }
            if event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
               let key = event.charactersIgnoringModifiers?.lowercased() {
                switch key {
                case "1":
                    self.menuPanelController?.selectTab(0, persist: true)
                    return nil
                case "2":
                    self.menuPanelController?.selectTab(1, persist: true)
                    return nil
                case "3":
                    self.menuPanelController?.selectTab(2, persist: true)
                    return nil
                case ",":
                    self.closeMenuPopover()
                    self.showSettings()
                    return nil
                case "o":
                    let tab = self.menuPanelController?.selectedTab ?? 0
                    let scope: EnvironmentScope = tab == 1
                        ? self.activeNodeScope
                        : EnvironmentScope(rawEnvironmentId: self.menuPanelController?.selectedEnvironmentId)
                    self.openMainWindowFromMenuPanel(
                        tab: tab,
                        scope: scope,
                        usagePeriod: self.menuPanelController?.selectedPeriod ?? 0,
                        carryLocalToOverview: true
                    )
                    return nil
                case "r":
                    self.menuPanelController?.refreshCurrentTab()
                    return nil
                case "q":
                    self.closeMenuPopover()
                    self.quit()
                    return nil
                default:
                    break
                }
            }
            return event
        }
        let wsCenter = NSWorkspace.shared.notificationCenter
        let myPid = ProcessInfo.processInfo.processIdentifier
        popoverWorkspaceObservers = [
            wsCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] note in
                guard let self, self.isMenuPanelShown else { return }
                guard !Self.shouldSuppressMenuPopoverDismiss() else { return }
                let activeApp = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
                guard let activePid = activeApp?.processIdentifier, activePid != myPid else { return }
                // Allow non-activating overlay/screenshot capture utilities (WeChat capture, macOS Screenshot, CleanShot, Xnip) to inspect and snap to the menu panel without auto-closing it; real clicks outside are already handled by popoverGlobalClickMonitor.
                let bundleId = (activeApp?.bundleIdentifier ?? "").lowercased()
                let isOverlayCaptureHelper = activeApp?.activationPolicy != .regular
                    || bundleId.contains("screencapture")
                    || bundleId.contains("screenshot")
                    || bundleId.contains("cleanshot")
                    || bundleId.contains("snip")
                    || bundleId.contains("xnip")
                if !isOverlayCaptureHelper {
                    self.closeMenuPopover()
                }
            },
            wsCenter.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
                guard let self, self.isMenuPanelShown else { return }
                self.closeMenuPopover()
            }
        ]
        popoverAppObservers = [
            NotificationCenter.default.addObserver(forName: NSWindow.didBecomeKeyNotification, object: nil, queue: .main) { [weak self] note in
                guard let self, self.isMenuPanelShown,
                      let win = note.object as? NSWindow,
                      win === self.window else { return }
                self.closeMenuPopover()
            }
        ]
    }

    private func removePopoverMonitors() {
        if let monitor = popoverGlobalClickMonitor {
            NSEvent.removeMonitor(monitor)
            popoverGlobalClickMonitor = nil
        }
        if let monitor = popoverLocalClickMonitor {
            NSEvent.removeMonitor(monitor)
            popoverLocalClickMonitor = nil
        }
        if let monitor = popoverLocalKeyMonitor {
            NSEvent.removeMonitor(monitor)
            popoverLocalKeyMonitor = nil
        }
        let wsCenter = NSWorkspace.shared.notificationCenter
        for obs in popoverWorkspaceObservers { wsCenter.removeObserver(obs) }
        popoverWorkspaceObservers.removeAll()
        for obs in popoverAppObservers { NotificationCenter.default.removeObserver(obs) }
        popoverAppObservers.removeAll()
    }

    func buildMoreMenu() -> NSMenu {
        let menu = NSMenu(title: L10n.t("menu.more_actions"))
        menu.showsStateColumn = true
        let stateSize = NSSize(width: 13, height: 13)
        let checkmark = NSImage(systemSymbolName: "checkmark", accessibilityDescription: nil)
        checkmark?.size = stateSize; checkmark?.isTemplate = true
        let emptyCheck = NSImage(size: stateSize, flipped: false) { _ in true }

        let langSubmenu = NSMenu(title: L10n.t("menu.language"))
        langSubmenu.showsStateColumn = true
        let configured = pendingLanguageTarget ?? configuration?.value.appLanguage ?? L10n.shared.configuredLanguage
        let sysItem = NSMenuItem(title: L10n.t("language.system"), action: #selector(selectGlobalLanguageFromMenu(_:)), keyEquivalent: "")
        sysItem.target = self
        sysItem.representedObject = "system"
        sysItem.onStateImage = checkmark
        sysItem.offStateImage = emptyCheck
        sysItem.state = configured == "system" ? .on : .off
        langSubmenu.addItem(sysItem)
        langSubmenu.addItem(.separator())
        for meta in L10n.shared.supportedLocales {
            let entry = NSMenuItem(title: meta.nativeName, action: #selector(selectGlobalLanguageFromMenu(_:)), keyEquivalent: "")
            entry.target = self
            entry.representedObject = meta.code
            entry.onStateImage = checkmark
            entry.offStateImage = emptyCheck
            entry.state = configured == meta.code ? .on : .off
            langSubmenu.addItem(entry)
        }
        let langItem = NSMenuItem(title: L10n.t("menu.language"), action: nil, keyEquivalent: "")
        langItem.submenu = langSubmenu
        menu.addItem(langItem)

        let hudToggle = add(menu, L10n.t("settings.hud.title"), #selector(toggleHud))
        hudToggle.onStateImage = checkmark
        hudToggle.offStateImage = emptyCheck
        hudToggle.state = effectiveHudEnabled() ? NSControl.StateValue.on : NSControl.StateValue.off
        hudToggle.isEnabled = reachable && statusValue.mode != "unsupported"

        menu.addItem(.separator())
        add(menu, L10n.t("menu.settings"), #selector(showSettingsFromMenuPanel), ",")
        menu.addItem(.separator())
        add(menu, L10n.t("menu.quit"), #selector(quitFromMenuPanel), "q")
        return menu
    }

    @objc func showSettingsFromMenuPanel() {
        closeMenuPopover(animated: false)
        showSettings()
    }

    @objc func quitFromMenuPanel() {
        closeMenuPopover(animated: false)
        quit()
    }

    func openMainWindowFromMenuPanel(tab: Int, usagePeriod: Int, usageEnvironmentId: String? = nil) {
        let scope = EnvironmentScope(rawEnvironmentId: usageEnvironmentId)
        openMainWindowFromMenuPanel(
            tab: tab,
            scope: tab == 1 ? activeNodeScope : scope,
            usagePeriod: usagePeriod,
            carryLocalToOverview: false
        )
    }

    /// Wave 2 symmetrical entry: carries the active environment scope from MenuPanel into Usage or Overview.
    func openMainWindowFromMenuPanel(
        tab: Int,
        scope: EnvironmentScope,
        usagePeriod: Int = 0,
        carryLocalToOverview: Bool = true
    ) {
        closeMenuPopover(animated: false)
        switch tab {
        case 0:
            let targetPeriod = max(0, min(3, usagePeriod))
            usageSelectedPeriod = targetPeriod
            let resolvedEnv = scope.rawEnvironmentId
            usageSelectedEnvironment = resolvedEnv
            usageFilterScope = scope
            if let configuration, configuration.value.menuUsageEnvironmentId != resolvedEnv {
                configuration.value.menuUsageEnvironmentId = resolvedEnv
                scheduleConfigurationSave()
            }
            usageScrollOrigin = .zero
            usagePage?.periodSegment.selectedSegment = targetPeriod
            let hadUsagePage = (usagePage != nil)
            selectPage(2)
            if hadUsagePage, let usagePage {
                usagePage.applyExternalFilter(period: targetPeriod, environmentId: resolvedEnv)
            }
        case 1:
            switch scope {
            case .remote(let envId):
                if canonicalRemoteHosts().contains(where: { $0.environmentId == envId }) {
                    selectOverviewEnvironment("env:\(envId)")
                } else {
                    selectOverviewEnvironment("all")
                }
            case .local:
                selectOverviewEnvironment(carryLocalToOverview ? "local" : "all")
            case .all:
                selectOverviewEnvironment("all")
            }
            selectPage(0)
        case 2:
            selectPage(1)
        default:
            selectPage(0)
        }
    }

    @objc func showPanel() {
        guard !quitting else { return }
        if isMenuPanelShown {
            closeMenuPopover(animated: false)
        }
        if window == nil {
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 1024, height: 710),
                styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                backing: .buffered,
                defer: false
            )
            #if NATIVE_UI_TEST
            Assistant.configureHeadlessWindowIfNeeded(window)
            #endif
            window.titlebarAppearsTransparent = true
            window.isReleasedWhenClosed = false
            window.delegate = self
            window.minSize = NSSize(width: 880, height: 580)
            #if NATIVE_UI_TEST
            if !Assistant.headlessOffscreenUI {
                window.setFrameAutosaveName("GravityBox.MainWindow.v08")
            }
            #else
            window.setFrameAutosaveName("GravityBox.MainWindow.v08")
            #endif
            window.toolbar = nil
            window.titleVisibility = .hidden
            window.title = "GravityBox"
            window.titlebarSeparatorStyle = .none
            window.isMovableByWindowBackground = true

            let split = NSSplitViewController()
            split.view.wantsLayer = true
            let sideController = NSViewController()
            let side = NSVisualEffectView()
            side.material = .sidebar
            side.blendingMode = .behindWindow
            side.state = .active
            side.wantsLayer = true
            sideController.view = side

            let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("navigation"))
            column.resizingMask = .autoresizingMask
            sidebar.addTableColumn(column)
            sidebar.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
            sidebar.headerView = nil
            sidebar.rowHeight = 36
            sidebar.style = .plain
            sidebar.backgroundColor = .clear
            sidebar.selectionHighlightStyle = .none
            sidebar.intercellSpacing = NSSize(width: 0, height: 4)
            sidebar.dataSource = self
            sidebar.delegate = self
            sidebar.setAccessibilityLabel(L10n.t("nav.accessibility", fallback: "导航"))
            sidebar.addSubview(pillSelectionView, positioned: .below, relativeTo: nil)
            pillSelectionView.autoresizingMask = [.width]

            let scroll = NSScrollView()
            scroll.documentView = sidebar
            scroll.hasVerticalScroller = false
            scroll.drawsBackground = false

            let brandHeader = NSView()
            let brandIconView: NSImageView = {
                if let mark = Design.brandMarkImage() {
                    let iv = NSImageView(image: mark)
                    iv.imageScaling = .scaleProportionallyUpOrDown
                    return iv
                } else {
                    return symbol("app.fill", size: 16, color: Design.blue)
                }
            }()
            brandIconView.translatesAutoresizingMaskIntoConstraints = false
            let brandLabel = text("GravityBox", size: 14.5, weight: .semibold, color: .labelColor)
            brandLabel.translatesAutoresizingMaskIntoConstraints = false
            brandHeader.addSubview(brandIconView)
            brandHeader.addSubview(brandLabel)
            NSLayoutConstraint.activate([
                brandIconView.leadingAnchor.constraint(equalTo: brandHeader.leadingAnchor, constant: 12),
                brandIconView.centerYAnchor.constraint(equalTo: brandHeader.centerYAnchor),
                brandIconView.widthAnchor.constraint(equalToConstant: 20),
                brandIconView.heightAnchor.constraint(equalToConstant: 20),
                brandLabel.leadingAnchor.constraint(equalTo: brandIconView.trailingAnchor, constant: 8),
                brandLabel.centerYAnchor.constraint(equalTo: brandHeader.centerYAnchor),
                brandLabel.trailingAnchor.constraint(lessThanOrEqualTo: brandHeader.trailingAnchor, constant: -8),
                brandHeader.heightAnchor.constraint(equalToConstant: 28)
            ])

            let installBtn = SidebarLaunchButton(
                title: L10n.t("sidebar.install_update", fallback: "安装更新"),
                symbolName: "arrow.down.app",
                isUpdatePrompt: true,
                target: self,
                action: #selector(installUpdateFromSidebar)
            )
            installBtn.isHidden = true
            installUpdateButton = installBtn

            let globalOpenBtn = SidebarLaunchButton(title: L10n.t("sidebar.open_antigravity", fallback: "打开 Antigravity"), target: self, action: #selector(openAntigravity))
            launchApplicationButton = globalOpenBtn

            serviceFootnoteLabel.alignment = .left
            serviceFootnoteLabel.lineBreakMode = .byTruncatingTail
            serviceFootnoteLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            updateServiceFootnote()

            let footnoteBox = NSView()
            footnoteBox.addSubview(serviceFootnoteLabel)
            serviceFootnoteLabel.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                serviceFootnoteLabel.leadingAnchor.constraint(equalTo: footnoteBox.leadingAnchor, constant: 12),
                serviceFootnoteLabel.trailingAnchor.constraint(lessThanOrEqualTo: footnoteBox.trailingAnchor, constant: -8),
                serviceFootnoteLabel.topAnchor.constraint(equalTo: footnoteBox.topAnchor),
                serviceFootnoteLabel.bottomAnchor.constraint(equalTo: footnoteBox.bottomAnchor)
            ])

            let bottomStack = vertical([footnoteBox, installBtn, globalOpenBtn], spacing: 6)
            bottomStack.detachesHiddenViews = true
            footnoteBox.isHidden = reachable
            let sideStack = vertical([brandHeader, scroll, bottomStack], spacing: 10)
            side.addSubview(sideStack)
            sideStack.translatesAutoresizingMaskIntoConstraints = false
            let sideSeparator = SidebarSeparatorView()
            sideSeparator.translatesAutoresizingMaskIntoConstraints = false
            side.addSubview(sideSeparator)
            NSLayoutConstraint.activate([
                sideSeparator.trailingAnchor.constraint(equalTo: side.trailingAnchor),
                sideSeparator.topAnchor.constraint(equalTo: side.topAnchor),
                sideSeparator.bottomAnchor.constraint(equalTo: side.bottomAnchor),
                sideSeparator.widthAnchor.constraint(equalToConstant: 1),
                sideStack.leadingAnchor.constraint(equalTo: side.leadingAnchor, constant: 12),
                sideStack.trailingAnchor.constraint(equalTo: side.trailingAnchor, constant: -12),
                sideStack.topAnchor.constraint(equalTo: side.safeAreaLayoutGuide.topAnchor, constant: 16),
                sideStack.bottomAnchor.constraint(equalTo: side.bottomAnchor, constant: -14)
            ])
            fillWidth(brandHeader, in: sideStack)
            fillWidth(scroll, in: sideStack)
            fillWidth(bottomStack, in: sideStack)
            fillWidth(footnoteBox, in: bottomStack)
            fillWidth(installBtn, in: bottomStack)
            fillWidth(globalOpenBtn, in: bottomStack)
            syncUpdatePromptControls()
            scroll.setContentHuggingPriority(.defaultLow, for: .vertical)

            let left = NSSplitViewItem(sidebarWithViewController: sideController)
            left.minimumThickness = 190
            left.maximumThickness = 210
            left.canCollapse = false
            split.addSplitViewItem(left)

            let content = NSViewController()
            let root = SurfaceView()
            content.view = root
            let rootStack = vertical([pageHost], spacing: 0)
            root.addSubview(rootStack)
            rootStack.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                rootStack.leadingAnchor.constraint(equalTo: root.leadingAnchor),
                rootStack.trailingAnchor.constraint(equalTo: root.trailingAnchor),
                rootStack.topAnchor.constraint(equalTo: root.topAnchor),
                rootStack.bottomAnchor.constraint(equalTo: root.bottomAnchor)
            ])
            fillWidth(pageHost, in: rootStack)
            pageHost.setContentHuggingPriority(.defaultLow, for: .vertical)
            split.addSplitViewItem(NSSplitViewItem(viewController: content))
            window.contentViewController = split
            self.window = window
            Design.applyControls(split.view)
            currentPage = min(names.count - 1, max(0, configuration.value.lastPage))
            sidebar.selectRowIndexes(IndexSet(integer: currentPage), byExtendingSelection: false)
            navigate(currentPage)
            updateNavigationAppearance()
            #if NATIVE_UI_TEST
            let restored = Assistant.headlessOffscreenUI ? false : window.setFrameUsingName("GravityBox.MainWindow.v08")
            #else
            let restored = window.setFrameUsingName("GravityBox.MainWindow.v08")
            #endif
            if window.frame.width < window.minSize.width || window.frame.height < window.minSize.height {
                var clampedFrame = window.frame
                clampedFrame.size.width = max(clampedFrame.size.width, window.minSize.width)
                clampedFrame.size.height = max(clampedFrame.size.height, window.minSize.height)
                window.setFrame(clampedFrame, display: false)
            }
            #if NATIVE_UI_TEST
            if Assistant.headlessOffscreenUI {
                window.setFrameOrigin(NSPoint(x: -24000, y: -24000))
            } else {
                let visible = NSScreen.screens.contains {
                    $0.visibleFrame.intersection(window.frame).width >= 120 &&
                    $0.visibleFrame.intersection(window.frame).height >= 100
                }
                if !restored || !visible { window.center() }
            }
            #else
            let visible = NSScreen.screens.contains {
                $0.visibleFrame.intersection(window.frame).width >= 120 &&
                $0.visibleFrame.intersection(window.frame).height >= 100
            }
            if !restored || !visible { window.center() }
            #endif
        }
        #if !NATIVE_UI_TEST
        let wasAccessory = NSApp.activationPolicy() != .regular
        if wasAccessory {
            NSApp.setActivationPolicy(.regular)
        }
        if window?.isMiniaturized == true {
            window?.deminiaturize(nil)
        }
        Design.activateApplicationForcingFront()
        window?.makeKeyAndOrderFront(nil)
        if wasAccessory {
            let ensureFrontActivation: () -> Void = { [weak self] in
                guard let self, let win = self.window, win.isVisible, !self.quitting else { return }
                if !NSApp.isActive {
                    Design.activateApplicationForcingFront()
                }
                if !win.isKeyWindow {
                    win.makeKeyAndOrderFront(nil)
                }
            }
            DispatchQueue.main.async(execute: ensureFrontActivation)
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(80), execute: ensureFrontActivation)
        }
        #endif
        configureRefreshTimer()
        if quotaRefreshTimer == nil { configureQuotaRefreshTimer() }
        refresh()
    }
    func numberOfRows(in tableView: NSTableView) -> Int { names.count }
    func tableView(_ tableView: NSTableView, rowViewForRow row: Int) -> NSTableRowView? {
        let view = SidebarRowView()
        view.navigationSelected = sidebar.selectedRow == row
        return view
    }
    private func navTextColor(selected: Bool) -> NSColor {
        guard selected else { return Design.dynamicAlpha(Design.primary, 0.84) }
        return NSColor(name: nil) { app in
            app.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? .white
                : Design.blue
        }
    }
    private func navIconColor(selected: Bool) -> NSColor {
        guard selected else { return Design.secondary }
        return Design.activeBlue
    }
    private func navSymbolName(row: Int, selected: Bool) -> String {
        let outline = ["square.grid.2x2", "person.2", "chart.bar", "gearshape", "info.circle"][row]
        let filled = ["square.grid.2x2.fill", "person.2.fill", "chart.bar.fill", "gearshape.fill", "info.circle.fill"][row]
        return selected ? filled : outline
    }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let cell = NSTableCellView()
        let selected = sidebar.selectedRow == row
        let label = text(names[row], size: 13, weight: selected ? .semibold : .medium, color: navTextColor(selected: selected))
        cell.textField = label
        let icon = symbol(navSymbolName(row: row, selected: selected), size: 14.5, color: navIconColor(selected: selected))
        icon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 14.5, weight: selected ? .semibold : .medium)
        cell.imageView = icon
        let content = horizontal([icon, label], spacing: 10)
        content.alignment = .centerY
        cell.addSubview(content)
        content.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 12),
            content.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
            content.trailingAnchor.constraint(lessThanOrEqualTo: cell.trailingAnchor, constant: -10)
        ])
        cell.setAccessibilityLabel(names[row])
        return cell
    }
    func tableViewSelectionDidChange(_ notification: Notification) {
        updateNavigationAppearance()
        let row = sidebar.selectedRow
        if row >= 0 { navigate(row) }
    }
    func updateNavigationAppearance() {
        let selected = sidebar.selectedRow
        if selected >= 0 && selected < names.count {
            let rowRect = sidebar.rect(ofRow: selected)
            if rowRect.width > 0 && rowRect.height > 0 {
                pillSelectionView.isHidden = false
                pillSelectionView.slide(to: rowRect, in: sidebar)
            }
        } else {
            pillSelectionView.isHidden = true
        }
        for row in names.indices {
            let isCurrent = row == selected
            (sidebar.rowView(atRow: row, makeIfNecessary: false) as? SidebarRowView)?.navigationSelected = isCurrent
            if let cell = sidebar.view(atColumn: 0, row: row, makeIfNecessary: false) as? NSTableCellView {
                cell.textField?.font = .systemFont(ofSize: 13, weight: isCurrent ? .semibold : .medium)
                cell.textField?.textColor = navTextColor(selected: isCurrent)
                if let image = cell.imageView {
                    image.image = NSImage(systemSymbolName: navSymbolName(row: row, selected: isCurrent), accessibilityDescription: nil)
                    image.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 14.5, weight: isCurrent ? .semibold : .medium)
                    image.contentTintColor = navIconColor(selected: isCurrent)
                }
            }
        }
    }

    func currentContentPage() -> NSView? {
        switch currentPage {
        case 1: return accountsPage?.view
        case 2: return usagePage?.view
        case 3: return preferencesController?.view
        case 4: return aboutPage?.view
        default: return overview?.view
        }
    }

    func applyLocalizedChrome() {
        installApplicationMenu()
        if window != nil {
            let deferPrefsSheetRebuild = preferencesController?.maintenanceSheet != nil || preferencesController?.pricingSheet != nil
            let deferStorageCacheRebuild = deferPrefsSheetRebuild || cachePage?.busy == true
            sidebar.setAccessibilityLabel(L10n.t("nav.accessibility", fallback: "导航"))
            sidebar.reloadData()
            if names.indices.contains(currentPage) {
                sidebar.selectRowIndexes(IndexSet(integer: currentPage), byExtendingSelection: false)
            }
            updateNavigationAppearance()
            installUpdateButton?.setDisplayTitle(L10n.t("sidebar.install_update", fallback: "安装更新"))
            launchApplicationButton?.setDisplayTitle(L10n.t("sidebar.open_antigravity", fallback: "打开 Antigravity"))
            if let usagePage {
                usageSelectedPeriod = usagePage.periodSegment.selectedSegment
                usageSelectedEnvironment = usagePage.selectedEnvironmentId
                usageSelectedAccount = usagePage.selectedAccountId
                if let scroll = usagePage.view as? NSScrollView {
                    usageScrollOrigin = scroll.contentView.bounds.origin
                }
            }
            overview = nil
            accountsPage = nil
            usagePage = nil
            if !deferStorageCacheRebuild {
                cachePage = nil
            }
            if !deferPrefsSheetRebuild {
                pendingLocalizedRebuildAfterMaintenance = deferStorageCacheRebuild
                preferencesController = nil
            } else {
                pendingLocalizedRebuildAfterMaintenance = true
                preferencesController?.update()
            }
            aboutPage = nil
            navigate(currentPage, force: true)
        }
        menuPanelResizeMotion?.cancel()
        menuPanelResizeMotion = nil
        menuPanelFadeMotion?.cancel()
        menuPanelFadeMotion = nil
        if isMenuPanelShown, let panel = menuPanel {
            menuPanelController = nil
            let refreshed = ensureMenuPanelController()
            attachMenuPanelContent(refreshed, to: panel)
            refreshed.panelWillOpen()
            resizeMenuPanel(to: refreshed.measuredPanelSize, animate: false)
        } else {
            menuPanelController = nil
            menuPanel?.contentView = nil
        }
        updateViews()
    }

    func selectPage(_ index: Int) {
        guard names.indices.contains(index), window?.activeSheetWindow == nil else { return }; showPanel()
        if sidebar.selectedRow == index { navigate(index) }
        else { sidebar.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false) }
        updateNavigationAppearance()
    }
    @objc func menuNavigate(_ item: NSMenuItem) { selectPage(item.tag) }
    func navigate(_ index: Int, force: Bool = false) {
        guard names.indices.contains(index) else { return }
        let navSignpost = PerformanceSignpost.begin("NavigatePage")
        defer { PerformanceSignpost.end("NavigatePage", navSignpost) }
        let hadContent = !pageHost.subviews.isEmpty
        if index == currentPage && hadContent && !force { return }
        let previousPage = currentPage
        if let usagePage {
            usageSelectedPeriod = usagePage.periodSegment.selectedSegment
            usageSelectedEnvironment = usagePage.selectedEnvironmentId
            usageSelectedAccount = usagePage.selectedAccountId
            if let scroll = usagePage.view as? NSScrollView { usageScrollOrigin = scroll.contentView.bounds.origin }
        }
        currentPage = index
        if configuration.value.lastPage != index {
            configuration.value.lastPage = index
            scheduleConfigurationSave()
        }
        let content: NSView
        let isNewPage: Bool
        switch index {
        case 1:
            isNewPage = accountsPage == nil
            let page = accountsPage ?? AccountsPage(app: self)
            accountsPage = page
            if !isNewPage { page.update() }
            content = page.view
        case 2:
            isNewPage = usagePage == nil
            let page = usagePage ?? UsagePage(app: self)
            usagePage = page
            if !isNewPage { page.update() }
            content = page.view
        case 3:
            isNewPage = preferencesController == nil
            let page = preferencesController ?? PreferencesController(app: self)
            preferencesController = page
            page.update()
            content = page.view
        case 4:
            isNewPage = aboutPage == nil
            let page = aboutPage ?? AboutPage(app: self)
            aboutPage = page
            page.update()
            content = page.view
        default:
            isNewPage = overview == nil
            let page = overview ?? DashboardPage(app: self)
            overview = page
            if !isNewPage { page.update() }
            content = page.view
        }
        let oldViews = pageHost.subviews.filter { $0 !== content }
        let animateFade = hadContent && Design.shouldAnimate(in: pageHost)
        if !animateFade {
            for oldView in oldViews {
                oldView.layer?.removeAllAnimations()
                oldView.removeFromSuperview()
                oldView.alphaValue = 1.0
            }
        }
        content.layer?.removeAllAnimations()
        content.wantsLayer = true
        if content.superview !== pageHost {
            pageHost.addSubview(content)
            pin(content, to: pageHost)
        } else {
            pageHost.addSubview(content)
        }
        if isNewPage { Design.applyControls(content) }
        pageHost.layoutSubtreeIfNeeded()
        window?.makeFirstResponder(sidebar); window?.title = "GravityBox"; updateViews()
        if animateFade {
            let offsetY: CGFloat = index > previousPage ? -6.0 : 6.0
            content.alphaValue = 0.0
            content.layer?.transform = CATransform3DMakeTranslation(0, offsetY, 0)
            for oldView in oldViews {
                oldView.layer?.removeAllAnimations()
                oldView.wantsLayer = true
            }
            NSAnimationContext.runAnimationGroup({ ctx in
                ctx.duration = 0.22
                ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.22, 1.0, 0.36, 1.0)
                content.animator().alphaValue = 1.0
                content.layer?.transform = CATransform3DIdentity
                for oldView in oldViews {
                    oldView.animator().alphaValue = 0.0
                }
            }, completionHandler: { [weak self] in
                guard let self else { return }
                content.layer?.transform = CATransform3DIdentity
                let active = self.currentContentPage()
                for oldView in oldViews {
                    if oldView !== active && oldView.superview === self.pageHost {
                        oldView.removeFromSuperview()
                        oldView.alphaValue = 1.0
                        oldView.layer?.transform = CATransform3DIdentity
                    }
                }
            })
        } else {
            content.alphaValue = 1.0
            content.layer?.transform = CATransform3DIdentity
        }
    }
    func standbyRefreshMode(_ acc: [String: Any]) -> String? {
        if let activeRemoteIds = acc["activeRemoteEnvIds"] as? [String], !activeRemoteIds.isEmpty {
            return nil
        }
        if quotaSourceEnvironment(forAccount: acc) != nil {
            return nil
        }
        let remoteHosts = canonicalRemoteHosts()
        if !remoteHosts.isEmpty && SshEnvironmentResolver.matchingHosts(forAccount: acc, hosts: remoteHosts).contains(where: { $0.state == .online }) {
            return nil
        }
        guard let status = acc["standbyRefreshStatus"] as? [String: Any],
              let mode = status["mode"] as? String else { return nil }
        let trimmed = mode.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    func isStandbySnapshotOnly(_ acc: [String: Any]) -> Bool {
        let mode = standbyRefreshMode(acc)
        return mode == "snapshot_cooling" || mode == "snapshot_cooldown_elapsed"
    }

    func isEligibleForAutoQuotaRefresh(_ acc: [String: Any]) -> Bool {
        if acc["disabled"] as? Bool == true { return false }
        if acc["validation_blocked"] as? Bool == true { return false }
        if let readiness = acc["credentialReadiness"] as? [String: Any],
           readiness["state"] as? String == "needs_authorization" { return false }
        if isStandbySnapshotOnly(acc) { return false }
        return true
    }

    func installQuotaScheduleObservers() {
        #if !NATIVE_UI_TEST
        if workspaceWakeObserver == nil {
            workspaceWakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
                forName: NSWorkspace.didWakeNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                self?.configureQuotaRefreshTimer(preserveSchedule: true)
                self?.refresh()
            }
        }
        if appBecomeActiveObserver == nil {
            appBecomeActiveObserver = NotificationCenter.default.addObserver(
                forName: NSApplication.didBecomeActiveNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                self?.checkAndTriggerOverdueQuotaRefreshIfNeeded()
            }
        }
        #endif
    }

    func removeQuotaScheduleObservers() {
        if let observer = workspaceWakeObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
            workspaceWakeObserver = nil
        }
        if let observer = appBecomeActiveObserver {
            NotificationCenter.default.removeObserver(observer)
            appBecomeActiveObserver = nil
        }
        if let observer = popUpMenuCloseObserver {
            NotificationCenter.default.removeObserver(observer)
            popUpMenuCloseObserver = nil
        }
    }

    func oldestEnabledAccountQuotaTimestamp() -> TimeInterval? {
        var oldest: TimeInterval? = nil
        var hasEligible = false
        for acc in cachedAccounts {
            guard isEligibleForAutoQuotaRefresh(acc) else { continue }
            hasEligible = true
            let quota = acc["quota"] as? [String: Any]
            let rawStamp = QuotaPresentation.number(acc["persisted_quota_last_updated"])
                ?? QuotaPresentation.number(quota?["last_updated"])
                ?? QuotaPresentation.number(acc["quota_last_updated"])
                ?? 0
            let stamp = rawStamp > 10_000_000_000 ? rawStamp / 1000.0 : rawStamp
            if stamp <= 0 {
                return 0
            }
            if let currentOldest = oldest {
                if stamp < currentOldest { oldest = stamp }
            } else {
                oldest = stamp
            }
        }
        return hasEligible ? oldest : nil
    }

    @discardableResult
    func triggerResetOverdueRefreshIfNeeded(for account: [String: Any], now: Date = Date()) -> Bool {
        guard !quitting, reachable, !quotaRefreshing, pendingAccountTaskId == nil else { return false }
        guard isEligibleForAutoQuotaRefresh(account) else { return false }
        guard let id = account["id"] as? String, !id.isEmpty, !refreshingAccountIds.contains(id) else { return false }
        let signature = QuotaPresentation.contract(account).overdueResetSignature(at: now)
        guard !signature.isEmpty else { return false }
        if let prev = lastResetOverdueRefreshByAccount[id] {
            let elapsed = now.timeIntervalSince(prev.at)
            if prev.signature == signature && elapsed < 90.0 { return false }
            if elapsed < 20.0 { return false }
        }
        lastResetOverdueRefreshByAccount[id] = (signature: signature, at: now)
        refreshSingleAccountQuota(id: id)
        return true
    }

    func checkAndTriggerOverdueQuotaRefreshIfNeeded() {
        guard !quitting, reachable else { return }
        let now = Date()
        let minutes = configuration?.value.quotaRefreshMinutes ?? 0
        let autoEnabled = [5, 10, 15, 30, 60].contains(minutes)

        if quotaRefreshing || pendingAccountTaskId != nil {
            if autoEnabled, let scheduledAt = nextScheduledQuotaRefreshAt, now >= scheduledAt {
                pendingAutoQuotaRefresh = true
            }
            return
        }

        if autoEnabled {
            let interval = TimeInterval(minutes * 60)
            if cachedAccounts.isEmpty {
                if !accountListInFlight && now.timeIntervalSince(lastAccountListFetchAt) >= 15.0 {
                    fetchAccountList(notifyPage: false)
                }
                if pendingAutoQuotaRefresh || (nextScheduledQuotaRefreshAt.map { now >= $0 } ?? false) {
                    if now.timeIntervalSince(lastAutoQuotaRefreshTriggerAt) >= 60.0 {
                        pendingAutoQuotaRefresh = false
                        lastAutoQuotaRefreshTriggerAt = now
                        nextScheduledQuotaRefreshAt = now.addingTimeInterval(interval)
                        refreshAccountQuotas()
                    }
                }
                return
            }

            let oldest = oldestEnabledAccountQuotaTimestamp()
            let age = oldest.map { $0 > 0 ? now.timeIntervalSince1970 - $0 : .infinity } ?? 0
            let ageDue = oldest != nil && age >= interval
            let wallDue = nextScheduledQuotaRefreshAt.map { now >= $0 } ?? false

            if pendingAutoQuotaRefresh || ageDue || wallDue {
                if now.timeIntervalSince(lastAutoQuotaRefreshTriggerAt) >= 60.0 {
                    pendingAutoQuotaRefresh = false
                    lastAutoQuotaRefreshTriggerAt = now
                    nextScheduledQuotaRefreshAt = now.addingTimeInterval(interval)
                    refreshAccountQuotas()
                    return
                }
            }
        } else {
            pendingAutoQuotaRefresh = false
        }

        // 当任意启用账号出现“重置时间已过”窗口（刚重新进入 5h / 7d 计时周期）且处于可见刷新场景或开启了自动刷新时，主动纠偏单账号配额
        let shouldAutoCorrectOverdueReset = autoEnabled || menuTracking || isMenuPanelShown || (contentVisible && currentPage <= 1)
        if shouldAutoCorrectOverdueReset && !cachedAccounts.isEmpty {
            for acc in cachedAccounts {
                if triggerResetOverdueRefreshIfNeeded(for: acc, now: now) {
                    break
                }
            }
        }
    }

    func configureQuotaRefreshTimer(preserveSchedule: Bool = false) {
        quotaRefreshTimer?.invalidate(); quotaRefreshTimer = nil
        guard let configuration, !quitting else { return }
        let minutes = configuration.value.quotaRefreshMinutes
        guard [5, 10, 15, 30, 60].contains(minutes) else {
            nextScheduledQuotaRefreshAt = nil
            pendingAutoQuotaRefresh = false
            return
        }
        let interval = TimeInterval(minutes * 60)
        let now = Date()
        let targetFireDate: Date
        if preserveSchedule, let existing = nextScheduledQuotaRefreshAt, existing > now.addingTimeInterval(1.0) {
            targetFireDate = existing
        } else if let oldest = oldestEnabledAccountQuotaTimestamp(), oldest > 0 {
            let aligned = Date(timeIntervalSince1970: oldest).addingTimeInterval(interval)
            targetFireDate = aligned > now.addingTimeInterval(1.0) ? aligned : now.addingTimeInterval(interval)
        } else {
            targetFireDate = now.addingTimeInterval(interval)
        }
        nextScheduledQuotaRefreshAt = targetFireDate

        let timer = Timer(fire: targetFireDate, interval: interval, repeats: true) { [weak self] _ in
            guard let self, !self.quitting else { return }
            let fireNow = Date()
            self.nextScheduledQuotaRefreshAt = fireNow.addingTimeInterval(interval)
            guard self.reachable else { return }
            guard !self.quotaRefreshing, self.pendingAccountTaskId == nil else {
                self.pendingAutoQuotaRefresh = true
                return
            }
            self.pendingAutoQuotaRefresh = false
            self.lastAutoQuotaRefreshTriggerAt = fireNow
            self.refreshAccountQuotas()
        }
        timer.tolerance = min(5.0, interval * 0.02)
        RunLoop.main.add(timer, forMode: .common)
        quotaRefreshTimer = timer
        checkAndTriggerOverdueQuotaRefreshIfNeeded()
    }
    func configureRefreshTimer(){
        guard !quitting else { return }
        timer?.invalidate()
        // 仅在窗口可见或状态栏菜单展开时采用 3s 前台节奏；无窗口/隐藏/遮挡驻留时统一降频至 12s。
        let visible = menuTracking || contentVisible
        timer=Timer.scheduledTimer(withTimeInterval:visible ? 3:12,repeats:true){[weak self]_ in self?.refresh()};timer?.tolerance=visible ? 0.5:3
        if let timer { RunLoop.main.add(timer, forMode: .common) }
    }
    static func desiredActivationPolicy(isWindowVisible: Bool, isWindowMiniaturized: Bool, isQuitting: Bool) -> NSApplication.ActivationPolicy {
        guard !isQuitting else { return .accessory }
        return (isWindowVisible || isWindowMiniaturized) ? .regular : .accessory
    }

    private func syncActivationPolicy() {
        #if !NATIVE_UI_TEST
        let desired = Self.desiredActivationPolicy(
            isWindowVisible: window?.isVisible == true,
            isWindowMiniaturized: window?.isMiniaturized == true,
            isQuitting: quitting
        )
        if NSApp.activationPolicy() != desired {
            NSApp.setActivationPolicy(desired)
        }
        #endif
    }

    func windowWillClose(_ notification:Notification){DispatchQueue.main.async{[weak self]in guard let self else{return};self.configureRefreshTimer();self.syncActivationPolicy()}}
    func windowDidMiniaturize(_ notification:Notification){configureRefreshTimer();syncActivationPolicy()}
    func windowDidDeminiaturize(_ notification:Notification){configureRefreshTimer();syncActivationPolicy();refresh()}
    func windowDidChangeOcclusionState(_ notification:Notification){configureRefreshTimer()}

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { handleAppIconReopen(); return true }
    @objc func showAccounts() { selectPage(1) }
    @objc func showUsage() { selectPage(2) }
    @objc func showSettings() { selectPage(3) }
    @objc func showAbout() { selectPage(4) }
    @objc func about() {
        showAbout()
    }
    func perform(_ payload: [String: Any], completion: (([String: Any]) -> Void)? = nil) {
        bridge.send(payload) { [weak self] result in switch result { case .success(let value): completion?(value); case .failure(let error): self?.showMessage(error.localizedDescription, error: true) } }
    }
    func refresh(taskPollOnly: Bool = false) {
        guard !quitting else { return }
        if refreshInFlight {
            if taskPollOnly {
                pendingTaskPollRequested = true
            } else {
                pendingRefreshRequested = true
            }
            return
        }
        refreshInFlight = true
        if let started = quotaRefreshStartedAt, Date().timeIntervalSince(started) > 45 { failPendingQuotaRefresh(L10n.t("assistant.quota_refresh_timeout", fallback: "刷新超时，请重试；保留上次配额"), cancelBackendTask: true) }
        let needTasks = taskPollOnly || pendingAccountTaskId != nil || quotaRefreshing
        let includeAccounts = !taskPollOnly && (menuTracking || (contentVisible && currentPage <= 1))
        let previousTaskRev = lastTaskRevision
        bridge.send(["command": "status","includeTasks":needTasks,"includeAccounts":includeAccounts,"tasksSince":reachable ? lastTaskRevision:-1]) { [weak self] result in guard let self else { return }; self.refreshInFlight = false
            switch result {
            case .success(let value):
                self.updateManager.cleanupAfterSuccessfulLaunch()
                let prevRemoteSyncRevision = self.statusValue.remoteSyncRevision
                let prevEnvironmentsRevision = self.environmentsRevision
                self.reachable = true; self.recoveryAttempts = 0; self.autoRestartAttempts = 0
                var raw=value["status"] as? [String:Any] ?? [:]
                raw["taskRevision"]=value["taskRevision"];raw["runningTasks"]=value["runningTasks"]
                if raw["environments"] == nil, let topEnvs = value["environments"] { raw["environments"] = topEnvs }
                if raw["environmentsRevision"] == nil, let topEnvRev = value["environmentsRevision"] { raw["environmentsRevision"] = topEnvRev }
                if raw["focusedEnvironmentId"] == nil, let topFocused = value["focusedEnvironmentId"] { raw["focusedEnvironmentId"] = topFocused }
                self.statusValue=self.mergeStatusSnapshot(raw, previous:self.statusValue)
                self.syncEnvironmentsFromPayload(raw, notifyUI: true, notifyMenuPanel: false)
                if self.statusValue.remoteSyncRevision > prevRemoteSyncRevision || self.environmentsRevision > prevEnvironmentsRevision {
                    self.usageLastFetchTimeByPeriod.removeAll()
                }
                var taskRevAdvanced = false
                if let rows=value["tasks"] as? [[String:Any]] {
                    self.taskRows=rows
                    let incomingRev = value["taskRevision"] as? Int ?? 0
                    taskRevAdvanced = previousTaskRev >= 0 && incomingRev != previousTaskRev
                    self.lastTaskRevision = incomingRev
                }
                if includeAccounts {
                    let revisionDiff = !self.statusValue.accountsRevision.isEmpty
                        && self.statusValue.accountsRevision != self.lastFetchedAccountsRevision
                        && (!self.accountListInFlight || self.statusValue.accountsRevision != self.accountListInFlightRevision)
                    let emailDiff = self.statusValue.liveAccountEmail != self.lastFetchedLiveEmail
                        && (!self.accountListInFlight || self.statusValue.liveAccountEmail != self.accountListInFlightLiveEmail)
                    let accountsChanged = self.bootstrappedAccounts || revisionDiff || emailDiff
                    let periodicAccountRefreshDue = !self.accountListInFlight
                        && (self.menuTracking || (self.contentVisible && self.currentPage == 1))
                        && Date().timeIntervalSince(self.lastAccountListFetchAt) >= 15.0
                    if (!self.hasLoadedAccountsOnce && !self.accountListInFlight) || accountsChanged || periodicAccountRefreshDue {
                        self.fetchAccountList(notifyPage: true)
                    }
                }
                if let pending = self.pendingAccountTaskId {
                    if let task = self.taskRows.first(where: { $0["id"] as? String == pending && $0["state"] as? String != "running" }) {
                        self.pendingAccountTaskId = nil
                        if self.quotaRefreshing { self.finishQuotaRefresh(error: task["state"] as? String == "succeeded" ? nil : (task["message"] as? String ?? L10n.t("assistant.quota_refresh_incomplete", fallback: "配额刷新未完成"))) }
                        else { self.showMessage(task["message"] as? String ?? L10n.t("assistant.account_op_finished", fallback: "账号操作已结束"), error: task["state"] as? String != "succeeded"); self.fetchAccountList(notifyPage: true); self.overview?.update(force: true) }
                    } else if self.quotaRefreshing && taskRevAdvanced {
                        self.fetchAccountList(notifyPage: true)
                        self.overview?.update(force: true)
                    }
                }
                self.checkAndTriggerOverdueQuotaRefreshIfNeeded()
                self.handlePricingRevisionIfChanged()
            case .failure:
                self.reachable = false
                self.failPendingQuotaRefresh(L10n.t("assistant.service_disconnected_keep_quota", fallback: "本机服务连接中断，保留上次配额"))
                if !self.bridge.isOwnedProcessRunning && !self.bridge.isRestarting && !self.selfHealingPending && self.recoveryAttempts < 3 && Date() >= self.nextRecoveryAt {
                    self.recoveryAttempts += 1; self.nextRecoveryAt = Date().addingTimeInterval(Double(self.recoveryAttempts * 10))
                    self.bridge.launch { [weak self] launchResult in
                        if case .success = launchResult {
                            self?.syncBackendProxyConfiguration()
                            self?.refresh()
                        }
                    }
                }
            }
            self.updateViews()
            if !self.quitting && (self.pendingRefreshRequested || self.pendingTaskPollRequested) {
                let needsFull = self.pendingRefreshRequested
                self.pendingRefreshRequested = false
                self.pendingTaskPollRequested = false
                self.refresh(taskPollOnly: !needsFull)
            }
        }
    }

    func handlePricingRevisionIfChanged() {
        let incoming = statusValue.pricingRevision
        guard !incoming.isEmpty else { return }
        if lastObservedPricingRevision.isEmpty {
            lastObservedPricingRevision = incoming
            return
        }
        guard incoming != lastObservedPricingRevision else { return }
        lastObservedPricingRevision = incoming
        invalidateUsageReportCache()
        overview?.fetch()
        if let sheet = preferencesController?.pricingSheet, sheet.sheet.isVisible {
            sheet.reloadFromBackend()
        }
    }

    func updateServiceFootnote() {
        let isConnected = reachable
        serviceFootnoteLabel.superview?.isHidden = isConnected
        if isConnected {
            serviceFootnoteLabel.stringValue = ""
            return
        }
        let dotColor = accessibleWarningColor()
        let dotFont = NSFont.systemFont(ofSize: 8, weight: .bold)
        let textFont = NSFont.systemFont(ofSize: 10.5, weight: .medium)
        let attr = NSMutableAttributedString(
            string: "○ ",
            attributes: [.foregroundColor: dotColor, .font: dotFont]
        )
        attr.append(NSAttributedString(
            string: L10n.t("sidebar.waiting_service", fallback: "等待本机服务…"),
            attributes: [.foregroundColor: Design.secondary.withAlphaComponent(0.90), .font: textFont]
        ))
        serviceFootnoteLabel.attributedStringValue = attr
    }
    private func ensurePopUpMenuCloseObserver() {
        guard popUpMenuCloseObserver == nil else { return }
        popUpMenuCloseObserver = NotificationCenter.default.addObserver(
            forName: Design.popUpMenuDidCloseNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            guard let self, self.pendingViewUpdateAfterPopUpMenu else { return }
            self.pendingViewUpdateAfterPopUpMenu = false
            DispatchQueue.main.async { [weak self] in
                guard let self, !self.quitting, !Design.isTrackingPopUpMenu else { return }
                self.updateViews()
            }
        }
    }

    func updateViews() {
        if Design.isTrackingPopUpMenu {
            pendingViewUpdateAfterPopUpMenu = true
            ensurePopUpMenuCloseObserver()
            return
        }
        item?.button?.toolTip = nil
        item?.button?.setAccessibilityLabel("GravityBox · " + (reachable ? statusValue.title : L10n.t("status.disconnected", fallback: "连接已断开")))
        updateStatusItemState()
        updateServiceFootnote()
        if contentVisible {
            switch currentPage {
            case 0: overview?.update()
            case 2: usagePage?.update()
            case 3:
                preferencesController?.update()
                if preferencesController?.maintenanceSheet?.sheet.isVisible == true {
                    cachePage?.update()
                }
            case 4:
                aboutPage?.update()
            default: break
            }
        }
        updateQuotaRefreshControls()
        if menuPanelController?.isViewLoaded == true {
            menuPanelController?.syncDebugPortBanner()
        }
    }
    func showMessage(_ message: String, error: Bool = false) {
        guard error, !message.isEmpty else { lastOperationError = nil; pageHost.setAccessibilityHelp(nil); return }
        lastOperationError = message
        pageHost.setAccessibilityHelp(message)
        #if !NATIVE_UI_TEST
        guard presentedError == nil else { return }
        presentedError = message
        let alert = NSAlert(); alert.alertStyle = .warning
        alert.messageText = L10n.t("assistant.action_incomplete", fallback: "操作未完成"); alert.informativeText = message
        alert.addButton(withTitle: L10n.t("common.ok", fallback: "好"))
        presentSheetAlert(alert) { [weak self] _ in self?.presentedError = nil }
        #endif
    }
    func watchState() {
        let fd = open(state.path, O_EVTONLY); guard fd >= 0 else { return }
        let statusURL = state.appendingPathComponent("status.json")
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write], queue: stateWatchQueue)
        source.setEventHandler { [weak self] in
            guard let self else { return }
            self.stateWatchWorkItem?.cancel()
            let work = DispatchWorkItem { [weak self] in
                guard let self,
                      let data = try? Data(contentsOf: statusURL),
                      let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
                DispatchQueue.main.async { [weak self] in
                    guard let self, self.bridge.ownedPID == nil || (raw["pid"] as? NSNumber)?.int32Value == self.bridge.ownedPID else { return }
                    let rawTaskRev = raw["taskRevision"] as? Int ?? 0
                    if self.reachable && rawTaskRev < self.statusValue.taskRevision { return }
                    let wasReachable = self.reachable
                    let taskChanged = self.statusValue.taskRevision != rawTaskRev
                    let prevRemoteSyncRevision = self.statusValue.remoteSyncRevision
                    let prevEnvironmentsRevision = self.environmentsRevision
                    self.reachable = true
                    self.recoveryAttempts = 0
                    self.statusValue = self.mergeStatusSnapshot(raw, previous: self.statusValue)
                    if raw["environments"] != nil
                        || raw["environmentsRevision"] != nil
                        || raw["focusedEnvironmentId"] != nil
                        || raw["remoteSessions"] != nil
                        || raw["focusedContextKey"] != nil {
                        self.syncEnvironmentsFromPayload(raw, notifyUI: true, notifyMenuPanel: false)
                    }
                    if self.statusValue.remoteSyncRevision > prevRemoteSyncRevision || self.environmentsRevision > prevEnvironmentsRevision {
                        self.usageLastFetchTimeByPeriod.removeAll()
                    }
                    self.handlePricingRevisionIfChanged()
                    self.updateViews()
                    if !wasReachable || (taskChanged && (self.pendingAccountTaskId != nil || self.quotaRefreshing)) {
                        self.refresh()
                    }
                }
            }
            self.stateWatchWorkItem = work
            self.stateWatchQueue.asyncAfter(deadline: .now() + 0.04, execute: work)
        }
        source.setCancelHandler { close(fd) }; source.resume(); directorySource = source
    }
    /// 合并 status.json 快照：其中缺失的账号字段沿用上一次 socket status 的值，避免账号/费用 UI 瞬时清空。
    func mergeStatusSnapshot(_ raw: [String: Any], previous: LiveStatus) -> LiveStatus {
        var merged = LiveStatus(raw)
        if raw["translationEnabled"] == nil { merged.translationEnabled = previous.translationEnabled }
        if raw["hudEnabled"] == nil { merged.hudEnabled = previous.hudEnabled }
        if raw["activeAccountEmail"] == nil { merged.activeAccountEmail = previous.activeAccountEmail }
        if raw["activeFiveHourQuota"] == nil { merged.activeFiveHourQuota = previous.activeFiveHourQuota }
        if raw["activeSubscriptionTier"] == nil { merged.activeSubscriptionTier = previous.activeSubscriptionTier }
        if raw["accountsRevision"] == nil { merged.accountsRevision = previous.accountsRevision }
        if raw["pricingRevision"] == nil { merged.pricingRevision = previous.pricingRevision }
        if raw["liveAccountEmail"] == nil { merged.liveAccountEmail = previous.liveAccountEmail }
        if raw["oauthClientConfigured"] == nil { merged.oauthClientConfigured = previous.oauthClientConfigured }
        if raw["sshWindowsCount"] == nil && raw["sshWindows"] == nil {
            merged.sshWindowsCount = previous.sshWindowsCount
            merged.activeSshHosts = previous.activeSshHosts
        }
        if raw["focusedContextKey"] == nil { merged.focusedContextKey = previous.focusedContextKey }
        if raw["remoteObservedVersion"] == nil { merged.remoteObservedVersion = previous.remoteObservedVersion }
        if raw["remoteSyncRevision"] == nil { merged.remoteSyncRevision = previous.remoteSyncRevision }
        if raw["remoteSessions"] == nil { merged.remoteSessions = previous.remoteSessions }
        if let hudTarget = pendingHudTarget {
            merged.hudEnabled = hudTarget
        }
        if pendingHudTarget == nil, let authoritative = raw["hudEnabled"] as? Bool,
           let configuration, configuration.value.hudEnabled != authoritative {
            configuration.value.hudEnabled = authoritative
            scheduleConfigurationSave()
        }
        return merged
    }

    static let remoteSessionsDidChangeNotification = Notification.Name("local.gravitybox.remoteSessionsDidChange")

    func syncUsageFilterScopeFromConfiguration() {
        let raw = configuration?.value.menuUsageEnvironmentId ?? "all"
        let scope = EnvironmentScope(rawEnvironmentId: raw)
        usageFilterScope = scope
        usageSelectedEnvironment = scope.rawEnvironmentId
    }

    var isMenuQuotaFollowingFocus: Bool {
        guard !userPinnedContext, case .remote(let activeEnvId) = activeNodeScope else { return false }
        if focusedEnvironmentId != "local" && focusedEnvironmentId == activeEnvId {
            return true
        }
        let focusedKey = statusValue.focusedContextKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard focusedKey.hasPrefix("remote:") else { return false }
        let focusedRemoteKey = String(focusedKey.dropFirst("remote:".count))
        if let matchedSession = remoteSessions.first(where: { ($0["remoteKey"] as? String) == focusedRemoteKey }) {
            return remoteEnvironmentId(for: matchedSession) == activeEnvId
        }
        return false
    }

    func remoteEnvironmentId(for session: [String: Any]) -> String {
        if let envId = ((session["environmentId"] as? String) ?? (session["id"] as? String))?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !envId.isEmpty {
            return envId
        }
        let rawHost = (session["hostLabel"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let cleaned = SshEnvironmentResolver.cleanHostLabel(rawHost)
        return cleaned.isEmpty ? "ssh:remote" : "ssh:\(cleaned.lowercased())"
    }

    func canonicalAllEnvironments(includeLocal: Bool = false, includeHistorical: Bool = true) -> [CanonicalHostEnvironment] {
        let merged = SshEnvironmentResolver.mergeEnvironments(
            primaryNodes: hasAuthoritativeEnvironmentsPayload ? backendEnvironmentNodes : [],
            legacyRemoteSessions: remoteSessions,
            availableEnvironments: usageAvailableEnvironments,
            usageShareByEnvId: usageEnvironmentShareById
        )
        return merged.filter { node in
            if !includeLocal && node.isLocal { return false }
            if !includeHistorical && !node.isLocal && node.state == .historicalOnly { return false }
            return true
        }
    }

    func canonicalRemoteHosts() -> [CanonicalHostEnvironment] {
        canonicalAllEnvironments(includeLocal: false, includeHistorical: false)
    }

    func usageRemoteEnvironments() -> [CanonicalHostEnvironment] {
        canonicalAllEnvironments(includeLocal: false, includeHistorical: true)
    }

    func environmentNode(for environmentId: String) -> CanonicalHostEnvironment? {
        let normalized = EnvironmentScope(rawEnvironmentId: environmentId).rawEnvironmentId
        if normalized == "all" { return nil }
        return canonicalAllEnvironments(includeLocal: true, includeHistorical: true)
            .first { $0.environmentId == normalized }
    }

    func selectedActiveNodeHost() -> CanonicalHostEnvironment? {
        guard case .remote(let envId) = activeNodeScope else { return nil }
        return canonicalRemoteHosts().first { $0.environmentId == envId }
    }

    func quotaFreshness(forHost host: CanonicalHostEnvironment, now: Date = Date()) -> QuotaFreshness {
        SshEnvironmentResolver.resolveQuotaFreshness(
            forHost: host,
            staleThresholdSeconds: quotaStaleThresholdSeconds,
            now: now
        )
    }

    func quotaFreshness(forAccount account: [String: Any], now: Date = Date()) -> QuotaFreshness {
        SshEnvironmentResolver.resolveQuotaFreshness(
            forAccount: account,
            staleThresholdSeconds: quotaStaleThresholdSeconds,
            now: now
        )
    }

    func fusedAccount(_ account: [String: Any]) -> [String: Any] {
        SshEnvironmentResolver.fuseAccountQuota(account: account, hosts: canonicalRemoteHosts())
    }

    func fusedAccountsForDisplay() -> [[String: Any]] {
        SshEnvironmentResolver.fuseAccountsQuota(accounts: cachedAccounts, hosts: canonicalRemoteHosts())
    }

    func quotaSourceEnvironment(forAccount account: [String: Any]) -> CanonicalHostEnvironment? {
        guard let sourceId = (account["quotaSourceEnvironmentId"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !sourceId.isEmpty,
              sourceId != "local" else { return nil }
        return environmentNode(for: sourceId)
    }

    func overviewRemoteEnvironments() -> [(environmentId: String, hostLabel: String, session: [String: Any])] {
        canonicalRemoteHosts().map {
            (environmentId: $0.environmentId, hostLabel: $0.hostLabel, session: $0.rawSession)
        }
    }

    func selectedOverviewRemoteSession() -> [String: Any]? {
        guard overviewEnvironmentKey.hasPrefix("env:") else { return nil }
        let targetEnvId = String(overviewEnvironmentKey.dropFirst("env:".count))
        return overviewRemoteEnvironments().first { $0.environmentId == targetEnvId }?.session
    }

    func selectOverviewEnvironment(_ environmentKey: String) {
        let nextScope = EnvironmentScope(rawEnvironmentId: environmentKey)
        let liveOrHistHosts = canonicalAllEnvironments(includeLocal: false, includeHistorical: true)
        let hasAnySsh = !liveOrHistHosts.isEmpty
        let resolvedScope: EnvironmentScope
        switch nextScope {
        case .all:
            resolvedScope = .all
        case .local:
            resolvedScope = hasAnySsh ? .local : .all
        case .remote(let envId):
            resolvedScope = liveOrHistHosts.contains(where: { $0.environmentId == envId }) ? .remote(environmentId: envId) : .all
        }
        overviewEnvironmentKey = resolvedScope.overviewKey
        usageFilterScope = resolvedScope
        usageSelectedEnvironment = resolvedScope.rawEnvironmentId
        overview?.handleOverviewEnvironmentChanged()
        updateQuotaRefreshControls()
    }

    func syncEnvironmentsFromPayload(_ payload: [String: Any], notifyUI: Bool = true, notifyMenuPanel: Bool = true) {
        if let rev = (payload["environmentsRevision"] as? NSNumber)?.intValue ?? (payload["environmentsRevision"] as? Int) {
            environmentsRevision = rev
        }
        if let rawNodes = payload["environments"] as? [[String: Any]] {
            hasAuthoritativeEnvironmentsPayload = true
            backendEnvironmentNodes = SshEnvironmentResolver.parseEnvironments(from: rawNodes)
        }
        if let sessions = payload["remoteSessions"] as? [[String: Any]] {
            remoteSessions = sessions
        }
        if let focusedKey = payload["focusedContextKey"] as? String {
            statusValue.focusedContextKey = focusedKey
        }

        if let explicitFocusedEnv = (payload["focusedEnvironmentId"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !explicitFocusedEnv.isEmpty {
            focusedEnvironmentId = explicitFocusedEnv
        } else if let focusedNode = backendEnvironmentNodes.first(where: { $0.focused }) {
            focusedEnvironmentId = focusedNode.environmentId
        } else {
            let focusedKey = statusValue.focusedContextKey.trimmingCharacters(in: .whitespacesAndNewlines)
            if focusedKey.hasPrefix("remote:") {
                let rk = String(focusedKey.dropFirst("remote:".count))
                if let matched = remoteSessions.first(where: { ($0["remoteKey"] as? String) == rk }) {
                    focusedEnvironmentId = remoteEnvironmentId(for: matched)
                } else if let matchedNode = backendEnvironmentNodes.first(where: { $0.primaryRemoteKey == rk }) {
                    focusedEnvironmentId = matchedNode.environmentId
                } else {
                    focusedEnvironmentId = "local"
                }
            } else {
                focusedEnvironmentId = "local"
            }
        }

        reconcileActiveNodeAndOverviewScopes()

        if notifyUI {
            overview?.syncRemoteSessionsUI()
            if notifyMenuPanel {
                menuPanelController?.syncFromAssistant()
            }
            NotificationCenter.default.post(name: Self.remoteSessionsDidChangeNotification, object: self)
        }
    }

    func syncRemoteSessionsFromPayload(_ sessions: [[String: Any]]?, focusedKey: String?, notifyUI: Bool = true) {
        if let sessions {
            // Explicit legacy/test session injection supersedes prior authoritative environments list
            // unless the caller invokes `syncEnvironmentsFromPayload`.
            hasAuthoritativeEnvironmentsPayload = false
            backendEnvironmentNodes = []
            remoteSessions = sessions
        }
        if let focusedKey {
            statusValue.focusedContextKey = focusedKey
        }
        var payload: [String: Any] = [:]
        if let sessions {
            payload["remoteSessions"] = sessions
        }
        if let focusedKey {
            payload["focusedContextKey"] = focusedKey
        }
        syncEnvironmentsFromPayload(payload, notifyUI: notifyUI)
    }

    func syncUsageEnvironmentsFromReport(_ report: [String: Any]) {
        let summary = report["summary"] as? [String: Any]
        if let envNodes = (report["environments"] as? [[String: Any]]) ?? (summary?["environments"] as? [[String: Any]]),
           !envNodes.isEmpty {
            hasAuthoritativeEnvironmentsPayload = true
            backendEnvironmentNodes = SshEnvironmentResolver.parseEnvironments(from: envNodes)
        }
        if let rev = (report["environmentsRevision"] as? NSNumber)?.intValue ?? (report["environmentsRevision"] as? Int) {
            environmentsRevision = max(environmentsRevision, rev)
        }
        let avail = (report["availableEnvironments"] as? [[String: Any]])
            ?? (report["available_environments"] as? [[String: Any]])
            ?? (summary?["availableEnvironments"] as? [[String: Any]])
            ?? (summary?["available_environments"] as? [[String: Any]])
        if let avail {
            usageAvailableEnvironments = avail
            for item in avail {
                let id = ((item["environmentId"] as? String) ?? (item["id"] as? String) ?? "")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if !id.isEmpty, let pct = QuotaPresentation.number(item["sharePct"] ?? item["usageSharePct"]) {
                    usageEnvironmentShareById[id] = pct
                }
            }
        }
        if let breakdown = (report["environmentBreakdown"] as? [String: Any])
            ?? (report["environment_breakdown"] as? [String: Any])
            ?? (summary?["environmentBreakdown"] as? [String: Any])
            ?? (summary?["environment_breakdown"] as? [String: Any]) {
            if let localPct = QuotaPresentation.number(breakdown["localSharePct"] ?? breakdown["local_share_pct"]) {
                usageEnvironmentShareById["local"] = localPct
            }
            if let byEnv = (breakdown["byEnvironment"] as? [[String: Any]]) ?? (breakdown["by_environment"] as? [[String: Any]]) {
                for entry in byEnv {
                    let id = ((entry["environmentId"] as? String) ?? (entry["id"] as? String) ?? "")
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    if !id.isEmpty, let pct = QuotaPresentation.number(entry["sharePct"] ?? entry["share_pct"]) {
                        usageEnvironmentShareById[id] = pct
                    }
                }
            }
        }
    }

    private func reconcileActiveNodeAndOverviewScopes() {
        let liveHosts = canonicalRemoteHosts()
        let liveById = Dictionary(uniqueKeysWithValues: liveHosts.map { ($0.environmentId, $0) })

        // Reconnect port changes preserve the lock because matching is strictly by stable `environmentId`.
        if case .remote(let envId) = activeNodeScope, liveById[envId] == nil {
            activeNodeScope = .local
            userPinnedContext = false
        }

        if !userPinnedContext {
            if focusedEnvironmentId != "local", liveById[focusedEnvironmentId] != nil {
                activeNodeScope = .remote(environmentId: focusedEnvironmentId)
            } else {
                activeNodeScope = .local
            }
        }

        syncLegacySelectedContextKey(using: liveById)

        let allHosts = canonicalAllEnvironments(includeLocal: false, includeHistorical: true)
        if allHosts.isEmpty {
            overviewEnvironmentKey = "all"
        } else if overviewEnvironmentKey.hasPrefix("env:") {
            let envId = String(overviewEnvironmentKey.dropFirst("env:".count))
            if !allHosts.contains(where: { $0.environmentId == envId }) {
                overviewEnvironmentKey = "all"
            }
        }
    }

    private func syncLegacySelectedContextKey(using liveById: [String: CanonicalHostEnvironment]? = nil) {
        switch activeNodeScope {
        case .all, .local:
            selectedContextKey = "local"
        case .remote(let envId):
            let host = liveById?[envId] ?? canonicalRemoteHosts().first(where: { $0.environmentId == envId })
            if let rk = host?.primaryRemoteKey, !rk.isEmpty {
                selectedContextKey = "remote:\(rk)"
            } else {
                selectedContextKey = "remote:\(envId)"
            }
        }
    }

    func setActiveNodeScope(_ scope: EnvironmentScope, userInitiated: Bool = true, notifyUI: Bool = true) {
        let normalizedScope: EnvironmentScope
        let liveHosts = canonicalRemoteHosts()
        let liveById = Dictionary(uniqueKeysWithValues: liveHosts.map { ($0.environmentId, $0) })

        switch scope {
        case .all, .local:
            normalizedScope = .local
        case .remote(let envId):
            normalizedScope = liveById[envId] != nil ? .remote(environmentId: envId) : .local
        }

        activeNodeScope = normalizedScope
        if normalizedScope == .local && !userInitiated {
            userPinnedContext = false
        } else if userInitiated {
            userPinnedContext = true
        }
        syncLegacySelectedContextKey(using: liveById)

        if notifyUI {
            overview?.syncRemoteSessionsUI()
            menuPanelController?.syncFromAssistant()
            updateQuotaRefreshControls()
        }
    }

    func setUsageFilterScope(
        _ scope: EnvironmentScope,
        persist: Bool = true,
        syncOverview: Bool = true,
        syncUsagePage: Bool = true,
        syncMenuPanel: Bool = true
    ) {
        usageFilterScope = scope
        let envId = scope.rawEnvironmentId
        usageSelectedEnvironment = envId
        if persist, configuration?.value.menuUsageEnvironmentId != envId {
            configuration?.value.menuUsageEnvironmentId = envId
            scheduleConfigurationSave()
        }
        if syncOverview {
            overviewEnvironmentKey = scope.overviewKey
            overview?.handleOverviewEnvironmentChanged()
        }
        if syncUsagePage, let usagePage, usagePage.selectedEnvironmentId != envId {
            usagePage.applyExternalFilter(period: usageSelectedPeriod, environmentId: envId)
        }
        if syncMenuPanel {
            menuPanelController?.syncFromAssistant()
        }
        updateQuotaRefreshControls()
    }

    /// Projects MenuPanel Tab 0 (`usageFilterScope`) to Tab 1 (`activeNodeScope`):
    /// - `.local` -> `.local`
    /// - `.remote(X)` -> `.remote(X)` if live/recent; if `historical_only` or missing -> safe fallback to `.local`
    /// - `.all` -> keeps current `activeNodeScope`
    func projectUsageFilterScopeToActiveNode(from usageScope: EnvironmentScope) -> (scope: EnvironmentScope, fellBackFromHistorical: Bool) {
        let liveHosts = canonicalRemoteHosts()
        switch usageScope {
        case .all:
            return (activeNodeScope, false)
        case .local:
            return (.local, false)
        case .remote(let envId):
            if liveHosts.contains(where: { $0.environmentId == envId }) {
                return (.remote(environmentId: envId), false)
            }
            return (.local, true)
        }
    }

    /// Projects MenuPanel Tab 1 (`activeNodeScope`) back to Tab 0 (`usageFilterScope`).
    func projectActiveNodeScopeToUsageFilter(from nodeScope: EnvironmentScope, wasUserPinned: Bool) -> EnvironmentScope? {
        switch nodeScope {
        case .remote(let envId):
            return wasUserPinned ? .remote(environmentId: envId) : nil
        case .local:
            // Symmetrical fix: if user pinned back to `.local` in Tab 1 while Tab 0 was viewing a remote host, reflect `.local` in Tab 0.
            if wasUserPinned && usageFilterScope.isRemote {
                return .local
            }
            return nil
        case .all:
            return nil
        }
    }

    /// Performs symmetrical environment synchronization between MenuPanel Tab 0 (Usage) and Tab 1 (Quota).
    /// Returns `true` if a `historical_only` selection safely fell back to `.local`.
    @discardableResult
    func syncMenuTabEnvironmentTransition(from prevTab: Int, to nextTab: Int) -> Bool {
        switch (prevTab, nextTab) {
        case (0, 1):
            let projection = projectUsageFilterScopeToActiveNode(from: usageFilterScope)
            if projection.fellBackFromHistorical {
                setActiveNodeScope(.local, userInitiated: true, notifyUI: false)
                return true
            }
            if usageFilterScope != .all {
                setActiveNodeScope(projection.scope, userInitiated: true, notifyUI: false)
            }
            return false
        case (1, 0):
            if let nextUsage = projectActiveNodeScopeToUsageFilter(from: activeNodeScope, wasUserPinned: userPinnedContext) {
                setUsageFilterScope(nextUsage, persist: true, syncOverview: false, syncUsagePage: false, syncMenuPanel: false)
            }
            return false
        default:
            return false
        }
    }

    /// Builds unified `EnvironmentContextPill` items for any UI touchpoint.
    func buildContextPillItems(
        includeAll: Bool,
        includeHistorical: Bool,
        includeSharePct: Bool = false
    ) -> [EnvironmentContextPill.Item] {
        var result: [EnvironmentContextPill.Item] = []
        let allTitle = L10n.t("ssh.scope.all", fallback: "全部")
        let localTitle = L10n.t("ssh.scope.local", fallback: "本机")

        func formatShare(_ pct: Double?) -> String? {
            guard includeSharePct, let pct, pct.isFinite else { return nil }
            if pct > 0 && pct < 1 { return "<1%" }
            return "\(Int(pct.rounded()))%"
        }

        if includeAll {
            let totalSec: String? = includeSharePct && !usageEnvironmentShareById.isEmpty ? "100%" : nil
            result.append(EnvironmentContextPill.Item(
                scope: .all,
                hostLabel: allTitle,
                secondaryText: totalSec
            ))
        }
        result.append(EnvironmentContextPill.Item(
            scope: .local,
            hostLabel: localTitle,
            secondaryText: formatShare(usageEnvironmentShareById["local"])
        ))

        let hosts = canonicalAllEnvironments(includeLocal: false, includeHistorical: includeHistorical)
        for host in hosts {
            let secondary: String?
            if includeSharePct {
                secondary = formatShare(host.usageSharePct ?? usageEnvironmentShareById[host.environmentId])
            } else if host.windowCount > 1 {
                secondary = L10n.t("accounts.ssh.remote_window_count", ["count": host.windowCount], fallback: "\(host.windowCount) 个窗口")
            } else {
                secondary = nil
            }
            result.append(EnvironmentContextPill.Item(
                scope: .remote(environmentId: host.environmentId),
                hostLabel: host.cleanHostLabel,
                state: host.state,
                windowCount: host.windowCount,
                email: host.email.isEmpty ? nil : host.email,
                secondaryText: secondary
            ))
        }
        return result
    }

    func selectedMenuQuotaHost() -> CanonicalHostEnvironment? {
        if let direct = selectedActiveNodeHost() {
            return direct
        }
        guard selectedContextKey.hasPrefix("remote:") else { return nil }
        let targetKey = String(selectedContextKey.dropFirst("remote:".count))
        let hosts = canonicalRemoteHosts()
        if let direct = hosts.first(where: { $0.primaryRemoteKey == targetKey }) {
            return direct
        }
        guard let matchedSession = remoteSessions.first(where: { ($0["remoteKey"] as? String) == targetKey }) else {
            return nil
        }
        let envId = remoteEnvironmentId(for: matchedSession)
        return hosts.first { $0.environmentId == envId }
    }

    func selectMenuQuotaHost(_ environmentId: String, userInitiated: Bool = true) {
        let scope = EnvironmentScope(rawEnvironmentId: environmentId)
        setActiveNodeScope(scope == .all ? .local : scope, userInitiated: userInitiated, notifyUI: true)
    }

    func selectQuotaContext(_ contextKey: String, userInitiated: Bool = true) {
        if contextKey.hasPrefix("remote:") {
            let rk = String(contextKey.dropFirst("remote:".count))
            if let host = canonicalRemoteHosts().first(where: { $0.primaryRemoteKey == rk || $0.environmentId == rk }) {
                setActiveNodeScope(.remote(environmentId: host.environmentId), userInitiated: userInitiated, notifyUI: true)
                return
            }
            if let matched = remoteSessions.first(where: { ($0["remoteKey"] as? String) == rk }) {
                let envId = remoteEnvironmentId(for: matched)
                setActiveNodeScope(.remote(environmentId: envId), userInitiated: userInitiated, notifyUI: true)
                return
            }
        }
        setActiveNodeScope(.local, userInitiated: userInitiated, notifyUI: true)
    }

    @objc func refreshAllQuotasIncludingRemotes() {
        refreshAccountQuotas()
        guard reachable else { return }
        let onlineHosts = canonicalRemoteHosts().filter { $0.state.isOnlineOrAuthExpired }
        guard !onlineHosts.isEmpty else { return }
        refreshRemoteQuota(remoteKey: nil, environmentId: nil)
    }

    func refreshRemoteQuota(remoteKey: String? = nil, environmentId: String? = nil, completion: (() -> Void)? = nil) {
        guard !remoteQuotaRefreshing, reachable else { completion?(); return }
        remoteQuotaRefreshing = true
        updateQuotaRefreshControls()
        menuPanelController?.syncHeaderRefreshState()
        var payload: [String: Any] = ["command": "remote_quota_refresh"]
        if let remoteKey, !remoteKey.isEmpty {
            payload["remoteKey"] = remoteKey
        }
        if let environmentId, !environmentId.isEmpty {
            payload["environmentId"] = environmentId
            if payload["remoteKey"] == nil,
               let matchedKey = environmentNode(for: environmentId)?.primaryRemoteKey,
               !matchedKey.isEmpty {
                payload["remoteKey"] = matchedKey
            }
        }
        bridge.send(payload) { [weak self] response in
            guard let self else { return }
            self.remoteQuotaRefreshing = false
            if case .success(let value) = response {
                if let rev = value["remoteObservedVersion"] as? Int {
                    self.statusValue.remoteObservedVersion = rev
                }
                if let focused = value["focusedContextKey"] as? String {
                    self.statusValue.focusedContextKey = focused
                }
                self.syncEnvironmentsFromPayload(value, notifyUI: true)
            }
            self.updateQuotaRefreshControls()
            self.menuPanelController?.syncFromAssistant()
            completion?()
        }
    }
    func presentSheetAlert(_ alert: NSAlert, completion: @escaping (NSApplication.ModalResponse) -> Void) {
        if isMenuPanelShown {
            closeMenuPopover(animated: false)
        }
        if window == nil || window?.isVisible != true {
            showPanel()
        }
        guard let rootWindow = self.window else {
            #if !NATIVE_UI_TEST
            Design.activateApplicationForcingFront()
            #endif
            completion(alert.runModal())
            return
        }
        var parent = rootWindow
        while let sheet = parent.activeSheetWindow { parent = sheet }
        #if NATIVE_UI_TEST
        Assistant.configureHeadlessWindowIfNeeded(parent)
        Assistant.configureHeadlessWindowIfNeeded(alert.window)
        #else
        Design.activateApplicationForcingFront()
        #endif
        alert.beginSheetModal(for: parent, completionHandler: completion)
    }
}

#if !NATIVE_UI_TEST
@main struct GravityBoxMain {
    static func main() {
        if let i = CommandLine.arguments.firstIndex(of: "--install-update"), i + 1 < CommandLine.arguments.count {
            if let envLang = ProcessInfo.processInfo.environment["GRAVITYBOX_LANGUAGE"]?.trimmingCharacters(in: .whitespacesAndNewlines),
               !envLang.isEmpty {
                _ = L10n.shared.setLanguage(envLang, notify: false)
            }
            do { try UpdateInstaller.run(receiptURL: URL(fileURLWithPath: CommandLine.arguments[i + 1])); exit(0) }
            catch { fputs(L10n.t("assistant.update_incomplete_stderr", fallback: "GravityBox 更新未完成；恢复材料已保留。\n"), stderr); exit(1) }
        }
        if CommandLine.arguments.contains("--lifecycle-agent") {
            AntigravityLifecycleAgent.run()
        }
        let app = NSApplication.shared
        let delegate = Assistant()
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}

#endif
