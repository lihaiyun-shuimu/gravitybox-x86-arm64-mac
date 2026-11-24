import Cocoa

private final class CopyTextMenuItem: NSMenuItem {
    weak var label: NSTextField?
    var rawValue: String?
    init(label: NSTextField, value: String?, title: String) {
        self.label = label; self.rawValue = value
        super.init(title: title, action: #selector(copyText), keyEquivalent: "")
        target = self
    }
    required init(coder: NSCoder) { fatalError() }
    @objc func copyText() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(rawValue ?? label?.stringValue ?? "", forType: .string)
    }
}
func enableTextCopy(_ label: NSTextField, value: String? = nil, title: String? = nil) {
    let resolvedTitle = title ?? L10n.t("common.copy_full_content", fallback: "复制完整内容")
    if let existingMenu = label.menu,
       existingMenu.items.count == 1,
       let existingItem = existingMenu.items.first as? CopyTextMenuItem {
        existingItem.label = label
        existingItem.rawValue = value
        if existingItem.title != resolvedTitle {
            existingItem.title = resolvedTitle
        }
        return
    }
    let menu = NSMenu()
    menu.addItem(CopyTextMenuItem(label: label, value: value, title: resolvedTitle))
    label.menu = menu
}

func text(_ value: String, size: CGFloat = 13, weight: NSFont.Weight = .regular, color: NSColor = .labelColor, wrap: Bool = false) -> NSTextField {
    let label = wrap ? NSTextField(wrappingLabelWithString: value) : NSTextField(labelWithString: value)
    label.font = .systemFont(ofSize: size, weight: weight); label.textColor = color
    if wrap {
        label.maximumNumberOfLines = 0
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    }
    return label
}
func vertical(_ views: [NSView], spacing: CGFloat = 12) -> NSStackView {
    let stack = NSStackView(views: views); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = spacing
    return stack
}
func horizontal(_ views: [NSView], spacing: CGFloat = 10) -> NSStackView {
    let stack = NSStackView(views: views); stack.orientation = .horizontal; stack.alignment = .centerY; stack.spacing = spacing
    return stack
}
func flexibleSpace() -> NSView {
    let view = NSView(); view.setContentHuggingPriority(.defaultLow, for: .horizontal); return view
}
func pin(_ view: NSView, to parent: NSView, inset: CGFloat = 0) {
    view.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([view.leadingAnchor.constraint(equalTo: parent.leadingAnchor, constant: inset), view.trailingAnchor.constraint(equalTo: parent.trailingAnchor, constant: -inset), view.topAnchor.constraint(equalTo: parent.topAnchor, constant: inset), view.bottomAnchor.constraint(equalTo: parent.bottomAnchor, constant: -inset)])
}
func fillWidth(_ view: NSView, in stack: NSStackView) { view.translatesAutoresizingMaskIntoConstraints = false; view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true }
func symbol(_ name: String, size: CGFloat = 22, color: NSColor = .controlAccentColor) -> NSImageView {
    let view = NSImageView(image: NSImage(systemSymbolName: name, accessibilityDescription: nil) ?? NSImage(systemSymbolName: "square", accessibilityDescription: nil) ?? NSImage())
    view.setAccessibilityElement(false)
    view.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: size, weight: .regular); view.contentTintColor = color
    view.translatesAutoresizingMaskIntoConstraints = false; view.widthAnchor.constraint(equalToConstant: size + 4).isActive = true; view.heightAnchor.constraint(equalToConstant: size + 4).isActive = true
    return view
}
func button(_ title: String, target: AnyObject?, action: Selector) -> NSButton {
    let view = DesignButton(title: title, target: target, action: action)
    view.bezelStyle = .rounded; view.isBordered = false; view.font = .systemFont(ofSize: 12, weight: .medium)
    return view
}
class DesignCardBox: NSBox {
    var enablesHoverHighlight: Bool = false {
        didSet {
            if enablesHoverHighlight { updateTrackingAreas() }
        }
    }
    private var hoverTrackingArea: NSTrackingArea?
    private let hoverMotion = DesignMotion()
    private var hoverProgress: CGFloat = 0

    deinit {
        hoverMotion.cancel()
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area = hoverTrackingArea { removeTrackingArea(area); hoverTrackingArea = nil }
        guard enablesHoverHighlight else { return }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        hoverTrackingArea = area
        addTrackingArea(area)
    }

    override func mouseEntered(with event: NSEvent) {
        guard enablesHoverHighlight else { return }
        hoverMotion.animate(in: self, from: hoverProgress, to: 1.0, curve: .hover) { [weak self] val in
            self?.hoverProgress = val
            self?.needsDisplay = true
        }
    }

    override func mouseExited(with event: NSEvent) {
        guard enablesHoverHighlight else { return }
        hoverMotion.animate(in: self, from: hoverProgress, to: 0.0, curve: .hover) { [weak self] val in
            self?.hoverProgress = val
            self?.needsDisplay = true
        }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if Design.isInPopover(self) {
            shadow = nil
        }
        if window == nil {
            hoverMotion.cancel()
            hoverProgress = 0
        }
    }
    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        if enablesHoverHighlight && hoverProgress > 0.005 {
            let hoverRect = bounds.insetBy(dx: 0.5, dy: 0.5)
            let hoverPath = NSBezierPath(roundedRect: hoverRect, xRadius: cornerRadius, yRadius: cornerRadius)
            (isDark ? NSColor.white.withAlphaComponent(0.028 * hoverProgress) : NSColor.black.withAlphaComponent(0.016 * hoverProgress)).setFill()
            hoverPath.fill()
            Design.blue.withAlphaComponent((isDark ? 0.22 : 0.16) * hoverProgress).setStroke()
            hoverPath.lineWidth = 0.75
            hoverPath.stroke()
        }
        Design.drawSpecularBevel(in: bounds, cornerRadius: cornerRadius, isDark: isDark)
    }
}

final class SheetWindow: NSWindow {
    var onCancelOperation: (() -> Void)?
    override func cancelOperation(_ sender: Any?) {
        if let onCancelOperation {
            onCancelOperation()
        } else {
            super.cancelOperation(sender)
        }
    }
}

final class SheetVisualEffectView: NSVisualEffectView {
    override init(frame frameRect: NSRect = .zero) {
        super.init(frame: frameRect)
        material = .sheet
        blendingMode = .behindWindow
        state = .active
        wantsLayer = true
        layer?.cornerRadius = Design.Radius.medium
        layer?.masksToBounds = true
    }
    required init?(coder: NSCoder) { fatalError() }
    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let path = NSBezierPath(roundedRect: bounds, xRadius: Design.Radius.medium, yRadius: Design.Radius.medium)
        (isDark ? NSColor(white: 0.14, alpha: 0.88) : NSColor(white: 0.98, alpha: 0.88)).setFill()
        path.fill()
        Design.drawSpecularBevel(in: bounds, cornerRadius: Design.Radius.medium, isDark: isDark)
    }
}

final class PillSelectionView: NSView {
    override var allowsVibrancy: Bool { false }
    private let motion = DesignMotion()
    private var currentTargetRect: NSRect = .zero

    override init(frame frameRect: NSRect = .zero) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.cornerRadius = 9
    }
    required init?(coder: NSCoder) { fatalError() }

    deinit {
        motion.cancel()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil {
            motion.cancel()
        }
    }

    func slide(to targetRect: NSRect, in view: NSView?) {
        guard targetRect != currentTargetRect else { return }
        currentTargetRect = targetRect
        guard Design.shouldAnimate(in: view), frame != .zero, frame != targetRect else {
            frame = targetRect
            needsDisplay = true
            return
        }
        let startY = frame.origin.y
        let startH = frame.height
        let targetY = targetRect.origin.y
        let targetH = targetRect.height
        motion.animate(in: view, from: 0.0, to: 1.0, curve: .spring, threshold: 0.01) { [weak self] p in
            guard let self else { return }
            let y = startY + (targetY - startY) * p
            let h = startH + (targetH - startH) * p
            self.frame = NSRect(x: targetRect.origin.x, y: y, width: targetRect.width, height: h)
            self.needsDisplay = true
        } completion: { [weak self] in
            self?.frame = targetRect
            self?.needsDisplay = true
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let rect = bounds.insetBy(dx: 0.5, dy: 1.0)
        let path = NSBezierPath(roundedRect: rect, xRadius: 9, yRadius: 9)
        Design.blue.withAlphaComponent(isDark ? 0.22 : 0.12).setFill()
        path.fill()
    }
}

func group(_ rows: [NSView], inset: CGFloat = 17, spacing: CGFloat = 0) -> NSBox {
    let box = DesignCardBox(); box.boxType = .custom; box.cornerRadius = Design.Radius.medium; box.borderWidth = 0.5
    box.borderColor = Design.border; box.fillColor = Design.card; box.contentViewMargins = .zero
    box.shadow = Design.cardShadow()
    let stack = vertical(rows, spacing: spacing); box.addSubview(stack); pin(stack, to: box, inset: inset)
    for row in rows { fillWidth(row, in: stack) }
    return box
}
func groupStack(_ box: NSBox) -> NSStackView? {
    (box.subviews.first as? NSStackView) ?? (box.contentView?.subviews.first as? NSStackView)
}
final class DesignDividerView: NSView {
    override var isOpaque: Bool { false }
    override var allowsVibrancy: Bool { false }
    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: 1)
    }
    init() {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(equalToConstant: 1).isActive = true
        setAccessibilityElement(false)
    }
    required init?(coder: NSCoder) { fatalError() }
    override func draw(_ dirtyRect: NSRect) {
        designHairline(lightAlpha: 0.06, darkAlpha: 0.07).setFill()
        bounds.fill()
    }
    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }
}

func divider() -> NSView {
    DesignDividerView()
}
func pageHeader(title: String, actions: NSView? = nil) -> NSView {
    let titleLabel = text(title, size: 24, weight: .semibold)
    titleLabel.identifier = NSUserInterfaceItemIdentifier("page-title")
    titleLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
    titleLabel.setContentCompressionResistancePriority(.required, for: .vertical)
    guard let actions else { return titleLabel }
    actions.setContentHuggingPriority(.required, for: .horizontal)
    actions.setContentCompressionResistancePriority(.required, for: .horizontal)
    let row = horizontal([titleLabel, flexibleSpace(), actions])
    row.alignment = .centerY
    return row
}
func pageStack(title: String, actions: NSView? = nil) -> NSStackView {
    vertical([pageHeader(title: title, actions: actions)], spacing: 20)
}
func fixedPage(_ stack: NSStackView) -> NSView {
    let container = NSView()
    container.addSubview(stack)
    stack.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
        stack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 24),
        stack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -24),
        stack.topAnchor.constraint(equalTo: container.topAnchor, constant: 20),
        stack.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -20)
    ])
    for child in stack.arrangedSubviews { fillWidth(child, in: stack) }
    return container
}
final class TopAlignedDocument: NSView { override var isFlipped: Bool { true } }

final class StickyHeaderScrollView: NSScrollView {
    let headerHost = NSVisualEffectView()
    let headerDivider = DesignDividerView()
    var onViewportHeightChanged: ((CGFloat) -> Void)?
    private var lastReportedViewportHeight: CGFloat = -1
    private var boundsObserver: NSObjectProtocol?

    init(headerView: NSView) {
        super.init(frame: .zero)
        drawsBackground = false
        hasVerticalScroller = true
        autohidesScrollers = true
        automaticallyAdjustsContentInsets = false
        contentInsets = NSEdgeInsets(top: 0, left: 0, bottom: 0, right: 0)

        headerHost.material = .headerView
        headerHost.blendingMode = .withinWindow
        headerHost.state = .active
        headerHost.wantsLayer = true
        headerView.translatesAutoresizingMaskIntoConstraints = false
        headerDivider.translatesAutoresizingMaskIntoConstraints = false
        headerDivider.isHidden = true
        headerHost.addSubview(headerView)
        headerHost.addSubview(headerDivider)
        NSLayoutConstraint.activate([
            headerView.leadingAnchor.constraint(equalTo: headerHost.leadingAnchor, constant: 24),
            headerView.trailingAnchor.constraint(equalTo: headerHost.trailingAnchor, constant: -24),
            headerView.topAnchor.constraint(equalTo: headerHost.topAnchor, constant: 13),
            headerView.bottomAnchor.constraint(equalTo: headerHost.bottomAnchor, constant: -5),
            headerDivider.leadingAnchor.constraint(equalTo: headerHost.leadingAnchor, constant: 24),
            headerDivider.trailingAnchor.constraint(equalTo: headerHost.trailingAnchor, constant: -24),
            headerDivider.bottomAnchor.constraint(equalTo: headerHost.bottomAnchor),
            headerDivider.heightAnchor.constraint(equalToConstant: 1)
        ])
        addSubview(headerHost)

        contentView.postsBoundsChangedNotifications = true
        boundsObserver = NotificationCenter.default.addObserver(
            forName: NSView.boundsDidChangeNotification,
            object: contentView,
            queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            let scrolled = self.contentView.bounds.origin.y > 2.0
            if self.headerDivider.isHidden == scrolled {
                self.headerDivider.isHidden = !scrolled
            }
        }
    }

    required init?(coder: NSCoder) { fatalError() }

    deinit {
        if let boundsObserver {
            NotificationCenter.default.removeObserver(boundsObserver)
        }
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        tile()
    }

    override func layout() {
        let headerH: CGFloat = 52
        let expectedH = max(0, bounds.height - headerH)
        if abs(headerHost.frame.width - bounds.width) > 0.5
            || abs(contentView.frame.origin.y - headerH) > 0.5
            || abs(contentView.frame.height - expectedH) > 0.5 {
            tile()
        }
        super.layout()
    }

    override func tile() {
        super.tile()
        let headerH: CGFloat = 52
        headerHost.frame = NSRect(x: 0, y: 0, width: bounds.width, height: headerH)
        var clipFrame = contentView.frame
        clipFrame.origin.y = headerH
        clipFrame.size.height = max(0, bounds.height - headerH)
        contentView.frame = clipFrame
        if let vScroller = verticalScroller {
            var sFrame = vScroller.frame
            sFrame.origin.y = headerH
            sFrame.size.height = max(0, bounds.height - headerH)
            vScroller.frame = sFrame
        }
        if abs(clipFrame.size.height - lastReportedViewportHeight) > 0.5 {
            lastReportedViewportHeight = clipFrame.size.height
            onViewportHeightChanged?(clipFrame.size.height)
        }
    }
}

func scrollPage(_ stack: NSStackView) -> NSView {
    if let first = stack.arrangedSubviews.first,
       (first.identifier?.rawValue == "page-title" || first.subviews.contains(where: { $0.identifier?.rawValue == "page-title" })) {
        stack.removeArrangedSubview(first)
        first.removeFromSuperview()
        let scroll = StickyHeaderScrollView(headerView: first)
        let document = TopAlignedDocument()
        document.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = document
        document.addSubview(stack)
        stack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
            stack.leadingAnchor.constraint(equalTo: document.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: document.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: document.topAnchor, constant: 4),
            stack.bottomAnchor.constraint(equalTo: document.bottomAnchor, constant: -16)
        ])
        for view in stack.arrangedSubviews { fillWidth(view, in: stack) }
        return scroll
    }

    let scroll = NSScrollView()
    scroll.drawsBackground = false
    scroll.hasVerticalScroller = true
    scroll.autohidesScrollers = true
    scroll.automaticallyAdjustsContentInsets = false
    scroll.contentInsets = NSEdgeInsets(top: 0, left: 0, bottom: 0, right: 0)
    let document = TopAlignedDocument()
    document.translatesAutoresizingMaskIntoConstraints = false
    scroll.documentView = document
    document.addSubview(stack)
    stack.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
        document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
        stack.leadingAnchor.constraint(equalTo: document.leadingAnchor, constant: 24),
        stack.trailingAnchor.constraint(equalTo: document.trailingAnchor, constant: -24),
        stack.topAnchor.constraint(equalTo: document.topAnchor, constant: 20),
        stack.bottomAnchor.constraint(equalTo: document.bottomAnchor, constant: -20)
    ])
    for view in stack.arrangedSubviews { fillWidth(view, in: stack) }
    return scroll
}
/// Overview adaptively expands across Ultra / Pro / Free quota row counts to fill the scroll viewport cleanly while keeping middle KPI cards poised and steady across tiers.
func dashboardScrollPage(_ stack: NSStackView, hero: NSView, metrics: [NSView], bento: NSView) -> NSView {
    stack.distribution = .fill
    stack.detachesHiddenViews = true
    let scroll = scrollPage(stack) as! NSScrollView
    if let document = scroll.documentView {
        let minViewport = document.heightAnchor.constraint(greaterThanOrEqualTo: scroll.contentView.heightAnchor)
        minViewport.priority = .required
        let fitViewport = document.heightAnchor.constraint(equalTo: scroll.contentView.heightAnchor)
        fitViewport.priority = NSLayoutConstraint.Priority(490)
        NSLayoutConstraint.activate([minViewport, fitViewport])
    }
    for metric in metrics {
        metric.heightAnchor.constraint(greaterThanOrEqualToConstant: 96).isActive = true
        let maxMetricH = metric.heightAnchor.constraint(lessThanOrEqualToConstant: 148)
        maxMetricH.priority = NSLayoutConstraint.Priority(485)
        maxMetricH.isActive = true
        metric.setContentHuggingPriority(NSLayoutConstraint.Priority(230), for: .vertical)
    }
    if let firstMetric = metrics.first {
        let viewportMetricRatio = firstMetric.heightAnchor.constraint(equalTo: scroll.contentView.heightAnchor, multiplier: 0.21)
        viewportMetricRatio.priority = NSLayoutConstraint.Priority(470)
        viewportMetricRatio.isActive = true
    }
    let _ = (hero, bento)
    return scroll
}

// MARK: - Safe Numeric Extraction Helper
func intVal(_ dict: [String: Any], _ key: String, fallback: Int = 0) -> Int {
    if let n = dict[key] as? NSNumber { return n.intValue }
    if let i = dict[key] as? Int { return i }
    if let d = dict[key] as? Double { return Int(d) }
    return fallback
}
func doubleVal(_ dict: [String: Any], _ key: String, fallback: Double = 0.0) -> Double {
    if let n = dict[key] as? NSNumber { return n.doubleValue }
    if let d = dict[key] as? Double { return d }
    if let i = dict[key] as? Int { return Double(i) }
    return fallback
}

// MARK: - Apple HIG Sidebar Row View (Eliminates black selection box in offscreen/inactive states)

func metricValue() -> NSTextField {
    let label = text("—"); label.font = .monospacedDigitSystemFont(ofSize: 21, weight: .bold); label.lineBreakMode = .byTruncatingTail
    label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal); return label
}

final class SurfaceView: NSView {
    override var isOpaque: Bool { true }
    override func draw(_ rect: NSRect) { Design.background.setFill(); rect.fill() }
}

final class EmptyStateView: NSView {
    let iconView: NSImageView
    let titleLabel: NSTextField
    let subtitleLabel: NSTextField
    let actionButton: NSButton?

    init(icon: String, title: String, subtitle: String, buttonTitle: String? = nil, target: AnyObject? = nil, action: Selector? = nil) {
        iconView = NSImageView()
        iconView.image = NSImage(systemSymbolName: icon, accessibilityDescription: nil)
        iconView.contentTintColor = .secondaryLabelColor
        iconView.imageScaling = .scaleProportionallyUpOrDown
        iconView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            iconView.widthAnchor.constraint(equalToConstant: 40),
            iconView.heightAnchor.constraint(equalToConstant: 40)
        ])

        titleLabel = text(title, size: 14, weight: .semibold, color: .labelColor)
        titleLabel.alignment = .center

        subtitleLabel = text(subtitle, size: 12, weight: .regular, color: Design.secondary, wrap: true)
        subtitleLabel.alignment = .center
        subtitleLabel.maximumNumberOfLines = 3

        var views: [NSView] = [iconView, titleLabel]
        if let btnTitle = buttonTitle, let act = action {
            let btn = button(btnTitle, target: target, action: act)
            btn.bezelStyle = .rounded
            btn.controlSize = .regular
            views.append(btn)
            actionButton = btn
        } else {
            actionButton = nil
        }

        super.init(frame: .zero)
        let stack = vertical(views, spacing: 10)
        stack.alignment = .centerX
        addSubview(stack)
        stack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -20),
            heightAnchor.constraint(greaterThanOrEqualToConstant: 160)
        ])
    }

    required init?(coder: NSCoder) { fatalError() }
}

final class TableScrollView: NSScrollView {
    var tableStyle: NSTableView.Style = .fullWidth
    private var fittedWidth: CGFloat = -1
    // G02/F16: 深浅色下统一表格网格线为低对比语义色；表格高度贴合真实行数，避免把空白区域
    // 画成一条条“空记录”分隔线（深色下的可见度远高于浅色，形成深浅不一致）。
    private static let gridLineColor = NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor.white.withAlphaComponent(0.035)
            : NSColor.black.withAlphaComponent(0.10)
    }
    private var originalGridMasks: [ObjectIdentifier: NSTableView.GridLineStyle] = [:]
    override func tile() { super.tile(); fitColumns(); updateEmptyRowGrid() }
    override func layout() { super.layout(); fitColumns(); updateEmptyRowGrid() }
    // G02/F16: NSTableView 在 scroll view 内会把自己的 frame 拉伸到视口高度，并在空白行也画网格线；
    // 数据不足以填满视口时隐藏网格线（与浅色“无行分隔线”一致），填满视口时恢复，
    // 并用自适应低对比色统一深浅色的可见度。
    private func updateEmptyRowGrid() {
        guard let table = documentView as? NSTableView else { return }
        let key = ObjectIdentifier(table)
        if !table.gridStyleMask.isEmpty { originalGridMasks[key] = table.gridStyleMask }
        let rows = table.numberOfRows
        let contentHeight: CGFloat = rows > 0 ? table.rect(ofRow: rows - 1).maxY : 0
        let fillsViewport = contentHeight >= contentView.bounds.height - 1
        let desired: NSTableView.GridLineStyle = fillsViewport ? (originalGridMasks[key] ?? []) : []
        if table.gridStyleMask != desired { table.gridStyleMask = desired }
        if !desired.isEmpty { table.gridColor = Self.gridLineColor }
    }
    private func fitColumns() {
        guard let table = documentView as? NSTableView, !table.tableColumns.isEmpty else { return }
        if table.style != tableStyle { table.style = tableStyle }
        let width = max(contentView.bounds.width, table.tableColumns.reduce(0) { $0 + $1.minWidth } + CGFloat(table.tableColumns.count) * table.intercellSpacing.width)
        guard abs(width - fittedWidth) > 0.5 || abs(table.frame.width - width) > 0.5 else { return }; fittedWidth = width
        let columns = table.tableColumns, weights = table.tableColumns.map { $0.width }, total = table.tableColumns.reduce(0) { $0 + $1.width }
        let gutters = CGFloat(columns.count) * table.intercellSpacing.width
        let minimum = columns.reduce(0) { $0 + $1.minWidth }, extra = max(0, width - minimum - gutters)
        table.columnAutoresizingStyle = .noColumnAutoresizing
        for (index,column) in columns.enumerated() { column.width = column.minWidth + extra * (total > 0 ? weights[index] / total : 1 / CGFloat(columns.count)) }
        table.setFrameSize(NSSize(width: width, height: table.frame.height))
    }
}
