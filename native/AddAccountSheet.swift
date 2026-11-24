import Cocoa
import UniformTypeIdentifiers

final class AddAccountSheet: NSObject {
    static let sheetWidth: CGFloat = 460
    static let initialHeight: CGFloat = 370

    unowned let app: Assistant
    let accountCount: Int
    let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: AddAccountSheet.sheetWidth, height: AddAccountSheet.initialHeight),
        styleMask: [.titled],
        backing: .buffered,
        defer: false
    )
    let status = text("", size: 12, color: Design.secondary, wrap: true)
    let spinner = NSProgressIndicator()
    let currentButton = button(L10n.t("add_account.save_current", fallback: "保存当前账号"), target: nil, action: #selector(saveCurrent))
    let importJsonButton = button(L10n.t("add_account.import_json_btn", fallback: "选择文件…"), target: nil, action: #selector(importFromJson))
    let exportButton = button(L10n.t("add_account.export_btn", fallback: "导出文件…"), target: nil, action: #selector(exportAccounts))
    let cancelButton = button(L10n.t("common.cancel", fallback: "取消"), target: nil, action: #selector(cancel))
    private var feedback: NSStackView!
    private var languageObserver: NSObjectProtocol?
    private var headerTitleLabel: NSTextField!
    private var saveCurrentTitleLabel: NSTextField!
    private var saveCurrentSubLabel: NSTextField!
    private var importJsonTitleLabel: NSTextField!
    private var importJsonSubLabel: NSTextField!
    private var exportTitleLabel: NSTextField!
    private var exportSubLabel: NSTextField!
    private var saveEmailCopyTitle: NSTextField?
    private var contentViewRef: NSView?
    var saved: () -> Void
    var onDismiss: (() -> Void)?
    var filePickerHook: (() -> [URL]?)?
    var expiredNoticeHook: ((String, String) -> Void)?
    var exportConfirmHook: (() -> Bool)?
    var exportSavePanelHook: ((String) -> URL?)?

    private static let exportDateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyyMMdd"
        return f
    }()

    init(app: Assistant, accountCount: Int? = nil, saved: @escaping () -> Void) {
        self.app = app
        self.accountCount = max(0, accountCount ?? app.cachedAccounts.count)
        self.saved = saved
        super.init()
        window.title = L10n.t("add_account.title", fallback: "管理账号")
        window.isReleasedWhenClosed = false

        let currentEmail = app.statusValue.liveAccountEmail.isEmpty ? app.statusValue.activeAccountEmail : app.statusValue.liveAccountEmail
        currentButton.target = self
        currentButton.title = L10n.t("add_account.save_current", fallback: "保存当前账号")
        currentButton.isEnabled = true
        currentButton.bezelColor = Design.blue
        currentButton.keyEquivalent = "\r"
        currentButton.toolTip = nil
        currentButton.setAccessibilityLabel(currentButton.title)
        currentButton.setContentHuggingPriority(.required, for: .horizontal)
        currentButton.setContentCompressionResistancePriority(.required, for: .horizontal)

        importJsonButton.target = self
        importJsonButton.title = L10n.t("add_account.import_json_btn", fallback: "选择文件…")
        importJsonButton.isEnabled = true
        importJsonButton.toolTip = nil
        importJsonButton.setAccessibilityLabel(L10n.t("add_account.import_json_title", fallback: "导入账号"))
        importJsonButton.setContentHuggingPriority(.required, for: .horizontal)
        importJsonButton.setContentCompressionResistancePriority(.required, for: .horizontal)

        exportButton.target = self
        exportButton.title = L10n.t("add_account.export_btn", fallback: "导出文件…")
        exportButton.isEnabled = self.accountCount > 0
        exportButton.toolTip = nil
        exportButton.setAccessibilityLabel(L10n.t("accounts.a11y.export_backup", fallback: "导出全部已保存账号为 JSON 文件"))
        exportButton.setContentHuggingPriority(.required, for: .horizontal)
        exportButton.setContentCompressionResistancePriority(.required, for: .horizontal)

        cancelButton.title = L10n.t("common.cancel", fallback: "取消")
        cancelButton.target = self
        cancelButton.keyEquivalent = "\u{1b}"
        cancelButton.toolTip = nil
        cancelButton.setAccessibilityLabel(cancelButton.title)
        window.initialFirstResponder = currentButton

        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false
        spinner.isHidden = true
        spinner.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            spinner.widthAnchor.constraint(equalToConstant: 16),
            spinner.heightAnchor.constraint(equalToConstant: 16)
        ])

        func makeActionCard(
            icon: String,
            title: String,
            subtitle: String,
            extraViews: [NSView] = [],
            actionButton: NSButton
        ) -> (card: NSBox, titleLbl: NSTextField, subLbl: NSTextField) {
            let titleLbl = text(title, size: 13, weight: .semibold, color: .labelColor)
            let subLbl = text(subtitle, size: 11, color: Design.secondary, wrap: true)
            subLbl.setContentHuggingPriority(.defaultLow, for: .horizontal)
            subLbl.setContentHuggingPriority(.required, for: .vertical)
            subLbl.setContentCompressionResistancePriority(.required, for: .vertical)
            let textViews: [NSView] = [titleLbl, subLbl] + extraViews
            let textCol = vertical(textViews, spacing: 2.5)
            textCol.alignment = .leading
            textCol.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
            textCol.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            for v in textViews {
                v.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
                fillWidth(v, in: textCol)
            }
            let row = horizontal([iconBadge(icon, tint: Design.blue, size: 30), textCol, actionButton], spacing: 12)
            row.alignment = .centerY
            let card = group([row], inset: 12)
            card.setContentHuggingPriority(.required, for: .vertical)
            card.setContentCompressionResistancePriority(.required, for: .vertical)
            return (card, titleLbl, subLbl)
        }

        // 第一卡：保存当前 Antigravity 登录账号（主操作）
        var saveExtras: [NSView] = []
        if !currentEmail.isEmpty {
            let emailLbl = text(currentEmail, size: 10.5, color: .secondaryLabelColor)
            enableTextCopy(emailLbl, title: L10n.t("common.copy_full_email", fallback: "复制完整邮箱"))
            emailLbl.font = .systemFont(ofSize: 11.5, weight: .regular)
            emailLbl.lineBreakMode = .byTruncatingMiddle
            emailLbl.setContentHuggingPriority(.defaultLow, for: .horizontal)
            emailLbl.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            saveEmailCopyTitle = emailLbl
            saveExtras.append(emailLbl)
        }
        let saveCardBuilt = makeActionCard(
            icon: "person.crop.rectangle",
            title: L10n.t("add_account.current_card_title", fallback: "当前 Antigravity 账号"),
            subtitle: L10n.t("add_account.save_current_sub", fallback: "导入当前 Antigravity 登录账号"),
            extraViews: saveExtras,
            actionButton: currentButton
        )
        let saveCard = saveCardBuilt.card
        saveCurrentTitleLabel = saveCardBuilt.titleLbl
        saveCurrentSubLabel = saveCardBuilt.subLbl

        // 第二卡：从 JSON 批量导入账号（迁移/恢复）
        let importCardBuilt = makeActionCard(
            icon: "doc.badge.plus",
            title: L10n.t("add_account.import_json_title", fallback: "导入账号"),
            subtitle: L10n.t("add_account.import_json_sub", fallback: "支持导入 GravityBox 备份文件、单账号 JSON 或账号文件夹"),
            actionButton: importJsonButton
        )
        let importCard = importCardBuilt.card
        importJsonTitleLabel = importCardBuilt.titleLbl
        importJsonSubLabel = importCardBuilt.subLbl

        // 第三卡：导出已保存账号为 JSON 备份
        let exportSubtitle = self.accountCount > 0
            ? L10n.t("add_account.export_sub", ["count": self.accountCount], fallback: "将已保存的 \(self.accountCount) 个账号导出为 JSON 文件（含登录凭据，请妥善保管）")
            : L10n.t("add_account.export_sub_empty", fallback: "暂无已保存账号，添加账号后可导出为 JSON 备份")
        let exportCardBuilt = makeActionCard(
            icon: "square.and.arrow.up",
            title: L10n.t("add_account.export_title", fallback: "导出账号"),
            subtitle: exportSubtitle,
            actionButton: exportButton
        )
        let exportCard = exportCardBuilt.card
        exportTitleLabel = exportCardBuilt.titleLbl
        exportSubLabel = exportCardBuilt.subLbl

        status.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
        status.setContentHuggingPriority(.required, for: .vertical)
        status.setContentCompressionResistancePriority(.required, for: .vertical)
        feedback = horizontal([spinner, status], spacing: 8)
        feedback.isHidden = true
        let headerBadge = iconBadge("person.badge.plus", tint: Design.blue, size: 32)
        let headerTitle = text(L10n.t("add_account.title", fallback: "管理账号"), size: 16, weight: .semibold, color: .labelColor)
        headerTitleLabel = headerTitle
        let headerRow = horizontal([headerBadge, headerTitle, flexibleSpace()], spacing: 10)
        headerRow.alignment = .centerY

        let footer = horizontal([flexibleSpace(), cancelButton], spacing: 8)
        footer.alignment = .centerY

        let root = vertical([headerRow, saveCard, importCard, exportCard, feedback, footer], spacing: 10)
        root.detachesHiddenViews = true
        let surface = SheetVisualEffectView()
        let content = fixedPage(root)
        contentViewRef = content
        surface.addSubview(content)
        content.translatesAutoresizingMaskIntoConstraints = false
        let contentBottom = content.bottomAnchor.constraint(equalTo: surface.bottomAnchor)
        contentBottom.priority = .defaultHigh
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: surface.leadingAnchor),
            content.trailingAnchor.constraint(equalTo: surface.trailingAnchor),
            content.topAnchor.constraint(equalTo: surface.topAnchor),
            contentBottom
        ])
        window.isOpaque = false
        window.backgroundColor = .clear
        window.contentView = surface
        Design.applyControls(surface)
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

    deinit {
        if let languageObserver {
            NotificationCenter.default.removeObserver(languageObserver)
        }
    }

    private static func syncWrappingLabelWidths(in view: NSView) {
        if let tf = view as? NSTextField, !tf.isEditable, tf.cell?.wraps == true, !tf.isHidden, tf.bounds.width > 1 {
            // NSTextFieldCell 左右共保留约 4pt 内边距，按可绘制文本宽设置换行上限避免末行被裁剪
            let targetW = max(1, floor(tf.bounds.width) - 4)
            if abs(tf.preferredMaxLayoutWidth - targetW) > 0.5 {
                tf.preferredMaxLayoutWidth = targetW
            }
            tf.invalidateIntrinsicContentSize()
        }
        for sub in view.subviews {
            syncWrappingLabelWidths(in: sub)
        }
    }

    private func resizeSheetToFit() {
        guard let surface = window.contentView, let content = contentViewRef else { return }
        if abs(surface.frame.width - Self.sheetWidth) > 0.5 {
            surface.frame.size.width = Self.sheetWidth
        }
        surface.layoutSubtreeIfNeeded()
        Self.syncWrappingLabelWidths(in: surface)
        surface.layoutSubtreeIfNeeded()
        let targetH = max(1, ceil(content.fittingSize.height))
        if abs(surface.frame.width - Self.sheetWidth) > 0.5 || abs(surface.frame.height - targetH) > 0.5 {
            window.setContentSize(NSSize(width: Self.sheetWidth, height: targetH))
        }
        surface.layoutSubtreeIfNeeded()
    }

    private func syncLocalizedChrome() {
        let title = L10n.t("add_account.title", fallback: "管理账号")
        window.title = title
        headerTitleLabel.stringValue = title
        saveCurrentTitleLabel.stringValue = L10n.t("add_account.current_card_title", fallback: "当前 Antigravity 账号")
        saveCurrentSubLabel.stringValue = L10n.t("add_account.save_current_sub", fallback: "导入当前 Antigravity 登录账号")
        importJsonTitleLabel.stringValue = L10n.t("add_account.import_json_title", fallback: "导入账号")
        importJsonSubLabel.stringValue = L10n.t("add_account.import_json_sub", fallback: "支持导入 GravityBox 备份文件、单账号 JSON 或账号文件夹")
        exportTitleLabel.stringValue = L10n.t("add_account.export_title", fallback: "导出账号")
        exportSubLabel.stringValue = accountCount > 0
            ? L10n.t("add_account.export_sub", ["count": accountCount], fallback: "将已保存的 \(accountCount) 个账号导出为 JSON 文件（含登录凭据，请妥善保管）")
            : L10n.t("add_account.export_sub_empty", fallback: "暂无已保存账号，添加账号后可导出为 JSON 备份")
        currentButton.title = L10n.t("add_account.save_current", fallback: "保存当前账号")
        currentButton.setAccessibilityLabel(currentButton.title)
        importJsonButton.title = L10n.t("add_account.import_json_btn", fallback: "选择文件…")
        importJsonButton.setAccessibilityLabel(L10n.t("add_account.import_json_title", fallback: "导入账号"))
        exportButton.title = L10n.t("add_account.export_btn", fallback: "导出文件…")
        exportButton.setAccessibilityLabel(L10n.t("accounts.a11y.export_backup", fallback: "导出全部已保存账号为 JSON 文件"))
        cancelButton.title = L10n.t("common.cancel", fallback: "取消")
        cancelButton.setAccessibilityLabel(cancelButton.title)
        if let saveEmailCopyTitle {
            enableTextCopy(saveEmailCopyTitle, title: L10n.t("common.copy_full_email", fallback: "复制完整邮箱"))
        }
        resizeSheetToFit()
    }

    func show(in parent: NSWindow, onDismiss: @escaping () -> Void) {
        self.onDismiss = onDismiss
        resizeSheetToFit()
        app.presentRetainedSheet(controller: self, sheet: window, in: parent) { [weak self] _ in
            self?.onDismiss?()
        }
        // F06: Sheet 成为 key 后再锁定一次初始焦点，避免 AppKit 按视图顺序落到次级按钮。
        DispatchQueue.main.async { [weak self] in
            guard let self, self.window.sheetParent != nil else { return }
            self.window.makeFirstResponder(self.currentButton)
        }
    }

    func busy(_ value: Bool) {
        feedback.isHidden = status.stringValue.isEmpty
        resizeSheetToFit()
        currentButton.isEnabled = !value
        importJsonButton.isEnabled = !value
        exportButton.isEnabled = !value && accountCount > 0
        spinner.isHidden = !value
        if value {
            spinner.startAnimation(nil)
        } else {
            spinner.stopAnimation(nil)
        }
    }

    func fail(_ message: String) {
        status.stringValue = message
        status.textColor = accessibleDangerColor()
        busy(false)
        cancelButton.isEnabled = true
    }

    @objc func saveCurrent() {
        status.stringValue = L10n.t("add_account.status.reading_current")
        status.textColor = Design.secondary
        busy(true)
        cancelButton.isEnabled = false
        app.bridge.send(["command": "account_save_current"]) { [weak self] response in
            guard let self else { return }
            switch response {
            case .success:
                self.saved()
                self.dismiss()
            case .failure(let error):
                self.fail(error.localizedDescription)
            }
        }
    }

    @objc func importFromJson() {
        if let picker = filePickerHook {
            guard let urls = picker(), !urls.isEmpty else { return }
            performJsonImport(urls: urls)
            return
        }
        let panel = NSOpenPanel()
        panel.title = L10n.t("add_account.import_panel_title", fallback: "选择账号 JSON 文件或文件夹")
        panel.canChooseFiles = true
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = true
        panel.resolvesAliases = false
        if #available(macOS 11.0, *) {
            panel.allowedContentTypes = [.json, .folder]
        } else {
            panel.allowedFileTypes = ["json"]
        }
        let handleSelection: (NSApplication.ModalResponse) -> Void = { [weak self] resp in
            guard let self, resp == .OK, !panel.urls.isEmpty else { return }
            self.performJsonImport(urls: panel.urls)
        }
        if window.sheetParent != nil {
            panel.beginSheetModal(for: window, completionHandler: handleSelection)
        } else {
            handleSelection(panel.runModal())
        }
    }

    func performJsonImport(urls: [URL]) {
        let paths = urls.map(\.path).filter { !$0.isEmpty }
        guard !paths.isEmpty else { return }
        status.stringValue = L10n.t("add_account.status.importing_json", fallback: "正在从 JSON 导入账号…")
        status.textColor = Design.secondary
        busy(true)
        cancelButton.isEnabled = false
        app.bridge.send(["command": "account_import_json", "paths": paths]) { [weak self] response in
            guard let self else { return }
            switch response {
            case .success(let value):
                let imported = intVal(value, "imported", fallback: 0)
                let updated = intVal(value, "updated", fallback: 0)
                let expiredCount = intVal(value, "expiredWithoutRefreshConfig", fallback: 0)
                let skipped = value["skipped"] as? [[String: Any]] ?? []
                let totalProcessed = imported + updated
                if totalProcessed == 0 {
                    let firstReason = (skipped.first?["reason"] as? String)
                        ?? L10n.t("accounts.import.err.empty_records", fallback: "未找到任何账号记录")
                    let msg = L10n.t(
                        "add_account.import.none_imported",
                        ["skipped": max(1, skipped.count), "reason": firstReason],
                        fallback: "未能导入有效账号（跳过 \(max(1, skipped.count)) 项：\(firstReason)）"
                    )
                    self.fail(msg)
                    return
                }
                var summary = L10n.t(
                    "add_account.import.success_summary",
                    ["imported": imported, "updated": updated],
                    fallback: "已成功导入 \(imported) 个新账号，更新 \(updated) 个已有账号"
                )
                if !skipped.isEmpty {
                    summary += L10n.t(
                        "add_account.import.skipped_suffix",
                        ["skipped": skipped.count],
                        fallback: "（已跳过 \(skipped.count) 项无效记录）"
                    )
                }
                self.app.showMessage(summary)
                self.saved()
                self.dismiss()
                if expiredCount > 0 {
                    let noticeTitle = L10n.t("add_account.import.expired_notice_title", fallback: "部分导入账号的短期凭据已过期")
                    let noticeBody = L10n.t(
                        "add_account.import.expired_notice_body",
                        ["total": totalProcessed, "expired": expiredCount],
                        fallback: "共处理 \(totalProcessed) 个账号，其中 \(expiredCount) 个账号的短期访问令牌（access_token）已过期且本机未配置后台刷新凭据。您仍可随时切换至这些账号，启动 Antigravity 后将自动续期并更新配额。"
                    )
                    if let hook = self.expiredNoticeHook {
                        hook(noticeTitle, noticeBody)
                    } else if let hostWindow = self.app.window {
                        DispatchQueue.main.async {
                            let alert = NSAlert()
                            alert.alertStyle = .informational
                            alert.messageText = noticeTitle
                            alert.informativeText = noticeBody
                            alert.addButton(withTitle: L10n.t("common.ok", fallback: "好"))
                            alert.beginSheetModal(for: hostWindow, completionHandler: nil)
                        }
                    }
                }
            case .failure(let error):
                self.fail(error.localizedDescription)
            }
        }
    }

    @objc func exportAccounts() {
        guard accountCount > 0 else { return }
        if let confirmHook = exportConfirmHook {
            guard confirmHook() else { return }
            presentExportSavePanel()
            return
        }
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = L10n.t("accounts.export.confirm_title", fallback: "导出未加密的账号凭据？")
        alert.informativeText = L10n.t("accounts.export.confirm_body", fallback: "导出的 JSON 文件包含未加密的 OAuth 登录凭据（access_token 与 refresh_token）。请妥善保管在安全的本地位置，切勿上传至公开网盘或分享给他人。")
        alert.addButton(withTitle: L10n.t("accounts.export.confirm_action", fallback: "继续导出…"))
        alert.addButton(withTitle: L10n.t("common.cancel", fallback: "取消"))
        if window.sheetParent != nil {
            alert.beginSheetModal(for: window) { [weak self] resp in
                guard let self, resp == .alertFirstButtonReturn else { return }
                DispatchQueue.main.async {
                    self.presentExportSavePanel()
                }
            }
        } else if alert.runModal() == .alertFirstButtonReturn {
            presentExportSavePanel()
        }
    }

    private func presentExportSavePanel() {
        let dateTag = Self.exportDateFormatter.string(from: Date())
        let defaultFileName = "gravitybox-accounts-backup-\(dateTag).json"
        if let saveHook = exportSavePanelHook {
            guard let url = saveHook(defaultFileName) else { return }
            executeExportAccounts(to: url)
            return
        }
        let panel = NSSavePanel()
        panel.title = L10n.t("accounts.export.panel_title", fallback: "导出账号")
        panel.nameFieldStringValue = defaultFileName
        panel.canCreateDirectories = true
        panel.isExtensionHidden = false
        if #available(macOS 11.0, *) {
            panel.allowedContentTypes = [.json]
        } else {
            panel.allowedFileTypes = ["json"]
        }
        let handleSave: (NSApplication.ModalResponse) -> Void = { [weak self] resp in
            guard let self, resp == .OK, let url = panel.url else { return }
            self.executeExportAccounts(to: url)
        }
        if window.sheetParent != nil {
            panel.beginSheetModal(for: window, completionHandler: handleSave)
        } else {
            handleSave(panel.runModal())
        }
    }

    private func executeExportAccounts(to url: URL) {
        status.stringValue = L10n.t("add_account.status.exporting_json", fallback: "正在导出账号…")
        status.textColor = Design.secondary
        busy(true)
        cancelButton.isEnabled = false
        app.bridge.send([
            "command": "account_export_backup",
            "path": url.path,
            "confirmed": true
        ]) { [weak self] response in
            guard let self else { return }
            switch response {
            case .success(let value):
                let count = intVal(value, "count", fallback: self.accountCount)
                self.app.showMessage(L10n.t("accounts.export.success", ["count": count, "name": url.lastPathComponent], fallback: "已导出 \(count) 个账号至 \(url.lastPathComponent)"))
                self.dismiss()
            case .failure(let error):
                self.fail(L10n.t("accounts.export.failed", ["error": error.localizedDescription], fallback: "导出账号失败：\(error.localizedDescription)"))
            }
        }
    }

    @objc func cancel() {
        guard cancelButton.isEnabled else { return }
        dismiss()
    }

    func dismiss() {
        window.sheetParent?.endSheet(window)
    }
}
