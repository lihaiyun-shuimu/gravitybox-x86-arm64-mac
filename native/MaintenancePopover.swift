import Cocoa

extension CachePage {
    // MARK: - Stage 1 & Stage 3 Non-Intrusive NSPopover Disclosure
    @objc func runtimeInfoPressed(_ sender: NSView) {
        toggleDetailPopover(.runtime, relativeTo: sender, preferredEdge: .maxY)
    }

    @objc func historyInfoPressed(_ sender: NSView) {
        toggleDetailPopover(.history, relativeTo: sender, preferredEdge: .maxY)
    }

    func toggleDetailPopover(_ kind: DetailKind, relativeTo anchor: NSView, preferredEdge: NSRectEdge = .maxY) {
        if activePopoverKind == kind, detailPopover != nil {
            dismissDetailPopover()
            return
        }
        openDetailPopover(kind, relativeTo: anchor, preferredEdge: preferredEdge)
    }

    func openDetailPopover(_ kind: DetailKind, relativeTo anchor: NSView, preferredEdge: NSRectEdge = .maxY) {
        dismissDetailPopover()
        let contentView = makeDetailPopoverContentView(for: kind)
        Design.applyControls(contentView)
        Self.stripTooltipsRecursively(contentView)
        contentView.layoutSubtreeIfNeeded()

        let vc = NSViewController()
        vc.view = contentView

        let pop = NSPopover()
        pop.contentViewController = vc
        pop.behavior = .transient
        pop.animates = Design.shouldAnimate(in: anchor)
        pop.delegate = self

        detailPopover = pop
        activePopoverKind = kind
        syncPopoverActiveStates()

        #if NATIVE_UI_TEST
        let allowPopoverDisplay = !Assistant.headlessOffscreenUI
        #else
        let allowPopoverDisplay = true
        #endif
        if allowPopoverDisplay,
           let hostWindow = anchor.window,
           hostWindow.isVisible,
           anchor.bounds.width > 0,
           anchor.bounds.height > 0 {
            pop.show(relativeTo: anchor.bounds, of: anchor, preferredEdge: preferredEdge)
        }
    }

    func dismissDetailPopover() {
        let existing = detailPopover
        detailPopover = nil
        activePopoverKind = nil
        syncPopoverActiveStates()
        if let existing, existing.isShown {
            existing.performClose(nil)
        }
    }

    func popoverDidClose(_ notification: Notification) {
        guard let closed = notification.object as? NSPopover, closed === detailPopover else { return }
        detailPopover = nil
        activePopoverKind = nil
        syncPopoverActiveStates()
    }

    func syncPopoverActiveStates() {
        runtimeInfoButton.isActivePopover = (activePopoverKind == .runtime)
        historyInfoButton.isActivePopover = (activePopoverKind == .history)
        legendRuntimeTrigger.isActivePopover = (activePopoverKind == .runtime)
        legendHistoryTrigger.isActivePopover = (activePopoverKind == .history)
        legendProtectedTrigger.isActivePopover = (activePopoverKind == .protected)
        recoveryTriggerView.isActivePopover = (activePopoverKind == .snapshot)
    }

    static func containsCJK(_ value: String) -> Bool {
        value.range(of: "[\\u4E00-\\u9FFF]", options: .regularExpression) != nil
    }

    func formatCount(_ count: Int) -> String {
        InterfaceText.formatInteger(max(0, count))
    }

    private func localizedRetentionWindowTitle() -> String {
        Self.retentionChoices.first(where: { $0.days == selectedRetentionDays })?.title
            ?? L10n.t("maintenance.simple.retention_7d")
    }

    private func localizedDynamicWindowDesc() -> String {
        selectedRetentionDays > 0
            ? L10n.t("maintenance.window.days_ago", ["days": selectedRetentionDays])
            : L10n.t("maintenance.window.inactive")
    }

    private func localizedCatalogEntry(_ item: [String: Any]) -> (title: String, subtitle: String, icon: String) {
        let rawName = (item["name"] as? String) ?? ""
        let rawTitle = (item["title"] as? String) ?? ""
        let rawSub = (item["subtitle"] as? String) ?? ""
        let rawIcon = (item["icon"] as? String) ?? ""
        let spec = Self.catalogSpecByName[rawName]
        let icon = !rawIcon.isEmpty ? rawIcon : (spec?.icon ?? "folder")
        let needsEnglishOverride = L10n.shared.isEnglish
        let isLanguageMismatched: (String) -> Bool = { text in
            guard !text.isEmpty else { return true }
            return needsEnglishOverride ? Self.containsCJK(text) : !Self.containsCJK(text)
        }

        let resolvedTitle: String
        if spec == nil && !isLanguageMismatched(rawTitle) {
            resolvedTitle = rawTitle
        } else if let prefix = spec?.prefix {
            resolvedTitle = L10n.t("\(prefix).title", fallback: rawName)
        } else if !isLanguageMismatched(rawTitle) {
            resolvedTitle = rawTitle
        } else {
            resolvedTitle = rawName
        }

        let resolvedSub: String
        if spec == nil && !isLanguageMismatched(rawSub) {
            resolvedSub = rawSub
        } else if rawName == "AgentSubagentDatabases" {
            let subCount = historyBucketSubagentCount > 0 ? historyBucketSubagentCount : max(1, intVal(item, "fileCount"))
            resolvedSub = L10n.t("maintenance.dynamic.subagent_sub", ["windowDesc": localizedDynamicWindowDesc(), "count": subCount])
        } else if rawName == "AgentTaskStepLogs" {
            resolvedSub = L10n.t("maintenance.dynamic.task_step_sub", ["windowDesc": localizedDynamicWindowDesc()])
        } else if rawName == "AgentVerboseTranscripts" {
            resolvedSub = L10n.t("maintenance.dynamic.verbose_sub", ["windowDesc": localizedDynamicWindowDesc()])
        } else if let prefix = spec?.prefix {
            resolvedSub = L10n.t("\(prefix).sub", fallback: L10n.t("maintenance.catalog.default.sub", ["name": rawName]))
        } else if !isLanguageMismatched(rawSub) {
            resolvedSub = rawSub
        } else {
            resolvedSub = L10n.t("maintenance.catalog.default.sub", ["name": rawName])
        }

        return (resolvedTitle, resolvedSub, icon)
    }

    private func localizedProtectedEntry(_ item: [String: Any]) -> (title: String, subtitle: String, icon: String) {
        let rawId = (item["id"] as? String) ?? "workspace"
        let rawTitle = (item["title"] as? String) ?? ""
        let rawSub = (item["subtitle"] as? String) ?? ""
        let rawIcon = (item["icon"] as? String) ?? ""
        let defaultIcon: String
        switch rawId {
        case "conversations": defaultIcon = "bubble.left.and.bubble.right"
        case "gravitybox": defaultIcon = "person.text.rectangle"
        default: defaultIcon = "folder.badge.gearshape"
        }
        let icon = !rawIcon.isEmpty ? rawIcon : defaultIcon
        let needsEnglishOverride = L10n.shared.isEnglish
        let isLanguageMismatched: (String) -> Bool = { text in
            guard !text.isEmpty else { return true }
            return needsEnglishOverride ? Self.containsCJK(text) : !Self.containsCJK(text)
        }

        let titleKey = "maintenance.protected.\(rawId).title"
        let subKey = "maintenance.protected.\(rawId).sub"
        let fallbackTitle = isLanguageMismatched(rawTitle) ? L10n.t("maintenance.protected.workspace.title") : rawTitle
        let fallbackSub = isLanguageMismatched(rawSub) ? L10n.t("maintenance.protected.workspace.sub") : rawSub
        let resolvedTitle = L10n.t(titleKey, fallback: fallbackTitle)
        let resolvedSub = L10n.t(subKey, fallback: fallbackSub)
        return (resolvedTitle, resolvedSub, icon)
    }

    private func effectiveProtectedEntries() -> [[String: Any]] {
        if !protectedEntries.isEmpty {
            return protectedEntries
        }
        return [
            ["id": "workspace", "icon": "folder.badge.gearshape", "bytes": 0],
            ["id": "conversations", "icon": "bubble.left.and.bubble.right", "bytes": 0]
        ]
    }

    private func localizedSnapshotItemTitles(_ snap: [String: Any]) -> [String] {
        let rawNames = (snap["items"] as? [String]) ?? []
        let rawTitles = (snap["itemTitles"] as? [String]) ?? []
        let needsEnglishOverride = L10n.shared.isEnglish
        let hasLangMismatch = rawTitles.contains { title in
            needsEnglishOverride ? Self.containsCJK(title) : !Self.containsCJK(title)
        }
        if !rawTitles.isEmpty && !hasLangMismatch {
            return rawTitles
        }
        if !rawNames.isEmpty {
            return rawNames.map { name in
                if let prefix = Self.catalogSpecByName[name]?.prefix {
                    return L10n.t("\(prefix).title", fallback: name)
                }
                return name
            }
        }
        return rawTitles.filter { !(needsEnglishOverride && Self.containsCJK($0)) }
    }

    func makeDetailPopoverContentView(for kind: DetailKind) -> NSView {
        let headerIcon: String
        let headerTint: NSColor
        let headerTitle: String
        let headerSubtitle: String
        var headerPill: PillBadge?
        var bodyRows: [NSView] = []
        let footerNote: String
        let footerIcon: String

        switch kind {
        case .runtime:
            headerIcon = "memorychip"
            headerTint = Design.blue
            headerTitle = L10n.t("maintenance.popover.runtime.title")
            headerSubtitle = L10n.t("maintenance.popover.runtime.subtitle")
            footerNote = L10n.t("maintenance.popover.runtime.footer")
            footerIcon = "arrow.uturn.backward.circle"

            let runtimeItems = entries
                .filter { !isStatefulItem($0) && ($0["clearable"] as? Bool != false) && intVal($0, "bytes") > 0 }
                .sorted { intVal($0, "bytes") > intVal($1, "bytes") }
            let totalFiles = runtimeBucketFileCount > 0
                ? runtimeBucketFileCount
                : runtimeItems.reduce(0) { $0 + intVal($1, "fileCount") }
            if runtimeBucketBytes > 0 {
                headerPill = pillBadge(formatBytes(runtimeBucketBytes), color: Design.blue)
            }

            if runtimeItems.isEmpty {
                bodyRows.append(makePopoverEmptyRow(L10n.t("maintenance.popover.runtime.empty")))
            } else {
                let visibleLimit = 5
                for item in runtimeItems.prefix(visibleLimit) {
                    let meta = localizedCatalogEntry(item)
                    let bytes = Int64(intVal(item, "bytes"))
                    let files = intVal(item, "fileCount")
                    bodyRows.append(makePopoverEntryRow(
                        icon: meta.icon,
                        tint: Design.blue,
                        title: meta.title,
                        subtitle: meta.subtitle,
                        trailingPrimary: formatBytes(bytes),
                        trailingSecondary: files > 0 ? L10n.t("maintenance.popover.files_count", ["count": formatCount(files)]) : nil
                    ))
                }
                if runtimeItems.count > visibleLimit {
                    let extraItems = runtimeItems.dropFirst(visibleLimit)
                    let extraBytes = extraItems.reduce(Int64(0)) { $0 + Int64(intVal($1, "bytes")) }
                    let extraFiles = extraItems.reduce(0) { $0 + intVal($1, "fileCount") }
                    bodyRows.append(makePopoverEntryRow(
                        icon: "ellipsis.circle",
                        tint: Design.secondary,
                        title: L10n.t("maintenance.popover.more_items", ["count": extraItems.count]),
                        subtitle: "",
                        trailingPrimary: formatBytes(extraBytes),
                        trailingSecondary: extraFiles > 0 ? L10n.t("maintenance.popover.files_count", ["count": formatCount(extraFiles)]) : nil
                    ))
                }
                if totalFiles > 0 {
                    let summaryText = L10n.t("maintenance.popover.total_summary", [
                        "items": runtimeItems.count,
                        "files": formatCount(totalFiles)
                    ])
                    let sumLbl = text(summaryText, size: 10.5, weight: .medium, color: Design.secondary)
                    sumLbl.font = .monospacedDigitSystemFont(ofSize: 10.5, weight: .medium)
                    bodyRows.append(sumLbl)
                }
            }

        case .history:
            let amberTint = Design.color(0xD97706, 0xFBBF24)
            let winTitle = localizedRetentionWindowTitle()
            headerIcon = "list.bullet.rectangle.portrait"
            headerTint = amberTint
            headerTitle = L10n.t("maintenance.popover.history.title", ["window": winTitle])
            headerSubtitle = L10n.t("maintenance.popover.history.subtitle")
            footerNote = L10n.t("maintenance.popover.history.footer")
            footerIcon = "checkmark.shield"

            let historyItems = entries
                .filter { isStatefulItem($0) && ($0["clearable"] as? Bool != false) && intVal($0, "bytes") > 0 }
                .sorted { intVal($0, "bytes") > intVal($1, "bytes") }
            let totalFiles = historyBucketFileCount > 0
                ? historyBucketFileCount
                : historyItems.reduce(0) { $0 + intVal($1, "fileCount") }
            if historyBucketBytes > 0 {
                headerPill = pillBadge(formatBytes(historyBucketBytes), color: amberTint)
            }

            if historyItems.isEmpty {
                bodyRows.append(makePopoverEmptyRow(L10n.t("maintenance.popover.history.empty", ["window": winTitle])))
            } else {
                for item in historyItems {
                    let meta = localizedCatalogEntry(item)
                    let bytes = Int64(intVal(item, "bytes"))
                    let files = intVal(item, "fileCount")
                    bodyRows.append(makePopoverEntryRow(
                        icon: meta.icon,
                        tint: amberTint,
                        title: meta.title,
                        subtitle: meta.subtitle,
                        trailingPrimary: formatBytes(bytes),
                        trailingSecondary: files > 0 ? L10n.t("maintenance.popover.files_count", ["count": formatCount(files)]) : nil
                    ))
                }
                if totalFiles > 0 {
                    let summaryText = L10n.t("maintenance.popover.total_summary", [
                        "items": historyItems.count,
                        "files": formatCount(totalFiles)
                    ])
                    let sumLbl = text(summaryText, size: 10.5, weight: .medium, color: Design.secondary)
                    sumLbl.font = .monospacedDigitSystemFont(ofSize: 10.5, weight: .medium)
                    bodyRows.append(sumLbl)
                }
            }

        case .protected:
            headerIcon = "checkmark.shield"
            headerTint = .systemGreen
            headerTitle = L10n.t("maintenance.popover.protected.title")
            headerSubtitle = L10n.t("maintenance.popover.protected.subtitle")
            headerPill = pillBadge(L10n.t("maintenance.popover.protected.badge"), color: .systemGreen)
            footerNote = L10n.t("maintenance.popover.protected.footer")
            footerIcon = "lock.shield"

            for prot in effectiveProtectedEntries() {
                let meta = localizedProtectedEntry(prot)
                let bytes = Int64(intVal(prot, "bytes"))
                let files = intVal(prot, "fileCount")
                bodyRows.append(makePopoverEntryRow(
                    icon: meta.icon,
                    tint: .systemGreen,
                    title: meta.title,
                    subtitle: meta.subtitle,
                    trailingPrimary: bytes > 0 ? formatBytes(bytes) : nil,
                    trailingSecondary: files > 0 ? L10n.t("maintenance.popover.files_count", ["count": formatCount(files)]) : nil,
                    wrapSubtitle: true
                ))
            }

        case .snapshot:
            headerIcon = "arrow.uturn.backward.circle"
            headerTint = Design.blue
            headerTitle = L10n.t("maintenance.popover.snapshot.title")
            footerNote = L10n.t("maintenance.popover.snapshot.footer")
            footerIcon = "doc.badge.gearshape"

            if let snap = latestUndoSnapshot ?? snapshots.first {
                let snapId = (snap["id"] as? String) ?? ""
                let fullSnap = snapshots.first(where: { ($0["id"] as? String) == snapId }) ?? snap
                let bytes = Int64(intVal(fullSnap, "totalBytes", fallback: intVal(snap, "totalBytes")))
                let files = max(1, intVal(fullSnap, "fileCount", fallback: intVal(snap, "fileCount", fallback: 1)))
                let ts = intVal(fullSnap, "timestamp", fallback: intVal(snap, "timestamp"))
                let timeStr = ts > 0
                    ? Self.snapshotDateFormatter.string(from: Date(timeIntervalSince1970: TimeInterval(ts)))
                    : L10n.t("maintenance.recovery.recent")
                let sizeStr = bytes > 0 ? formatBytes(bytes) : L10n.t("maintenance.recovery.items_count", ["count": 1])
                headerSubtitle = L10n.t("maintenance.popover.snapshot.subtitle", [
                    "time": timeStr,
                    "files": formatCount(files),
                    "size": sizeStr
                ])
                if bytes > 0 {
                    headerPill = pillBadge(sizeStr, color: Design.blue)
                }
                let itemTitles = localizedSnapshotItemTitles(fullSnap)
                if itemTitles.isEmpty {
                    bodyRows.append(makePopoverEntryRow(
                        icon: "checkmark.circle",
                        tint: Design.blue,
                        title: L10n.t("maintenance.recovery.items_count", ["count": max(1, intVal(fullSnap, "movedCount", fallback: 1))]),
                        subtitle: "",
                        trailingPrimary: nil,
                        trailingSecondary: nil
                    ))
                } else {
                    for titleStr in itemTitles.prefix(6) {
                        bodyRows.append(makePopoverEntryRow(
                            icon: "checkmark.circle",
                            tint: Design.blue,
                            title: titleStr,
                            subtitle: "",
                            trailingPrimary: nil,
                            trailingSecondary: nil
                        ))
                    }
                }
            } else {
                headerSubtitle = L10n.t("maintenance.simple.safety_idle_sub")
                bodyRows.append(makePopoverEmptyRow(L10n.t("maintenance.popover.snapshot.empty")))
            }
        }

        let badgeIcon = iconBadge(headerIcon, tint: headerTint, size: 24)
        let titleLbl = text(headerTitle, size: 13, weight: .semibold, color: .labelColor)
        titleLbl.lineBreakMode = .byTruncatingTail
        var topItems: [NSView] = [badgeIcon, titleLbl, Self.elasticSpacer()]
        if let headerPill {
            headerPill.setContentHuggingPriority(.required, for: .horizontal)
            headerPill.setContentCompressionResistancePriority(.required, for: .horizontal)
            topItems.append(headerPill)
        }
        let headerTopRow = horizontal(topItems, spacing: 8)
        headerTopRow.alignment = .centerY

        let subLbl = text(headerSubtitle, size: 11, color: Design.secondary, wrap: true)
        let headerStack = vertical([headerTopRow, subLbl], spacing: 5)
        fillWidth(headerTopRow, in: headerStack)
        fillWidth(subLbl, in: headerStack)

        let rowsStack = vertical(bodyRows, spacing: 8)
        for row in bodyRows {
            fillWidth(row, in: rowsStack)
        }

        let fIcon = symbol(footerIcon, size: 11, color: Design.secondary)
        fIcon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 11, weight: .medium)
        fIcon.setContentHuggingPriority(.required, for: .horizontal)
        fIcon.setContentCompressionResistancePriority(.required, for: .horizontal)
        let fText = text(footerNote, size: 10.5, color: Design.secondary, wrap: true)
        let footerRow = horizontal([fIcon, fText], spacing: 6)
        footerRow.alignment = .top

        let contentStack = vertical([headerStack, divider(), rowsStack, divider(), footerRow], spacing: 10)
        for section in contentStack.arrangedSubviews {
            fillWidth(section, in: contentStack)
        }

        let container = NSView()
        container.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(contentStack)
        pin(contentStack, to: container, inset: 14)
        container.widthAnchor.constraint(equalToConstant: Self.popoverWidth).isActive = true
        return container
    }

    private func makePopoverEmptyRow(_ message: String) -> NSView {
        let lbl = text(message, size: 11.5, color: Design.secondary, wrap: true)
        return lbl
    }

    private func makePopoverEntryRow(
        icon: String,
        tint: NSColor,
        title: String,
        subtitle: String,
        trailingPrimary: String?,
        trailingSecondary: String?,
        wrapSubtitle: Bool = false
    ) -> NSView {
        let rowIcon = symbol(icon, size: 12, color: tint)
        rowIcon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 12, weight: .medium)
        rowIcon.setContentHuggingPriority(.required, for: .horizontal)
        rowIcon.setContentCompressionResistancePriority(.required, for: .horizontal)

        let titleLbl = text(title, size: 12, weight: .medium, color: .labelColor)
        titleLbl.lineBreakMode = .byTruncatingTail
        var textItems: [NSView] = [titleLbl]
        if !subtitle.isEmpty {
            let subLbl = text(subtitle, size: 10.5, color: Design.secondary, wrap: wrapSubtitle)
            if wrapSubtitle {
                subLbl.maximumNumberOfLines = 2
            } else {
                subLbl.maximumNumberOfLines = 1
                subLbl.lineBreakMode = .byTruncatingTail
            }
            textItems.append(subLbl)
        }
        let leftCaptions = vertical(textItems, spacing: 1.5)
        leftCaptions.alignment = .leading
        leftCaptions.setContentHuggingPriority(.defaultLow, for: .horizontal)
        leftCaptions.setContentCompressionResistancePriority(NSLayoutConstraint.Priority(720), for: .horizontal)
        for item in textItems {
            fillWidth(item, in: leftCaptions)
        }

        var rowViews: [NSView] = [rowIcon, leftCaptions, Self.elasticSpacer()]
        if trailingPrimary != nil || trailingSecondary != nil {
            var rightItems: [NSView] = []
            if let primary = trailingPrimary, !primary.isEmpty {
                let pLbl = text(primary, size: 11.5, weight: .semibold, color: .labelColor)
                pLbl.font = .monospacedDigitSystemFont(ofSize: 11.5, weight: .semibold)
                pLbl.alignment = .right
                pLbl.setContentHuggingPriority(.required, for: .horizontal)
                pLbl.setContentCompressionResistancePriority(.required, for: .horizontal)
                rightItems.append(pLbl)
            }
            if let secondary = trailingSecondary, !secondary.isEmpty {
                let sLbl = text(secondary, size: 10, color: Design.secondary)
                sLbl.font = .monospacedDigitSystemFont(ofSize: 10, weight: .regular)
                sLbl.alignment = .right
                sLbl.setContentHuggingPriority(.required, for: .horizontal)
                sLbl.setContentCompressionResistancePriority(.required, for: .horizontal)
                rightItems.append(sLbl)
            }
            let rightCol = vertical(rightItems, spacing: 1)
            rightCol.alignment = .trailing
            rightCol.setContentHuggingPriority(.required, for: .horizontal)
            rightCol.setContentCompressionResistancePriority(.required, for: .horizontal)
            rowViews.append(rightCol)
        }

        let row = horizontal(rowViews, spacing: 8)
        row.alignment = subtitle.isEmpty ? .centerY : .top
        return row
    }

}
