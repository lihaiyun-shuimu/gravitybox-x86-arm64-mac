import Cocoa

/// Keep the field editor and the inactive number on exactly the same text rectangle.
private final class PolicyNumberCell: NSTextFieldCell {
    private func textRect(_ rect: NSRect) -> NSRect {
        let font = font ?? .systemFont(ofSize: 12)
        let height = ceil(font.ascender - font.descender + font.leading)
        return NSRect(x: rect.minX+8, y: rect.midY-height/2, width: max(0, rect.width-16), height: height)
    }
    override func draw(withFrame rect: NSRect, in view: NSView) {
        let focused = (view as? NSTextField)?.currentEditor() != nil
        drawInput(rect, focused: focused)
        guard !focused else { return }
        let style = NSMutableParagraphStyle(); style.alignment = alignment
        (stringValue as NSString).draw(in: textRect(rect), withAttributes: [
            .font: font ?? NSFont.systemFont(ofSize: 12),
            .foregroundColor: isEnabled ? NSColor.labelColor : Design.secondary, .paragraphStyle: style
        ])
    }
    override func edit(withFrame rect: NSRect, in view: NSView, editor: NSText, delegate: Any?, event: NSEvent?) {
        editor.alignment = alignment
        if let tv = editor as? NSTextView {
            tv.drawsBackground = false
            tv.textContainerInset = .zero
            tv.textContainer?.lineFragmentPadding = 0
        }
        super.edit(withFrame: textRect(rect), in: view, editor: editor, delegate: delegate, event: event)
    }
    override func select(withFrame rect: NSRect, in view: NSView, editor: NSText, delegate: Any?, start: Int, length: Int) {
        editor.alignment = alignment
        if let tv = editor as? NSTextView {
            tv.drawsBackground = false
            tv.textContainerInset = .zero
            tv.textContainer?.lineFragmentPadding = 0
        }
        super.select(withFrame: textRect(rect), in: view, editor: editor, delegate: delegate, start: start, length: length)
    }
}

final class PolicyNumberField: NSTextField {
    override func becomeFirstResponder() -> Bool {
        let ok = super.becomeFirstResponder()
        if ok { needsDisplay = true }
        return ok
    }
    override func textDidEndEditing(_ notification: Notification) {
        super.textDidEndEditing(notification)
        needsDisplay = true
    }
}

final class AccountPolicySheet: NSObject {
    static let sheetWidth: CGFloat = 520

    unowned let app: Assistant
    let activeAccount: [String: Any]?
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: AccountPolicySheet.sheetWidth, height: 340), styleMask: [.titled], backing: .buffered, defer: false)
    let strategyPopup = DesignPopUpButton(frame: .zero, pullsDown: false)
    let modelPopup = DesignPopUpButton(frame: .zero, pullsDown: false)
    let monitoredSubLabel = text("", size: 11, color: Design.secondary, wrap: true)
    let reserve = PolicyNumberField(string: "")
    let candidate = PolicyNumberField(string: "")
    let errorLabel = text("", size: 11.5, color: accessibleDangerColor(), wrap: true)
    private(set) var fieldsCard: NSBox!
    private var contentViewRef: NSView!
    private var popupWidthConstraints: [NSLayoutConstraint] = []
    private var languageObserver: NSObjectProtocol?
    private var titleLabel: NSTextField!
    private var strategyTitleLabel: NSTextField!
    private var strategySubLabel: NSTextField!
    private var monitoredTitleLabel: NSTextField!
    private var reserveTitleLabel: NSTextField!
    private var reserveSubLabel: NSTextField!
    private var candidateTitleLabel: NSTextField!
    private var candidateSubLabel: NSTextField!
    private let initialRawMonitoredModel: String
    private var userChangedMonitoredScope = false
    private var saving = false
    private let cancelButton = button(L10n.t("common.cancel", fallback: "取消"), target: nil, action: #selector(cancel))
    let saved: () -> Void
    var onDismiss: (() -> Void)?
    let saveButton = button(L10n.t("common.save", fallback: "保存"), target: nil, action: #selector(save))

    deinit {
        if let languageObserver {
            NotificationCenter.default.removeObserver(languageObserver)
        }
    }

    init(app: Assistant, config: [String: Any], saved: @escaping () -> Void) {
        self.app = app
        self.activeAccount = app.resolvedActiveAccount()
        self.initialRawMonitoredModel = (config["monitored_model"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        self.saved = saved
        super.init()
        window.title = L10n.t("policy.title", fallback: "备用推荐配置")
        window.isReleasedWhenClosed = false

        strategyPopup.addItem(withTitle: L10n.t("policy.strategy.priority", fallback: "配额充裕优先"))
        strategyPopup.lastItem?.representedObject = "priority"
        strategyPopup.addItem(withTitle: L10n.t("policy.strategy.round_robin", fallback: "按顺序轮询"))
        strategyPopup.lastItem?.representedObject = "round_robin"
        let strat = config["strategy"] as? String ?? "priority"
        strategyPopup.selectItem(at: strat == "round_robin" ? 1 : 0)
        strategyPopup.translatesAutoresizingMaskIntoConstraints = false
        strategyPopup.heightAnchor.constraint(equalToConstant: 28).isActive = true
        strategyPopup.setAccessibilityLabel(L10n.t("policy.strategy.a11y", fallback: "推荐策略"))

        let modelChoices = QuotaPresentation.monitoredScopeChoices(for: activeAccount)
        let menu = NSMenu()
        for choice in modelChoices {
            if choice.isSeparator {
                menu.addItem(.separator())
            } else {
                let item = NSMenuItem(title: choice.title, action: nil, keyEquivalent: "")
                item.representedObject = choice.key
                menu.addItem(item)
            }
        }
        modelPopup.menu = menu

        let rawMonitored = (config["monitored_model"] as? String ?? "all").trimmingCharacters(in: .whitespacesAndNewlines)
        let effectiveKey = QuotaPresentation.effectiveMonitoredModelKey(rawMonitored, activeAccount: activeAccount)
        if let selectedItem = menu.items.first(where: { ($0.representedObject as? String)?.lowercased() == effectiveKey.lowercased() }) {
            modelPopup.select(selectedItem)
        } else if let firstSelectable = menu.items.first(where: { !$0.isSeparatorItem }) {
            modelPopup.select(firstSelectable)
        }
        modelPopup.target = self
        modelPopup.action = #selector(monitoredScopeChanged)
        modelPopup.translatesAutoresizingMaskIntoConstraints = false
        modelPopup.heightAnchor.constraint(equalToConstant: 28).isActive = true
        modelPopup.setAccessibilityLabel(L10n.t("policy.model.a11y", fallback: "监测模型组"))

        reserve.stringValue = "\(intVal(config, "reserve_percentage", fallback: 10))"
        candidate.stringValue = "\(intVal(config, "candidate_min_percentage", fallback: 30))"
        reserve.setAccessibilityLabel(L10n.t("policy.reserve.a11y", fallback: "当前账号低于百分比"))
        candidate.setAccessibilityLabel(L10n.t("policy.candidate.a11y", fallback: "推荐账号至少剩余百分比"))
        for field in [reserve, candidate] {
            let value = field.stringValue
            field.cell = PolicyNumberCell(textCell: value)
            field.identifier = NSUserInterfaceItemIdentifier("native-percent-input")
            field.alignment = .center
            field.isEditable = true; field.isSelectable = true
            field.isBezeled = false; field.drawsBackground = false; field.focusRingType = .none
            field.font = .systemFont(ofSize: 12)
            (field.cell as? NSTextFieldCell)?.usesSingleLineMode = true
            field.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                field.widthAnchor.constraint(equalToConstant: 64),
                field.heightAnchor.constraint(equalToConstant: 28)
            ])
        }

        func policyFormRow(title: String, subtitle: String, subtitleLabel: NSTextField? = nil, control: NSView) -> (row: NSView, titleLbl: NSTextField, subLbl: NSTextField) {
            let titleLbl = text(title, size: 12.5, weight: .medium, color: .labelColor)
            let subLbl = subtitleLabel ?? text(subtitle, size: 11, color: Design.secondary, wrap: true)
            if subtitleLabel != nil { subLbl.stringValue = subtitle }
            subLbl.isHidden = subtitle.isEmpty
            let left = vertical([titleLbl, subLbl], spacing: 2)
            fillWidth(subLbl, in: left)
            left.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            control.setContentHuggingPriority(.required, for: .horizontal)
            control.setContentCompressionResistancePriority(.required, for: .horizontal)
            let row = horizontal([left, flexibleSpace(), control], spacing: 12)
            row.alignment = .centerY
            return (row, titleLbl, subLbl)
        }

        func percentControl(_ field: NSTextField) -> NSView {
            let unit = text("%", size: 12, weight: .medium, color: Design.secondary)
            let row = horizontal([field, unit], spacing: 6)
            row.alignment = .centerY
            return row
        }

        let initialSelectedKey = (modelPopup.selectedItem?.representedObject as? String) ?? effectiveKey
        let initialSubtitle = QuotaPresentation.monitoredScopeSubtitle(for: initialSelectedKey, activeAccount: activeAccount)

        let strategyRow = policyFormRow(title: L10n.t("policy.row.strategy.title", fallback: "推荐排序方式"), subtitle: L10n.t("policy.row.strategy.sub", fallback: "高阶订阅优先，同等级下按此规则排序"), control: strategyPopup)
        strategyTitleLabel = strategyRow.titleLbl
        strategySubLabel = strategyRow.subLbl
        let monitoredRow = policyFormRow(title: L10n.t("policy.row.monitored.title", fallback: "监测模型范围"), subtitle: initialSubtitle, subtitleLabel: monitoredSubLabel, control: modelPopup)
        monitoredTitleLabel = monitoredRow.titleLbl
        let reserveRow = policyFormRow(title: L10n.t("policy.row.reserve.title", fallback: "触发切换阈值"), subtitle: L10n.t("policy.row.reserve.sub", fallback: "当前配额 ≤ 此值时提示切换"), control: percentControl(reserve))
        reserveTitleLabel = reserveRow.titleLbl
        reserveSubLabel = reserveRow.subLbl
        let candidateRow = policyFormRow(title: L10n.t("policy.row.candidate.title", fallback: "候选准入下限"), subtitle: L10n.t("policy.row.candidate.sub", fallback: "备用配额 ≥ 此值才参与推荐"), control: percentControl(candidate))
        candidateTitleLabel = candidateRow.titleLbl
        candidateSubLabel = candidateRow.subLbl

        let fields = vertical([
            strategyRow.row,
            divider(),
            monitoredRow.row,
            divider(),
            reserveRow.row,
            divider(),
            candidateRow.row
        ], spacing: 12)
        for fieldRow in fields.arrangedSubviews { fillWidth(fieldRow, in: fields) }
        fields.setContentHuggingPriority(.required, for: .vertical)

        let card = group([fields], inset: 16)
        card.setContentHuggingPriority(.required, for: .vertical)
        card.setContentCompressionResistancePriority(.required, for: .vertical)
        self.fieldsCard = card

        cancelButton.target = self
        cancelButton.keyEquivalent = "\u{1b}"
        saveButton.target = self
        saveButton.bezelColor = Design.blue
        saveButton.keyEquivalent = "\r"
        errorLabel.isHidden = true

        let headerBadge = iconBadge("arrow.left.arrow.right", tint: Design.blue, size: 32)
        let titleLabel = text(L10n.t("policy.title", fallback: "备用推荐配置"), size: 16, weight: .semibold, color: .labelColor)
        self.titleLabel = titleLabel
        let heading = horizontal([headerBadge, titleLabel, flexibleSpace()], spacing: 10)
        heading.alignment = .centerY

        let footer = horizontal([errorLabel, flexibleSpace(), cancelButton, saveButton], spacing: 8)
        footer.alignment = .centerY

        let root = vertical([heading, card, divider(), footer], spacing: 14)
        for child in root.arrangedSubviews { fillWidth(child, in: root) }
        let surface = SheetVisualEffectView()
        let content = fixedPage(root)
        self.contentViewRef = content
        surface.addSubview(content)
        pin(content, to: surface)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.contentView = surface
        Design.applyControls(surface)
        let unifiedPopupWidth = min(216, max(104, Design.fittedPopUpWidth(strategyPopup), Design.fittedPopUpWidth(modelPopup)))
        popupWidthConstraints = [
            strategyPopup.widthAnchor.constraint(equalToConstant: unifiedPopupWidth),
            modelPopup.widthAnchor.constraint(equalToConstant: unifiedPopupWidth)
        ]
        NSLayoutConstraint.activate(popupWidthConstraints)
        for popup in [strategyPopup, modelPopup] {
            popup.focusRingType = .none
            popup.cell?.focusRingType = .none
        }
        resizeSheetToFit()
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
        let title = L10n.t("policy.title", fallback: "备用推荐配置")
        window.title = title
        titleLabel.stringValue = title
        let selectedStrat = (strategyPopup.selectedItem?.representedObject as? String) ?? "priority"
        strategyPopup.item(at: 0)?.title = L10n.t("policy.strategy.priority", fallback: "配额充裕优先")
        strategyPopup.item(at: 1)?.title = L10n.t("policy.strategy.round_robin", fallback: "按顺序轮询")
        strategyPopup.selectItem(at: selectedStrat == "round_robin" ? 1 : 0)
        strategyPopup.setAccessibilityLabel(L10n.t("policy.strategy.a11y", fallback: "推荐策略"))

        let selectedModelKey = (modelPopup.selectedItem?.representedObject as? String) ?? "all"
        let menu = NSMenu()
        for choice in QuotaPresentation.monitoredScopeChoices(for: activeAccount) {
            if choice.isSeparator {
                menu.addItem(.separator())
            } else {
                let item = NSMenuItem(title: choice.title, action: nil, keyEquivalent: "")
                item.representedObject = choice.key
                menu.addItem(item)
            }
        }
        modelPopup.menu = menu
        if let item = menu.items.first(where: { ($0.representedObject as? String)?.lowercased() == selectedModelKey.lowercased() }) {
            modelPopup.select(item)
        } else if let first = menu.items.first(where: { !$0.isSeparatorItem }) {
            modelPopup.select(first)
        }
        modelPopup.setAccessibilityLabel(L10n.t("policy.model.a11y", fallback: "监测模型组"))
        reserve.setAccessibilityLabel(L10n.t("policy.reserve.a11y", fallback: "当前账号低于百分比"))
        candidate.setAccessibilityLabel(L10n.t("policy.candidate.a11y", fallback: "推荐账号至少剩余百分比"))
        strategyTitleLabel.stringValue = L10n.t("policy.row.strategy.title", fallback: "推荐排序方式")
        strategySubLabel.stringValue = L10n.t("policy.row.strategy.sub", fallback: "高阶订阅优先，同等级下按此规则排序")
        monitoredTitleLabel.stringValue = L10n.t("policy.row.monitored.title", fallback: "监测模型范围")
        reserveTitleLabel.stringValue = L10n.t("policy.row.reserve.title", fallback: "触发切换阈值")
        reserveSubLabel.stringValue = L10n.t("policy.row.reserve.sub", fallback: "当前配额 ≤ 此值时提示切换")
        candidateTitleLabel.stringValue = L10n.t("policy.row.candidate.title", fallback: "候选准入下限")
        candidateSubLabel.stringValue = L10n.t("policy.row.candidate.sub", fallback: "备用配额 ≥ 此值才参与推荐")
        cancelButton.title = L10n.t("common.cancel", fallback: "取消")
        saveButton.title = L10n.t("common.save", fallback: "保存")
        strategyPopup.invalidateIntrinsicContentSize()
        modelPopup.invalidateIntrinsicContentSize()
        let unifiedPopupWidth = min(216, max(104, Design.fittedPopUpWidth(strategyPopup), Design.fittedPopUpWidth(modelPopup)))
        for constraint in popupWidthConstraints {
            constraint.constant = unifiedPopupWidth
        }
        updateMonitoredSubtitle()
    }

    private static func syncWrappingLabelWidths(in view: NSView) {
        if let tf = view as? NSTextField, !tf.isEditable, tf.cell?.wraps == true, !tf.isHidden, tf.bounds.width > 1 {
            let targetW = floor(tf.bounds.width)
            if abs(tf.preferredMaxLayoutWidth - targetW) > 0.5 {
                tf.preferredMaxLayoutWidth = targetW
                tf.invalidateIntrinsicContentSize()
            }
        }
        for sub in view.subviews {
            syncWrappingLabelWidths(in: sub)
        }
    }

    func resizeSheetToFit() {
        guard let surface = window.contentView, let content = contentViewRef else { return }
        if abs(surface.frame.width - Self.sheetWidth) > 0.5 {
            surface.frame.size.width = Self.sheetWidth
        }
        surface.layoutSubtreeIfNeeded()
        Self.syncWrappingLabelWidths(in: surface)
        surface.layoutSubtreeIfNeeded()
        let targetHeight = max(260, ceil(content.fittingSize.height))
        if abs(window.frame.width - Self.sheetWidth) > 0.5 || abs(window.frame.height - targetHeight) > 0.5 {
            window.setContentSize(NSSize(width: Self.sheetWidth, height: targetHeight))
        }
        surface.layoutSubtreeIfNeeded()
    }

    private func updateMonitoredSubtitle() {
        let selectedKey = (modelPopup.selectedItem?.representedObject as? String) ?? "all"
        let sub = QuotaPresentation.monitoredScopeSubtitle(for: selectedKey, activeAccount: activeAccount)
        monitoredSubLabel.stringValue = sub
        monitoredSubLabel.isHidden = sub.isEmpty
        resizeSheetToFit()
    }

    @objc func monitoredScopeChanged() {
        userChangedMonitoredScope = true
        updateMonitoredSubtitle()
    }

    func show(in parent: NSWindow, onDismiss: @escaping () -> Void) {
        self.onDismiss = onDismiss
        resizeSheetToFit()
        app.presentRetainedSheet(controller: self, sheet: window, in: parent) { [weak self] _ in
            self?.onDismiss?()
        }
    }

    @objc func cancel() {
        guard !saving else { return }
        window.sheetParent?.endSheet(window)
    }

    @objc func save() {
        guard !saving else { return }
        guard let low = Int(reserve.stringValue.trimmingCharacters(in: .whitespaces)), (1...98).contains(low) else {
            errorLabel.stringValue = L10n.t("policy.error.reserve_range", fallback: "触发阈值请输入 1–98 之间的整数。")
            errorLabel.isHidden = false
            resizeSheetToFit()
            return
        }
        guard let min = Int(candidate.stringValue.trimmingCharacters(in: .whitespaces)), (2...100).contains(min) else {
            errorLabel.stringValue = L10n.t("policy.error.candidate_range", fallback: "候选下限请输入 2–100 之间的整数。")
            errorLabel.isHidden = false
            resizeSheetToFit()
            return
        }
        guard min > low else {
            errorLabel.stringValue = L10n.t("policy.error.candidate_le_reserve", fallback: "候选准入下限必须大于触发切换阈值。")
            errorLabel.isHidden = false
            resizeSheetToFit()
            return
        }
        errorLabel.stringValue = ""
        errorLabel.isHidden = true
        resizeSheetToFit()
        let strat = strategyPopup.selectedItem?.representedObject as? String ?? "priority"
        let selectedModel = modelPopup.selectedItem?.representedObject as? String ?? "all"
        let model = (!userChangedMonitoredScope && !initialRawMonitoredModel.isEmpty) ? initialRawMonitoredModel : selectedModel
        saving = true
        saveButton.isEnabled = false
        cancelButton.isEnabled = false
        let onSaved = self.saved
        app.bridge.send([
            "command": "auto_switch_set",
            "config": [
                "reserve_percentage": low,
                "candidate_min_percentage": min,
                "strategy": strat,
                "monitored_model": model
            ]
        ]) { [weak self] response in
            switch response {
            case .success:
                onSaved()
                guard let self else { return }
                self.saving = false
                self.saveButton.isEnabled = true
                self.cancelButton.isEnabled = true
                self.cancel()
            case .failure(let error):
                guard let self else { return }
                self.saving = false
                self.saveButton.isEnabled = true
                self.cancelButton.isEnabled = true
                self.errorLabel.stringValue = error.localizedDescription
                self.errorLabel.isHidden = false
                self.resizeSheetToFit()
            }
        }
    }
}
