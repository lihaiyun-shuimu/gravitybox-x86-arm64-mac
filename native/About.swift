import Cocoa

final class AboutPage: NSObject {
    unowned let app: Assistant
    var view: NSView!

    let versionPill: PillBadge
    let checkUpdateBtn: InlineRefreshButton
    let installNowBtn = button(L10n.t("about.install_now", fallback: "立即更新"), target: nil, action: #selector(installAvailableUpdate))
    let cancelDownloadBtn = button(L10n.t("about.cancel_download", fallback: "取消下载"), target: nil, action: #selector(cancelActiveDownload))
    let releaseNotesBtn = button(L10n.t("about.release_notes", fallback: "更新日志 ↗"), target: nil, action: #selector(openReleasesPage))
    let updateStatusIcon = symbol("checkmark.seal.fill", size: 12, color: Design.secondary)
    let updateStatusLabel = text("", size: 11.5, weight: .medium, color: Design.secondary)
    let updateMetaLabel = text("", size: 11, color: Design.secondary)
    private(set) var statusLine: NSStackView!
    let autoUpdateSwitch = DesignSwitch()
    let versionSpecLabel = text("", size: 12.5, weight: .medium, color: .labelColor)
    let revealDataBtn = button(L10n.t("about.reveal_data", fallback: "在访达中显示"), target: nil, action: #selector(revealDataFolder))
    let githubReleasesBtn = button("GitHub ↗", target: nil, action: #selector(openReleasesPage))
    private let heroActions = horizontal([], spacing: 8)

    init(app: Assistant) {
        self.app = app
        let ver = app.updateManager.currentVersion
        self.versionPill = pillBadge("v\(ver)", color: Design.blue)
        self.checkUpdateBtn = InlineRefreshButton(L10n.t("about.check_update", fallback: "检查更新"), width: 124, target: nil, action: #selector(checkForUpdates))
        super.init()

        checkUpdateBtn.target = self
        installNowBtn.target = self
        installNowBtn.bezelColor = Design.blue
        cancelDownloadBtn.target = self
        releaseNotesBtn.target = self
        revealDataBtn.target = self
        revealDataBtn.controlSize = .small
        githubReleasesBtn.target = self
        githubReleasesBtn.controlSize = .small

        // 1. Hero & Update Card
        let iconBox = NSBox()
        iconBox.boxType = .custom
        iconBox.cornerRadius = Design.Radius.medium
        iconBox.fillColor = Design.inactivePillFill
        iconBox.borderWidth = 0.75
        iconBox.borderColor = Design.inactivePillBorder
        iconBox.contentViewMargins = .zero
        iconBox.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            iconBox.widthAnchor.constraint(equalToConstant: 48),
            iconBox.heightAnchor.constraint(equalToConstant: 48)
        ])
        iconBox.setAccessibilityElement(false)
        if let mark = Design.brandMarkImage() ?? Design.appIconImage() {
            let imgView = NSImageView(image: mark)
            imgView.imageScaling = .scaleProportionallyUpOrDown
            imgView.translatesAutoresizingMaskIntoConstraints = false
            iconBox.addSubview(imgView)
            NSLayoutConstraint.activate([
                imgView.widthAnchor.constraint(equalToConstant: 30),
                imgView.heightAnchor.constraint(equalToConstant: 30),
                imgView.centerXAnchor.constraint(equalTo: iconBox.centerXAnchor),
                imgView.centerYAnchor.constraint(equalTo: iconBox.centerYAnchor)
            ])
        }

        let appName = text("GravityBox", size: 18, weight: .bold, color: .labelColor)
        let titleLine = horizontal([appName, versionPill], spacing: 7)
        titleLine.alignment = .centerY
        versionPill.setContentCompressionResistancePriority(.required, for: .horizontal)

        updateStatusIcon.translatesAutoresizingMaskIntoConstraints = false
        updateStatusIcon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 12, weight: .semibold)
        for c in updateStatusIcon.constraints where c.firstAttribute == .width || c.firstAttribute == .height {
            c.constant = 14
        }
        updateStatusLabel.lineBreakMode = .byTruncatingTail
        updateStatusLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        updateMetaLabel.font = .monospacedDigitSystemFont(ofSize: 11, weight: .medium)
        updateMetaLabel.setContentHuggingPriority(.required, for: .horizontal)
        updateMetaLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
        updateMetaLabel.isHidden = true

        statusLine = horizontal([updateStatusIcon, updateStatusLabel, updateMetaLabel], spacing: 5)
        statusLine.alignment = .centerY
        statusLine.detachesHiddenViews = true
        statusLine.isHidden = true

        let brandCol = vertical([titleLine, statusLine], spacing: 4)
        brandCol.alignment = .leading
        brandCol.detachesHiddenViews = true
        brandCol.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        heroActions.alignment = .centerY
        heroActions.detachesHiddenViews = true
        heroActions.addArrangedSubview(releaseNotesBtn)
        heroActions.addArrangedSubview(checkUpdateBtn)
        heroActions.addArrangedSubview(installNowBtn)
        heroActions.addArrangedSubview(cancelDownloadBtn)

        let heroTop = horizontal([iconBox, brandCol, flexibleSpace(), heroActions], spacing: 12)
        heroTop.alignment = .centerY

        autoUpdateSwitch.controlSize = .small
        autoUpdateSwitch.state = app.configuration.value.autoUpdateEnabled ? .on : .off
        autoUpdateSwitch.target = self
        autoUpdateSwitch.action = #selector(toggleAutoUpdate)
        autoUpdateSwitch.setAccessibilityLabel(L10n.t("about.auto_update", fallback: "自动检查更新"))
        let autoTitle = text(L10n.t("about.auto_update", fallback: "自动检查更新"), size: 13, weight: .semibold, color: .labelColor)
        let autoRow = horizontal([autoTitle, flexibleSpace(), autoUpdateSwitch], spacing: 12)
        autoRow.alignment = .centerY

        let heroInner = vertical([heroTop, divider(), autoRow], spacing: 11)
        for child in heroInner.arrangedSubviews { fillWidth(child, in: heroInner) }
        let heroCard = group([heroInner], inset: 14)
        heroCard.cornerRadius = Design.Radius.card

        // 2. Environment & Data Card
        versionSpecLabel.font = .monospacedDigitSystemFont(ofSize: 12.5, weight: .medium)
        versionSpecLabel.lineBreakMode = .byTruncatingMiddle
        versionSpecLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let displayStatePath = app.state.path.replacingOccurrences(
            of: FileManager.default.homeDirectoryForCurrentUser.path,
            with: "~"
        )
        let dataPathLabel = text(displayStatePath, size: 12, weight: .regular, color: Design.secondary)
        dataPathLabel.lineBreakMode = .byTruncatingMiddle
        dataPathLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        enableTextCopy(dataPathLabel, value: app.state.path, title: L10n.t("about.copy_data_path", fallback: "复制目录路径"))

        func specRow(icon: String, tint: NSColor, key: String, right: NSView) -> NSView {
            let iconBox = tintedIconBox(
                size: 28,
                cornerRadius: 7.5,
                tint: tint,
                lightNeutralAlpha: 0.04
            )
            let iconView = symbol(icon, size: 13.5, color: tint)
            iconView.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 13.5, weight: .medium)
            iconBox.addSubview(iconView)
            NSLayoutConstraint.activate([
                iconView.centerXAnchor.constraint(equalTo: iconBox.centerXAnchor),
                iconView.centerYAnchor.constraint(equalTo: iconBox.centerYAnchor)
            ])
            let keyLbl = text(key, size: 13, weight: .semibold, color: .labelColor)
            keyLbl.setContentHuggingPriority(.required, for: .horizontal)
            keyLbl.setContentCompressionResistancePriority(.required, for: .horizontal)
            let row = horizontal([iconBox, keyLbl, flexibleSpace(), right], spacing: 11)
            row.alignment = .centerY
            return row
        }

        let dataRight = horizontal([dataPathLabel, revealDataBtn], spacing: 8)
        dataRight.alignment = .centerY
        dataRight.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let specsInner = vertical([
            specRow(icon: "cpu", tint: .systemIndigo, key: L10n.t("about.target_app", fallback: "目标应用"), right: versionSpecLabel),
            divider(),
            specRow(icon: "folder", tint: .systemOrange, key: L10n.t("about.data_dir", fallback: "GravityBox 数据目录"), right: dataRight)
        ], spacing: 11)
        for child in specsInner.arrangedSubviews { fillWidth(child, in: specsInner) }
        let specsCard = group([specsInner], inset: 14)
        specsCard.cornerRadius = Design.Radius.card

        // 3. GitHub Releases Card
        let releasesRow = settingRow(
            icon: "shippingbox",
            tint: Design.blue,
            title: "GitHub Releases",
            subtitle: "",
            control: githubReleasesBtn
        )
        let projectCard = group([releasesRow], inset: 14)
        projectCard.cornerRadius = Design.Radius.card

        func sectionGroup(_ title: String, card: NSView) -> NSStackView {
            let hdr = text(title, size: 11.5, weight: .semibold, color: Design.secondary)
            let grp = vertical([hdr, card], spacing: 6)
            fillWidth(hdr, in: grp)
            fillWidth(card, in: grp)
            return grp
        }

        let root = pageStack(title: L10n.t("about.title", fallback: "关于"))
        root.spacing = 12
        root.addArrangedSubview(heroCard)
        root.addArrangedSubview(sectionGroup(L10n.t("about.section.runtime", fallback: "运行信息"), card: specsCard))
        root.addArrangedSubview(projectCard)
        fillWidth(heroCard, in: root)
        fillWidth(projectCard, in: root)

        view = scrollPage(root)
        Design.applyControls(view)
        refreshSpecs()
        refreshUpdateState()
    }

    private var cachedBuildSummary: String?

    private func resolvedBuildSummary() -> String {
        if let cachedBuildSummary { return cachedBuildSummary }
        var buildStr = (Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if buildStr.lowercased().hasPrefix("build ") {
            buildStr = String(buildStr.dropFirst(6)).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let infoURLs = [
            app.resources.appendingPathComponent("build-info.json"),
            Bundle.main.resourceURL?.appendingPathComponent("build-info.json")
        ].compactMap { $0 }
        for url in infoURLs {
            if let data = try? Data(contentsOf: url),
               let info = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let rev = (info["revision"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
               !rev.isEmpty {
                let resolved = buildStr.isEmpty || buildStr == rev ? rev : "\(buildStr) · \(rev)"
                cachedBuildSummary = resolved
                return resolved
            }
        }
        let fallback = buildStr.isEmpty ? app.updateManager.currentBuildDisplay : buildStr
        cachedBuildSummary = fallback
        return fallback
    }

    private func resolvedAntigravityDisplay() -> String {
        let bundleVer = (Bundle(path: DesktopApplicationTarget().path)?
            .object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !bundleVer.isEmpty {
            return "Antigravity \(bundleVer)"
        }
        let liveVer = app.statusValue.appVersion.trimmingCharacters(in: .whitespacesAndNewlines)
        if !liveVer.isEmpty && liveVer != "fixture" {
            return "Antigravity \(liveVer)"
        }
        return L10n.t("about.antigravity_stable", fallback: "Antigravity 正式版")
    }

    private func refreshSpecs() {
        let ver = app.updateManager.currentVersion
        let buildDisplay = resolvedBuildSummary()
        let buildPart = buildDisplay.isEmpty ? "v\(ver)" : "Build \(buildDisplay)"
        let antigravityPart = resolvedAntigravityDisplay()
        versionSpecLabel.stringValue = antigravityPart

        let osVer = ProcessInfo.processInfo.operatingSystemVersion
        let osStr = osVer.patchVersion > 0
            ? "macOS \(osVer.majorVersion).\(osVer.minorVersion).\(osVer.patchVersion)"
            : "macOS \(osVer.majorVersion).\(osVer.minorVersion)"
        let copyText = "GravityBox v\(ver) (\(buildPart)) · \(antigravityPart) · \(osStr) \(AppUpdateManager.releaseArch)"
        enableTextCopy(versionSpecLabel, value: copyText, title: L10n.t("about.copy_version_info", fallback: "复制版本与环境信息"))
    }

    func syncAutoUpdateSwitch() {
        autoUpdateSwitch.state = app.configuration.value.autoUpdateEnabled ? .on : .off
    }

    func refreshUpdateState() {
        syncAutoUpdateSwitch()
        let ver = app.updateManager.currentVersion
        versionPill.title = "v\(ver)"
        switch app.updateManager.state {
        case .idle:
            statusLine.isHidden = true
            updateStatusLabel.stringValue = ""
            updateMetaLabel.stringValue = ""
            updateMetaLabel.isHidden = true
            checkUpdateBtn.isHidden = false
            checkUpdateBtn.setBusy(false, available: true)
            installNowBtn.isHidden = true
            cancelDownloadBtn.isHidden = true
            releaseNotesBtn.isHidden = true
        case .checking:
            statusLine.isHidden = false
            updateStatusIcon.image = NSImage(systemSymbolName: "arrow.triangle.2.circlepath", accessibilityDescription: nil)
            updateStatusIcon.contentTintColor = Design.blue
            updateStatusLabel.textColor = Design.secondary
            updateStatusLabel.stringValue = L10n.t("about.status.checking", fallback: "正在检查最新版本…")
            updateMetaLabel.stringValue = ""
            updateMetaLabel.isHidden = true
            checkUpdateBtn.isHidden = false
            checkUpdateBtn.setBusy(true, available: true)
            installNowBtn.isHidden = true
            cancelDownloadBtn.isHidden = true
            releaseNotesBtn.isHidden = true
        case .upToDate:
            statusLine.isHidden = false
            updateStatusIcon.image = NSImage(systemSymbolName: "checkmark.seal.fill", accessibilityDescription: nil)
            updateStatusIcon.contentTintColor = .systemGreen
            updateStatusLabel.textColor = Design.secondary
            updateStatusLabel.stringValue = L10n.t("about.status.up_to_date", fallback: "已是最新版本")
            updateMetaLabel.stringValue = ""
            updateMetaLabel.isHidden = true
            checkUpdateBtn.isHidden = false
            checkUpdateBtn.setBusy(false, available: true)
            installNowBtn.isHidden = true
            cancelDownloadBtn.isHidden = true
            releaseNotesBtn.isHidden = true
        case .updateAvailable(let release):
            statusLine.isHidden = false
            updateStatusIcon.image = NSImage(systemSymbolName: "sparkles", accessibilityDescription: nil)
            updateStatusIcon.contentTintColor = Design.blue
            updateStatusLabel.textColor = .labelColor
            updateStatusLabel.stringValue = L10n.t("about.status.available", ["tag": release.tagName], fallback: "发现新版本 \(release.tagName)")
            updateMetaLabel.stringValue = release.publishedDate.isEmpty ? "" : L10n.t("about.status.published_at", ["date": release.publishedDate], fallback: "发布于 \(release.publishedDate)")
            updateMetaLabel.isHidden = updateMetaLabel.stringValue.isEmpty
            checkUpdateBtn.isHidden = true
            installNowBtn.title = L10n.t("about.install_now", fallback: "立即更新")
            installNowBtn.isEnabled = true
            installNowBtn.isHidden = false
            cancelDownloadBtn.isHidden = true
            releaseNotesBtn.isHidden = false
        case .downloading(let release):
            statusLine.isHidden = false
            updateStatusIcon.image = NSImage(systemSymbolName: "arrow.down.circle.fill", accessibilityDescription: nil)
            updateStatusIcon.contentTintColor = Design.blue
            updateStatusLabel.textColor = .labelColor
            updateStatusLabel.stringValue = L10n.t("about.status.downloading", ["tag": release.tagName], fallback: "正在下载 \(release.tagName) 更新包…")
            if let pct = app.updateManager.downloadProgressPercent, pct > 0 {
                updateMetaLabel.stringValue = L10n.t("about.status.downloading_progress", ["pct": pct], fallback: "下载中 \(pct)%")
            } else {
                updateMetaLabel.stringValue = L10n.t("about.status.downloading_meta", fallback: "下载中")
            }
            updateMetaLabel.isHidden = false
            checkUpdateBtn.isHidden = true
            installNowBtn.isHidden = true
            cancelDownloadBtn.isEnabled = true
            cancelDownloadBtn.isHidden = false
            releaseNotesBtn.isHidden = false
        case .readyToInstall(let release, _):
            statusLine.isHidden = false
            updateStatusIcon.image = NSImage(systemSymbolName: "checkmark.shield.fill", accessibilityDescription: nil)
            updateStatusIcon.contentTintColor = .systemGreen
            updateStatusLabel.textColor = .labelColor
            updateStatusLabel.stringValue = L10n.t("about.status.ready", ["tag": release.tagName], fallback: "\(release.tagName) 更新包已就绪")
            updateMetaLabel.stringValue = L10n.t("about.status.verified_meta", fallback: "已校验")
            updateMetaLabel.isHidden = false
            checkUpdateBtn.isHidden = true
            installNowBtn.title = L10n.t("about.install_now", fallback: "立即更新")
            installNowBtn.isEnabled = true
            installNowBtn.isHidden = false
            cancelDownloadBtn.isHidden = true
            releaseNotesBtn.isHidden = false
        case .installing(let release):
            statusLine.isHidden = false
            updateStatusIcon.image = NSImage(systemSymbolName: "gearshape.2.fill", accessibilityDescription: nil)
            updateStatusIcon.contentTintColor = Design.blue
            updateStatusLabel.textColor = .labelColor
            updateStatusLabel.stringValue = L10n.t("about.status.installing", ["tag": release.tagName], fallback: "正在准备安装 \(release.tagName)…")
            updateMetaLabel.stringValue = L10n.t("about.status.installing_meta", fallback: "安装中")
            updateMetaLabel.isHidden = false
            checkUpdateBtn.isHidden = true
            installNowBtn.title = L10n.t("about.installing_btn", fallback: "正在安装…")
            installNowBtn.isEnabled = false
            installNowBtn.isHidden = false
            cancelDownloadBtn.isHidden = true
            releaseNotesBtn.isHidden = false
        case .failed(let message):
            statusLine.isHidden = false
            updateStatusIcon.image = NSImage(systemSymbolName: "exclamationmark.triangle.fill", accessibilityDescription: nil)
            updateStatusIcon.contentTintColor = accessibleWarningColor()
            updateStatusLabel.textColor = .labelColor
            updateStatusLabel.stringValue = L10n.t("about.status.failed", ["message": message], fallback: "检查更新未完成：\(message)")
            updateMetaLabel.stringValue = L10n.t("about.status.retry_meta", fallback: "可重试")
            updateMetaLabel.isHidden = false
            checkUpdateBtn.isHidden = false
            checkUpdateBtn.setBusy(false, available: true)
            installNowBtn.isHidden = true
            cancelDownloadBtn.isHidden = true
            releaseNotesBtn.isHidden = true
        }
    }

    func update() {
        refreshSpecs()
        refreshUpdateState()
    }

    @objc func checkForUpdates() {
        app.updateManager.checkForUpdates(silent: false)
    }

    @objc func installAvailableUpdate() {
        guard let release = app.updateManager.availableRelease else {
            checkForUpdates()
            return
        }
        app.updateManager.installRelease(release)
    }

    @objc func cancelActiveDownload() {
        cancelDownloadBtn.isEnabled = false
        app.updateManager.cancelDownload()
    }

    @objc func toggleAutoUpdate() {
        let enabled = autoUpdateSwitch.state == .on
        app.configuration.value.autoUpdateEnabled = enabled
        try? app.configuration.save()
        app.configureAutoUpdateTimer()
    }

    @objc func revealDataFolder() {
        NSWorkspace.shared.activateFileViewerSelecting([app.state])
    }

    @objc func openReleasesPage() {
        if let release = app.updateManager.availableRelease {
            NSWorkspace.shared.open(release.htmlURL)
        } else {
            NSWorkspace.shared.open(AppUpdateManager.releasesPageURL)
        }
    }
}
