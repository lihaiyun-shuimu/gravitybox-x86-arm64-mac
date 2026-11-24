import Cocoa
import UniformTypeIdentifiers

#if NATIVE_UI_TEST
var saveUsageJSONTestHook: (([String: Any], String) -> Bool)?
#endif

func saveUsageJSON(_ report: [String: Any], name: String, window: NSWindow, app: Assistant, onCompletion: ((Bool) -> Void)? = nil) {
    #if NATIVE_UI_TEST
    if let hook = saveUsageJSONTestHook {
        let ok = hook(report, name)
        onCompletion?(ok)
        return
    }
    #endif
    let panel = NSSavePanel(); panel.allowedContentTypes = [.json]; panel.nameFieldStringValue = name
    panel.beginSheetModal(for: window) { response in
        guard response == .OK, let url = panel.url else {
            onCompletion?(false)
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            let state = PerformanceSignpost.begin("UsageExportWrite")
            let result = Result {
                let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
                try data.write(to: url, options: .atomic)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            }
            PerformanceSignpost.end("UsageExportWrite", state)
            DispatchQueue.main.async {
                switch result {
                case .success:
                    app.showMessage(L10n.t("usage_log.export.done"))
                    onCompletion?(true)
                case .failure(let error):
                    app.showMessage(L10n.t("usage_log.export.failed", ["error": error.localizedDescription]), error: true)
                    onCompletion?(false)
                }
            }
        }
    }
}

typealias PageNumberField = PolicyNumberField

final class UsageLogController: NSObject, NSTableViewDataSource, NSTableViewDelegate, NSSearchFieldDelegate, NSTextFieldDelegate {
    weak var app: Assistant?
    let sheet = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 700, height: 540), styleMask: [.titled], backing: .buffered, defer: false)
    let search = NSSearchField()
    let searchSpinner = NSProgressIndicator()
    let table = NSTableView()
    let listHost = NSView()
    let scroll = TableScrollView()
    let emptyTitle = text(L10n.t("usage_log.loading_rows"), size: 13, weight: .medium, color: Design.secondary)
    let emptyIcon = NSImageView()
    // F08: filtered/searched empty results get an explicit way back instead of a contradictory footer.
    let clearFiltersButton = button(L10n.t("usage_log.clear_filters"), target: nil, action: #selector(clearFilters))
    let emptyView = NSView()
    var snapshotID: String?
    var loading = false
    var closed = false
    private var handlingJumpToPage = false
    var searchDebounce: DispatchWorkItem?
    let period = DesignSegmentedControl(labels: [L10n.t("usage.period.today"), L10n.t("usage.period.7d"), L10n.t("usage.period.30d"), L10n.t("usage.period.all")], trackingMode: .selectOne, target: nil, action: nil)
    let environmentPill = EnvironmentContextPill(style: .headerPill, compact: false, minWidth: 68, maxWidth: 180, height: 26)
    let accountPopup = DesignPopUpButton(frame: .zero, pullsDown: false)
    let filterRow: NSStackView
    var selectedEnvironmentId: String
    var selectedAccountId: String
    private var availableEnvironments: [[String: Any]] = []
    private var availableAccounts: [[String: Any]] = []
    let status = text(L10n.t("usage_log.loading"), size: 11, color: Design.secondary, wrap: true)
    let previous = button(L10n.t("usage_log.prev_page"), target: nil, action: #selector(previousPage))
    let next = button(L10n.t("usage_log.next_page"), target: nil, action: #selector(nextPage))
    let pageNumber = PageNumberField(string: "1")
    let pageCount = text(L10n.t("usage_log.page_count", ["pages": 1]), size: 11, color: Design.secondary)
    var listScope = ""
    private var listScopeFromBackend = false
    private var lastReadErrorMessage: String?
    let refreshButton = InlineRefreshButton(L10n.t("common.refresh"), width: 76, target: nil, action: #selector(reloadSnapshot))
    let exportButton = button(L10n.t("usage.export_btn"), target: nil, action: #selector(exportRows))
    private let headerTitleLabel = text(L10n.t("usage_log.title"), size: 18, weight: .semibold)
    private var closeButtonRef: NSButton!
    private var languageObserver: NSObjectProtocol?
    private var cachedHasSshRows = false
    private var cachedRemoteHosts: [CanonicalHostEnvironment] = []
    var rows: [[String: Any]] = [] {
        didSet {
            cachedHasSshRows = rows.contains(where: Self.isSshEventRow)
            cachedRemoteHosts = app?.canonicalRemoteHosts() ?? []
        }
    }
    var offset = 0; var total = 0; var requestRevision = 0
    var onDismiss: (() -> Void)?
    let periods = ["today", "7d", "30d", "all"]

    deinit {
        searchDebounce?.cancel()
        if let languageObserver {
            NotificationCenter.default.removeObserver(languageObserver)
        }
    }
    init(app: Assistant, period selected: String, environmentId: String? = nil, accountId: String? = nil) {
        self.app = app
        let inheritedEnv = environmentId ?? (app.usagePage?.selectedEnvironmentId ?? app.usageFilterScope.rawEnvironmentId)
        let trimmedEnv = inheritedEnv.trimmingCharacters(in: .whitespacesAndNewlines)
        self.selectedEnvironmentId = trimmedEnv.isEmpty ? "all" : trimmedEnv
        let inheritedAcc = accountId ?? (app.usagePage?.selectedAccountId ?? app.usageSelectedAccount)
        let trimmedAcc = inheritedAcc.trimmingCharacters(in: .whitespacesAndNewlines)
        self.selectedAccountId = (trimmedAcc.isEmpty || trimmedAcc == "unattributed") ? "all" : trimmedAcc
        if let latest = app.usagePage?.latestReport {
            self.availableEnvironments = UsageFilterSupport.extractAvailableEnvironments(from: latest)
            self.availableAccounts = UsageFilterSupport.extractAvailableAccounts(from: latest)
        }
        environmentPill.setAccessibilityLabel(L10n.t("usage_log.env.a11y"))
        accountPopup.controlSize = .regular
        accountPopup.toolTip = nil
        accountPopup.setAccessibilityLabel(L10n.t("usage_log.account.a11y"))
        accountPopup.setContentHuggingPriority(.required, for: .horizontal)
        accountPopup.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        filterRow = horizontal([environmentPill, accountPopup, flexibleSpace()], spacing: 8)
        filterRow.alignment = .centerY
        filterRow.detachesHiddenViews = true
        filterRow.identifier = NSUserInterfaceItemIdentifier("usage-log-filter-row")
        super.init()
        environmentPill.onSelectScope = { [weak self] scope in
            self?.applyEnvironmentSelection(scope.rawEnvironmentId)
        }
        accountPopup.target = self
        accountPopup.action = #selector(accountChanged(_:))
        sheet.title = L10n.t("usage_log.title"); sheet.isReleasedWhenClosed = false; table.rowHeight = 64; table.backgroundColor = .clear
        search.placeholderString = L10n.t("usage_log.search_placeholder"); search.delegate = self; search.setAccessibilityLabel(L10n.t("usage_log.search_a11y"))
        period.selectedSegment = periods.firstIndex(of: selected) ?? 0; period.controlSize = .regular; period.target = self; period.action = #selector(periodChanged)
        period.translatesAutoresizingMaskIntoConstraints = false; period.heightAnchor.constraint(equalToConstant: 28).isActive = true
        table.headerView = nil; table.gridStyleMask = []; table.intercellSpacing = NSSize(width: 0, height: 8)
        table.selectionHighlightStyle = .none; table.focusRingType = .none
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("request")); column.width = 640; column.minWidth = 400; table.addTableColumn(column)
        table.dataSource = self; table.delegate = self
        scroll.tableStyle = .plain; table.style = .plain
        scroll.drawsBackground = false; scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true; scroll.documentView = table
        scroll.automaticallyAdjustsContentInsets = false
        listHost.addSubview(scroll); pin(scroll,to:listHost)
        emptyIcon.image = NSImage(systemSymbolName: "magnifyingglass", accessibilityDescription: nil)
        emptyIcon.contentTintColor = Design.secondary
        emptyIcon.imageScaling = .scaleProportionallyUpOrDown
        emptyIcon.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([emptyIcon.widthAnchor.constraint(equalToConstant: 24), emptyIcon.heightAnchor.constraint(equalToConstant: 24)])
        emptyTitle.alignment = .center
        clearFiltersButton.target = self
        clearFiltersButton.setAccessibilityLabel(L10n.t("usage_log.clear_filters_a11y"))
        clearFiltersButton.isHidden = true
        let empty = vertical([emptyIcon, emptyTitle, clearFiltersButton], spacing: 10); empty.alignment = .centerX
        emptyView.addSubview(empty); empty.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([empty.centerXAnchor.constraint(equalTo:emptyView.centerXAnchor),empty.centerYAnchor.constraint(equalTo:emptyView.centerYAnchor),empty.leadingAnchor.constraint(greaterThanOrEqualTo:emptyView.leadingAnchor,constant:20),empty.trailingAnchor.constraint(lessThanOrEqualTo:emptyView.trailingAnchor,constant:-20)])
        listHost.addSubview(emptyView); pin(emptyView,to:listHost)
        listHost.heightAnchor.constraint(greaterThanOrEqualToConstant: 240).isActive = true
        listHost.setContentHuggingPriority(.defaultLow, for:.vertical)
        previous.target = self; next.target = self; refreshButton.target = self; exportButton.target = self
        previous.isEnabled = false; next.isEnabled = false; exportButton.isEnabled = false
        pageNumber.alignment = .center
        pageNumber.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        pageNumber.focusRingType = .none
        pageNumber.isBezeled = false
        pageNumber.drawsBackground = false
        pageNumber.delegate = self
        pageNumber.setAccessibilityLabel(L10n.t("usage_log.page_a11y"))
        pageNumber.target = self
        pageNumber.action = #selector(jumpToPage)
        pageNumber.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            pageNumber.widthAnchor.constraint(equalToConstant: 46),
            pageNumber.heightAnchor.constraint(equalToConstant: 28)
        ])
        let close = button(L10n.t("usage_log.done"), target: self, action: #selector(closeSheet)); close.bezelColor = Design.blue; close.keyEquivalent = "\u{1b}"
        closeButtonRef = close
        searchSpinner.style = .spinning; searchSpinner.controlSize = .small; searchSpinner.isDisplayedWhenStopped = false
        searchSpinner.translatesAutoresizingMaskIntoConstraints = false; searchSpinner.isHidden = true
        NSLayoutConstraint.activate([searchSpinner.widthAnchor.constraint(equalToConstant: 16), searchSpinner.heightAnchor.constraint(equalToConstant: 16)])
        search.translatesAutoresizingMaskIntoConstraints = false; search.widthAnchor.constraint(greaterThanOrEqualToConstant: 220).isActive = true
        let searchRow = horizontal([search, searchSpinner], spacing: 6); searchRow.alignment = .centerY
        period.setContentHuggingPriority(.required,for:.horizontal); period.setContentCompressionResistancePriority(.required,for:.horizontal)
        let headerActions = horizontal([refreshButton, exportButton], spacing: 8)
        headerActions.alignment = .centerY
        let root = vertical([
            horizontal([headerTitleLabel, flexibleSpace(), headerActions]),
            horizontal([searchRow, period], spacing: 12),
            filterRow,
            listHost,
            status,
            horizontal([previous, next, pageNumber, pageCount, flexibleSpace(), close])
        ], spacing: 12)
        root.detachesHiddenViews = true
        let surface = SheetVisualEffectView(); sheet.isOpaque = false; sheet.backgroundColor = .clear; sheet.contentView = surface
        let content = fixedPage(root); surface.addSubview(content); pin(content, to: surface); Design.applyControls(surface)
        syncFilterControls()
        languageObserver = NotificationCenter.default.addObserver(
            forName: L10n.didChangeNotification,
            object: nil,
            queue: nil
        ) { [weak self] _ in
            if Thread.isMainThread {
                self?.syncLocalizedChrome()
            } else {
                DispatchQueue.main.async { [weak self] in self?.syncLocalizedChrome() }
            }
        }
    }

    private func syncLocalizedChrome() {
        guard !closed, app != nil else { return }
        let title = L10n.t("usage_log.title")
        sheet.title = title
        headerTitleLabel.stringValue = title
        search.placeholderString = L10n.t("usage_log.search_placeholder")
        search.setAccessibilityLabel(L10n.t("usage_log.search_a11y"))
        let labels = [L10n.t("usage.period.today"), L10n.t("usage.period.7d"), L10n.t("usage.period.30d"), L10n.t("usage.period.all")]
        for (idx, lbl) in labels.enumerated() where idx < period.segmentCount {
            period.setLabel(lbl, forSegment: idx)
        }
        refreshButton.title = L10n.t("common.refresh")
        refreshButton.invalidateIntrinsicContentSize()
        refreshButton.setAccessibilityLabel(
            refreshButton.isBusy
                ? L10n.t("design.inline_refresh.busy", ["title": refreshButton.title], fallback: "\(refreshButton.title)，刷新中")
                : refreshButton.title
        )
        exportButton.title = L10n.t("usage.export_btn")
        previous.title = L10n.t("usage_log.prev_page")
        next.title = L10n.t("usage_log.next_page")
        closeButtonRef.title = L10n.t("usage_log.done")
        clearFiltersButton.title = L10n.t("usage_log.clear_filters")
        clearFiltersButton.setAccessibilityLabel(L10n.t("usage_log.clear_filters_a11y"))
        pageNumber.setAccessibilityLabel(L10n.t("usage_log.page_a11y"))
        if !listScopeFromBackend && !listScope.isEmpty {
            listScope = L10n.t("usage_log.scope.default")
        }
        let pages = max(1, (total + 199) / 200)
        pageCount.stringValue = L10n.t("usage_log.page_count", ["pages": InterfaceText.formatInteger(pages)])
        if loading {
            status.stringValue = L10n.t("usage_log.loading")
        } else if let err = lastReadErrorMessage {
            status.stringValue = L10n.t("usage_log.status.read_failed", ["error": err])
        } else if rows.isEmpty {
            if filterActive {
                status.stringValue = L10n.t("usage_log.status.no_match")
            } else if total == 0 {
                status.stringValue = L10n.t("usage_log.status.no_records_period")
            } else if offset > 0 {
                status.stringValue = L10n.t("usage_log.status.page_empty", ["total": InterfaceText.formatInteger(total)])
            } else {
                status.stringValue = L10n.t("usage_log.status.total", ["total": InterfaceText.formatInteger(total)])
            }
        } else {
            status.stringValue = pageStatus()
        }
        updateEmptyState(failed: lastReadErrorMessage != nil)
        environmentPill.setAccessibilityLabel(L10n.t("usage_log.env.a11y"))
        accountPopup.setAccessibilityLabel(L10n.t("usage_log.account.a11y"))
        syncFilterControls()
        table.reloadData()
    }

    private func buildEnvironmentPillItems() -> [EnvironmentContextPill.Item] {
        var items = app?.buildContextPillItems(includeAll: true, includeHistorical: true, includeSharePct: false) ?? [
            EnvironmentContextPill.Item(scope: .all, hostLabel: L10n.t("ssh.scope.all", fallback: "全部")),
            EnvironmentContextPill.Item(scope: .local, hostLabel: L10n.t("ssh.scope.local", fallback: "本机"))
        ]
        var seenIds = Set(items.map(\.id))

        for env in availableEnvironments {
            let id = ((env["environmentId"] as? String) ?? (env["id"] as? String) ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !id.isEmpty, !seenIds.contains(id) else { continue }
            let kindStr = ((env["kind"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard kindStr == "ssh" || id.hasPrefix("ssh:") || id.hasPrefix("host:") else { continue }
            seenIds.insert(id)
            let rawHost = ((env["host_label"] as? String)
                ?? (env["hostLabel"] as? String)
                ?? (env["label"] as? String)
                ?? id).trimmingCharacters(in: .whitespacesAndNewlines)
            let cleanHost = SshEnvironmentResolver.cleanHostLabel(rawHost)
            let hostLabel = cleanHost.isEmpty ? id : cleanHost
            let rawState = (env["lifecycleState"] as? String) ?? (env["state"] as? String)
            let state: SshHostState
            if let rawState, !rawState.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                state = SshHostState(rawSessionState: rawState)
            } else if (env["online"] as? Bool) == true {
                state = .online
            } else {
                state = .historicalOnly
            }
            let winCount = state.isOfflineLike ? 0 : ((env["windowCount"] as? Int) ?? (env["window_count"] as? Int) ?? 1)
            items.append(EnvironmentContextPill.Item(
                scope: .remote(environmentId: id),
                hostLabel: hostLabel,
                state: state,
                windowCount: winCount
            ))
        }

        for row in rows where Self.isSshEventRow(row) {
            let envId = ((row["environment_id"] as? String) ?? (row["environmentId"] as? String) ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !envId.isEmpty, !seenIds.contains(envId) else { continue }
            seenIds.insert(envId)
            let hostLabel = UsageFilterSupport.cleanedHostLabel(
                from: row,
                environments: availableEnvironments,
                canonicalHosts: app?.canonicalRemoteHosts() ?? []
            )
            items.append(EnvironmentContextPill.Item(
                scope: .remote(environmentId: envId),
                hostLabel: hostLabel,
                state: .historicalOnly,
                windowCount: 0
            ))
        }

        let currentScope = EnvironmentScope(rawEnvironmentId: selectedEnvironmentId)
        if case .remote(let remoteEnvId) = currentScope, !seenIds.contains(currentScope.rawEnvironmentId) {
            let fallbackHost = SshEnvironmentResolver.cleanHostLabel(remoteEnvId)
            items.append(EnvironmentContextPill.Item(
                scope: currentScope,
                hostLabel: fallbackHost.isEmpty ? remoteEnvId : fallbackHost,
                state: .historicalOnly,
                windowCount: 0
            ))
        }
        return items
    }

    func syncFilterControls() {
        let pillItems = buildEnvironmentPillItems()
        let selectedScope = EnvironmentScope(rawEnvironmentId: selectedEnvironmentId)
        environmentPill.update(items: pillItems, selectedScope: selectedScope)

        let normalizedAcc = UsageFilterSupport.syncAccountPopup(
            accountPopup,
            accounts: availableAccounts,
            cachedAccounts: app?.cachedAccounts ?? [],
            selectedId: selectedAccountId,
            allTitle: L10n.t("usage_log.account.all"),
            maxWidth: 210,
            fitsSelectedTitleOnly: true
        )
        if selectedAccountId == "unattributed"
            || (!(availableAccounts.isEmpty && (app?.cachedAccounts ?? []).isEmpty) && normalizedAcc != selectedAccountId) {
            selectedAccountId = normalizedAcc
        }
        accountPopup.toolTip = nil
        let realAccountIds = Set(
            (accountPopup.menu?.items ?? [])
                .compactMap { $0.representedObject as? String }
                .filter { !$0.isEmpty && $0 != "all" && $0 != "unattributed" }
        )
        accountPopup.isHidden = !(realAccountIds.count > 1 || selectedAccountId != "all")
        filterRow.isHidden = environmentPill.isHidden && accountPopup.isHidden
    }
    func show(in window: NSWindow, onDismiss: @escaping () -> Void) {
        self.onDismiss = onDismiss
        guard let app else { return }
        app.presentRetainedSheet(controller: self, sheet: sheet, in: window) { [weak self] _ in
            self?.onDismiss?()
        }
        fetch()
    }
    @objc func reloadSnapshot() {
        guard !loading, !exporting else { return }
        if let snapshotID { app?.bridge.send(["command":"usage_snapshot_release","snapshotId":snapshotID]) { _ in } }
        snapshotID = nil; offset = 0; fetch(force: true)
    }
    @objc func closeSheet() {
        if let languageObserver {
            NotificationCenter.default.removeObserver(languageObserver)
            self.languageObserver = nil
        }
        if let snapshotID { app?.bridge.send(["command":"usage_snapshot_release","snapshotId":snapshotID]) { _ in } }
        snapshotID = nil; closed = true; requestRevision += 1; searchDebounce?.cancel(); sheet.sheetParent?.endSheet(sheet) }
    @objc func periodChanged() { offset = 0; fetch() }
    private func applyEnvironmentSelection(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalized = trimmed.isEmpty ? "all" : trimmed
        guard normalized != selectedEnvironmentId else { return }
        if let snapshotID { app?.bridge.send(["command": "usage_snapshot_release", "snapshotId": snapshotID]) { _ in } }
        snapshotID = nil
        selectedEnvironmentId = normalized
        offset = 0
        fetch()
    }
    @objc func accountChanged(_ sender: NSPopUpButton) {
        let next = ((sender.selectedItem?.representedObject as? String) ?? "all").trimmingCharacters(in: .whitespacesAndNewlines)
        let normalized = (next.isEmpty || next == "unattributed") ? "all" : next
        if let cell = sender.cell as? DesignPopUpCell {
            cell.visualStyle = .headerPill
            cell.customHeight = 26
            cell.fitsSelectedTitleOnly = true
            cell.isActiveState = (normalized != "all")
        }
        _ = Design.syncPopUpWidth(sender, maxWidth: 210)
        sender.toolTip = nil
        sender.needsDisplay = true
        guard normalized != selectedAccountId else { return }
        if let snapshotID { app?.bridge.send(["command": "usage_snapshot_release", "snapshotId": snapshotID]) { _ in } }
        snapshotID = nil
        selectedAccountId = normalized
        offset = 0
        fetch()
    }
    func controlTextDidChange(_ obj: Notification) {
        guard obj.object as? NSSearchField === search else { return }
        searchDebounce?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.offset = 0; self?.fetch(fromSearch: true) }
        searchDebounce = work; DispatchQueue.main.asyncAfter(deadline:.now()+0.18,execute:work)
    }
    func controlTextDidBeginEditing(_ obj: Notification) {
        if obj.object as? NSTextField === pageNumber {
            pageNumber.needsDisplay = true
        }
    }
    func controlTextDidEndEditing(_ obj: Notification) {
        guard !handlingJumpToPage, !loading, !exporting, obj.object as? NSTextField === pageNumber else { return }
        pageNumber.needsDisplay = true
        let pages = max(1, (total + 199) / 200)
        let current = offset / 200 + 1
        let raw = pageNumber.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let number = Int(raw), (1...pages).contains(number) else {
            pageNumber.stringValue = "\(current)"
            return
        }
        pageNumber.stringValue = "\(number)"
        if number != current {
            offset = (number - 1) * 200
            fetch()
        }
    }
    @objc func jumpToPage() {
        guard !handlingJumpToPage, !loading, !exporting else { return }
        handlingJumpToPage = true
        defer { handlingJumpToPage = false }
        let pages = max(1, (total + 199) / 200)
        let current = offset / 200 + 1
        let raw = pageNumber.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let number = Int(raw), (1...pages).contains(number) else {
            status.stringValue = L10n.t("usage_log.page_range_error", ["pages": InterfaceText.formatInteger(pages)])
            pageNumber.stringValue = "\(current)"
            pageNumber.needsDisplay = true
            return
        }
        pageNumber.stringValue = "\(number)"
        pageNumber.needsDisplay = true
        if number == current {
            sheet.makeFirstResponder(nil)
            return
        }
        offset = (number - 1) * 200
        sheet.makeFirstResponder(nil)
        fetch()
    }
    func pageStatus() -> String {
        rows.isEmpty
            ? L10n.t("usage_log.status.empty")
            : L10n.t("usage_log.status.page", [
                "scope": listScope,
                "total": InterfaceText.formatInteger(total),
                "start": InterfaceText.formatInteger(offset + 1),
                "end": InterfaceText.formatInteger(offset + rows.count)
            ])
    }
    @objc func previousPage() { offset = max(0, offset - 200); fetch() }
    @objc func nextPage() { offset += 200; fetch() }
    /// F08: true when a search term is narrowing the list (period is part of the query too but the
    /// page always has a period; the confusing empty footer came from the text search).
    var filterActive: Bool {
        !search.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || selectedEnvironmentId != "all"
            || selectedAccountId != "all"
    }

    @objc func clearFilters() {
        searchDebounce?.cancel()
        search.stringValue = ""
        if selectedEnvironmentId != "all" || selectedAccountId != "all" {
            if let snapshotID { app?.bridge.send(["command": "usage_snapshot_release", "snapshotId": snapshotID]) { _ in } }
            snapshotID = nil
            selectedEnvironmentId = "all"
            selectedAccountId = "all"
            syncFilterControls()
        }
        offset = 0
        fetch()
    }

    func fetch(force: Bool = false, fromSearch: Bool = false) {
        guard let app else { return }
        searchDebounce?.cancel(); loading = true; pageNumber.isEnabled = false
        refreshButton.setBusy(true, available: app.reachable)
        if fromSearch {
            searchSpinner.isHidden = false; searchSpinner.startAnimation(nil)
        } else {
            searchSpinner.stopAnimation(nil); searchSpinner.isHidden = true
        }
        previous.isEnabled = false; next.isEnabled = false; exportButton.isEnabled = false
        status.stringValue = L10n.t("usage_log.loading"); status.textColor = Design.secondary; updateEmptyState()
        requestRevision += 1; let revision = requestRevision
        let requestedPeriod = periods[max(0, min(periods.count - 1, period.selectedSegment))]
        let requestedEnv = selectedEnvironmentId
        let requestedAcc = selectedAccountId
        var payload: [String:Any] = [
            "command": "usage_events",
            "period": requestedPeriod,
            "query": search.stringValue,
            "offset": offset,
            "limit": 200,
            "environmentId": requestedEnv,
            "accountId": requestedAcc
        ]
        if force {
            payload["force"] = true
            payload["pinSnapshot"] = true
        } else if let snapshotID {
            payload["snapshotId"] = snapshotID
        } else {
            payload["pinSnapshot"] = true
        }
        let acquiring = snapshotID == nil || force
        app.bridge.send(payload) { [weak self] response in
            guard let self else { return }
            let currentPeriod = self.periods[max(0, min(self.periods.count - 1, self.period.selectedSegment))]
            guard !self.closed,
                  let activeApp = self.app,
                  revision == self.requestRevision,
                  currentPeriod == requestedPeriod,
                  self.selectedEnvironmentId == requestedEnv,
                  self.selectedAccountId == requestedAcc else {
                if acquiring, case .success(let value) = response, let id = value["snapshot_id"] as? String { self.app?.bridge.send(["command":"usage_snapshot_release","snapshotId":id]) { _ in } }
                return
            }
            self.loading = false
            self.refreshButton.setBusy(false, available: activeApp.reachable)
            self.searchSpinner.stopAnimation(nil); self.searchSpinner.isHidden = true
            switch response {
            case .failure(let error):
                self.snapshotID = nil
                self.lastReadErrorMessage = error.localizedDescription
                self.rows = []; self.table.reloadData(); self.status.stringValue = L10n.t("usage_log.status.read_failed", ["error": error.localizedDescription]); self.status.textColor = accessibleDangerColor(); self.emptyTitle.stringValue = L10n.t("usage_log.empty.failed"); self.updateEmptyState(failed:true)
            case .success(let value):
                let retPeriod = (value["period"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let retEnv = ((value["selectedEnvironmentId"] as? String) ?? (value["selected_environment_id"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let retAcc = ((value["selectedAccountId"] as? String) ?? (value["selected_account_id"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if (!retPeriod.isEmpty && retPeriod != requestedPeriod)
                    || (!retEnv.isEmpty && retEnv != requestedEnv)
                    || (!retAcc.isEmpty && retAcc != requestedAcc) {
                    if acquiring, let id = value["snapshot_id"] as? String {
                        activeApp.bridge.send(["command": "usage_snapshot_release", "snapshotId": id]) { _ in }
                    }
                    self.snapshotID = nil
                    self.lastReadErrorMessage = L10n.t("usage.error.period_mismatch")
                    self.rows = []
                    self.table.reloadData()
                    self.status.stringValue = L10n.t("usage.error.period_mismatch")
                    self.status.textColor = accessibleDangerColor()
                    self.emptyTitle.stringValue = L10n.t("usage_log.empty.failed")
                    self.updateEmptyState(failed: true)
                    return
                }
                self.lastReadErrorMessage = nil
                self.snapshotID = value["snapshot_id"] as? String
                self.rows = value["rows"] as? [[String: Any]] ?? []; self.total = intVal(value, "total")
                let respEnvs = UsageFilterSupport.extractAvailableEnvironments(from: value)
                if !respEnvs.isEmpty {
                    self.availableEnvironments = respEnvs
                    activeApp.syncUsageEnvironmentsFromReport(value)
                }
                self.cachedRemoteHosts = activeApp.canonicalRemoteHosts()
                let respAccounts = UsageFilterSupport.extractAvailableAccounts(from: value)
                if !respAccounts.isEmpty { self.availableAccounts = respAccounts }
                self.syncFilterControls()
                let animateTable = Design.shouldAnimate(in: self.table)
                if animateTable {
                    self.table.wantsLayer = true
                    self.table.alphaValue = 0.35
                } else {
                    self.table.alphaValue = 1.0
                }
                self.table.reloadData()
                if animateTable {
                    NSAnimationContext.runAnimationGroup { ctx in
                        ctx.duration = 0.14
                        ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
                        self.table.animator().alphaValue = 1.0
                    }
                }
                self.previous.isEnabled = self.offset > 0; self.next.isEnabled = self.offset + self.rows.count < self.total
                self.status.textColor = Design.secondary
                let rawScope = (value["scope"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                self.listScopeFromBackend = !rawScope.isEmpty
                let scope = rawScope.isEmpty ? L10n.t("usage_log.scope.default") : rawScope
                self.listScope = scope; self.pageNumber.stringValue = "\(self.offset / 200 + 1)"; self.pageNumber.isEnabled = self.total > 0; self.pageNumber.needsDisplay = true; self.pageCount.stringValue = L10n.t("usage_log.page_count", ["pages": InterfaceText.formatInteger(max(1, (self.total + 199) / 200))])
                if self.rows.isEmpty {
                    // F08: never print "N 个 · 0 条 · 当前 0–0"; the footer must match the empty state.
                    if self.filterActive {
                        self.status.stringValue = L10n.t("usage_log.status.no_match")
                    } else if self.total == 0 {
                        self.status.stringValue = L10n.t("usage_log.status.no_records_period")
                    } else if self.offset > 0 {
                        self.status.stringValue = L10n.t("usage_log.status.page_empty", ["total": InterfaceText.formatInteger(self.total)])
                    } else {
                        self.status.stringValue = L10n.t("usage_log.status.total", ["total": InterfaceText.formatInteger(self.total)])
                    }
                } else {
                    self.status.stringValue = self.pageStatus()
                }
                self.exportButton.isEnabled = self.total > 0 && self.snapshotID != nil && (value["availability"] as? String) != "unavailable"
                self.updateEmptyState(); self.scroll.contentView.scroll(to:.zero); self.scroll.reflectScrolledClipView(self.scroll.contentView)
                if force {
                    activeApp.usagePage?.update(force: false)
                }
            }
        }
    }
    private var exporting = false
    @objc func exportRows() {
        guard !exporting, !loading, total > 0, let activeApp = app else { return }
        exporting = true
        status.textColor = Design.secondary
        refreshButton.isEnabled = false
        exportButton.isEnabled = false
        pageNumber.isEnabled = false
        period.isEnabled = false
        environmentPill.isEnabled = false
        accountPopup.isEnabled = false
        search.isEnabled = false
        previous.isEnabled = false
        next.isEnabled = false
        let chosenPeriod = periods[max(0, min(periods.count - 1, period.selectedSegment))]
        let chosenEnv = selectedEnvironmentId
        let chosenAcc = selectedAccountId
        let query = search.stringValue
        var collected: [[String: Any]] = []; var generation: Int?; var snapshotID: String? = self.snapshotID; var scope = ""
        func finishExport(errorMsg: String? = nil) {
            exporting = false
            refreshButton.setBusy(false, available: app?.reachable ?? false)
            exportButton.isEnabled = total > 0 && self.snapshotID != nil
            pageNumber.isEnabled = total > 0
            period.isEnabled = true
            environmentPill.isEnabled = true
            accountPopup.isEnabled = true
            search.isEnabled = true
            previous.isEnabled = offset > 0
            next.isEnabled = offset + rows.count < total
            if let errorMsg {
                status.stringValue = errorMsg
                status.textColor = accessibleDangerColor()
            } else {
                status.textColor = Design.secondary
            }
        }
        func readPage() {
            guard let activeApp = app else {
                finishExport(errorMsg: L10n.t("usage_log.export.snapshot_changed"))
                return
            }
            var payload: [String: Any] = [
                "command": "usage_events",
                "period": chosenPeriod,
                "query": query,
                "environmentId": chosenEnv,
                "accountId": chosenAcc,
                "offset": collected.count,
                "limit": 500
            ]
            if let snapshotID { payload["snapshotId"] = snapshotID }
            activeApp.bridge.send(payload) { [weak self] result in
                guard let self, !self.closed else { return }
                guard self.selectedEnvironmentId == chosenEnv, self.selectedAccountId == chosenAcc, let currentApp = self.app else {
                    finishExport(errorMsg: L10n.t("usage_log.export.snapshot_changed"))
                    return
                }
                switch result {
                case .failure(let error):
                    finishExport(errorMsg: L10n.t("usage_log.export.failed", ["error": error.localizedDescription]))
                case .success(let value):
                    let retPeriod = (value["period"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    let retEnv = ((value["selectedEnvironmentId"] as? String) ?? (value["selected_environment_id"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    let retAcc = ((value["selectedAccountId"] as? String) ?? (value["selected_account_id"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    if (!retPeriod.isEmpty && retPeriod != chosenPeriod)
                        || (!retEnv.isEmpty && retEnv != chosenEnv)
                        || (!retAcc.isEmpty && retAcc != chosenAcc) {
                        finishExport(errorMsg: L10n.t("usage_log.export.snapshot_changed"))
                        return
                    }
                    let returnedID = value["snapshot_id"] as? String
                    guard let returnedID, !returnedID.isEmpty, snapshotID == nil || snapshotID == returnedID else { finishExport(errorMsg: L10n.t("usage_log.export.snapshot_changed")); return }
                    snapshotID = returnedID
                    let stamp = intVal(value, "generated_at")
                    if let old = generation, old != stamp {
                        finishExport(errorMsg: L10n.t("usage_log.export.records_updated"))
                        return
                    }
                    generation = stamp; scope = value["scope"] as? String ?? ""
                    let batch = value["rows"] as? [[String: Any]] ?? []; collected += batch
                    let total = intVal(value, "total")
                    self.status.stringValue = L10n.t("usage_log.export.progress", ["loaded": InterfaceText.formatInteger(collected.count), "total": InterfaceText.formatInteger(total)])
                    if collected.count < total && !batch.isEmpty {
                        readPage()
                    } else {
                        let exportedCount = collected.count
                        let fallbackScope = scope.isEmpty ? L10n.t("usage_log.scope.default") : scope
                        self.status.stringValue = L10n.t("usage_log.export.choose_location", ["count": InterfaceText.formatInteger(exportedCount)])
                        saveUsageJSON([
                            "period": chosenPeriod,
                            "query": query,
                            "environmentId": chosenEnv,
                            "accountId": chosenAcc,
                            "scope": scope,
                            "generatedAt": stamp,
                            "snapshotId": snapshotID ?? "",
                            "rows": collected
                        ], name: L10n.t("usage_log.export.filename", ["period": chosenPeriod]), window: self.sheet, app: currentApp) { [weak self] saved in
                            guard let self, !self.closed else { return }
                            finishExport()
                            if saved {
                                self.status.stringValue = L10n.t("usage_log.export.saved", ["count": InterfaceText.formatInteger(exportedCount), "scope": fallbackScope])
                            } else {
                                self.status.stringValue = self.pageStatus()
                            }
                        }
                    }
                }
            }
        }
        readPage()
    }
    func updateEmptyState(failed: Bool = false) {
        emptyView.isHidden = !rows.isEmpty; scroll.isHidden = rows.isEmpty
        let symbolName: String
        if failed {
            symbolName = "exclamationmark.triangle"
            emptyIcon.contentTintColor = accessibleWarningColor()
            emptyTitle.stringValue = L10n.t("usage_log.empty.failed")
        } else if loading {
            symbolName = "magnifyingglass"
            emptyIcon.contentTintColor = Design.secondary
            emptyTitle.stringValue = L10n.t("usage_log.loading_rows")
        } else if filterActive {
            symbolName = "line.3.horizontal.decrease.circle"
            emptyIcon.contentTintColor = .secondaryLabelColor
            emptyTitle.stringValue = L10n.t("usage_log.status.no_match")
        } else {
            symbolName = "magnifyingglass"
            emptyIcon.contentTintColor = Design.secondary
            emptyTitle.stringValue = L10n.t("usage_log.empty.none")
        }
        emptyIcon.image = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil)
        clearFiltersButton.isHidden = !filterActive || failed || loading
    }
    private static func isSshEventRow(_ row: [String: Any]) -> Bool {
        let rawEnvKind = ((row["environment_kind"] as? String) ?? (row["environmentKind"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let rawEnvId = ((row["environment_id"] as? String) ?? (row["environmentId"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return rawEnvKind == "ssh" || rawEnvId.hasPrefix("ssh:") || rawEnvId.hasPrefix("host:")
    }

    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }
    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat { 64 }
    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool { false }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard rows.indices.contains(row) else { return nil }
        let card = (tableView.makeView(withIdentifier:NSUserInterfaceItemIdentifier("usage-event-card"),owner:self) as? UsageEventCard) ?? UsageEventCard(frame:.zero)
        let showLocalBadge = selectedEnvironmentId != "local" && cachedHasSshRows
        var rowPayload = rows[row]
        if Self.isSshEventRow(rowPayload) {
            let cleanHost = UsageFilterSupport.cleanedHostLabel(
                from: rowPayload,
                environments: availableEnvironments,
                canonicalHosts: cachedRemoteHosts
            )
            let stripped = SshEnvironmentResolver.cleanHostLabel(cleanHost)
            let resolvedCleanHost = stripped.isEmpty ? cleanHost : stripped
            rowPayload["environment_kind"] = "ssh"
            rowPayload["environment_label"] = resolvedCleanHost
        }
        card.configure(rowPayload, highlight: search.stringValue.trimmingCharacters(in: .whitespacesAndNewlines), showLocalEnvironmentBadge: showLocalBadge)
        return card
    }
}
