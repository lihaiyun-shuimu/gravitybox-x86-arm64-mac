import Cocoa

private final class SourceLinkButton: NSButton {
    let sourceURL: URL
    private var hoverTracking: NSTrackingArea?
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    private var hovered = false {
        didSet {
            if oldValue != hovered { updateAppearance() }
        }
    }

    init(title: String, sourceURL: URL, target: AnyObject?, action: Selector) {
        self.sourceURL = sourceURL
        super.init(frame: .zero)
        self.target = target
        self.action = action
        isBordered = false
        bezelStyle = .inline
        focusRingType = .none
        setButtonType(.momentaryChange)
        translatesAutoresizingMaskIntoConstraints = false
        setAccessibilityElement(true)
        setAccessibilityRole(.link)
        setAccessibilityLabel(title)
        self.title = title
        updateAppearance()
    }

    required init?(coder: NSCoder) { fatalError() }

    private func updateAppearance() {
        let color = hovered ? Design.blue.withAlphaComponent(0.75) : Design.blue
        var attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 10.5, weight: .medium),
            .foregroundColor: color,
        ]
        if hovered {
            attrs[.underlineStyle] = NSUnderlineStyle.single.rawValue
        }
        attributedTitle = NSAttributedString(string: title, attributes: attrs)
        invalidateIntrinsicContentSize()
    }

    override func resetCursorRects() {
        super.resetCursorRects()
        addCursorRect(bounds, cursor: .pointingHand)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let hoverTracking { removeTrackingArea(hoverTracking) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self)
        hoverTracking = area
        addTrackingArea(area)
    }

    override func mouseEntered(with event: NSEvent) { hovered = true }
    override func mouseExited(with event: NSEvent) { hovered = false }
}

private final class RetiredToggleButton: NSButton {
    override var allowsVibrancy: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    private let labelFont = NSFont.systemFont(ofSize: 11.5, weight: .medium)
    private var hoverTracking: NSTrackingArea?
    private var hovered = false {
        didSet {
            if oldValue != hovered { needsDisplay = true }
        }
    }

    init(title: String, target: AnyObject?, action: Selector) {
        super.init(frame: .zero)
        self.title = title
        self.target = target
        self.action = action
        bezelStyle = .inline
        isBordered = false
        focusRingType = .none
        alignment = .left
        font = labelFont
        setButtonType(.momentaryChange)
        translatesAutoresizingMaskIntoConstraints = false
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel(title)
    }

    required init?(coder: NSCoder) { fatalError() }

    override var title: String {
        didSet {
            setAccessibilityLabel(title)
            invalidateIntrinsicContentSize()
            needsDisplay = true
        }
    }

    override var intrinsicContentSize: NSSize {
        let size = (title as NSString).size(withAttributes: [.font: labelFont])
        return NSSize(width: ceil(size.width) + 12, height: 24)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area = hoverTracking { removeTrackingArea(area) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        hoverTracking = area
        addTrackingArea(area)
    }

    override func mouseEntered(with event: NSEvent) { hovered = true }
    override func mouseExited(with event: NSEvent) { hovered = false }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { hovered = false }
    }

    override func resetCursorRects() {
        super.resetCursorRects()
        addCursorRect(bounds, cursor: .pointingHand)
    }

    override func draw(_ dirtyRect: NSRect) {
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        if hovered {
            let bg = NSBezierPath(roundedRect: bounds, xRadius: 6, yRadius: 6)
            (isDark ? NSColor.white.withAlphaComponent(0.06) : NSColor.black.withAlphaComponent(0.045)).setFill()
            bg.fill()
        }
        let textColor = hovered ? NSColor.labelColor : Design.secondary
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byTruncatingTail
        let attrs: [NSAttributedString.Key: Any] = [
            .font: labelFont,
            .foregroundColor: textColor,
            .paragraphStyle: paragraph
        ]
        let textSize = (title as NSString).size(withAttributes: attrs)
        let textRect = NSRect(
            x: 6,
            y: floor((bounds.height - textSize.height) / 2),
            width: max(0, bounds.width - 12),
            height: ceil(textSize.height)
        )
        (title as NSString).draw(in: textRect, withAttributes: attrs)
    }
}

final class PricingSyncSheetController: NSObject, NSWindowDelegate {
    private unowned let app: Assistant
    let sheet = SheetWindow(contentRect: NSRect(x: 0, y: 0, width: 648, height: 512), styleMask: [.titled], backing: .buffered, defer: false)
    private let statusIconBox = NSBox()
    private let statusIconView = NSImageView()
    private let titleLabel = text(L10n.t("pricing_sheet.title"), size: 16, weight: .semibold, color: .labelColor)
    let subtitleLabel = text("", size: 11, color: Design.secondary, wrap: true)
    let summaryPill = pillBadge("", color: Design.blue)
    let historicalNoteLabel = text(L10n.t("pricing_sheet.note"), size: 11, color: Design.secondary, wrap: true)
    let listStack = NSStackView()
    let listScroll = NSScrollView()
    let listCard = DesignCardBox()
    let recheckBtn = InlineRefreshButton(L10n.t("pricing_sheet.recheck"), width: 96, target: nil, action: #selector(recheck))
    let closeBtn = button(L10n.t("pricing_sheet.done"), target: nil, action: #selector(closeSheet))
    private var checking = false
    var onDismiss: (() -> Void)?
    var renderedSummaryLines: [String] = []
    var retiredExpanded = false
    var retiredToggleBtn: NSButton?
    var retiredListStack: NSStackView?
    var renderedRetiredSummaryLines: [String] = []
    private var retiredModelsCount = 0
    private var retiredWidthConstraint: NSLayoutConstraint?
    private var lastPayload: [String: Any]?
    private var languageObserver: NSObjectProtocol?

    private static let checkTimeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.dateFormat = "MM-dd HH:mm"
        return f
    }()

    private static let priceFormatter: NumberFormatter = {
        let f = NumberFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.numberStyle = .decimal
        f.minimumFractionDigits = 2
        f.maximumFractionDigits = 4
        f.usesGroupingSeparator = false
        return f
    }()

    init(app: Assistant) {
        self.app = app
        super.init()
        sheet.title = L10n.t("pricing_sheet.title")
        sheet.isReleasedWhenClosed = false
        sheet.backgroundColor = .clear
        sheet.isOpaque = false
        sheet.delegate = self
        sheet.onCancelOperation = { [weak self] in self?.closeSheet() }

        let surface = SheetVisualEffectView()
        sheet.contentView = surface

        statusIconBox.boxType = .custom
        statusIconBox.cornerRadius = 8.5
        statusIconBox.borderWidth = 0.5
        statusIconBox.contentViewMargins = .zero
        statusIconBox.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            statusIconBox.widthAnchor.constraint(equalToConstant: 32),
            statusIconBox.heightAnchor.constraint(equalToConstant: 32)
        ])
        statusIconBox.setAccessibilityElement(false)
        statusIconView.translatesAutoresizingMaskIntoConstraints = false
        statusIconView.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 15, weight: .semibold)
        statusIconBox.addSubview(statusIconView)
        NSLayoutConstraint.activate([
            statusIconView.centerXAnchor.constraint(equalTo: statusIconBox.centerXAnchor),
            statusIconView.centerYAnchor.constraint(equalTo: statusIconBox.centerYAnchor)
        ])

        let headerTextCol = vertical([titleLabel, subtitleLabel], spacing: 2)
        headerTextCol.detachesHiddenViews = true
        headerTextCol.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        subtitleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        fillWidth(titleLabel, in: headerTextCol)
        fillWidth(subtitleLabel, in: headerTextCol)
        summaryPill.setContentHuggingPriority(.required, for: .horizontal)
        summaryPill.setContentCompressionResistancePriority(.required, for: .horizontal)

        let headerRow = horizontal([statusIconBox, headerTextCol, flexibleSpace(), summaryPill], spacing: 10)
        headerRow.alignment = .centerY

        listStack.orientation = .vertical
        listStack.alignment = .leading
        listStack.spacing = 7
        listStack.detachesHiddenViews = true
        listStack.translatesAutoresizingMaskIntoConstraints = false

        let docWrapper = TopAlignedDocument()
        docWrapper.translatesAutoresizingMaskIntoConstraints = false
        docWrapper.addSubview(listStack)
        NSLayoutConstraint.activate([
            listStack.leadingAnchor.constraint(equalTo: docWrapper.leadingAnchor),
            listStack.trailingAnchor.constraint(equalTo: docWrapper.trailingAnchor),
            listStack.topAnchor.constraint(equalTo: docWrapper.topAnchor),
            listStack.bottomAnchor.constraint(equalTo: docWrapper.bottomAnchor)
        ])

        listScroll.drawsBackground = false
        listScroll.hasVerticalScroller = true
        listScroll.autohidesScrollers = true
        listScroll.borderType = .noBorder
        listScroll.documentView = docWrapper
        listScroll.translatesAutoresizingMaskIntoConstraints = false
        let minScrollHeight = listScroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 300)
        minScrollHeight.isActive = true
        listScroll.setContentHuggingPriority(.defaultLow, for: .vertical)
        listScroll.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
        docWrapper.widthAnchor.constraint(equalTo: listScroll.contentView.widthAnchor).isActive = true

        listCard.boxType = .custom
        listCard.cornerRadius = Design.Radius.medium
        listCard.borderWidth = 0.5
        listCard.borderColor = Design.border
        listCard.fillColor = Design.card
        listCard.contentViewMargins = .zero
        listCard.shadow = Design.cardShadow()
        listCard.translatesAutoresizingMaskIntoConstraints = false
        listCard.setContentHuggingPriority(.defaultLow, for: .vertical)
        listCard.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
        listCard.addSubview(listScroll)
        pin(listScroll, to: listCard, inset: 10)

        recheckBtn.target = self
        closeBtn.target = self
        closeBtn.bezelColor = Design.blue
        closeBtn.keyEquivalent = "\r"

        let footerRow = horizontal([flexibleSpace(), recheckBtn, closeBtn], spacing: 8)
        footerRow.alignment = .centerY
        for rigid in [headerRow, historicalNoteLabel, footerRow] {
            rigid.setContentHuggingPriority(.required, for: .vertical)
            rigid.setContentCompressionResistancePriority(.required, for: .vertical)
        }

        let root = vertical([headerRow, listCard, historicalNoteLabel, divider(), footerRow], spacing: 12)
        for child in root.arrangedSubviews { fillWidth(child, in: root) }

        let content = fixedPage(root)
        surface.addSubview(content)
        pin(content, to: surface)
        Design.applyControls(surface)

        languageObserver = NotificationCenter.default.addObserver(
            forName: L10n.didChangeNotification,
            object: nil,
            queue: nil
        ) { [weak self] _ in
            if Thread.isMainThread {
                self?.syncLocalizedChrome()
            } else {
                DispatchQueue.main.async { [weak self] in
                    self?.syncLocalizedChrome()
                }
            }
        }
    }

    deinit {
        if let languageObserver {
            NotificationCenter.default.removeObserver(languageObserver)
        }
    }

    private func syncLocalizedChrome() {
        let localizedTitle = L10n.t("pricing_sheet.title")
        sheet.title = localizedTitle
        titleLabel.stringValue = localizedTitle
        historicalNoteLabel.stringValue = L10n.t("pricing_sheet.note")
        recheckBtn.title = L10n.t("pricing_sheet.recheck")
        recheckBtn.setAccessibilityLabel(recheckBtn.title)
        recheckBtn.invalidateIntrinsicContentSize()
        closeBtn.title = L10n.t("pricing_sheet.done")
        closeBtn.setAccessibilityLabel(closeBtn.title)
        closeBtn.invalidateIntrinsicContentSize()
        if let lastPayload {
            renderPayload(lastPayload, resetScroll: false)
        }
    }

    private static func fmtRate(_ val: Double) -> String {
        let s = priceFormatter.string(from: NSNumber(value: val)) ?? String(format: "%.2f", locale: Locale(identifier: "en_US_POSIX"), val)
        return "$\(s)"
    }

    private static func availabilityRank(_ raw: String?) -> Int {
        switch raw {
        case "tier_locked": return 1
        case "other_tier_only": return 2
        case "retired": return 3
        default: return 0
        }
    }

    private static func hostOrder(for key: String, catalogState: [String: [String: Any]]) -> Int? {
        if let n = catalogState[key]?["hostOrder"] as? NSNumber {
            return n.intValue
        }
        return nil
    }

    private static let modelVersionRegex = try? NSRegularExpression(
        pattern: "(?:gemini|gpt|opus|sonnet|haiku|claude(?:-[a-z]+)?)-(\\d+)(?:[.-](\\d+))?|^o(\\d+)(?:$|[-_])",
        options: [.caseInsensitive]
    )

    private static func modelSortTuple(_ key: String) -> (brandRank: Int, major: Int, minor: Int, seriesRank: Int) {
        let lower = key.lowercased()
        let isOpenAI = lower.hasPrefix("gpt-") || lower.range(of: "^o[1-9](?:$|[-_])", options: .regularExpression) != nil
        let brandRank: Int
        if lower.hasPrefix("gemini-") {
            brandRank = 0
        } else if lower.hasPrefix("claude-") {
            brandRank = 1
        } else if isOpenAI {
            brandRank = 2
        } else {
            brandRank = 3
        }

        var major = 0
        var minor = 0
        if let regex = modelVersionRegex {
            let range = NSRange(lower.startIndex..<lower.endIndex, in: lower)
            if let m = regex.firstMatch(in: lower, range: range) {
                for g in [1, 3] {
                    if m.range(at: g).location != NSNotFound, let r = Range(m.range(at: g), in: lower), let v = Int(lower[r]) {
                        major = v
                        break
                    }
                }
                if m.range(at: 2).location != NSNotFound, let r = Range(m.range(at: 2), in: lower), let v = Int(lower[r]) {
                    minor = v
                }
            }
        }

        let seriesRank: Int
        if brandRank == 0 {
            if lower.contains("flash-lite") { seriesRank = 3 }
            else if lower.contains("flash") { seriesRank = 2 }
            else if lower.contains("pro") { seriesRank = 1 }
            else { seriesRank = 0 }
        } else if brandRank == 1 {
            if lower.contains("sonnet") { seriesRank = 1 }
            else if lower.contains("haiku") { seriesRank = 2 }
            else { seriesRank = 0 }
        } else if brandRank == 2 {
            if lower.contains("mini") || lower.contains("nano") || lower.contains("oss") { seriesRank = 1 }
            else { seriesRank = 0 }
        } else {
            seriesRank = 0
        }

        return (brandRank, major, minor, seriesRank)
    }

    private static func compareFamilyAndVersion(_ lhs: String, _ rhs: String) -> Bool {
        let a = modelSortTuple(lhs)
        let b = modelSortTuple(rhs)
        if a.brandRank != b.brandRank { return a.brandRank < b.brandRank }
        if a.major != b.major { return a.major > b.major }
        if a.minor != b.minor { return a.minor > b.minor }
        if a.seriesRank != b.seriesRank { return a.seriesRank < b.seriesRank }
        return lhs.localizedStandardCompare(rhs) == .orderedAscending
    }

    static func sortCurrentPlanKeys(_ keys: [String], catalogState: [String: [String: Any]]) -> [String] {
        keys.sorted { lhs, rhs in
            let hoL = hostOrder(for: lhs, catalogState: catalogState)
            let hoR = hostOrder(for: rhs, catalogState: catalogState)
            if let l = hoL, let r = hoR {
                return l != r ? l < r : compareFamilyAndVersion(lhs, rhs)
            }
            if hoL != nil { return true }
            if hoR != nil { return false }
            let lr = availabilityRank(catalogState[lhs]?["availability"] as? String)
            let rr = availabilityRank(catalogState[rhs]?["availability"] as? String)
            if lr != rr { return lr < rr }
            return compareFamilyAndVersion(lhs, rhs)
        }
    }

    private func makeRigidBadge(_ title: String, color: NSColor) -> PillBadge {
        let badge = pillBadge(title, color: color)
        badge.setContentHuggingPriority(.required, for: .horizontal)
        badge.setContentCompressionResistancePriority(.required, for: .horizontal)
        return badge
    }

    private func makeSectionHeader(_ title: String, topSpacing: CGFloat) -> NSView {
        let lbl = text(title, size: 11, weight: .semibold, color: Design.secondary)
        lbl.setContentCompressionResistancePriority(.required, for: .horizontal)
        let box = NSView()
        box.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(lbl)
        lbl.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            lbl.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 2),
            lbl.trailingAnchor.constraint(lessThanOrEqualTo: box.trailingAnchor),
            lbl.topAnchor.constraint(equalTo: box.topAnchor, constant: topSpacing),
            lbl.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -1)
        ])
        return box
    }

    private func makeTitleViews(key: String, displayName: String?) -> [NSView] {
        let trimmedName = (displayName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedName.isEmpty && trimmedName.lowercased() != key.lowercased() {
            let nameLbl = text(trimmedName, size: 13, weight: .semibold, color: .labelColor)
            nameLbl.lineBreakMode = .byTruncatingTail
            nameLbl.setContentHuggingPriority(.required, for: .horizontal)
            nameLbl.setContentCompressionResistancePriority(.required, for: .horizontal)

            let keyLbl = text(key, size: 11, color: Design.secondary)
            keyLbl.lineBreakMode = .byTruncatingMiddle
            keyLbl.setContentHuggingPriority(.defaultHigh, for: .horizontal)
            keyLbl.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)
            return [nameLbl, keyLbl]
        }
        let modelTitle = text(key, size: 13, weight: .semibold, color: .labelColor)
        modelTitle.lineBreakMode = .byTruncatingMiddle
        modelTitle.setContentHuggingPriority(.defaultHigh, for: .horizontal)
        modelTitle.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)
        return [modelTitle]
    }

    private static let cardBoxFillColor = Design.dynamicAlpha(Design.color(0x000000, 0xFFFFFF), 0.022, 0.035)

    private func makeCardBox(body: NSView, alpha: CGFloat = 1.0) -> DesignCardBox {
        let card = DesignCardBox()
        card.boxType = .custom
        card.cornerRadius = 9
        card.borderWidth = 0.5
        card.borderColor = Design.border
        card.enablesHoverHighlight = false
        card.fillColor = Self.cardBoxFillColor
        card.contentViewMargins = .zero
        card.alphaValue = alpha
        card.addSubview(body)
        body.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            body.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 12),
            body.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -12),
            body.topAnchor.constraint(equalTo: card.topAnchor, constant: 9),
            body.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -9)
        ])
        return card
    }

    private func buildPriceCard(
        key: String,
        entry: [String: Any],
        rawState: String,
        displayName: String?,
        availabilityBadge: (title: String, color: NSColor)?,
        isRetiredSection: Bool = false,
        alpha: CGFloat = 1.0
    ) -> (card: DesignCardBox, summaryLine: String) {
        let inputRate = doubleVal(entry, "input")
        let outputRate = doubleVal(entry, "output")
        let cachedRate = doubleVal(entry, "cached")
        let cacheWriteRate = entry["cacheWrite"] != nil ? doubleVal(entry, "cacheWrite") : nil
        let (stateTitle, stateTint): (String, NSColor) = switch rawState {
        case "confirmed": (L10n.t("pricing_sheet.state.confirmed"), Design.blue)
        case "user": (L10n.t("pricing_sheet.state.user"), .systemPurple)
        case "expired": (L10n.t("pricing_sheet.state.expired"), accessibleWarningColor())
        default: (L10n.t("pricing_sheet.state.historical"), Design.inactivePill)
        }

        // 每张卡片最多只保留 1 枚高信号胶囊：常规当前套餐可用模型（含已核对与参考估算）零胶囊降噪，参考估算统一放第二行元信息。
        let visualPill: (title: String, color: NSColor)?
        var showedHistoricalInline = false
        if isRetiredSection {
            if rawState == "user" || rawState == "expired" {
                visualPill = (stateTitle, stateTint)
            } else {
                visualPill = (availabilityBadge?.title ?? stateTitle, availabilityBadge?.color ?? stateTint)
            }
        } else if rawState == "user" || rawState == "expired" {
            visualPill = (stateTitle, stateTint)
        } else {
            visualPill = availabilityBadge
            showedHistoricalInline = (rawState == "historical")
        }

        let prov = entry["provenance"] as? [String: Any] ?? [:]
        let checkedAt = (prov["checkedAt"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let validUntil = (prov["validUntil"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let sourceUrl = (prov["sourceUrl"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

        var dateParts: [String] = []
        if !checkedAt.isEmpty { dateParts.append(L10n.t("pricing_sheet.date.checked_at", ["date": checkedAt])) }
        if !validUntil.isEmpty {
            let shortDate = validUntil.count >= 10 ? String(validUntil.prefix(10)) : validUntil
            dateParts.append(L10n.t("pricing_sheet.date.valid_until", ["date": shortDate]))
        }
        let dateText = dateParts.joined(separator: " \u{00B7} ")

        var rowMetaParts: [String] = []
        if showedHistoricalInline {
            rowMetaParts.append(stateTitle)
        }
        rowMetaParts.append(contentsOf: dateParts)
        let rowMetaText = rowMetaParts.joined(separator: " \u{00B7} ")

        var topViews = makeTitleViews(key: key, displayName: displayName)
        topViews.append(flexibleSpace())
        if let pill = visualPill {
            topViews.append(makeRigidBadge(pill.title, color: pill.color))
        }

        let topRow = horizontal(topViews, spacing: 8)
        topRow.alignment = .centerY
        topRow.detachesHiddenViews = true

        var rateParts = [
            L10n.t("pricing_sheet.rate.input", ["rate": Self.fmtRate(inputRate)]),
            L10n.t("pricing_sheet.rate.cache_read", ["rate": Self.fmtRate(cachedRate)]),
        ]
        if let cacheWriteRate, cacheWriteRate > 0 {
            rateParts.append(L10n.t("pricing_sheet.rate.cache_write", ["rate": Self.fmtRate(cacheWriteRate)]))
        }
        rateParts.append(L10n.t("pricing_sheet.rate.output", ["rate": Self.fmtRate(outputRate)]))
        let rateLabel = text(rateParts.joined(separator: " \u{00B7} "), size: 11.5, weight: .medium, color: .labelColor)
        rateLabel.font = .monospacedDigitSystemFont(ofSize: 11.5, weight: .medium)
        rateLabel.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)

        var trailingMetaViews: [NSView] = []
        if !rowMetaText.isEmpty {
            let metaLbl = text(rowMetaText, size: 10.5, color: Design.secondary)
            metaLbl.lineBreakMode = .byTruncatingMiddle
            metaLbl.setContentHuggingPriority(.required, for: .horizontal)
            metaLbl.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            trailingMetaViews.append(metaLbl)
        }
        if let url = URL(string: sourceUrl), url.scheme?.lowercased() == "https", url.host != nil {
            let linkBtn = SourceLinkButton(title: L10n.t("pricing_sheet.source_link"), sourceURL: url, target: self, action: #selector(openSourceURL(_:)))
            linkBtn.setContentHuggingPriority(.required, for: .horizontal)
            linkBtn.setContentCompressionResistancePriority(.required, for: .horizontal)
            trailingMetaViews.append(linkBtn)
        }

        let bottomRow: NSView
        if !trailingMetaViews.isEmpty {
            let metaGroup = horizontal(trailingMetaViews, spacing: 8)
            metaGroup.alignment = .centerY
            let row = horizontal([rateLabel, flexibleSpace(), metaGroup], spacing: 8)
            row.alignment = .centerY
            bottomRow = row
        } else {
            bottomRow = rateLabel
        }

        let cardBody = vertical([topRow, bottomRow], spacing: 5)
        for r in cardBody.arrangedSubviews { fillWidth(r, in: cardBody) }
        let card = makeCardBox(body: cardBody, alpha: alpha)

        var summaryLine = "\(key) [\(stateTitle)] \u{00B7} \(rateParts.joined(separator: " \u{00B7} "))"
        if !dateText.isEmpty { summaryLine += " \u{00B7} \(dateText)" }
        if !sourceUrl.isEmpty { summaryLine += " \u{00B7} \(sourceUrl)" }
        if let av = availabilityBadge { summaryLine += " \u{00B7} [\(av.title)]" }
        return (card, summaryLine)
    }

    private func retiredToggleTitle(count: Int) -> String {
        let key = retiredExpanded ? "pricing_sheet.retired.toggle_expanded" : "pricing_sheet.retired.toggle_collapsed"
        return L10n.t(key, ["count": count])
    }

    private func syncRetiredSectionVisibility() {
        guard let retiredStack = retiredListStack, let toggleBtn = retiredToggleBtn else { return }
        retiredStack.isHidden = !retiredExpanded
        if retiredExpanded {
            if retiredWidthConstraint == nil || retiredWidthConstraint?.isActive == false {
                retiredWidthConstraint = retiredStack.widthAnchor.constraint(equalTo: listStack.widthAnchor)
                retiredWidthConstraint?.isActive = true
            }
        } else {
            retiredWidthConstraint?.isActive = false
            retiredWidthConstraint = nil
        }
        toggleBtn.title = retiredToggleTitle(count: retiredModelsCount)
    }

    @objc func toggleRetiredSection() {
        guard retiredListStack != nil, retiredToggleBtn != nil else { return }
        let savedOrigin = listScroll.contentView.bounds.origin
        retiredExpanded.toggle()
        syncRetiredSectionVisibility()
        listScroll.layoutSubtreeIfNeeded()
        let docHeight = listScroll.documentView?.bounds.height ?? 0
        let clipHeight = listScroll.contentView.bounds.height
        let maxY = max(0, docHeight - clipHeight)
        let clampedY = min(max(0, savedOrigin.y), maxY)
        listScroll.contentView.scroll(to: NSPoint(x: savedOrigin.x, y: clampedY))
        listScroll.reflectScrolledClipView(listScroll.contentView)
    }

    func apply(payload: [String: Any]) {
        renderPayload(payload, resetScroll: true)
    }

    struct UnpricedModelGroup {
        let key: String
        let displayName: String
        let disabled: Bool
        let variants: [String]
    }

    private static let unpricedVariantOrder: [String: Int] = [
        "Minimal": -1,
        "Low": 0,
        "Medium": 1,
        "High": 2,
        "XHigh": 3,
        "Extra": 4,
        "Extra High": 5,
        "Extra Low": 6,
        "Max": 7,
        "Thinking": 8,
        "Orchestrator": 9,
    ]

    private static func stripDisplayTierSuffix(_ name: String) -> String {
        let patterns = [
            "\\s*[（(]\\s*(?:extra[\\s-]*high|extra[\\s-]*low|xhigh|extra|high|medium|low|minimal|max|thinking)\\s*[）)]\\s*$",
            "\\s+(?:extra[\\s-]*high|extra[\\s-]*low|xhigh|extra|high|medium|low|minimal|max|thinking)\\s*$"
        ]
        var current = name.trimmingCharacters(in: .whitespacesAndNewlines)
        for pattern in patterns {
            if let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) {
                let range = NSRange(current.startIndex..<current.endIndex, in: current)
                current = regex.stringByReplacingMatches(in: current, range: range, withTemplate: "").trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
        return current
    }

    static func groupUnpricedLiveModels(_ rawUnpriced: [[String: Any]]) -> [UnpricedModelGroup] {
        let parsed: [(key: String, displayName: String, disabled: Bool, variants: [String], hostOrder: Int?)] = rawUnpriced.compactMap { item in
            guard let rawKey = item["key"] as? String else { return nil }
            let key = rawKey.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !key.isEmpty else { return nil }
            let displayName = (item["displayName"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let disabled = item["disabled"] as? Bool == true
            let variants = (item["variants"] as? [String] ?? [])
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
            let hostOrder = (item["hostOrder"] as? NSNumber)?.intValue
            return (key: key, displayName: displayName, disabled: disabled, variants: variants, hostOrder: hostOrder)
        }
        guard !parsed.isEmpty else { return [] }

        let thinkingRegex = try? NSRegularExpression(
            pattern: "^((?:gemini|claude|gpt|o[1-9]).+?)-(extra-high|extra-low|xhigh|extra|high|medium|low|minimal|max|thinking)$",
            options: [.caseInsensitive]
        )
        let orchIdRegex = try? NSRegularExpression(
            pattern: "^gemini-pro-orchestrator-(?!g1(?:-|$)|default$|pro$)([a-z][a-z0-9]*)$",
            options: [.caseInsensitive]
        )
        let orchLabelRegex = try? NSRegularExpression(
            pattern: "^Orchestrator\\s*[（(]\\s*([^)）]+?)\\s*[)）]$",
            options: [.caseInsensitive]
        )
        let spaceOrchLabelRegex = try? NSRegularExpression(
            pattern: "^Orchestrator\\s+(.+?)$",
            options: [.caseInsensitive]
        )
        let trailingOrchLabelRegex = try? NSRegularExpression(
            pattern: "^(.+?)\\s*[（(]\\s*Orchestrator\\s*[）)]$",
            options: [.caseInsensitive]
        )

        func normalizedAliasToken(_ raw: String) -> String {
            raw.lowercased()
                .replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
                .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        }

        // Collect non-orchestrator sibling bases so orchestrator rows only fold into an actually present sibling
        // (never fabricating a hardcoded "gemini-4-<codename>" key).
        var siblingBases: [(key: String, displayNorm: String)] = []
        for item in parsed {
            let lower = item.key.lowercased()
            let keyRange = NSRange(lower.startIndex..<lower.endIndex, in: lower)
            if orchIdRegex?.firstMatch(in: lower, range: keyRange) != nil { continue }
            let dispRange = NSRange(item.displayName.startIndex..<item.displayName.endIndex, in: item.displayName)
            if orchLabelRegex?.firstMatch(in: item.displayName, range: dispRange) != nil { continue }
            if spaceOrchLabelRegex?.firstMatch(in: item.displayName, range: dispRange) != nil { continue }
            if trailingOrchLabelRegex?.firstMatch(in: item.displayName, range: dispRange) != nil { continue }

            var baseKey = lower
            var baseDisp = item.displayName
            if let regex = thinkingRegex,
               let match = regex.firstMatch(in: lower, range: keyRange),
               let baseRange = Range(match.range(at: 1), in: lower) {
                baseKey = String(lower[baseRange])
                baseDisp = stripDisplayTierSuffix(item.displayName)
            }
            siblingBases.append((key: baseKey, displayNorm: normalizedAliasToken(baseDisp)))
        }

        let suffixLabels: [String: String] = [
            "minimal": "Minimal",
            "low": "Low",
            "medium": "Medium",
            "high": "High",
            "xhigh": "XHigh",
            "extra": "Extra",
            "extra-high": "Extra High",
            "extra-low": "Extra Low",
            "max": "Max",
            "thinking": "Thinking",
        ]

        struct Bucket {
            let key: String
            let firstIndex: Int
            var hostOrder: Int?
            var displayName: String
            var hasNonOrchName: Bool
            var disabled: Bool
            var variants: Set<String>
        }
        var order: [String] = []
        var buckets: [String: Bucket] = [:]

        for item in parsed {
            let lower = item.key.lowercased()
            var targetKey = item.key
            var resolvedDisplay = item.displayName
            var isOrch = false
            var collectedVariants = Set(item.variants)

            var orchCandidate: String? = nil
            var isOrchLabel = false
            if let regex = orchIdRegex {
                let range = NSRange(lower.startIndex..<lower.endIndex, in: lower)
                if let m = regex.firstMatch(in: lower, range: range), let r = Range(m.range(at: 1), in: lower) {
                    orchCandidate = String(lower[r])
                }
            }
            if let regex = orchLabelRegex {
                let range = NSRange(item.displayName.startIndex..<item.displayName.endIndex, in: item.displayName)
                if let m = regex.firstMatch(in: item.displayName, range: range), let r = Range(m.range(at: 1), in: item.displayName) {
                    isOrchLabel = true
                    if orchCandidate == nil {
                        let candidate = String(item.displayName[r]).trimmingCharacters(in: .whitespacesAndNewlines)
                        if !["pro", "flash", "default", "unknown", "g1"].contains(candidate.lowercased()) {
                            orchCandidate = candidate
                        }
                    }
                }
            }
            if orchCandidate == nil, let regex = spaceOrchLabelRegex {
                let range = NSRange(item.displayName.startIndex..<item.displayName.endIndex, in: item.displayName)
                if let m = regex.firstMatch(in: item.displayName, range: range), let r = Range(m.range(at: 1), in: item.displayName) {
                    isOrchLabel = true
                    let candidate = stripDisplayTierSuffix(String(item.displayName[r]))
                    if !candidate.isEmpty, !["pro", "flash", "default", "unknown", "g1"].contains(candidate.lowercased()) {
                        orchCandidate = candidate
                    }
                }
            }
            if orchCandidate == nil, let regex = trailingOrchLabelRegex {
                let range = NSRange(item.displayName.startIndex..<item.displayName.endIndex, in: item.displayName)
                if let m = regex.firstMatch(in: item.displayName, range: range), let r = Range(m.range(at: 1), in: item.displayName) {
                    isOrchLabel = true
                    let candidate = stripDisplayTierSuffix(String(item.displayName[r]))
                    if !candidate.isEmpty {
                        orchCandidate = candidate
                    }
                }
            }

            if let candidate = orchCandidate {
                let candLower = candidate.lowercased()
                let candNorm = normalizedAliasToken(candidate)
                let geminiCodenamePattern = "^gemini-(\\d+(?:\\.\\d+)?)-" + NSRegularExpression.escapedPattern(for: candLower) + "$"
                let geminiRegex = try? NSRegularExpression(pattern: geminiCodenamePattern, options: [.caseInsensitive])
                let matchedSibling = siblingBases.first { sib in
                    if sib.key == candNorm || (!sib.displayNorm.isEmpty && sib.displayNorm == candNorm) {
                        return true
                    }
                    if let geminiRegex {
                        let r = NSRange(sib.key.startIndex..<sib.key.endIndex, in: sib.key)
                        if geminiRegex.firstMatch(in: sib.key, range: r) != nil {
                            return true
                        }
                    }
                    return false
                }
                if let matchedSibling {
                    isOrch = true
                    collectedVariants.insert("Orchestrator")
                    targetKey = matchedSibling.key
                    if isOrchLabel {
                        resolvedDisplay = ""
                    }
                }
            } else if let regex = thinkingRegex {
                let range = NSRange(lower.startIndex..<lower.endIndex, in: lower)
                if let m = regex.firstMatch(in: lower, range: range),
                   let baseRange = Range(m.range(at: 1), in: lower),
                   let sufRange = Range(m.range(at: 2), in: lower) {
                    targetKey = String(lower[baseRange])
                    let rawSuf = String(lower[sufRange]).lowercased()
                    collectedVariants.insert(suffixLabels[rawSuf] ?? rawSuf)
                    resolvedDisplay = stripDisplayTierSuffix(item.displayName)
                }
            }

            if var existing = buckets[targetKey] {
                existing.disabled = existing.disabled && item.disabled
                existing.variants.formUnion(collectedVariants)
                if let ho = item.hostOrder {
                    existing.hostOrder = existing.hostOrder.map { min($0, ho) } ?? ho
                }
                if !isOrch && !resolvedDisplay.isEmpty && (!existing.hasNonOrchName || existing.displayName.isEmpty) {
                    existing.displayName = resolvedDisplay
                    existing.hasNonOrchName = true
                }
                buckets[targetKey] = existing
            } else {
                let idx = order.count
                order.append(targetKey)
                buckets[targetKey] = Bucket(
                    key: targetKey,
                    firstIndex: idx,
                    hostOrder: item.hostOrder,
                    displayName: resolvedDisplay,
                    hasNonOrchName: !isOrch && !resolvedDisplay.isEmpty,
                    disabled: item.disabled,
                    variants: collectedVariants
                )
            }
        }

        let orderedKeys = order.sorted { lhs, rhs in
            guard let bl = buckets[lhs], let br = buckets[rhs] else { return false }
            switch (bl.hostOrder, br.hostOrder) {
            case let (l?, r?):
                return l != r ? l < r : bl.firstIndex < br.firstIndex
            case (_?, nil):
                return true
            case (nil, _?):
                return false
            case (nil, nil):
                return bl.firstIndex < br.firstIndex
            }
        }

        return orderedKeys.compactMap { k in
            guard let b = buckets[k] else { return nil }
            let sortedVariants = b.variants.sorted { lhs, rhs in
                let lo = unpricedVariantOrder[lhs] ?? 99
                let ro = unpricedVariantOrder[rhs] ?? 99
                return lo != ro ? lo < ro : lhs.localizedStandardCompare(rhs) == .orderedAscending
            }
            let finalDisplay = b.displayName.isEmpty ? ModelDisplayName.name(b.key) : b.displayName
            return UnpricedModelGroup(
                key: b.key,
                displayName: finalDisplay.isEmpty ? b.key : finalDisplay,
                disabled: b.disabled,
                variants: sortedVariants
            )
        }
    }

    private func renderPayload(_ payload: [String: Any], resetScroll: Bool) {
        lastPayload = payload
        let synced = payload["synced"] as? Bool == true
        let healedCount = payload["healedCount"] as? Int ?? 0
        let err = payload["error"] as? String
        let status = payload["status"] as? [String: Any] ?? [:]
        let feedVersion = (payload["version"] as? String) ?? (status["feedVersion"] as? String) ?? ""
        let prices = payload["prices"] as? [String: [String: Any]] ?? [:]
        let retiredPrices = payload["retiredPrices"] as? [String: [String: Any]] ?? [:]
        let pricingStatus = payload["pricingStatus"] as? [String: String] ?? [:]
        let modelCatalogState = payload["modelCatalogState"] as? [String: [String: Any]] ?? [:]
        let rawUnpriced = payload["unpricedLiveModels"] as? [[String: Any]] ?? []
        let groupedUnpriced = Self.groupUnpricedLiveModels(rawUnpriced)

        let activeCount = prices.count + groupedUnpriced.count
        let totalModels = activeCount > 0 ? activeCount : (status["modelCount"] as? Int ?? 0)
        let lastCheckMs: Double = (status["lastCheckAt"] as? NSNumber)?.doubleValue
            ?? (status["lastSyncAt"] as? NSNumber)?.doubleValue
            ?? 0

        let badgeTint: NSColor = synced ? .systemGreen : accessibleWarningColor()
        statusIconBox.fillColor = NSColor(name: nil) { app in
            let isDark = app.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            return badgeTint.withAlphaComponent(isDark ? 0.18 : 0.11)
        }
        statusIconBox.borderColor = NSColor(name: nil) { app in
            let isDark = app.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            return badgeTint.withAlphaComponent(isDark ? 0.34 : 0.20)
        }
        if synced {
            statusIconView.image = NSImage(systemSymbolName: "dollarsign.arrow.circlepath", accessibilityDescription: nil)
            statusIconView.contentTintColor = .systemGreen
            titleLabel.stringValue = healedCount > 0 ? L10n.t("pricing_sheet.synced_healed") : L10n.t("pricing_sheet.synced")
            if healedCount > 0 {
                subtitleLabel.stringValue = L10n.t("pricing_sheet.healed_sub", ["count": healedCount])
                subtitleLabel.isHidden = false
            } else {
                subtitleLabel.stringValue = ""
                subtitleLabel.isHidden = true
            }
            summaryPill.tint = Design.blue
        } else {
            statusIconView.image = NSImage(systemSymbolName: "exclamationmark.triangle.fill", accessibilityDescription: nil)
            statusIconView.contentTintColor = accessibleWarningColor()
            titleLabel.stringValue = L10n.t("pricing_sheet.sync_incomplete")
            subtitleLabel.stringValue = (err?.isEmpty == false) ? L10n.t("pricing_sheet.check_hint", ["error": err!]) : L10n.t("pricing_sheet.remote_unreachable")
            subtitleLabel.isHidden = false
            summaryPill.tint = accessibleWarningColor()
        }

        if lastCheckMs > 0 {
            let formatted = Self.checkTimeFormatter.string(from: Date(timeIntervalSince1970: lastCheckMs / 1000.0))
            let stateText = synced ? L10n.t("pricing_sheet.pill.synced_at", ["time": formatted]) : L10n.t("pricing_sheet.pill.checked_at", ["time": formatted])
            summaryPill.title = L10n.t("pricing_sheet.pill.count", ["state": stateText, "count": totalModels])
            summaryPill.isHidden = false
        } else if !feedVersion.isEmpty && feedVersion != "unknown" {
            summaryPill.title = L10n.t("pricing_sheet.pill.version_count", ["version": feedVersion, "count": totalModels])
            summaryPill.isHidden = false
        } else {
            summaryPill.title = L10n.t("pricing_sheet.pill.active_count", ["count": totalModels])
            summaryPill.isHidden = totalModels == 0
        }

        retiredWidthConstraint?.isActive = false
        retiredWidthConstraint = nil
        retiredToggleBtn = nil
        retiredListStack = nil
        retiredModelsCount = retiredPrices.count
        listStack.arrangedSubviews.forEach {
            listStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }

        var summaryLines: [String] = []

        if !groupedUnpriced.isEmpty {
            let bannerBox = DesignCardBox()
            bannerBox.boxType = .custom
            bannerBox.cornerRadius = 9
            bannerBox.borderWidth = 0.75
            bannerBox.borderColor = Design.dynamicAlpha(accessibleWarningColor(), 0.34)
            bannerBox.fillColor = Design.dynamicAlpha(accessibleWarningColor(), 0.08, 0.12)
            bannerBox.enablesHoverHighlight = false
            bannerBox.contentViewMargins = .zero

            let bannerIcon = symbol("tag.slash", size: 12.5, color: accessibleWarningColor())
            bannerIcon.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                bannerIcon.widthAnchor.constraint(equalToConstant: 14),
                bannerIcon.heightAnchor.constraint(equalToConstant: 14)
            ])
            let bannerLabel = text(
                L10n.t("pricing_sheet.unpriced_summary_banner", ["count": groupedUnpriced.count]),
                size: 11.5,
                weight: .medium,
                color: .labelColor,
                wrap: true
            )
            bannerLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            let bannerRow = horizontal([bannerIcon, bannerLabel], spacing: 8)
            bannerRow.alignment = .centerY
            bannerBox.addSubview(bannerRow)
            pin(bannerRow, to: bannerBox, inset: 9)
            listStack.addArrangedSubview(bannerBox)
            fillWidth(bannerBox, in: listStack)
        }

        for group in groupedUnpriced {
            let unpricedBadgeTitle = group.disabled
                ? L10n.t("pricing_sheet.availability.unpriced_locked")
                : L10n.t("pricing_sheet.availability.unpriced_live")
            var topViews = makeTitleViews(key: group.key, displayName: group.displayName)
            topViews.append(flexibleSpace())
            topViews.append(makeRigidBadge(unpricedBadgeTitle, color: accessibleWarningColor()))
            let topRow = horizontal(topViews, spacing: 8)
            topRow.alignment = .centerY

            var cardRows: [NSView] = [topRow]
            if !group.variants.isEmpty {
                let variantsLabel = text(
                    L10n.t("pricing_sheet.unpriced_variants", ["variants": group.variants.joined(separator: " · ")]),
                    size: 11,
                    color: Design.secondary,
                    wrap: true
                )
                cardRows.append(variantsLabel)
            }
            let cardBody = vertical(cardRows, spacing: 5)
            for r in cardBody.arrangedSubviews { fillWidth(r, in: cardBody) }
            let card = makeCardBox(body: cardBody)
            listStack.addArrangedSubview(card)
            fillWidth(card, in: listStack)
            let variantsSummary = group.variants.isEmpty ? "" : " (\(group.variants.joined(separator: ", ")))"
            summaryLines.append("\(group.key) [\(unpricedBadgeTitle)]\(variantsSummary)")
        }

        let currentPlanKeys = Self.sortCurrentPlanKeys(
            prices.keys.filter { (modelCatalogState[$0]?["availability"] as? String ?? "available") != "other_tier_only" },
            catalogState: modelCatalogState
        )
        let otherPlanKeys = Self.sortCurrentPlanKeys(
            prices.keys.filter { (modelCatalogState[$0]?["availability"] as? String) == "other_tier_only" },
            catalogState: modelCatalogState
        )

        let appendPriceSection: ([String], String?) -> Void = { keys, sectionTitle in
            guard !keys.isEmpty else { return }
            if let sectionTitle {
                let header = self.makeSectionHeader(sectionTitle, topSpacing: self.listStack.arrangedSubviews.isEmpty ? 0 : 4)
                self.listStack.addArrangedSubview(header)
                fillWidth(header, in: self.listStack)
            }
            for key in keys {
                guard let entry = prices[key] else { continue }
                let meta = modelCatalogState[key]
                let availability = meta?["availability"] as? String ?? "available"
                let displayName = meta?["displayName"] as? String
                let avBadge: (title: String, color: NSColor)?
                switch availability {
                case "tier_locked":
                    avBadge = (L10n.t("pricing_sheet.availability.tier_locked"), accessibleWarningColor())
                case "other_tier_only":
                    let tiers = (meta?["availableInTiers"] as? [String] ?? [])
                        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                        .filter { !$0.isEmpty }
                    let title = tiers.isEmpty
                        ? L10n.t("pricing_sheet.availability.other_tier")
                        : L10n.t("pricing_sheet.availability.other_tier_named", ["tiers": tiers.joined(separator: "/")])
                    avBadge = (title, Design.inactivePill)
                default:
                    avBadge = nil
                }
                let built = self.buildPriceCard(
                    key: key,
                    entry: entry,
                    rawState: pricingStatus[key] ?? "historical",
                    displayName: displayName,
                    availabilityBadge: avBadge
                )
                self.listStack.addArrangedSubview(built.card)
                fillWidth(built.card, in: self.listStack)
                summaryLines.append(built.summaryLine)
            }
        }

        let showSectionHeaders = !otherPlanKeys.isEmpty || (!groupedUnpriced.isEmpty && !currentPlanKeys.isEmpty)
        appendPriceSection(currentPlanKeys, showSectionHeaders ? L10n.t("pricing_sheet.section.current") : nil)
        appendPriceSection(otherPlanKeys, !otherPlanKeys.isEmpty ? L10n.t("pricing_sheet.section.other_tier") : nil)

        var retiredSummary: [String] = []
        if !retiredPrices.isEmpty {
            if !groupedUnpriced.isEmpty || !currentPlanKeys.isEmpty || !otherPlanKeys.isEmpty {
                let sep = divider()
                listStack.addArrangedSubview(sep)
                fillWidth(sep, in: listStack)
            }
            let toggleBtn = RetiredToggleButton(
                title: retiredToggleTitle(count: retiredPrices.count),
                target: self,
                action: #selector(toggleRetiredSection)
            )
            retiredToggleBtn = toggleBtn
            listStack.addArrangedSubview(toggleBtn)
            fillWidth(toggleBtn, in: listStack)

            let retiredStack = NSStackView()
            retiredStack.orientation = .vertical
            retiredStack.alignment = .leading
            retiredStack.spacing = 7
            retiredStack.translatesAutoresizingMaskIntoConstraints = false
            retiredListStack = retiredStack

            let retiredBadgeTitle = L10n.t("pricing_sheet.availability.retired")
            for key in retiredPrices.keys.sorted(by: { Self.compareFamilyAndVersion($0, $1) }) {
                guard let entry = retiredPrices[key] else { continue }
                let displayName = modelCatalogState[key]?["displayName"] as? String
                let built = buildPriceCard(
                    key: key,
                    entry: entry,
                    rawState: pricingStatus[key] ?? "historical",
                    displayName: displayName,
                    availabilityBadge: (retiredBadgeTitle, Design.inactivePill),
                    isRetiredSection: true,
                    alpha: 0.88
                )
                retiredStack.addArrangedSubview(built.card)
                fillWidth(built.card, in: retiredStack)
                retiredSummary.append(built.summaryLine)
            }
            listStack.addArrangedSubview(retiredStack)
            syncRetiredSectionVisibility()
        }
        renderedRetiredSummaryLines = retiredSummary

        if groupedUnpriced.isEmpty && currentPlanKeys.isEmpty && otherPlanKeys.isEmpty && retiredPrices.isEmpty {
            let emptyLabel = text(L10n.t("pricing_sheet.empty"), size: 12, color: Design.secondary)
            listStack.addArrangedSubview(emptyLabel)
        }
        renderedSummaryLines = summaryLines
        listScroll.documentView?.layoutSubtreeIfNeeded()
        if resetScroll {
            listScroll.contentView.scroll(to: .zero)
            listScroll.reflectScrolledClipView(listScroll.contentView)
        }
    }

    @objc private func openSourceURL(_ sender: SourceLinkButton) {
        NSWorkspace.shared.open(sender.sourceURL)
    }

    func reloadFromBackend() {
        guard !checking else { return }
        app.bridge.send(["command": "api_pricing_get"]) { [weak self] result in
            guard let self, self.sheet.isVisible else { return }
            if case .success(var payload) = result {
                let status = payload["status"] as? [String: Any]
                let statusSynced = status?["lastSyncSuccess"] as? Bool
                if payload["synced"] == nil {
                    payload["synced"] = statusSynced ?? (self.lastPayload?["synced"] as? Bool ?? true)
                }
                self.apply(payload: payload)
            }
        }
    }

    @objc func recheck() {
        guard !checking else { return }
        checking = true
        recheckBtn.setBusy(true, available: true)
        app.bridge.send(["command": "pricing_sync_check"]) { [weak self] result in
            guard let self else { return }
            self.checking = false
            self.recheckBtn.setBusy(false, available: self.app.reachable)
            if case .success(let payload) = result {
                self.apply(payload: payload)
                if payload["synced"] as? Bool == true {
                    self.app.invalidateUsageReportCache()
                    self.app.overview?.fetch()
                    self.app.usagePage?.fetch(force: true)
                }
            } else if case .failure(let err) = result {
                self.app.showMessage(L10n.t("pricing_sheet.check_failed", ["error": err.localizedDescription]), error: true)
            }
        }
    }

    func show(in parent: NSWindow, payload: [String: Any], onDismiss: (() -> Void)? = nil) {
        self.onDismiss = onDismiss
        retiredExpanded = false
        apply(payload: payload)
        if sheet.sheetParent == nil {
            app.presentRetainedSheet(controller: self, sheet: sheet, in: parent) { [weak self] _ in
                self?.onDismiss?()
            }
        }
        sheet.makeFirstResponder(nil)
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        closeSheet()
        return false
    }

    @objc func closeSheet() {
        sheet.sheetParent?.endSheet(sheet)
    }
}
