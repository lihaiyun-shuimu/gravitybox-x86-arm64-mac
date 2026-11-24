import Cocoa

// A model summary uses two calm lines instead of a nested spreadsheet or quota control.
final class ModelUsageRow: NSView {
    let nameLabel: NSTextField
    let costLabel: NSTextField
    let tokensLabel: NSTextField

    init(name: String, rawModelId: String? = nil, tokens: String, input: String, output: String, requests: Int, cost: String, share: Int, shareText: String? = nil, isUnpriced explicitUnpriced: Bool? = nil) {
        let isUnpriced = explicitUnpriced ?? (cost == L10n.t("menu_panel.usage.unpriced") || cost == "未计价" || cost == "Unpriced")
        let copyId = (rawModelId?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0.isEmpty ? nil : $0 } ?? name
        nameLabel = text(name, size: 13, weight: .semibold)
        costLabel = text(cost, size: 14, weight: .semibold, color: isUnpriced ? Design.secondary : .labelColor)
        tokensLabel = text(L10n.t("usage.model_row.tokens", ["tokens": tokens]), size: 12, weight: .medium)
        super.init(frame: .zero)
        enableTextCopy(nameLabel, value: copyId, title: L10n.t("overview.copy_model_id"))
        identifier = NSUserInterfaceItemIdentifier("model-usage-row")
        nameLabel.lineBreakMode = .byTruncatingMiddle
        nameLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        nameLabel.setAccessibilityLabel(L10n.t("usage.model_row.a11y", ["display": name, "id": copyId]))
        tokensLabel.font = .monospacedDigitSystemFont(ofSize: 12, weight: .medium)
        costLabel.font = .monospacedDigitSystemFont(ofSize: isUnpriced ? 12.5 : 14, weight: .semibold)
        costLabel.setContentCompressionResistancePriority(.required, for: .horizontal)

        let icon = symbol("hexagon", size: 15, color: Design.secondary)
        if let brand = ModelIcons.brands(for: name).first, let image = ModelIcons.image(brand) {
            icon.image = image
            icon.contentTintColor = ModelIcons.tintColor(for: image)
        }
        let iconBox = NSBox()
        iconBox.boxType = .custom
        iconBox.cornerRadius = 7
        iconBox.fillColor = Design.subcard
        iconBox.borderWidth = 0.5
        iconBox.borderColor = Design.border
        iconBox.contentViewMargins = .zero
        iconBox.translatesAutoresizingMaskIntoConstraints = false
        iconBox.addSubview(icon)
        NSLayoutConstraint.activate([
            iconBox.widthAnchor.constraint(equalToConstant: 26),
            iconBox.heightAnchor.constraint(equalToConstant: 26),
            icon.centerXAnchor.constraint(equalTo: iconBox.centerXAnchor),
            icon.centerYAnchor.constraint(equalTo: iconBox.centerYAnchor)
        ])

        let heading = horizontal([iconBox, nameLabel, flexibleSpace(), costLabel], spacing: 9)
        heading.alignment = .centerY
        let resolvedShare = shareText ?? "\(share)%"
        let reqLabel = text(L10n.t("usage.model_row.requests", ["count": InterfaceText.formatInteger(requests)]), size: 11, color: Design.secondary)
        reqLabel.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        let shareLabel = text(L10n.t("usage.model_row.share", ["share": resolvedShare]), size: 11, color: Design.secondary)
        shareLabel.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        let metrics = horizontal([
            tokensLabel,
            reqLabel,
            flexibleSpace(),
            shareLabel
        ], spacing: 16)
        tokensLabel.setAccessibilityHelp(L10n.t("usage.model_row.tokens_help", ["input": input, "output": output]))
        let body = vertical([heading, metrics], spacing: 6)
        addSubview(body)
        pin(body, to: self, inset: 2)
        fillWidth(heading, in: body)
        fillWidth(metrics, in: body)
        setAccessibilityElement(false)
    }

    required init?(coder: NSCoder) { fatalError() }
}
