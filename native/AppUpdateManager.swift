import Cocoa
import CryptoKit

struct AppReleaseInfo {
    let version: String
    let tagName: String
    let title: String
    let changelog: String
    let publishedDate: String
    let htmlURL: URL
    let dmgURL: URL?
    let sha256URL: URL?
}

final class AppUpdateManager {
    enum State {
        case idle
        case checking
        case upToDate
        case updateAvailable(AppReleaseInfo)
        case downloading(AppReleaseInfo)
        case readyToInstall(AppReleaseInfo, URL)
        case installing(AppReleaseInfo)
        case failed(String)
    }

    #if arch(x86_64)
    static let releaseArch = "x86_64"
    static let latestReleaseEndpoint = URL(string: "https://api.github.com/repos/lihaiyun-shuimu/gravitybox-x86-mac/releases/latest")!
    static let releasesPageURL = URL(string: "https://github.com/lihaiyun-shuimu/gravitybox-x86-mac/releases")!
    #else
    static let releaseArch = "arm64"
    static let latestReleaseEndpoint = URL(string: "https://api.github.com/repos/Enzoo404/gravitybox/releases/latest")!
    static let releasesPageURL = URL(string: "https://github.com/Enzoo404/gravitybox/releases")!
    #endif

    private static func httpsURL(from raw: String?) -> URL? {
        guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty,
              let url = URL(string: trimmed),
              url.scheme?.lowercased() == "https",
              let host = url.host,
              !host.isEmpty else {
            return nil
        }
        return url
    }

    unowned let app: Assistant
    private(set) var state: State = .idle
    private(set) var availableRelease: AppReleaseInfo?
    private(set) var downloadedDMGURL: URL?
    private(set) var downloadProgressPercent: Int? = nil
    var onStateChanged: (() -> Void)?
    #if NATIVE_UI_TEST
    var checkTransport: ((URLRequest, @escaping (Data?, URLResponse?, Error?) -> Void) -> Void)?
    #endif
    private var checkGeneration = 0
    private var checkInFlight = false
    private var downloadInFlight = false
    private var downloadTask: Task<Void, Never>?
    private var installationInFlight = false
    private var pendingInstallAfterDownload = false
    private var cleanupInFlight = false
    private var launchCleanupCompleted = false
    private var launchAcknowledgeAttempted = false

    init(app: Assistant) {
        self.app = app
    }

    var currentVersion: String {
        if let bundleVer = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
           !bundleVer.isEmpty {
            return bundleVer
        }
        let candidateURLs: [URL?] = [
            app.resources.appendingPathComponent("build-info.json"),
            Bundle.main.resourceURL?.appendingPathComponent("build-info.json"),
            URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("package.json")
        ]
        for url in candidateURLs.compactMap({ $0 }) {
            if let data = try? Data(contentsOf: url),
               let info = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let ver = (info["version"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
               !ver.isEmpty {
                return Self.normalizeVersion(ver)
            }
        }
        return "1.2.0"
    }

    var currentBuildDisplay: String {
        var buildStr = (Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if buildStr.lowercased().hasPrefix("build ") {
            buildStr = String(buildStr.dropFirst(6)).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let infoURLs = [
            app.resources.appendingPathComponent("build-info.json"),
            Bundle.main.resourceURL?.appendingPathComponent("build-info.json")
        ].compactMap { $0 }
        for infoURL in infoURLs {
            if let data = try? Data(contentsOf: infoURL),
               let info = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                if buildStr.isEmpty, let buildNum = info["build"] ?? info["buildNumber"] {
                    buildStr = "\(buildNum)"
                }
                if let rev = (info["revision"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
                   !rev.isEmpty, !buildStr.contains(rev) {
                    buildStr = buildStr.isEmpty ? rev : "\(buildStr) · \(rev)"
                }
                break
            }
        }
        return buildStr.isEmpty ? "10200" : buildStr
    }

    static func normalizeVersion(_ raw: String) -> String {
        var cleaned = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.lowercased().hasPrefix("v") {
            cleaned = String(cleaned.dropFirst()).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if let dash = cleaned.firstIndex(of: "-") {
            cleaned = String(cleaned[..<dash])
        }
        return cleaned
    }

    static func isNewerVersion(_ remoteRaw: String, than currentRaw: String) -> Bool {
        let remoteParts = normalizeVersion(remoteRaw).split(separator: ".").map { Int($0) ?? 0 }
        let currentParts = normalizeVersion(currentRaw).split(separator: ".").map { Int($0) ?? 0 }
        let count = max(remoteParts.count, currentParts.count, 3)
        for i in 0..<count {
            let r = i < remoteParts.count ? remoteParts[i] : 0
            let c = i < currentParts.count ? currentParts[i] : 0
            if r != c { return r > c }
        }
        return false
    }

    private func transition(_ next: State) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.state = next
            self.app.syncUpdatePromptControls()
            self.onStateChanged?()
        }
    }

    #if NATIVE_UI_TEST
    func simulateRelease(_ release: AppReleaseInfo?) {
        availableRelease = release
        downloadedDMGURL = nil
        downloadProgressPercent = nil
        if let release {
            state = .updateAvailable(release)
        } else {
            state = .upToDate
        }
        app.syncUpdatePromptControls()
        onStateChanged?()
    }

    func simulateDownloading(_ release: AppReleaseInfo, progressPercent: Int? = nil) {
        availableRelease = release
        downloadedDMGURL = nil
        downloadProgressPercent = progressPercent
        state = .downloading(release)
        app.syncUpdatePromptControls()
        onStateChanged?()
    }

    func simulateReadyToInstall(_ release: AppReleaseInfo, dmgURL: URL) {
        availableRelease = release
        downloadedDMGURL = dmgURL
        downloadProgressPercent = nil
        state = .readyToInstall(release, dmgURL)
        app.syncUpdatePromptControls()
        onStateChanged?()
    }

    func simulateFailed(_ message: String) {
        downloadProgressPercent = nil
        state = .failed(message)
        app.syncUpdatePromptControls()
        onStateChanged?()
    }
    #endif

    func checkForUpdates(silent: Bool = false) {
        guard Thread.isMainThread else { DispatchQueue.main.async { [weak self] in self?.checkForUpdates(silent: silent) }; return }
        guard !checkInFlight, !downloadInFlight, !installationInFlight else { return }
        #if NATIVE_UI_TEST
        if checkTransport == nil {
            transition(availableRelease.map { .updateAvailable($0) } ?? .upToDate)
            return
        }
        #endif
        let preservedReady: (AppReleaseInfo, URL)?
        if case .readyToInstall(let rel, let dmg) = state, FileManager.default.fileExists(atPath: dmg.path) {
            preservedReady = (rel, dmg)
        } else {
            preservedReady = nil
        }
        checkInFlight = true
        checkGeneration += 1
        let generation = checkGeneration
        if !(silent && preservedReady != nil) {
            transition(.checking)
        }
        var req = URLRequest(url: Self.latestReleaseEndpoint, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("GravityBox/\(currentVersion)", forHTTPHeaderField: "User-Agent")
        req.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")

        let transport: (URLRequest, @escaping (Data?, URLResponse?, Error?) -> Void) -> Void
        #if NATIVE_UI_TEST
        transport = checkTransport ?? { request, completion in URLSession.shared.dataTask(with: request, completionHandler: completion).resume() }
        #else
        transport = { request, completion in URLSession.shared.dataTask(with: request, completionHandler: completion).resume() }
        #endif
        transport(req) { [weak self] data, response, error in
          DispatchQueue.main.async {
            guard let self, generation == self.checkGeneration, self.checkInFlight else { return }
            defer { self.checkInFlight = false }
            if let error {
                if !silent {
                    self.transition(.failed(L10n.t("update.error.github_connect", ["error": error.localizedDescription], fallback: "无法连接 GitHub Releases：\(error.localizedDescription)")))
                } else if let (rel, dmg) = preservedReady, FileManager.default.fileExists(atPath: dmg.path) {
                    self.downloadedDMGURL = dmg
                    self.transition(.readyToInstall(rel, dmg))
                } else {
                    self.transition(self.availableRelease.map { .updateAvailable($0) } ?? .idle)
                }
                return
            }
            let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
            if statusCode == 404 {
                self.availableRelease = nil
                self.downloadedDMGURL = nil
                self.transition(.upToDate)
                return
            }
            guard statusCode == 200, let data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                if !silent {
                    self.transition(.failed(L10n.t("update.error.github_http", ["status": statusCode], fallback: "获取 GitHub 版本信息失败（HTTP \(statusCode)）")))
                } else if let (rel, dmg) = preservedReady, FileManager.default.fileExists(atPath: dmg.path) {
                    self.downloadedDMGURL = dmg
                    self.transition(.readyToInstall(rel, dmg))
                } else {
                    self.transition(self.availableRelease.map { .updateAvailable($0) } ?? .idle)
                }
                return
            }
            if (json["draft"] as? Bool) == true || (json["prerelease"] as? Bool) == true {
                self.availableRelease = nil
                self.downloadedDMGURL = nil
                self.transition(.upToDate)
                return
            }
            let tagName = (json["tag_name"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let remoteVersion = Self.normalizeVersion(tagName)
            guard !remoteVersion.isEmpty, Self.isNewerVersion(remoteVersion, than: self.currentVersion) else {
                self.availableRelease = nil
                self.downloadedDMGURL = nil
                self.transition(.upToDate)
                return
            }

            let name = (json["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "GravityBox v\(remoteVersion)"
            let body = (json["body"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let publishedRaw = (json["published_at"] as? String) ?? ""
            let publishedDate = publishedRaw.count >= 10 ? String(publishedRaw.prefix(10)) : L10n.t("update.latest_build", fallback: "最新构建")
            let htmlURL = Self.httpsURL(from: json["html_url"] as? String) ?? Self.releasesPageURL

            var dmgURL: URL?
            var sha256URL: URL?
            if let assets = json["assets"] as? [[String: Any]] {
                for asset in assets {
                    guard let assetName = asset["name"] as? String,
                          let downloadStr = asset["browser_download_url"] as? String,
                          let url = Self.httpsURL(from: downloadStr) else { continue }
                    let expectedName = "GravityBox-\(remoteVersion)-\(Self.releaseArch).dmg"
                    if assetName == expectedName { dmgURL = url }
                    else if assetName == expectedName + ".sha256" { sha256URL = url }
                }
            }

            let info = AppReleaseInfo(
                version: remoteVersion,
                tagName: tagName.isEmpty ? "v\(remoteVersion)" : tagName,
                title: name,
                changelog: body.isEmpty ? L10n.t("update.default_changelog", fallback: "• 包含稳定性提升与细节体验优化。") : body,
                publishedDate: publishedDate,
                htmlURL: htmlURL,
                dmgURL: dmgURL,
                sha256URL: sha256URL
            )

            self.availableRelease = info
            if let (prevRel, dmg) = preservedReady,
               info.version == prevRel.version,
               FileManager.default.fileExists(atPath: dmg.path) {
                self.downloadedDMGURL = dmg
                self.transition(.readyToInstall(info, dmg))
                return
            }
            let cached = self.cachedDMGPath(for: info.version)
            self.downloadedDMGURL = nil
            self.transition(.updateAvailable(info))
            if FileManager.default.fileExists(atPath: cached.path) || self.app.configuration.value.autoUpdateEnabled {
                self.preDownloadRelease(info, silent: true)
            }
          }
        }
    }

    /// @testonly 供 native-ui 单测验证更新日志清洗规则（生产关于页直接打开 GitHub Release 页面）。
    static func formatReleaseNotes(_ raw: String) -> String {
        let normalized = raw.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        var outputLines: [String] = []
        var inCodeBlock = false
        var codeBlockLines: [String] = []
        var skipSection = false

        func isBoilerplateHeading(_ heading: String) -> Bool {
            let lower = heading.lowercased()
            return lower.contains("sha-256") ||
                lower.contains("sha256") ||
                lower.contains("checksum") ||
                lower.contains("verification") ||
                lower == "installation" ||
                lower == "install" ||
                lower.hasPrefix("installation ") ||
                lower.contains("installation & first launch") ||
                lower.contains("installation and first launch") ||
                lower.contains("manual installation") ||
                lower.contains("manual install") ||
                lower.contains("first launch") ||
                heading.contains("附件校验") ||
                heading.contains("安装与首次打开") ||
                heading.contains("安装说明") ||
                heading.contains("手动安装") ||
                heading == "安装"
        }

        func isBoilerplateCodeLine(_ line: String) -> Bool {
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.isEmpty { return true }
            if t.contains("com.apple.quarantine") || t.hasPrefix("sudo xattr") || t.hasPrefix("xattr ") {
                return true
            }
            let parts = t.split(whereSeparator: { $0.isWhitespace })
            if let first = parts.first, first.count == 64,
               first.allSatisfy({ $0.isHexDigit }) {
                return true
            }
            return false
        }

        for rawLine in normalized.components(separatedBy: "\n") {
            let trimmed = rawLine.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                if inCodeBlock {
                    inCodeBlock = false
                    if !skipSection && !codeBlockLines.allSatisfy(isBoilerplateCodeLine) {
                        for cLine in codeBlockLines {
                            outputLines.append("  " + cLine)
                        }
                    }
                    codeBlockLines.removeAll()
                } else {
                    inCodeBlock = true
                    codeBlockLines.removeAll()
                }
                continue
            }
            if inCodeBlock {
                codeBlockLines.append(rawLine)
                continue
            }
            var headingTitle: String?
            if trimmed.hasPrefix("### ") {
                headingTitle = String(trimmed.dropFirst(4)).trimmingCharacters(in: .whitespaces)
            } else if trimmed.hasPrefix("## ") {
                headingTitle = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
            } else if trimmed.hasPrefix("# ") {
                headingTitle = String(trimmed.dropFirst(2)).trimmingCharacters(in: .whitespaces)
            }
            if let headingTitle {
                skipSection = isBoilerplateHeading(headingTitle)
                if !skipSection {
                    let cleanHeading = headingTitle.replacingOccurrences(of: "**", with: "")
                        .replacingOccurrences(of: "`", with: "")
                    outputLines.append(cleanHeading)
                }
                continue
            }
            if skipSection { continue }

            var line = rawLine
            if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") {
                line = "• " + String(trimmed.dropFirst(2))
            }
            line = line.replacingOccurrences(of: "**", with: "")
                .replacingOccurrences(of: "`", with: "")
            outputLines.append(line)
        }
        var result = outputLines.joined(separator: "\n")
        while result.contains("\n\n\n") {
            result = result.replacingOccurrences(of: "\n\n\n", with: "\n\n")
        }
        result = result.trimmingCharacters(in: .whitespacesAndNewlines)
        return result.isEmpty ? L10n.t("update.default_changelog", fallback: "• 包含稳定性提升与细节体验优化。") : result
    }

    private func cachedDMGPath(for version: String) -> URL {
        app.state.appendingPathComponent("updates/v\(version)/GravityBox-\(version)-\(Self.releaseArch).dmg")
    }

    private static func configureSilentProcess(_ proc: Process) {
        proc.standardInput = FileHandle.nullDevice
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
    }

    static func verifyCachedDownload(_ file: URL) throws {
        let text = try String(contentsOf: file.appendingPathExtension("sha256"), encoding: .utf8)
        let expected = try UpdatePackageIntegrity.expectedHash(text, fileName: file.lastPathComponent)
        try UpdatePackageIntegrity.verify(file, expected: expected)
    }

    private static func makeUpdateDownloadSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 300
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }

    private final class LockedDownloadHandle: @unchecked Sendable {
        private let lock = NSLock()
        private var task: URLSessionDownloadTask?
        private var observation: NSKeyValueObservation?
        private var isCancelled = false
        private var lastReportedPercent = -1

        func bind(task: URLSessionDownloadTask, observation: NSKeyValueObservation) {
            var shouldCancelNow = false
            lock.lock()
            if isCancelled {
                shouldCancelNow = true
            } else {
                self.task = task
                self.observation = observation
            }
            lock.unlock()
            if shouldCancelNow {
                observation.invalidate()
                task.cancel()
            }
        }

        func shouldReport(percent: Int) -> Bool {
            lock.lock()
            defer { lock.unlock() }
            guard !isCancelled, percent != lastReportedPercent else { return false }
            lastReportedPercent = percent
            return true
        }

        func finish() {
            lock.lock()
            let obs = observation
            observation = nil
            task = nil
            lock.unlock()
            obs?.invalidate()
        }

        func cancel() {
            lock.lock()
            isCancelled = true
            let activeTask = task
            let obs = observation
            observation = nil
            task = nil
            lock.unlock()
            obs?.invalidate()
            activeTask?.cancel()
        }
    }

    private static func downloadFileWithProgress(
        session: URLSession,
        url: URL,
        destination: URL,
        onProgress: @escaping @Sendable (Int) -> Void
    ) async throws {
        let handle = LockedDownloadHandle()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                let task = session.downloadTask(with: url) { tempURL, response, error in
                    handle.finish()
                    if let error {
                        continuation.resume(throwing: error)
                        return
                    }
                    guard (response as? HTTPURLResponse)?.statusCode == 200, let tempURL else {
                        continuation.resume(throwing: URLError(.badServerResponse))
                        return
                    }
                    do {
                        let fm = FileManager.default
                        if fm.fileExists(atPath: destination.path) {
                            try? fm.removeItem(at: destination)
                        }
                        try fm.moveItem(at: tempURL, to: destination)
                        continuation.resume(returning: ())
                    } catch {
                        continuation.resume(throwing: error)
                    }
                }
                let observation = task.progress.observe(\.fractionCompleted, options: [.new]) { progress, _ in
                    guard progress.totalUnitCount > 0 else { return }
                    let pct = max(0, min(100, Int((progress.fractionCompleted * 100.0).rounded(.down))))
                    if handle.shouldReport(percent: pct) {
                        onProgress(pct)
                    }
                }
                handle.bind(task: task, observation: observation)
                task.resume()
            }
        } onCancel: {
            handle.cancel()
        }
    }

    func preDownloadRelease(_ release: AppReleaseInfo, silent: Bool, completion: ((Result<URL, Error>) -> Void)? = nil) {
        guard !downloadInFlight else { return }
        downloadInFlight = true
        downloadedDMGURL = nil
        downloadProgressPercent = nil
        transition(.downloading(release))
        let targetFile = cachedDMGPath(for: release.version)
        downloadTask = Task { @MainActor [weak self] in
            guard let self else { return }
            let reportProgress: @Sendable (Int) -> Void = { [weak self] pct in
                Task { @MainActor [weak self] in
                    guard let self, self.downloadInFlight else { return }
                    if case .downloading = self.state {
                        self.downloadProgressPercent = pct
                        self.onStateChanged?()
                    }
                }
            }
            let preparation = Task.detached(priority: .utility) { () -> Result<URL, Error> in
            let result: Result<URL, Error>
            do {
            let file = try await { () async throws -> URL in
                guard release.version.range(of: #"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$"#, options: .regularExpression) != nil else {
                    throw UpdatePackageIntegrity.failure(L10n.t("update.error.invalid_version", fallback: "更新版本号无效，已停止更新。"))
                }
                let fm = FileManager.default
                // Rehash on every reuse, including installation. Old unverified caches never qualify.
                if fm.fileExists(atPath: targetFile.path), (try? Self.verifyCachedDownload(targetFile)) != nil {
                    return targetFile
                }
                guard let dmgURL = release.dmgURL, let shaURL = release.sha256URL else {
                    throw UpdatePackageIntegrity.failure(L10n.t("update.error.missing_assets", fallback: "该版本缺少安装包或 SHA-256 校验文件，已停止更新；当前版本仍可继续使用。"))
                }
                let session = Self.makeUpdateDownloadSession()
                defer { session.invalidateAndCancel() }
                let shaText: String
                do { let (data, response) = try await session.data(from: shaURL); guard (response as? HTTPURLResponse)?.statusCode == 200, data.count < 65536, let decoded = String(data: data, encoding: .utf8) else { throw URLError(.badServerResponse) }; shaText = decoded }
                catch { throw UpdatePackageIntegrity.failure(L10n.t("update.error.sha_read_failed", fallback: "无法读取 SHA-256 校验文件，已停止更新，请稍后重试。")) }
                let expected = try UpdatePackageIntegrity.expectedHash(shaText, fileName: targetFile.lastPathComponent)
                let dir = targetFile.deletingLastPathComponent()
                try fm.createDirectory(at: dir, withIntermediateDirectories: true)
                let tempDMG = dir.appendingPathComponent("download-\(UUID().uuidString).dmg.part")
                defer { try? fm.removeItem(at: tempDMG) }
                try await Self.downloadFileWithProgress(session: session, url: dmgURL, destination: tempDMG, onProgress: reportProgress)
                try Task.checkCancellation()
                try UpdatePackageIntegrity.verify(tempDMG, expected: expected)
                let verify = Process()
                verify.executableURL = URL(fileURLWithPath: "/usr/bin/hdiutil")
                verify.arguments = ["verify", "-quiet", tempDMG.path]
                Self.configureSilentProcess(verify)
                try verify.run(); verify.waitUntilExit()
                guard verify.terminationStatus == 0 else { throw UpdatePackageIntegrity.failure(L10n.t("update.error.dmg_verify_failed", fallback: "DMG 磁盘映像完整性校验未通过。")) }
                try Task.checkCancellation()
                guard rename(tempDMG.path, targetFile.path) == 0 else { throw UpdatePackageIntegrity.failure(L10n.t("update.error.save_failed", fallback: "无法保存已校验安装包，请稍后重试。")) }
                // A crash between these writes leaves an unusable cache, never an unchecked ready state.
                try Data("\(expected)  \(targetFile.lastPathComponent)\n".utf8).write(to: targetFile.appendingPathExtension("sha256"), options: .atomic)
                try Self.verifyCachedDownload(targetFile)
                return targetFile
            }()
            result = .success(file)
            } catch { result = .failure(error) }
            return result
            }
            let result = await withTaskCancellationHandler { await preparation.value } onCancel: { preparation.cancel() }
                self.downloadInFlight = false
                self.downloadProgressPercent = nil
                let shouldAutoInstall = self.pendingInstallAfterDownload
                self.pendingInstallAfterDownload = false
                switch result {
                case .success(let file):
                    self.downloadedDMGURL = file
                    self.transition(.readyToInstall(release, file))
                    if shouldAutoInstall && !self.installationInFlight {
                        self.installationInFlight = true
                        self.executeInstall(release: release, dmgFile: file)
                    }
                case .failure(let error):
                    if error is CancellationError || (error as? URLError)?.code == .cancelled { self.transition(.updateAvailable(release)) }
                    else { self.transition((silent && !shouldAutoInstall) ? .updateAvailable(release) : .failed(error.localizedDescription)) }
                }
                completion?(result)
        }
    }

    func cancelDownload() { pendingInstallAfterDownload = false; downloadProgressPercent = nil; downloadTask?.cancel() }

    func installRelease(_ release: AppReleaseInfo) {
        guard !installationInFlight else { return }
        if downloadInFlight {
            pendingInstallAfterDownload = true
            transition(.downloading(release))
            return
        }
        installationInFlight = true
        // The cached path must pass the same validation as a newly downloaded package.
        preDownloadRelease(release, silent: false) { [weak self] result in
            switch result {
            case .success(let file): self?.executeInstall(release: release, dmgFile: file)
            case .failure: self?.installationInFlight = false
            }
        }
    }

    static func resolveInstallTargetAppPath(bundleURL: URL = Bundle.main.bundleURL) -> String {
        let bundlePath = bundleURL.standardizedFileURL.path
        if bundlePath.hasSuffix(".app"),
           !bundlePath.hasPrefix("/Volumes/"),
           !bundlePath.contains("/build/dmg-stage/"),
           !bundlePath.contains("/build/x64-stage/"),
           FileManager.default.isWritableFile(atPath: (bundlePath as NSString).deletingLastPathComponent) {
            return bundlePath
        }
        return "/Applications/GravityBox.app"
    }

    private static let dmgFilenameRegex = try! NSRegularExpression(
        pattern: #"^GravityBox[-_ ]v?(\d+\.\d+\.\d+(?:-[A-Za-z0-9._-]+)?)(?:-(?:arm64|universal|x86_64|mac))?\.dmg(?:\.sha256)?$"#,
        options: [.caseInsensitive]
    )

    static func extractGravityBoxDMGVersion(from fileName: String) -> String? {
        let ns = fileName as NSString
        let range = NSRange(location: 0, length: ns.length)
        guard let match = dmgFilenameRegex.firstMatch(in: fileName, options: [], range: range),
              match.numberOfRanges >= 2 else {
            return nil
        }
        let rawVer = ns.substring(with: match.range(at: 1))
        let normalized = normalizeVersion(rawVer)
        return normalized.isEmpty ? nil : normalized
    }

    func validateCachedDMGState() {
        if let url = downloadedDMGURL, !FileManager.default.fileExists(atPath: url.path) {
            downloadedDMGURL = nil
            if case .readyToInstall(let release, _) = state {
                state = .updateAvailable(release)
            }
        }
    }

    private struct CleanupRuntimeSnapshot {
        let stateDir: URL
        let currentVer: String
        let isInstalling: Bool
        let isDownloading: Bool
        let lastCleanedVersion: String
    }

    private func captureCleanupSnapshot(currentVersionOverride: String?) -> CleanupRuntimeSnapshot {
        let build = { () -> CleanupRuntimeSnapshot in
            let ver = Self.normalizeVersion(currentVersionOverride ?? self.currentVersion)
            let installing: Bool
            if case .installing = self.state { installing = true } else { installing = false }
            return CleanupRuntimeSnapshot(
                stateDir: self.app.state,
                currentVer: ver,
                isInstalling: installing,
                isDownloading: self.downloadInFlight,
                lastCleanedVersion: self.app.configuration?.value.lastCleanedVersion ?? ""
            )
        }
        if Thread.isMainThread {
            return build()
        }
        return DispatchQueue.main.sync(execute: build)
    }

    /// Invoked only after a successful backend status reply, never merely because the app started.
    func cleanupAfterSuccessfulLaunch() {
        #if !NATIVE_UI_TEST
        guard Thread.isMainThread else {
            DispatchQueue.main.async { [weak self] in self?.cleanupAfterSuccessfulLaunch() }
            return
        }
        guard !cleanupInFlight, !launchCleanupCompleted, !installationInFlight else { return }
        let arguments = CommandLine.arguments, version = currentVersion, bundle = Bundle.main.bundleURL, stateDir = app.state
        let hasReceipt = arguments.contains("--update-receipt")
        if !hasReceipt && app.configuration.value.lastCleanedVersion == version {
            launchCleanupCompleted = true
            return
        }
        let needAck = hasReceipt && !launchAcknowledgeAttempted
        launchAcknowledgeAttempted = true
        cleanupInFlight = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            if needAck {
                _ = UpdateInstaller.acknowledge(arguments: arguments, state: stateDir, bundle: bundle)
            }
            var confirmed = false
            if hasReceipt {
                // Ready is only the new app's acknowledgement; wait briefly for the helper's committed confirmation.
                for _ in 0..<15 {
                    if UpdateInstaller.isConfirmed(arguments: arguments, state: stateDir, bundle: bundle) {
                        confirmed = true
                        break
                    }
                    Thread.sleep(forTimeInterval: 0.1)
                }
            } else {
                // Manual drag-and-drop upgrades have no helper receipt: validate the running app after backend readiness.
                confirmed = (try? UpdateInstaller.validateApp(bundle, version: version, appHash: UpdatePackageIntegrity.appHash(bundle))) != nil
            }
            if confirmed {
                _ = self.cleanupObsoleteUpdateArtifacts(successfulLaunchConfirmed: true,
                    restartedAfterUpdate: arguments.contains("--restarted-after-update"), detachMountedVolumes: true)
            }
            DispatchQueue.main.async {
                self.cleanupInFlight = false
                self.launchCleanupCompleted = confirmed || !hasReceipt
            }
        }
        #endif
    }

    @discardableResult
    func cleanupObsoleteUpdateArtifacts(
        successfulLaunchConfirmed: Bool = false,
        restartedAfterUpdate: Bool = false,
        currentVersionOverride: String? = nil,
        downloadsDirectory: URL? = nil,
        detachMountedVolumes: Bool = false
    ) -> Int {
        guard successfulLaunchConfirmed else { return 0 }
        let snapshot = captureCleanupSnapshot(currentVersionOverride: currentVersionOverride)
        let fm = FileManager.default
        let currentVer = snapshot.currentVer
        var cleanedCount = 0

        let updatesDir = snapshot.stateDir.appendingPathComponent("updates", isDirectory: true)
        if let entries = try? fm.contentsOfDirectory(at: updatesDir, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey], options: [.skipsHiddenFiles]) {
            for entryURL in entries {
                let name = entryURL.lastPathComponent
                let values = try? entryURL.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
                if values?.isSymbolicLink == true { continue }
                let isDir = values?.isDirectory == true

                if isDir && name.hasPrefix("install-") {
                    if snapshot.isInstalling { continue }
                    if fm.fileExists(atPath: entryURL.appendingPathComponent(UpdateInstaller.receiptName).path) { continue }
                    if (try? fm.removeItem(at: entryURL)) != nil {
                        cleanedCount += 1
                    }
                    continue
                }

                if isDir && name == "transactions" {
                    if snapshot.isInstalling { continue }
                    if let txEntries = try? fm.contentsOfDirectory(at: entryURL, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey], options: [.skipsHiddenFiles]) {
                        for txURL in txEntries {
                            let txValues = try? txURL.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
                            guard txValues?.isSymbolicLink != true, txValues?.isDirectory == true, txURL.lastPathComponent.hasPrefix("install-") else { continue }
                            let receiptURL = txURL.appendingPathComponent(UpdateInstaller.receiptName)
                            if !fm.fileExists(atPath: receiptURL.path) {
                                if (try? fm.removeItem(at: txURL)) != nil { cleanedCount += 1 }
                                continue
                            }
                            if let rData = try? Data(contentsOf: receiptURL),
                               let receipt = try? JSONDecoder().decode(UpdateInstallReceipt.self, from: rData),
                               receipt.phase == "confirmed" {
                                for stagedName in ["GravityBox.app", "installer", "mount"] {
                                    let stagedItem = txURL.appendingPathComponent(stagedName)
                                    if fm.fileExists(atPath: stagedItem.path), (try? fm.removeItem(at: stagedItem)) != nil {
                                        cleanedCount += 1
                                    }
                                }
                            }
                        }
                    }
                    continue
                }

                if isDir && name.lowercased().hasPrefix("v") {
                    let folderVer = Self.normalizeVersion(name)
                    if !folderVer.isEmpty && !Self.isNewerVersion(folderVer, than: currentVer) {
                        if (try? fm.removeItem(at: entryURL)) != nil {
                            cleanedCount += 1
                        }
                    } else if !snapshot.isDownloading,
                              let children = try? fm.contentsOfDirectory(at: entryURL, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]) {
                        for child in children where child.lastPathComponent.hasSuffix(".dmg.part") {
                            if (try? fm.removeItem(at: child)) != nil {
                                cleanedCount += 1
                            }
                        }
                    }
                    continue
                }

                if !isDir {
                    if !snapshot.isDownloading && name.hasSuffix(".dmg.part") {
                        if (try? fm.removeItem(at: entryURL)) != nil {
                            cleanedCount += 1
                        }
                    } else if let pkgVer = Self.extractGravityBoxDMGVersion(from: name),
                              !Self.isNewerVersion(pkgVer, than: currentVer) {
                        if (try? fm.removeItem(at: entryURL)) != nil {
                            cleanedCount += 1
                        }
                    }
                }
            }
        }

        let lastCleaned = snapshot.lastCleanedVersion
        let isVersionUpgrade = !currentVer.isEmpty && lastCleaned != currentVer

        if detachMountedVolumes && (restartedAfterUpdate || isVersionUpgrade) {
            let bundlePath = Bundle.main.bundleURL.standardizedFileURL.path
            if !bundlePath.hasPrefix("/Volumes/") {
                let volumesDir = URL(fileURLWithPath: "/Volumes", isDirectory: true)
                if let mounts = try? fm.contentsOfDirectory(at: volumesDir, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]) {
                    for mountURL in mounts {
                        let mountName = mountURL.lastPathComponent
                        guard mountName.lowercased().hasPrefix("gravitybox"),
                              fm.fileExists(atPath: mountURL.appendingPathComponent("GravityBox.app/Contents/Info.plist").path) else {
                            continue
                        }
                        let detach = Process()
                        detach.executableURL = URL(fileURLWithPath: "/usr/bin/hdiutil")
                        detach.arguments = ["detach", mountURL.path, "-force", "-quiet"]
                        Self.configureSilentProcess(detach)
                        try? detach.run()
                        detach.waitUntilExit()
                    }
                }
            }
        }

        // 仅在显式传入指定目录（如单元测试隔离环境）时清理，严禁默认扫描用户 ~/Downloads，杜绝 TCC 权限弹窗与隐私越界
        if let downloadsURL = downloadsDirectory,
           let files = try? fm.contentsOfDirectory(at: downloadsURL, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey], options: [.skipsHiddenFiles]) {
            for fileURL in files {
                let values = try? fileURL.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
                guard values?.isSymbolicLink != true, values?.isRegularFile == true else { continue }
                let fileName = fileURL.lastPathComponent
                guard let pkgVer = Self.extractGravityBoxDMGVersion(from: fileName),
                      !Self.isNewerVersion(pkgVer, than: currentVer) else {
                    continue
                }
                if (try? fm.trashItem(at: fileURL, resultingItemURL: nil)) != nil {
                    cleanedCount += 1
                } else if (try? fm.removeItem(at: fileURL)) != nil {
                    cleanedCount += 1
                }
            }
        }

        let syncMemoryState = { [weak self] in
            guard let self else { return }
            if let dmg = self.downloadedDMGURL, !fm.fileExists(atPath: dmg.path) {
                self.downloadedDMGURL = nil
            }
            if let rel = self.availableRelease, !Self.isNewerVersion(rel.version, than: currentVer) {
                self.availableRelease = nil
                self.downloadedDMGURL = nil
                self.state = .upToDate
                self.app.syncUpdatePromptControls()
                self.onStateChanged?()
            } else {
                self.validateCachedDMGState()
                self.app.syncUpdatePromptControls()
            }
            if self.app.configuration != nil && self.app.configuration.value.lastCleanedVersion != currentVer {
                self.app.configuration.value.lastCleanedVersion = currentVer
                try? self.app.configuration.save()
            }
        }
        if Thread.isMainThread {
            syncMemoryState()
        } else {
            DispatchQueue.main.async(execute: syncMemoryState)
        }

        return cleanedCount
    }

    static func shellQuote(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\"'\"'") + "'" }

    static func buildDetachedUpdaterScript(
        myPid: Int32,
        stagedAppPath _: String = "",
        targetAppPath _: String = "",
        workDirPath: String,
        dmgFilePath _: String = "",
        i18nDirPath: String? = nil,
        appLanguage: String? = nil
    ) -> String {
        let helper = URL(fileURLWithPath: workDirPath).appendingPathComponent("installer").path
        let receipt = URL(fileURLWithPath: workDirPath).appendingPathComponent(UpdateInstaller.receiptName).path
        let resolvedI18n = (i18nDirPath?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0.isEmpty ? nil : $0 }
            ?? URL(fileURLWithPath: workDirPath).appendingPathComponent("i18n").path
        var envAssignments = ["GRAVITYBOX_I18N_DIR=" + shellQuote(resolvedI18n)]
        if let lang = appLanguage?.trimmingCharacters(in: .whitespacesAndNewlines), !lang.isEmpty {
            envAssignments.append("GRAVITYBOX_LANGUAGE=" + shellQuote(lang))
        }
        let body = """
        trap "" HUP TERM INT QUIT PIPE
        i=0
        while kill -0 \(myPid) 2>/dev/null && [ $i -lt 50 ]; do
          sleep 0.2
          i=$((i + 1))
        done
        if kill -0 \(myPid) 2>/dev/null; then
          kill -9 \(myPid) 2>/dev/null || true
          sleep 0.2
        fi
        export \(envAssignments.joined(separator: " "))
        exec \(shellQuote(helper)) --install-update \(shellQuote(receipt))
        """
        return "nohup /bin/sh -c " + shellQuote(body) + " >/dev/null 2>&1 &"
    }

    private static func findBundledI18nDirectory(fileManager: FileManager = .default) -> URL? {
        var candidates: [URL] = []
        if let envI18n = ProcessInfo.processInfo.environment["GRAVITYBOX_I18N_DIR"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !envI18n.isEmpty {
            candidates.append(URL(fileURLWithPath: envI18n, isDirectory: true))
        }
        if let res = Bundle.main.resourceURL {
            candidates.append(res.appendingPathComponent("i18n", isDirectory: true))
        }
        if let exeDir = Bundle.main.executableURL?.deletingLastPathComponent() {
            candidates.append(exeDir.appendingPathComponent("i18n", isDirectory: true))
        }
        candidates.append(
            URL(fileURLWithPath: fileManager.currentDirectoryPath, isDirectory: true)
                .appendingPathComponent("assets/i18n", isDirectory: true)
        )
        return candidates.first { dir in
            fileManager.fileExists(atPath: dir.appendingPathComponent("en.json").path)
        }
    }

    private func executeInstall(release: AppReleaseInfo, dmgFile: URL) {
        let configuredLang = app.effectiveConfiguredLanguage()
        let stateDir = app.state
        transition(.installing(release))
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            let fm = FileManager.default
            let workDir = stateDir.appendingPathComponent("updates/transactions/install-\(UUID().uuidString)")
            let mountDir = workDir.appendingPathComponent("mount")
            let stagedApp = workDir.appendingPathComponent("GravityBox.app")
            do {
                try Self.verifyCachedDownload(dmgFile)
                try fm.createDirectory(at: mountDir, withIntermediateDirectories: true)
                let attach = Process()
                attach.executableURL = URL(fileURLWithPath: "/usr/bin/hdiutil")
                attach.arguments = ["attach", "-nobrowse", "-readonly", "-quiet", "-mountpoint", mountDir.path, dmgFile.path]
                Self.configureSilentProcess(attach)
                try attach.run()
                attach.waitUntilExit()
                guard attach.terminationStatus == 0 else {
                    throw NSError(domain: "GravityBoxUpdate", code: 4, userInfo: [NSLocalizedDescriptionKey: L10n.t("update.error.mount_failed", fallback: "无法挂载更新镜像，安装包已保留，请重试或重新下载。")])
                }
                defer {
                    let detach = Process()
                    detach.executableURL = URL(fileURLWithPath: "/usr/bin/hdiutil")
                    detach.arguments = ["detach", mountDir.path, "-force", "-quiet"]
                    Self.configureSilentProcess(detach)
                    try? detach.run()
                    detach.waitUntilExit()
                }

                let mountedApp = mountDir.appendingPathComponent("GravityBox.app")
                guard fm.fileExists(atPath: mountedApp.appendingPathComponent("Contents/MacOS/GravityBox").path) else {
                    throw NSError(domain: "GravityBoxUpdate", code: 5, userInfo: [NSLocalizedDescriptionKey: L10n.t("update.error.app_not_found", fallback: "更新镜像内未找到有效的 GravityBox.app。")])
                }
                try fm.copyItem(at: mountedApp, to: stagedApp)

                let xattrProc = Process()
                xattrProc.executableURL = URL(fileURLWithPath: "/usr/bin/xattr")
                xattrProc.arguments = ["-dr", "com.apple.quarantine", stagedApp.path]
                Self.configureSilentProcess(xattrProc)
                try? xattrProc.run()
                xattrProc.waitUntilExit()

                try UpdateInstaller.verifyCodeSignature(
                    stagedApp,
                    failureMessage: L10n.t("update.error.codesign_failed", fallback: "新版本应用包代码签名校验未通过。")
                )

                let targetAppPath = Self.resolveInstallTargetAppPath()
                let receipt = try UpdateInstaller.prepare(stagedApp: stagedApp, target: URL(fileURLWithPath: targetAppPath),
                    work: workDir, version: release.version, dmg: dmgFile)
                let helper = workDir.appendingPathComponent("installer")
                guard let executableURL = Bundle.main.executableURL else {
                    throw UpdatePackageIntegrity.failure(L10n.t("update.error.helper_missing", fallback: "未能定位当前应用可执行文件。"))
                }
                try fm.copyItem(at: executableURL, to: helper)
                try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: helper.path)
                let stagedI18n = workDir.appendingPathComponent("i18n", isDirectory: true)
                if let srcI18n = Self.findBundledI18nDirectory(fileManager: fm) {
                    if fm.fileExists(atPath: stagedI18n.path) {
                        try? fm.removeItem(at: stagedI18n)
                    }
                    try? fm.copyItem(at: srcI18n, to: stagedI18n)
                }
                // The signed helper is the currently running binary, independent of the app being exchanged.
                guard fm.fileExists(atPath: receipt.path) else { throw UpdatePackageIntegrity.failure(L10n.t("update.error.receipt_save_failed", fallback: "更新恢复记录未能保存。")) }
                DispatchQueue.main.async {
                    self.app.suppressLifecycleAutoQuit(seconds: 60)
                    let myPid = getpid()
                    let script = Self.buildDetachedUpdaterScript(
                        myPid: myPid,
                        stagedAppPath: stagedApp.path,
                        targetAppPath: targetAppPath,
                        workDirPath: workDir.path,
                        dmgFilePath: dmgFile.path,
                        i18nDirPath: stagedI18n.path,
                        appLanguage: configuredLang
                    )
                    let updater = Process()
                    updater.executableURL = URL(fileURLWithPath: "/bin/sh")
                    updater.arguments = ["-c", script]
                    Self.configureSilentProcess(updater)
                    do {
                        try updater.run()
                        updater.waitUntilExit()
                        guard updater.terminationStatus == 0 else {
                            self.installationInFlight = false
                            self.transition(.failed(L10n.t(
                                "update.error.helper_launch_failed",
                                ["error": "exit \(updater.terminationStatus)"],
                                fallback: "无法启动安装辅助脚本，旧版本和恢复材料已保留（退出码 \(updater.terminationStatus)）"
                            )))
                            return
                        }
                        self.app.quitForUpdate()
                    } catch {
                        self.installationInFlight = false
                        self.transition(.failed(L10n.t("update.error.helper_launch_failed", ["error": error.localizedDescription], fallback: "无法启动安装辅助脚本，旧版本和恢复材料已保留：\(error.localizedDescription)")))
                    }
                }
            } catch {
                if !fm.fileExists(atPath: workDir.appendingPathComponent(UpdateInstaller.receiptName).path) { try? fm.removeItem(at: workDir) }
                DispatchQueue.main.async {
                    self.installationInFlight = false
                    if !fm.fileExists(atPath: dmgFile.path) {
                        self.downloadedDMGURL = nil
                    }
                    self.transition(.failed(error.localizedDescription))
                }
            }
        }
    }
}
