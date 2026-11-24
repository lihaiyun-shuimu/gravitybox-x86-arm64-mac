import Cocoa
import OSLog

private let lifecycleLogger = Logger(subsystem: "local.gravitybox.app", category: "Lifecycle")
private var safeRelaunchInFlightIds = Set<ObjectIdentifier>()
private var openAntigravityProbeInFlightIds = Set<ObjectIdentifier>()

enum StartupLaunchAction: Equatable {
    case showMainPanel
    case stayInMenuBar
    case launchAntigravityInBackground
}

enum ReopenLaunchAction: Equatable {
    case showMainPanel
    case launchAntigravityInBackground
}

struct ProcessTreeEntry: Equatable {
    let pid: Int32
    let ppid: Int32
    let args: String
}

#if NATIVE_UI_TEST
struct SafeRelaunchTestingHooks {
    var confirm: ((NSAlert, @escaping (Bool) -> Void) -> Void)? = nil
    var isRunning: (() -> Bool)? = nil
    var hasSubprocesses: (() -> Bool)? = nil
    var terminate: (() -> Void)? = nil
    var relaunchAttempt: ((Int, @escaping (Bool) -> Void) -> Void)? = nil
    var timeoutSeconds: TimeInterval? = nil
    var pollIntervalMilliseconds: Int? = nil
    var relaunchRetryDelayMilliseconds: Int? = nil
}
private var safeRelaunchTestingHooksById: [ObjectIdentifier: SafeRelaunchTestingHooks] = [:]
#endif

extension Assistant {
    static let remoteDebuggingArguments = ["--remote-debugging-port=0"]

    static func makeOpenConfiguration(environment: [String: String] = [:]) -> NSWorkspace.OpenConfiguration {
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        config.createsNewApplicationInstance = false
        config.arguments = remoteDebuggingArguments
        if !environment.isEmpty {
            config.environment = environment
        }
        return config
    }

    static func makeOpenCommandArguments(launchPath: String, environment: [String: String] = [:]) -> [String] {
        var args = ["-a", launchPath]
        for key in environment.keys.sorted() {
            if let value = environment[key] {
                args.append(contentsOf: ["--env", "\(key)=\(value)"])
            }
        }
        args.append("--args")
        args.append(contentsOf: remoteDebuggingArguments)
        return args
    }

    func effectiveProxyMode() -> AntigravityProxyMode {
        let raw = configuration?.value.antigravityProxyMode ?? "off"
        return AntigravityProxyMode(rawValue: raw) ?? .off
    }

    func currentProxyResolution() -> ProxyResolution {
        SystemProxyResolver.resolve(
            mode: effectiveProxyMode(),
            manualUrl: configuration?.value.antigravityProxyManualUrl ?? ""
        )
    }

    func currentRunningProxyState(resolution: ProxyResolution? = nil) -> RunningAntigravityProxyState {
        let resolved = resolution ?? currentProxyResolution()
        return SystemProxyResolver.inspectRunningAntigravity(expected: resolved, appPath: targetApplication.path)
    }

    func syncBackendProxyConfiguration() {
        guard let bridge else { return }
        let mode = effectiveProxyMode()
        let manualUrl = configuration?.value.antigravityProxyManualUrl ?? ""
        bridge.send([
            "command": "proxy_set",
            "mode": mode.rawValue,
            "manualUrl": manualUrl
        ]) { _ in }
    }

    func applyProxyConfiguration(mode: AntigravityProxyMode, manualUrl: String) throws {
        let trimmedManual = manualUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        let nextManualUrl: String
        switch mode {
        case .manual:
            switch SystemProxyResolver.normalizeManualProxyUrl(trimmedManual) {
            case .success(let normalized):
                nextManualUrl = normalized
            case .failure(let error):
                throw error
            }
        case .off, .system:
            if trimmedManual.isEmpty {
                nextManualUrl = configuration?.value.antigravityProxyManualUrl ?? ""
            } else {
                nextManualUrl = trimmedManual
            }
        }
        configuration?.value.antigravityProxyMode = mode.rawValue
        configuration?.value.antigravityProxyManualUrl = nextManualUrl
        try configuration?.save()
        syncBackendProxyConfiguration()
        updateViews()
    }

    @objc func safeRelaunchAntigravityForProxy() {
        safeRelaunchAntigravityForDebug()
    }

    private func currentAntigravityLaunchEnvironment() -> [String: String] {
        SystemProxyResolver.launchEnvironment(for: currentProxyResolution())
    }

    private func needsProxyRelaunch(resolution: ProxyResolution) -> Bool {
        guard case .active = resolution else { return false }
        switch currentRunningProxyState(resolution: resolution) {
        case .missing, .mismatch:
            return true
        case .notRunning, .matched, .overriddenByShell:
            return false
        }
    }

    static func devToolsActivePortFilePath() -> String {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Antigravity/DevToolsActivePort")
            .path
    }

    static func parseDevToolsActivePort(_ contents: String) -> UInt16? {
        guard let firstLine = contents.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).first else {
            return nil
        }
        let trimmed = firstLine.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let port = UInt16(trimmed), port > 0 else { return nil }
        return port
    }

    static func hasDebugPortArgument(
        inPsOutput psOutput: String,
        appPaths: [String] = DesktopApplicationTarget.allTargets.map(\.path)
    ) -> Bool {
        psOutput.split(separator: "\n").contains { line in
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            guard appPaths.contains(where: { trimmed.hasPrefix($0 + "/Contents/MacOS/") }) else {
                return false
            }
            return trimmed.range(
                of: #"(?:^|\s)--remote-debugging-port(?:=\d+|\s+\d+)(?=\s|$)"#,
                options: .regularExpression
            ) != nil
        }
    }

    private static func isLocalTcpPortListening(_ port: UInt16) -> Bool {
        let fd = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { _ = Darwin.close(fd) }

        let currentFlags = Darwin.fcntl(fd, F_GETFL, 0)
        if currentFlags >= 0 {
            _ = Darwin.fcntl(fd, F_SETFL, currentFlags | O_NONBLOCK)
        }

        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        guard Darwin.inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr) == 1 else { return false }

        let connectRes = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                Darwin.connect(fd, sockPtr, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        if connectRes == 0 { return true }
        guard errno == EINPROGRESS else { return false }

        var pfd = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
        let pollRes = Darwin.poll(&pfd, 1, 200)
        guard pollRes > 0, (pfd.revents & Int16(POLLOUT)) != 0 else { return false }

        var sockErr: Int32 = 0
        var errLen = socklen_t(MemoryLayout<Int32>.size)
        guard Darwin.getsockopt(fd, SOL_SOCKET, SO_ERROR, &sockErr, &errLen) == 0 else { return false }
        return sockErr == 0
    }

    static func hasLiveDevToolsPort(filePath: String = devToolsActivePortFilePath()) -> Bool {
        guard let contents = try? String(contentsOfFile: filePath, encoding: .utf8),
              let port = parseDevToolsActivePort(contents) else {
            return false
        }
        return isLocalTcpPortListening(port)
    }

    static func hasLiveAntigravityWithDebugPort(
        appPaths: [String] = DesktopApplicationTarget.allTargets.map(\.path)
    ) -> Bool {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/ps")
        task.arguments = ["-ax", "-ww", "-o", "args="]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = FileHandle.nullDevice
        do {
            defer { try? pipe.fileHandleForReading.close() }
            try task.run()
            let data = (try? pipe.fileHandleForReading.readToEnd()) ?? Data()
            task.waitUntilExit()
            let output = String(data: data, encoding: .utf8) ?? ""
            return hasDebugPortArgument(inPsOutput: output, appPaths: appPaths)
        } catch {
            return false
        }
    }

    #if NATIVE_UI_TEST
    func setSafeRelaunchTestingHooks(_ hooks: SafeRelaunchTestingHooks?) {
        let key = ObjectIdentifier(self)
        if let hooks {
            safeRelaunchTestingHooksById[key] = hooks
        } else {
            safeRelaunchTestingHooksById.removeValue(forKey: key)
        }
        safeRelaunchInFlightIds.remove(key)
    }
    #endif
    static func startupLaunchAction(
        launchAntigravityOnStart: Bool,
        loginLaunch: Bool,
        restartedAfterUpdate: Bool,
        launchedByAntigravity: Bool
    ) -> StartupLaunchAction {
        if loginLaunch || launchedByAntigravity {
            return .stayInMenuBar
        }
        if restartedAfterUpdate {
            return .showMainPanel
        }
        return launchAntigravityOnStart ? .launchAntigravityInBackground : .showMainPanel
    }

    static func parsePsPidPpidArgs(_ output: String) -> [ProcessTreeEntry] {
        var entries: [ProcessTreeEntry] = []
        for rawLine in output.split(separator: "\n") {
            let trimmed = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            var scanner = Substring(trimmed)
            guard let pidEnd = scanner.firstIndex(where: { $0 == " " || $0 == "\t" }) else { continue }
            guard let pid = Int32(scanner[..<pidEnd]) else { continue }
            scanner = scanner[pidEnd...].drop(while: { $0 == " " || $0 == "\t" })
            guard let ppidEnd = scanner.firstIndex(where: { $0 == " " || $0 == "\t" }) else { continue }
            guard let ppid = Int32(scanner[..<ppidEnd]) else { continue }
            let args = scanner[ppidEnd...].drop(while: { $0 == " " || $0 == "\t" })
            guard !args.isEmpty else { continue }
            entries.append(ProcessTreeEntry(pid: pid, ppid: ppid, args: String(args)))
        }
        return entries
    }

    private static func isChromiumHelperArgs(_ args: String) -> Bool {
        let chromiumTypes = [
            "--type=renderer",
            "--type=gpu-process",
            "--type=utility",
            "--type=zygote",
            "--type=broker",
            "--type=ppapi"
        ]
        return chromiumTypes.contains { args.contains($0) }
    }

    private static func isBlockingAntigravityArgs(
        _ args: String,
        appPaths: [String],
        includeLanguageServer: Bool
    ) -> Bool {
        let trimmed = args.trimmingCharacters(in: .whitespacesAndNewlines)
        return appPaths.contains { appPath in
            let lsPath = appPath + "/Contents/Resources/bin/language_server"
            let isLs = trimmed.hasPrefix(lsPath) || trimmed.contains(lsPath)
            if isLs {
                return includeLanguageServer
            }
            if includeLanguageServer {
                return trimmed.hasPrefix(appPath + "/Contents/")
            }
            guard trimmed.hasPrefix(appPath + "/Contents/") else { return false }
            if trimmed.contains("chrome_crashpad_handler") {
                return false
            }
            if trimmed.hasPrefix(appPath + "/Contents/Frameworks/") {
                return isChromiumHelperArgs(trimmed)
            }
            return true
        }
    }

    private static func languageServerTreeExcludedPids(
        entries: [ProcessTreeEntry],
        appPaths: [String]
    ) -> Set<Int32> {
        var childrenByParent: [Int32: [Int32]] = [:]
        var queue: [Int32] = []
        var excluded = Set<Int32>()
        for entry in entries {
            childrenByParent[entry.ppid, default: []].append(entry.pid)
            let isLs = appPaths.contains { appPath in
                let lsPath = appPath + "/Contents/Resources/bin/language_server"
                return entry.args.hasPrefix(lsPath) || entry.args.contains(lsPath)
            }
            if isLs && excluded.insert(entry.pid).inserted {
                queue.append(entry.pid)
            }
        }
        var cursor = 0
        while cursor < queue.count {
            let current = queue[cursor]
            cursor += 1
            for childPid in childrenByParent[current] ?? [] {
                if excluded.insert(childPid).inserted {
                    queue.append(childPid)
                }
            }
        }
        return excluded
    }

    static func hasRunningAntigravityProcess(
        psOutput: String,
        appPaths: [String],
        includeLanguageServer: Bool = true
    ) -> Bool {
        psOutput.split(separator: "\n").contains { line in
            isBlockingAntigravityArgs(
                String(line),
                appPaths: appPaths,
                includeLanguageServer: includeLanguageServer
            )
        }
    }

    static func hasRunningAntigravityProcess(
        psPidPpidArgsOutput: String,
        appPaths: [String],
        includeLanguageServer: Bool = true
    ) -> Bool {
        let entries = parsePsPidPpidArgs(psPidPpidArgsOutput)
        let excludedPids = includeLanguageServer
            ? Set<Int32>()
            : languageServerTreeExcludedPids(entries: entries, appPaths: appPaths)
        return entries.contains { entry in
            if !includeLanguageServer && excludedPids.contains(entry.pid) {
                return false
            }
            return isBlockingAntigravityArgs(
                entry.args,
                appPaths: appPaths,
                includeLanguageServer: includeLanguageServer
            )
        }
    }

    static func describeBlockingAntigravityProcesses(
        psPidPpidArgsOutput: String,
        appPaths: [String],
        includeLanguageServer: Bool = false
    ) -> [String] {
        let entries = parsePsPidPpidArgs(psPidPpidArgsOutput)
        let excludedPids = includeLanguageServer
            ? Set<Int32>()
            : languageServerTreeExcludedPids(entries: entries, appPaths: appPaths)
        var roles: [String] = []
        var seen = Set<String>()
        for entry in entries {
            if !includeLanguageServer && excludedPids.contains(entry.pid) { continue }
            guard isBlockingAntigravityArgs(entry.args, appPaths: appPaths, includeLanguageServer: includeLanguageServer) else {
                continue
            }
            let role: String
            if appPaths.contains(where: { entry.args.hasPrefix($0 + "/Contents/MacOS/") }) {
                role = "main"
            } else if entry.args.contains("--type=renderer") {
                role = "renderer"
            } else if entry.args.contains("--type=gpu-process") {
                role = "gpu-process"
            } else if entry.args.contains("--type=utility") {
                role = "utility"
            } else if entry.args.contains("/Contents/Resources/bin/language_server") {
                role = "language_server"
            } else {
                role = "helper"
            }
            if seen.insert(role).inserted {
                roles.append(role)
            }
        }
        return roles
    }

    static func hasLiveAntigravitySubprocesses(
        appPaths: [String] = DesktopApplicationTarget.allTargets.map(\.path),
        includeLanguageServer: Bool = true
    ) -> Bool {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/ps")
        task.arguments = ["-ax", "-ww", "-o", "pid=,ppid=,args="]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = FileHandle.nullDevice
        do {
            defer { try? pipe.fileHandleForReading.close() }
            try task.run()
            let data = (try? pipe.fileHandleForReading.readToEnd()) ?? Data()
            task.waitUntilExit()
            let output = String(data: data, encoding: .utf8) ?? ""
            return hasRunningAntigravityProcess(
                psPidPpidArgsOutput: output,
                appPaths: appPaths,
                includeLanguageServer: includeLanguageServer
            )
        } catch {
            return false
        }
    }

    private static func liveBlockingProcessRoles(
        appPaths: [String] = DesktopApplicationTarget.allTargets.map(\.path),
        includeLanguageServer: Bool = false
    ) -> [String] {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/ps")
        task.arguments = ["-ax", "-ww", "-o", "pid=,ppid=,args="]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = FileHandle.nullDevice
        do {
            defer { try? pipe.fileHandleForReading.close() }
            try task.run()
            let data = (try? pipe.fileHandleForReading.readToEnd()) ?? Data()
            task.waitUntilExit()
            let output = String(data: data, encoding: .utf8) ?? ""
            return describeBlockingAntigravityProcesses(
                psPidPpidArgsOutput: output,
                appPaths: appPaths,
                includeLanguageServer: includeLanguageServer
            )
        } catch {
            return []
        }
    }

    static func reopenLaunchAction(
        launchAntigravityOnStart: Bool,
        hasVisibleMainWindow: Bool,
        isAntigravityRunning: Bool
    ) -> ReopenLaunchAction {
        if launchAntigravityOnStart && !hasVisibleMainWindow && !isAntigravityRunning {
            return .launchAntigravityInBackground
        }
        return .showMainPanel
    }

    func quitAntigravityAndWait(completion: @escaping (Bool) -> Void) {
        suppressLifecycleAutoQuit(seconds: 30.0)
        let appPaths = DesktopApplicationTarget.allTargets.map(\.path)
        let queue = DispatchQueue(label: "local.gravitybox.quit-wait", qos: .userInitiated)
        let start = Date()
        var retriedTerminate = false

        func terminateRunningTargets() {
            let matchingApps = NSRunningApplication.runningApplications(withBundleIdentifier: DesktopApplicationTarget().bundleIdentifier)
                .filter { DesktopApplicationTarget.matchesAny($0) && !$0.isTerminated }
            for app in matchingApps { _ = app.terminate() }
        }

        func hasAntigravityProcesses() -> Bool {
            Self.hasLiveAntigravitySubprocesses(appPaths: appPaths)
        }

        func finish(_ exited: Bool) {
            DispatchQueue.main.async { [weak self] in
                self?.suppressLifecycleAutoQuit(seconds: 20.0)
                completion(exited)
            }
        }

        func pollStep() {
            let stillRegistered = DesktopApplicationTarget.isRegisteredRunning()
            let stillRunning = stillRegistered || hasAntigravityProcesses()
            if !stillRunning {
                // Allow LaunchServices / runningboardd to finish unregistering the terminated app job before relaunch.
                queue.asyncAfter(deadline: .now() + .milliseconds(300)) { finish(true) }
                return
            }
            let elapsed = Date().timeIntervalSince(start)
            if elapsed >= 20.0 {
                finish(false)
                return
            }
            if !retriedTerminate && elapsed >= 2.0 {
                retriedTerminate = true
                DispatchQueue.main.async { terminateRunningTargets() }
            }
            queue.asyncAfter(deadline: .now() + .milliseconds(150)) { pollStep() }
        }

        DispatchQueue.main.async { terminateRunningTargets() }
        queue.asyncAfter(deadline: .now() + .milliseconds(50)) { pollStep() }
    }

    func effectiveConfiguredLanguage() -> String {
        if let pendingLanguageTarget { return pendingLanguageTarget }
        if let configured = configuration?.value.appLanguage?.trimmingCharacters(in: .whitespacesAndNewlines),
           !configured.isEmpty {
            return configured
        }
        return L10n.shared.configuredLanguage
    }

    func setGlobalLanguage(_ configured: String) {
        let trimmed = configured.trimmingCharacters(in: .whitespacesAndNewlines)
        let targetLanguage = trimmed.isEmpty ? "system" : trimmed
        let previousConfigured = effectiveConfiguredLanguage()
        let previousStatus = statusValue
        let previousLocale = bridge?.preferredLocale

        languageCommandGeneration += 1
        let commandGen = languageCommandGeneration
        pendingLanguageTarget = targetLanguage
        configuration.value.appLanguage = targetLanguage
        try? configuration.save()
        bridge?.preferredLocale = targetLanguage

        let resolved = L10n.shared.setLanguage(targetLanguage, notify: true)
        let wantsTranslation = resolved != "en"
        statusValue.configuredLanguage = targetLanguage
        statusValue.locale = resolved
        statusValue.translationEnabled = wantsTranslation
        if statusValue.mode == "debug-port-missing" {
            if !wantsTranslation && !effectiveHudEnabled() {
                statusValue.mode = "paused"
            }
        } else if wantsTranslation {
            if statusValue.mode == "paused" || statusValue.mode == "error" || statusValue.mode == "starting" {
                statusValue.mode = "waiting"
            }
        } else {
            statusValue.mode = "paused"
        }
        applyLocalizedChrome()

        let sendCommand = { [weak self] in
            guard let self, commandGen == self.languageCommandGeneration else { return }
            self.bridge.send([
                "command": "language_set",
                "language": targetLanguage,
                "systemLocales": Locale.preferredLanguages
            ]) { [weak self] result in
                DispatchQueue.main.async {
                    guard let self, commandGen == self.languageCommandGeneration else { return }
                    self.pendingLanguageTarget = nil
                    switch result {
                    case .success(let value):
                        if let raw = value["status"] as? [String: Any] {
                            self.reachable = true
                            self.recoveryAttempts = 0
                            self.statusValue = self.mergeStatusSnapshot(raw, previous: self.statusValue)
                            self.updateViews()
                        }
                        self.refresh()
                    case .failure(let error):
                        self.configuration.value.appLanguage = previousConfigured
                        try? self.configuration.save()
                        self.bridge?.preferredLocale = previousLocale
                        _ = L10n.shared.setLanguage(previousConfigured, notify: true)
                        self.statusValue = previousStatus
                        self.applyLocalizedChrome()
                        self.showMessage(error.localizedDescription, error: true)
                        self.refresh()
                    }
                }
            }
        }
        if !reachable && !bridge.isOwnedProcessRunning {
            recoveryAttempts = 0
            nextRecoveryAt = .distantPast
            bridge.launch { _ in sendCommand() }
        } else {
            sendCommand()
        }
    }

    @objc func selectGlobalLanguageFromMenu(_ sender: NSMenuItem) {
        guard let code = sender.representedObject as? String else { return }
        setGlobalLanguage(code)
    }

    func effectiveHudEnabled() -> Bool {
        if let pending = pendingHudTarget { return pending }
        if let live = statusValue.hudEnabled { return live }
        return configuration?.value.hudEnabled ?? true
    }
    func setHudEnabled(_ enable: Bool) {
        let previousStatus = statusValue
        let previousConfig = configuration.value.hudEnabled
        hudCommandGeneration += 1
        let commandGen = hudCommandGeneration
        pendingHudTarget = enable
        statusValue.hudEnabled = enable
        configuration.value.hudEnabled = enable
        try? configuration.save()
        updateViews()
        bridge.send(["command": "hud_set", "enabled": enable]) { [weak self] result in
            DispatchQueue.main.async {
                guard let self, commandGen == self.hudCommandGeneration else { return }
                self.pendingHudTarget = nil
                switch result {
                case .success(let value):
                    if let raw = value["status"] as? [String: Any] {
                        self.reachable = true
                        self.recoveryAttempts = 0
                        self.statusValue = self.mergeStatusSnapshot(raw, previous: self.statusValue)
                    }
                    self.updateViews()
                case .failure(let error):
                    self.statusValue.hudEnabled = previousStatus.hudEnabled
                    self.configuration.value.hudEnabled = previousConfig
                    try? self.configuration.save()
                    self.updateViews()
                    self.showMessage(error.localizedDescription, error: true)
                }
            }
        }
    }
    @objc func toggleHud() {
        setHudEnabled(!effectiveHudEnabled())
    }
    var isSafeRelaunchInFlight: Bool {
        safeRelaunchInFlightIds.contains(ObjectIdentifier(self))
    }

    @objc func handleAppIconReopen() {
        let hasVisibleMainWindow = window?.isVisible == true && window?.isMiniaturized != true
        let action = Self.reopenLaunchAction(
            launchAntigravityOnStart: configuration?.value.launchAntigravityOnStart == true,
            hasVisibleMainWindow: hasVisibleMainWindow,
            isAntigravityRunning: Self.isAntigravityRunning()
        )
        switch action {
        case .launchAntigravityInBackground:
            launchAntigravityDirectly()
        case .showMainPanel:
            showPanel()
        }
    }

    func launchAntigravityDirectly() {
        #if NATIVE_UI_TEST
        openedApplications += 1
        #else
        suppressLifecycleAutoQuit(seconds: 30.0)
        let launchPath = DesktopApplicationTarget.preferredLaunchPath(fallbackChannel: Self.applicationChannel)
        let config = Self.makeOpenConfiguration(environment: currentAntigravityLaunchEnvironment())
        NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: launchPath), configuration: config) { [weak self] _, error in
            if let error {
                DispatchQueue.main.async { self?.showMessage(error.localizedDescription, error: true) }
            }
        }
        #endif
    }

    @objc func openAntigravity() {
        let proxyResolution = currentProxyResolution()
        #if NATIVE_UI_TEST
        let key = ObjectIdentifier(self)
        let running = safeRelaunchTestingHooksById[key]?.isRunning?() ?? true
        if running && (statusValue.mode == "debug-port-missing" || needsProxyRelaunch(resolution: proxyResolution)) {
            safeRelaunchAntigravityForDebug()
            return
        }
        launchAntigravityDirectly()
        #else
        let running = Self.isAntigravityRunning()
        guard running else {
            launchAntigravityDirectly()
            return
        }
        let key = ObjectIdentifier(self)
        guard !openAntigravityProbeInFlightIds.contains(key) else { return }
        openAntigravityProbeInFlightIds.insert(key)
        let wantsTranslation = statusValue.translationEnabled ?? (effectiveConfiguredLanguage() != "en")
        let wantsConnection = effectiveHudEnabled() || wantsTranslation
        let isDebugPortMissingMode = statusValue.mode == "debug-port-missing"
        let appPath = targetApplication.path
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let needsDebugPortRelaunch: Bool
            if isDebugPortMissingMode {
                needsDebugPortRelaunch = true
            } else if wantsConnection {
                needsDebugPortRelaunch = !(Self.hasLiveDevToolsPort() || Self.hasLiveAntigravityWithDebugPort())
            } else {
                needsDebugPortRelaunch = false
            }
            let needsProxy: Bool
            if needsDebugPortRelaunch {
                needsProxy = false
            } else if case .active = proxyResolution {
                switch SystemProxyResolver.inspectRunningAntigravity(expected: proxyResolution, appPath: appPath) {
                case .missing, .mismatch:
                    needsProxy = true
                case .notRunning, .matched, .overriddenByShell:
                    needsProxy = false
                }
            } else {
                needsProxy = false
            }
            DispatchQueue.main.async {
                openAntigravityProbeInFlightIds.remove(key)
                guard let self, !self.quitting else { return }
                if Self.isAntigravityRunning() && (needsDebugPortRelaunch || needsProxy) {
                    self.safeRelaunchAntigravityForDebug()
                } else {
                    self.launchAntigravityDirectly()
                }
            }
        }
        #endif
    }

    @objc func safeRelaunchAntigravityForDebug() {
        let key = ObjectIdentifier(self)
        guard !safeRelaunchInFlightIds.contains(key) else { return }
        safeRelaunchInFlightIds.insert(key)
        updateViews()

        #if NATIVE_UI_TEST
        guard safeRelaunchTestingHooksById[key] != nil else {
            safeRelaunchInFlightIds.remove(key)
            updateViews()
            return
        }
        performSafeRelaunchAfterConfirm(key: key)
        #else
        if statusValue.sshWindowsCount > 0 {
            let hostsSummary = statusValue.activeSshHosts.isEmpty
                ? "SSH"
                : statusValue.activeSshHosts.joined(separator: L10n.shared.isEnglish ? ", " : "、")
            let alert = NSAlert()
            alert.alertStyle = .warning
            alert.messageText = L10n.t("ssh.relaunch.confirm_title", fallback: "确认安全重启 Antigravity？")
            alert.informativeText = L10n.t("ssh.relaunch.active_windows_warning", ["count": statusValue.sshWindowsCount, "hosts": hostsSummary])
            alert.addButton(withTitle: L10n.t("ssh.relaunch.confirm_btn", fallback: "继续安全重启"))
            alert.addButton(withTitle: L10n.t("common.cancel"))
            presentSheetAlert(alert) { [weak self] resp in
                guard resp == .alertFirstButtonReturn else {
                    safeRelaunchInFlightIds.remove(key)
                    self?.updateViews()
                    return
                }
                self?.performSafeRelaunchAfterConfirm(key: key)
            }
            return
        }
        performSafeRelaunchAfterConfirm(key: key)
        #endif
    }

    private func performSafeRelaunchAfterConfirm(key: ObjectIdentifier) {
        suppressLifecycleAutoQuit(seconds: 30.0)

        let terminateTargets: (Bool) -> Void = { activateFirst in
            #if NATIVE_UI_TEST
            if let hook = safeRelaunchTestingHooksById[key]?.terminate {
                hook()
                return
            }
            #endif
            let matchingApps = NSRunningApplication.runningApplications(withBundleIdentifier: DesktopApplicationTarget().bundleIdentifier)
                .filter { DesktopApplicationTarget.matchesAny($0) && !$0.isTerminated }
            for app in matchingApps {
                if activateFirst {
                    _ = app.activate(options: [])
                }
                _ = app.terminate()
            }
        }

        let start = Date()
        terminateTargets(false)

        #if NATIVE_UI_TEST
        let hooks = safeRelaunchTestingHooksById[key]
        let maxWaitSeconds = hooks?.timeoutSeconds ?? 15.0
        let pollIntervalMs = hooks?.pollIntervalMilliseconds ?? 150
        let settleDelayMs = 20

        func isStillRunningForTest() -> Bool {
            let currentHooks = safeRelaunchTestingHooksById[key]
            let mainRunning = currentHooks?.isRunning?() ?? Self.isAntigravityRunning()
            let subRunning = currentHooks?.hasSubprocesses?() ?? false
            return mainRunning || subRunning
        }

        func pollStepTest() {
            if !isStillRunningForTest() {
                DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(settleDelayMs)) { [weak self] in
                    guard let self else {
                        safeRelaunchInFlightIds.remove(key)
                        return
                    }
                    self.suppressLifecycleAutoQuit(seconds: 20.0)
                    self.relaunchAntigravityForSafeDebug(
                        attemptsRemaining: 3,
                        attemptNumber: 1,
                        key: key
                    )
                }
                return
            }
            if Date().timeIntervalSince(start) >= maxWaitSeconds {
                safeRelaunchInFlightIds.remove(key)
                updateViews()
                showMessage(
                    L10n.t("assistant.safe_relaunch_timeout", fallback: "Antigravity 在 15 秒内未能退出，未强制关闭。请先保存工作并手动退出 Antigravity，再通过「打开 Antigravity」重新启动。"),
                    error: true
                )
                refresh()
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(pollIntervalMs)) { [weak self] in
                guard self != nil else {
                    safeRelaunchInFlightIds.remove(key)
                    return
                }
                pollStepTest()
            }
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(min(50, pollIntervalMs))) { [weak self] in
            guard self != nil else {
                safeRelaunchInFlightIds.remove(key)
                return
            }
            pollStepTest()
        }
        #else
        let appPaths = DesktopApplicationTarget.allTargets.map(\.path)
        let queue = DispatchQueue(label: "local.gravitybox.safe-relaunch", qos: .userInitiated)
        let maxWaitSeconds: TimeInterval = 15.0
        let pollIntervalMs = 150
        let settleDelayMs = 300
        var retriedTerminate = false

        func pollStep() {
            // Safe relaunch only resets the Electron UI shell for --remote-debugging-port; ignore detached language_server / sidecar_sdk trees.
            let registeredRunning = DesktopApplicationTarget.isRegisteredRunning()
            let stillRunning = registeredRunning
                || Self.hasLiveAntigravitySubprocesses(appPaths: appPaths, includeLanguageServer: false)
            if !stillRunning {
                queue.asyncAfter(deadline: .now() + .milliseconds(settleDelayMs)) { [weak self] in
                    DispatchQueue.main.async {
                        guard let self else {
                            safeRelaunchInFlightIds.remove(key)
                            return
                        }
                        self.suppressLifecycleAutoQuit(seconds: 20.0)
                        self.relaunchAntigravityForSafeDebug(
                            attemptsRemaining: 3,
                            attemptNumber: 1,
                            key: key
                        )
                    }
                }
                return
            }
            let elapsed = Date().timeIntervalSince(start)
            if elapsed >= maxWaitSeconds {
                let roles = Self.liveBlockingProcessRoles(appPaths: appPaths, includeLanguageServer: false)
                let roleSummary = roles.isEmpty ? (registeredRunning ? "registered-app" : "unknown") : roles.joined(separator: ",")
                lifecycleLogger.warning("安全重启等待 Antigravity 退出超时 (15s)，未强制关闭；阻塞进程角色: \(roleSummary, privacy: .public)")
                DispatchQueue.main.async { [weak self] in
                    safeRelaunchInFlightIds.remove(key)
                    guard let self else { return }
                    self.updateViews()
                    self.showMessage(
                        L10n.t("assistant.safe_relaunch_timeout", fallback: "Antigravity 在 15 秒内未能退出，未强制关闭。请先保存工作并手动退出 Antigravity，再通过「打开 Antigravity」重新启动。"),
                        error: true
                    )
                    self.refresh()
                }
                return
            }
            if !retriedTerminate && elapsed >= 2.0 && registeredRunning {
                retriedTerminate = true
                DispatchQueue.main.async {
                    terminateTargets(true)
                }
            }
            queue.asyncAfter(deadline: .now() + .milliseconds(pollIntervalMs)) { [weak self] in
                guard self != nil else {
                    DispatchQueue.main.async { safeRelaunchInFlightIds.remove(key) }
                    return
                }
                pollStep()
            }
        }

        queue.asyncAfter(deadline: .now() + .milliseconds(50)) { [weak self] in
            guard self != nil else {
                DispatchQueue.main.async { safeRelaunchInFlightIds.remove(key) }
                return
            }
            pollStep()
        }
        #endif
    }

    private func relaunchAntigravityForSafeDebug(
        attemptsRemaining: Int = 3,
        attemptNumber: Int = 1,
        key: ObjectIdentifier
    ) {
        #if NATIVE_UI_TEST
        let hooks = safeRelaunchTestingHooksById[key]
        let retryDelayMs = hooks?.relaunchRetryDelayMilliseconds ?? 20
        if let attemptHook = hooks?.relaunchAttempt {
            attemptHook(attemptNumber) { [weak self] launched in
                DispatchQueue.main.async {
                    guard let self else {
                        safeRelaunchInFlightIds.remove(key)
                        return
                    }
                    if launched {
                        safeRelaunchInFlightIds.remove(key)
                        self.openedApplications += 1
                        self.updateViews()
                        self.refresh()
                    } else if attemptsRemaining > 1 {
                        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(retryDelayMs)) { [weak self] in
                            guard let self else {
                                safeRelaunchInFlightIds.remove(key)
                                return
                            }
                            self.relaunchAntigravityForSafeDebug(
                                attemptsRemaining: attemptsRemaining - 1,
                                attemptNumber: attemptNumber + 1,
                                key: key
                            )
                        }
                    } else {
                        safeRelaunchInFlightIds.remove(key)
                        self.updateViews()
                        self.showMessage(
                            L10n.t("assistant.safe_relaunch_failed", ["detail": L10n.t("assistant.relaunch_manual")]),
                            error: true
                        )
                        self.refresh()
                    }
                }
            }
            return
        }
        safeRelaunchInFlightIds.remove(key)
        launchAntigravityDirectly()
        updateViews()
        refresh()
        return
        #else
        suppressLifecycleAutoQuit(seconds: 30.0)
        let launchPath = DesktopApplicationTarget.preferredLaunchPath(fallbackChannel: Self.applicationChannel)
        let launchEnv = currentAntigravityLaunchEnvironment()
        if attemptsRemaining <= 1 {
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                let proc = Process()
                proc.executableURL = URL(fileURLWithPath: "/usr/bin/open")
                proc.arguments = Self.makeOpenCommandArguments(launchPath: launchPath, environment: launchEnv)
                proc.standardOutput = FileHandle.nullDevice
                proc.standardError = FileHandle.nullDevice
                let launchError: Error? = {
                    do {
                        try proc.run()
                        proc.waitUntilExit()
                        return proc.terminationStatus == 0 ? nil : BackendFailure(message: "open exited with \(proc.terminationStatus)")
                    } catch {
                        return error
                    }
                }()
                let result = Self.waitForDebugReadyLaunch(maxWaitSeconds: 6.0)
                guard let self else {
                    DispatchQueue.main.async { safeRelaunchInFlightIds.remove(key) }
                    return
                }
                self.handleSafeDebugLaunchVerification(
                    result: result,
                    launchError: launchError,
                    attemptsRemaining: attemptsRemaining,
                    attemptNumber: attemptNumber,
                    key: key
                )
            }
            return
        }

        let config = Self.makeOpenConfiguration(environment: launchEnv)
        NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: launchPath), configuration: config) { [weak self] _, openError in
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                let result = Self.waitForDebugReadyLaunch(maxWaitSeconds: 5.0)
                guard let self else {
                    DispatchQueue.main.async { safeRelaunchInFlightIds.remove(key) }
                    return
                }
                self.handleSafeDebugLaunchVerification(
                    result: result,
                    launchError: openError,
                    attemptsRemaining: attemptsRemaining,
                    attemptNumber: attemptNumber,
                    key: key
                )
            }
        }
        #endif
    }

    #if !NATIVE_UI_TEST
    private static func waitForDebugReadyLaunch(maxWaitSeconds: TimeInterval = 5.0) -> (running: Bool, debugReady: Bool) {
        let deadline = Date().addingTimeInterval(maxWaitSeconds)
        while Date() < deadline {
            let running = isAntigravityRunning()
            let debugReady = running && (hasLiveDevToolsPort() || hasLiveAntigravityWithDebugPort())
            if debugReady {
                return (true, true)
            }
            Thread.sleep(forTimeInterval: 0.25)
        }
        let running = isAntigravityRunning()
        let debugReady = running && (hasLiveDevToolsPort() || hasLiveAntigravityWithDebugPort())
        return (running, debugReady)
    }

    private func handleSafeDebugLaunchVerification(
        result: (running: Bool, debugReady: Bool),
        launchError: Error?,
        attemptsRemaining: Int,
        attemptNumber: Int,
        key: ObjectIdentifier
    ) {
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                safeRelaunchInFlightIds.remove(key)
                return
            }
            if result.debugReady {
                safeRelaunchInFlightIds.remove(key)
                self.updateViews()
                self.refresh()
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
                    self?.refresh()
                }
                return
            }
            if !result.running && attemptsRemaining > 1 {
                self.relaunchAntigravityForSafeDebug(
                    attemptsRemaining: attemptsRemaining - 1,
                    attemptNumber: attemptNumber + 1,
                    key: key
                )
                return
            }
            safeRelaunchInFlightIds.remove(key)
            self.updateViews()
            let detail = launchError?.localizedDescription ?? L10n.t("assistant.relaunch_manual")
            self.showMessage(L10n.t("assistant.safe_relaunch_failed", ["detail": detail]), error: true)
            self.refresh()
        }
    }
    #endif

    func relaunchAntigravityAfterSwitch(attemptsRemaining: Int = 3) {
        #if NATIVE_UI_TEST
        openedApplications += 1
        return
        #else
        suppressLifecycleAutoQuit(seconds: 30.0)
        let launchPath = DesktopApplicationTarget.preferredLaunchPath(fallbackChannel: Self.applicationChannel)
        let launchEnv = currentAntigravityLaunchEnvironment()
        if attemptsRemaining <= 1 {
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                let proc = Process()
                proc.executableURL = URL(fileURLWithPath: "/usr/bin/open")
                proc.arguments = Self.makeOpenCommandArguments(launchPath: launchPath, environment: launchEnv)
                proc.standardOutput = FileHandle.nullDevice
                proc.standardError = FileHandle.nullDevice
                let launchError: Error? = {
                    do {
                        try proc.run()
                        proc.waitUntilExit()
                        return proc.terminationStatus == 0 ? nil : BackendFailure(message: "open exited with \(proc.terminationStatus)")
                    } catch {
                        return error
                    }
                }()
                DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 1.2) { [weak self] in
                    guard let self else { return }
                    let running = Self.isAntigravityRunning()
                    if !running {
                        DispatchQueue.main.async {
                            let detail = launchError?.localizedDescription ?? L10n.t("assistant.relaunch_manual")
                            self.showMessage(L10n.t("assistant.relaunch_failed", ["detail": detail]), error: true)
                        }
                    }
                }
            }
            return
        }

        let config = Self.makeOpenConfiguration(environment: launchEnv)
        NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: launchPath), configuration: config) { [weak self] app, error in
            guard let self else { return }
            DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 1.2) { [weak self] in
                guard let self else { return }
                let running = Self.isAntigravityRunning() || (app != nil && app?.isTerminated == false)
                if running {
                    return
                }
                if attemptsRemaining > 1 {
                    DispatchQueue.main.async {
                        self.relaunchAntigravityAfterSwitch(attemptsRemaining: attemptsRemaining - 1)
                    }
                } else if let error {
                    DispatchQueue.main.async {
                        self.showMessage(L10n.t("assistant.relaunch_failed", ["detail": error.localizedDescription]), error: true)
                    }
                }
            }
        }
        #endif
    }
    static var antigravityBundlePath: String { DesktopApplicationTarget.preferredLaunchPath(fallbackChannel: applicationChannel) }
    static let lifecycleAgentLabel = "local.gravitybox.lifecycle"

    static func isAntigravityApp(_ app: NSRunningApplication) -> Bool {
        DesktopApplicationTarget.matchesAny(app)
    }

    static func isAntigravityRunning() -> Bool {
        DesktopApplicationTarget.isRegisteredRunning()
    }

    func cleanupLegacyLifecycleAgent() {
        #if !NATIVE_UI_TEST
        DispatchQueue.global(qos: .utility).async {
            AntigravityLifecycleAgent.cleanupPlistAndBootout()
        }
        #endif
    }

    func scheduleSelfHealingRestart(reason: String) {
        guard !quitting, !bridge.isRestarting, !selfHealingPending else { return }
        let now = Date()
        if now.timeIntervalSince(lastAutoRestartAt) > 60.0 {
            autoRestartAttempts = 0
        }
        guard autoRestartAttempts < 3 else {
            lifecycleLogger.error("后台子进程短时间内连续异常退出 3 次，停止自动拉起并保留报错: \(reason, privacy: .private)")
            return
        }
        autoRestartAttempts += 1
        lastAutoRestartAt = now
        selfHealingPending = true
        let attempt = autoRestartAttempts
        lifecycleLogger.warning("后台子进程异常退出 (\(reason, privacy: .private))，将在 1 秒后尝试自动自愈重启 (第 \(attempt, privacy: .public)/3 次)...")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            guard let self else { return }
            self.selfHealingPending = false
            guard !self.quitting, !self.reachable, !self.bridge.isOwnedProcessRunning else { return }
            self.bridge.launch { [weak self] result in
                guard let self else { return }
                switch result {
                case .success:
                    lifecycleLogger.info("后台子进程自愈重启成功，重新同步状态与用量。")
                    self.syncBackendProxyConfiguration()
                    self.refresh()
                    if self.contentVisible && self.currentPage == 2 {
                        self.usagePage?.fetch()
                    }
                    if self.isMenuPanelShown, let panel = self.menuPanelController {
                        let periodKey = MenuPanelController.periods[max(0, min(MenuPanelController.periods.count - 1, panel.selectedPeriod))]
                        self.fetchUsageSummary(period: periodKey, environmentId: panel.selectedEnvironmentId, force: true, allowCached: false)
                    }
                case .failure(let error):
                    lifecycleLogger.error("后台子进程自愈重启失败: \(error.localizedDescription, privacy: .private)")
                }
            }
        }
    }
    func syncUpdatePromptControls() {
        aboutPage?.refreshUpdateState()
        if let release = updateManager.availableRelease {
            installUpdateButton?.badgeText = "v\(release.version)"
            installUpdateButton?.toolTip = nil
            installUpdateButton?.isHidden = false
        } else {
            installUpdateButton?.badgeText = ""
            installUpdateButton?.toolTip = nil
            installUpdateButton?.isHidden = true
        }
    }

    @objc func installUpdateFromSidebar() {
        guard let release = updateManager.availableRelease else {
            checkForUpdatesFromMenu()
            return
        }
        if window?.activeSheetWindow != nil {
            dismissAllSheetsAndPopovers()
        }
        showAbout()
        updateManager.installRelease(release)
    }
    func configureAutoUpdateTimer() {
        autoUpdateTimer?.invalidate()
        autoUpdateTimer = nil
        #if !NATIVE_UI_TEST
        guard configuration?.value.autoUpdateEnabled == true else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
            guard let self, !self.quitting, self.configuration?.value.autoUpdateEnabled == true else { return }
            self.updateManager.checkForUpdates(silent: true)
        }
        let t = Timer(timeInterval: 6 * 3600.0, repeats: true) { [weak self] _ in
            guard let self, !self.quitting, self.configuration?.value.autoUpdateEnabled == true else { return }
            self.updateManager.checkForUpdates(silent: true)
        }
        t.tolerance = 300.0
        RunLoop.main.add(t, forMode: .common)
        autoUpdateTimer = t
        #endif
    }
    func suppressLifecycleAutoQuit(seconds: TimeInterval) {
        let candidate = Date().addingTimeInterval(seconds)
        if candidate > suppressLifecycleAutoQuitUntil {
            suppressLifecycleAutoQuitUntil = candidate
        }
    }
    @objc func checkForUpdatesFromMenu() {
        if window?.activeSheetWindow != nil {
            dismissAllSheetsAndPopovers()
        }
        showAbout()
        updateManager.checkForUpdates(silent: false)
    }
    @objc func quit() {
        performQuit()
    }

    func dismissAllSheetsAndPopovers() {
        cachePage?.dismissDetailPopover()
        closeMenuPopover()
        guard let window else { return }
        var safetyCounter = 0
        while let rootSheet = window.activeSheetWindow, safetyCounter < 8 {
            safetyCounter += 1
            var leaf = rootSheet
            var depth = 0
            while let child = leaf.activeSheetWindow, depth < 8 {
                leaf = child
                depth += 1
            }
            let parent = leaf.sheetParent ?? window
            parent.endSheet(leaf)
            leaf.orderOut(nil)
        }
    }

    func quitForUpdate() {
        quitting = true
        suppressLifecycleAutoQuit(seconds: 60)
        timer?.invalidate(); timer = nil
        quotaRefreshTimer?.invalidate(); quotaRefreshTimer = nil
        quotaRefreshPollTimer?.invalidate(); quotaRefreshPollTimer = nil
        autoUpdateTimer?.invalidate(); autoUpdateTimer = nil
        removeQuotaScheduleObservers()
        if configSaveWorkItem != nil {
            configSaveWorkItem?.cancel()
            configSaveWorkItem = nil
            try? configuration?.save()
        }
        dismissAllSheetsAndPopovers()
        window?.orderOut(nil)
        #if NATIVE_UI_TEST
        return
        #else
        bridge.forceStop(timeout: 2.0) { [weak self] in
            self?.directorySource?.cancel()
            self?.directorySource = nil
            NSApp.terminate(nil)
            DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 0.35) {
                Darwin._exit(0)
            }
        }
        #endif
    }

    private func performQuit() {
        guard !quitting else { return }
        stopBackendAndQuit()
    }
    private func stopBackendAndQuit() {
        guard !quitting else { return }; quitting = true
        timer?.invalidate(); quotaRefreshTimer?.invalidate(); quotaRefreshPollTimer?.invalidate(); autoUpdateTimer?.invalidate()
        removeQuotaScheduleObservers()
        if configSaveWorkItem != nil {
            configSaveWorkItem?.cancel()
            configSaveWorkItem = nil
            try? configuration?.save()
        }
        dismissAllSheetsAndPopovers()
        bridge.send(["command":"stop"]) { [weak self] result in
            guard let self else { return }
            if case .success = result { self.directorySource?.cancel(); NSApp.terminate(nil) }
            else if !self.bridge.isOwnedProcessRunning { self.directorySource?.cancel(); NSApp.terminate(nil) }
            else { self.quitting = false; self.installQuotaScheduleObservers(); self.configureRefreshTimer(); self.configureQuotaRefreshTimer(); self.configureAutoUpdateTimer(); self.showPanel(); self.showMessage(L10n.t("assistant.quit_pending_restore"), error:true) }
        }
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply { if quitting { return .terminateNow }; quit(); return .terminateCancel }
}

#if !NATIVE_UI_TEST
enum AntigravityLifecycleAgent {
    static func cleanupPlistAndBootout() {
        let fm = FileManager.default
        let plistURL = fm.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(Assistant.lifecycleAgentLabel).plist")
        let hadPlist = fm.fileExists(atPath: plistURL.path)
        let uid = getuid()
        func runLaunchctl(_ args: [String]) {
            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
            task.arguments = args
            task.standardOutput = FileHandle.nullDevice
            task.standardError = FileHandle.nullDevice
            try? task.run()
            task.waitUntilExit()
        }
        if hadPlist {
            runLaunchctl(["bootout", "gui/\(uid)", plistURL.path])
            try? fm.removeItem(at: plistURL)
        }
        runLaunchctl(["bootout", "gui/\(uid)/\(Assistant.lifecycleAgentLabel)"])
    }

    static func run() -> Never {
        cleanupPlistAndBootout()
        exit(0)
    }
}
#endif
