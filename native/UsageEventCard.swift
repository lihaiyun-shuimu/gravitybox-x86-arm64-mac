import Cocoa

private final class UsageLocalTagBadge: NSView {
    override var allowsVibrancy: Bool { false }
    private let iconView = NSImageView()
    private let label = text("", size: 10.5, weight: .medium)
    private let row: NSStackView

    override init(frame frameRect: NSRect) {
        if let sym = NSImage(systemSymbolName: "laptopcomputer", accessibilityDescription: nil)?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 10, weight: .medium)) {
            sym.isTemplate = true
            iconView.image = sym
        }
        iconView.contentTintColor = .secondaryLabelColor
        iconView.setAccessibilityElement(false)
        iconView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            iconView.widthAnchor.constraint(equalToConstant: 11),
            iconView.heightAnchor.constraint(equalToConstant: 10.5)
        ])

        label.font = .systemFont(ofSize: 10.5, weight: .medium)
        label.textColor = .secondaryLabelColor
        label.maximumNumberOfLines = 1
        label.lineBreakMode = .byTruncatingTail
        label.setAccessibilityElement(false)

        row = horizontal([iconView, label], spacing: 3.5)
        row.alignment = .centerY
        row.translatesAutoresizingMaskIntoConstraints = false

        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 5.5),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -5.5),
            row.centerYAnchor.constraint(equalTo: centerYAnchor),
            heightAnchor.constraint(equalToConstant: 17)
        ])
        setContentHuggingPriority(.required, for: .horizontal)
        setContentCompressionResistancePriority(.required, for: .horizontal)
        setContentHuggingPriority(.required, for: .vertical)
        setContentCompressionResistancePriority(.required, for: .vertical)
        setAccessibilityElement(true)
        setAccessibilityRole(.staticText)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func updateTitle(_ title: String) {
        if label.stringValue != title {
            label.stringValue = title
        }
        setAccessibilityLabel(title)
        invalidateIntrinsicContentSize()
        needsDisplay = true
    }

    override var intrinsicContentSize: NSSize {
        let iconW: CGFloat = 11
        let gap: CGFloat = 3.5
        let textW = ceil(label.intrinsicContentSize.width)
        return NSSize(width: 5.5 + iconW + gap + textW + 5.5, height: 17)
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    private static let badgeBackgroundColor = Design.dynamicAlpha(Design.color(0xF7F8FA, 0xFFFFFF), 1.0, 0.05)
    private static let badgeBorderColor = Design.dynamicAlpha(Design.color(0x000000, 0xFFFFFF), 0.06, 0.09)

    override func draw(_ rect: NSRect) {
        guard bounds.width > 2 && bounds.height > 2 else { return }
        let outerRect = bounds.insetBy(dx: 0.25, dy: 0.25)
        let path = NSBezierPath(roundedRect: outerRect, xRadius: 4.25, yRadius: 4.25)

        Self.badgeBackgroundColor.setFill()
        path.fill()

        Self.badgeBorderColor.setStroke()
        path.lineWidth = 0.5
        path.stroke()
    }
}

final class UsageEventCard: NSView {
    let modelLabel = text("", size: 12, weight: .semibold)
    let sshTag = SshHostTagBadge(scale: .compact, showStatusDot: false)
    private let localBadge = UsageLocalTagBadge()
    let accountLabel = text("", size: 10.5, color: Design.secondary)
    let timeLabel = text("", size: 10.5, color: Design.secondary)
    let inputLabel = text("", size: 11, weight: .medium)
    let outputLabel = text("", size: 11, weight: .medium)
    let cacheWriteLabel = text("", size: 11, weight: .medium)
    let cacheLabel = text("", size: 11, weight: .medium)
    private let inputTitleLabel = text(L10n.t("usage_event.input"), size: 11, color: Design.secondary)
    private let outputTitleLabel = text(L10n.t("usage_event.output"), size: 11, color: Design.secondary)
    private let cacheReadTitleLabel = text(L10n.t("usage_event.cache_read"), size: 11, color: Design.secondary)
    private let cacheWriteTitleLabel = text(L10n.t("usage_event.cache_write"), size: 11, color: Design.secondary)
    let modelIcon = symbol("hexagon", size: 16, color: Design.secondary)
    private let card = DesignCardBox()
    private var hoverTracking: NSTrackingArea?
    private let hoverMotion = DesignMotion()
    private var hoverProgress: CGFloat = 0
    private var hovered = false
    private func setHovered(_ next: Bool, animated: Bool) {
        if !animated {
            hoverMotion.cancel()
            hovered = next
            hoverProgress = next ? 1.0 : 0.0
            card.borderColor = next ? Design.primary.withAlphaComponent(0.19) : Design.border
            card.needsDisplay = true
            return
        }
        guard hovered != next else { return }
        hovered = next
        let target: CGFloat = next ? 1.0 : 0.0
        hoverMotion.animate(in: self, from: hoverProgress, to: target, curve: .hover) { [weak self] val in
            guard let self else { return }
            self.hoverProgress = val
            self.card.borderColor = val > 0.01 ? Design.primary.withAlphaComponent(0.085 + 0.105 * val) : Design.border
            self.card.needsDisplay = true
        }
    }
    private static let dateFormat: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return f
    }()
    deinit { hoverMotion.cancel() }
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        identifier = NSUserInterfaceItemIdentifier("usage-event-card")
        modelLabel.maximumNumberOfLines = 1
        modelLabel.lineBreakMode = .byTruncatingMiddle
        modelLabel.cell?.wraps = false
        modelLabel.setContentHuggingPriority(.defaultHigh, for: .horizontal)
        modelLabel.setContentCompressionResistancePriority(NSLayoutConstraint.Priority(700), for: .horizontal)
        modelLabel.setContentCompressionResistancePriority(.required, for: .vertical)

        sshTag.identifier = NSUserInterfaceItemIdentifier("usage-event-ssh-tag")
        sshTag.isHidden = true
        let sshMaxWidth = sshTag.widthAnchor.constraint(lessThanOrEqualToConstant: 160)
        sshMaxWidth.priority = NSLayoutConstraint.Priority(740)
        sshMaxWidth.isActive = true

        localBadge.identifier = NSUserInterfaceItemIdentifier("usage-event-local-tag")
        localBadge.isHidden = true

        accountLabel.maximumNumberOfLines = 1
        accountLabel.lineBreakMode = .byTruncatingMiddle
        accountLabel.cell?.wraps = false
        accountLabel.isHidden = true
        accountLabel.toolTip = nil
        accountLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)
        accountLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        accountLabel.setContentCompressionResistancePriority(.required, for: .vertical)

        timeLabel.font = .monospacedDigitSystemFont(ofSize: 10.5, weight: .regular)
        timeLabel.setContentHuggingPriority(.required, for: .horizontal)
        timeLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
        timeLabel.setContentCompressionResistancePriority(.required, for: .vertical)
        func metric(_ titleLbl: NSTextField, _ value: NSTextField) -> NSView {
            titleLbl.setContentCompressionResistancePriority(.required, for: .vertical)
            value.font = .monospacedDigitSystemFont(ofSize: 11, weight: .medium)
            value.setContentCompressionResistancePriority(.required, for: .vertical)
            let row = horizontal([titleLbl, value, flexibleSpace()], spacing: 5)
            row.alignment = .centerY
            return row
        }
        let heading = horizontal([modelIcon, modelLabel, sshTag, localBadge, accountLabel, flexibleSpace(), timeLabel], spacing: 6)
        heading.setCustomSpacing(8, after: modelIcon)
        heading.alignment = .centerY
        heading.detachesHiddenViews = true
        let tokens = horizontal([
            metric(inputTitleLabel, inputLabel),
            metric(outputTitleLabel, outputLabel),
            metric(cacheReadTitleLabel, cacheLabel),
            metric(cacheWriteTitleLabel, cacheWriteLabel)
        ], spacing: 10)
        tokens.distribution = .fillEqually
        tokens.alignment = .centerY
        let body = vertical([heading, tokens], spacing: 7)
        fillWidth(heading, in: body)
        fillWidth(tokens, in: body)
        card.boxType = .custom
        card.cornerRadius = 10
        card.borderWidth = 0.5
        card.borderColor = Design.border
        card.fillColor = Design.card
        card.shadow = Design.cardShadow()
        card.contentViewMargins = .zero
        card.addSubview(body)
        body.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            body.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 14),
            body.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -14),
            body.centerYAnchor.constraint(equalTo: card.centerYAnchor),
            body.topAnchor.constraint(greaterThanOrEqualTo: card.topAnchor, constant: 9),
            body.bottomAnchor.constraint(lessThanOrEqualTo: card.bottomAnchor, constant: -9)
        ])
        addSubview(card)
        pin(card, to: self, inset: 1)
    }
    required init?(coder: NSCoder) { fatalError() }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area = hoverTracking { removeTrackingArea(area) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        hoverTracking = area
        addTrackingArea(area)
    }
    override func mouseEntered(with event: NSEvent) { setHovered(true, animated: true) }
    override func mouseExited(with event: NSEvent) { setHovered(false, animated: true) }
    override func prepareForReuse() {
        super.prepareForReuse()
        setHovered(false, animated: false)
        sshTag.isHidden = true
        localBadge.isHidden = true
        accountLabel.isHidden = true
        accountLabel.stringValue = ""
        accountLabel.toolTip = nil
        accountLabel.setAccessibilityHelp(nil)
    }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil {
            setHovered(false, animated: false)
        }
    }
    func configure(_ event: [String:Any], highlight: String = "", showLocalEnvironmentBadge: Bool = false) {
        inputTitleLabel.stringValue = L10n.t("usage_event.input")
        outputTitleLabel.stringValue = L10n.t("usage_event.output")
        cacheReadTitleLabel.stringValue = L10n.t("usage_event.cache_read")
        cacheWriteTitleLabel.stringValue = L10n.t("usage_event.cache_write")
        let rawModelId = [
            event["model_id"] as? String,
            event["modelId"] as? String,
            event["model"] as? String
        ]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { raw in
                !raw.isEmpty
                    && raw != "未知模型"
                    && raw.caseInsensitiveCompare("Unknown Model") != .orderedSame
            }
        let model = InterfaceText.localizedModelLabel((event["model"] as? String) ?? rawModelId)
        if !highlight.isEmpty, let range = model.range(of: highlight, options: .caseInsensitive) {
            let attr = NSMutableAttributedString(string: model, attributes: [
                .font: NSFont.systemFont(ofSize: 12, weight: .semibold),
                .foregroundColor: Design.primary
            ])
            let nsRange = NSRange(range, in: model)
            attr.addAttributes([
                .foregroundColor: Design.blue,
                .underlineStyle: NSUnderlineStyle.single.rawValue
            ], range: nsRange)
            modelLabel.attributedStringValue = attr
        } else {
            modelLabel.attributedStringValue = NSAttributedString(string: model, attributes: [.font: NSFont.systemFont(ofSize: 12, weight: .semibold), .foregroundColor: NSColor.labelColor])
        }
        modelLabel.setAccessibilityLabel(model)
        if let copyId = rawModelId {
            enableTextCopy(modelLabel, value: copyId, title: L10n.t("overview.copy_model_id"))
        } else {
            modelLabel.menu = nil
        }
        let stamp = doubleVal(event,"timestamp_seconds")
        timeLabel.stringValue = stamp > 0 ? Self.dateFormat.string(from:Date(timeIntervalSince1970:stamp)) : L10n.t("usage_event.time_unknown")
        inputLabel.stringValue = InterfaceText.formatInteger(intVal(event, "input_tokens")); outputLabel.stringValue = InterfaceText.formatInteger(intVal(event, "output_tokens")); cacheLabel.stringValue = InterfaceText.formatInteger(intVal(event, "cached_tokens")); cacheWriteLabel.stringValue = InterfaceText.formatInteger(intVal(event, "cache_write_tokens"))
        if let brand = ModelIcons.brands(for:model).first,let image = ModelIcons.image(brand) { modelIcon.image = image; modelIcon.contentTintColor = ModelIcons.tintColor(for: image) }
        else { modelIcon.image = NSImage(systemSymbolName:"hexagon",accessibilityDescription:nil); modelIcon.contentTintColor = Design.secondary }

        let rawEnvKind = ((event["environment_kind"] as? String) ?? (event["environmentKind"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let rawEnvId = ((event["environment_id"] as? String) ?? (event["environmentId"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let rawEnvLabel = ((event["environment_label"] as? String) ?? (event["environmentLabel"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let isSsh = rawEnvKind == "ssh" || rawEnvId.hasPrefix("ssh:") || rawEnvId.hasPrefix("host:")
        if isSsh {
            let rawHost = rawEnvLabel.isEmpty ? rawEnvId : rawEnvLabel
            let cleanedHost = SshEnvironmentResolver.cleanHostLabel(rawHost)
            let resolvedHost = cleanedHost.isEmpty ? rawEnvId : cleanedHost
            sshTag.update(hostLabel: resolvedHost, state: .online, windowCount: 1, extraCount: 0, showStatusDot: false)
            sshTag.isHidden = false
            localBadge.isHidden = true
        } else if showLocalEnvironmentBadge {
            sshTag.isHidden = true
            localBadge.updateTitle(L10n.t("ssh.scope.local", fallback: "本机"))
            localBadge.isHidden = false
        } else {
            sshTag.isHidden = true
            localBadge.isHidden = true
        }

        let rawEmail = ((event["account_email"] as? String) ?? (event["accountEmail"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let rawConfidence = ((event["account_confidence"] as? String) ?? (event["accountConfidence"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !rawEmail.isEmpty {
            accountLabel.stringValue = rawEmail
            accountLabel.textColor = Design.secondary
            accountLabel.setAccessibilityLabel(rawEmail)
            if rawConfidence == "inferred" {
                accountLabel.setAccessibilityHelp(L10n.t("usage_event.env.inferred_account_tooltip"))
            } else {
                accountLabel.setAccessibilityHelp(nil)
            }
            accountLabel.isHidden = false
        } else if isSsh || rawConfidence == "unknown" {
            let unattributed = L10n.t("usage_event.env.unattributed_account")
            accountLabel.stringValue = unattributed
            accountLabel.textColor = Design.secondary.withAlphaComponent(0.75)
            accountLabel.setAccessibilityLabel(unattributed)
            accountLabel.setAccessibilityHelp(nil)
            accountLabel.isHidden = false
        } else {
            accountLabel.stringValue = ""
            accountLabel.setAccessibilityHelp(nil)
            accountLabel.isHidden = true
        }
    }
}
