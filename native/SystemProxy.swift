import Cocoa
import CFNetwork
import Darwin

enum AntigravityProxyMode: String, CaseIterable, Codable {
    case off
    case system
    case manual
}

enum UnsupportedSystemProxyKind: Equatable {
    case pac(String)
    case socksOnly(String)
}

struct SystemProxySnapshot: Equatable {
    let httpUrl: String?
    let httpsUrl: String?
    let socksUrl: String?
    let pacUrl: String?
    let exceptions: [String]

    init(
        httpUrl: String? = nil,
        httpsUrl: String? = nil,
        socksUrl: String? = nil,
        pacUrl: String? = nil,
        exceptions: [String] = []
    ) {
        self.httpUrl = httpUrl
        self.httpsUrl = httpsUrl
        self.socksUrl = socksUrl
        self.pacUrl = pacUrl
        self.exceptions = exceptions
    }
}

enum ProxyResolution: Equatable {
    case disabled
    case active(httpUrl: String, httpsUrl: String, noProxy: String, displayUrl: String)
    case systemNotConfigured
    case systemUnsupported(UnsupportedSystemProxyKind)
    case invalidManual(String)
}

enum RunningAntigravityProxyState: Equatable {
    case notRunning
    case matched(activeUrl: String)
    case missing
    case mismatch(actualUrl: String, expectedUrl: String)
    case overriddenByShell(lsActualUrl: String, appInjectedUrl: String, expectedUrl: String)
}

enum SystemProxyResolver {
    static var testSystemProxySettingsOverride: [String: Any]? = nil
    static var testRunningProxyStateOverride: RunningAntigravityProxyState? = nil

    private static let mandatoryNoProxyEntries = ["127.0.0.1", "localhost", "::1"]

    static func readSystemProxySnapshot(rawSettings: [String: Any]? = nil) -> SystemProxySnapshot {
        let settings: [String: Any]
        if let rawSettings {
            settings = rawSettings
        } else if let override = testSystemProxySettingsOverride {
            settings = override
        } else {
            settings = (CFNetworkCopySystemProxySettings()?.takeRetainedValue() as? [String: Any]) ?? [:]
        }

        let httpUrl: String? = {
            guard isEnabled(settings[kCFNetworkProxiesHTTPEnable as String]) else { return nil }
            return formatProxyEndpoint(
                rawHost: settings[kCFNetworkProxiesHTTPProxy as String] as? String,
                rawPort: settings[kCFNetworkProxiesHTTPPort as String],
                defaultScheme: "http",
                requirePort: true
            )
        }()

        let httpsUrl: String? = {
            guard isEnabled(settings[kCFNetworkProxiesHTTPSEnable as String]) else { return nil }
            return formatProxyEndpoint(
                rawHost: settings[kCFNetworkProxiesHTTPSProxy as String] as? String,
                rawPort: settings[kCFNetworkProxiesHTTPSPort as String],
                defaultScheme: "http",
                requirePort: true
            )
        }()

        let socksUrl: String? = {
            guard isEnabled(settings[kCFNetworkProxiesSOCKSEnable as String]) else { return nil }
            return formatProxyEndpoint(
                rawHost: settings[kCFNetworkProxiesSOCKSProxy as String] as? String,
                rawPort: settings[kCFNetworkProxiesSOCKSPort as String],
                defaultScheme: "socks5",
                requirePort: false
            )
        }()

        let pacUrl: String? = {
            guard isEnabled(settings[kCFNetworkProxiesProxyAutoConfigEnable as String]) else { return nil }
            let raw = (settings[kCFNetworkProxiesProxyAutoConfigURLString as String] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return raw.isEmpty ? nil : raw
        }()

        let exceptions: [String] = {
            guard let rawList = settings[kCFNetworkProxiesExceptionsList as String] as? [Any] else { return [] }
            return rawList.compactMap { item in
                let trimmed = (item as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                return trimmed.isEmpty ? nil : trimmed
            }
        }()

        return SystemProxySnapshot(
            httpUrl: httpUrl,
            httpsUrl: httpsUrl,
            socksUrl: socksUrl,
            pacUrl: pacUrl,
            exceptions: exceptions
        )
    }

    static func normalizeManualProxyUrl(_ raw: String) -> Result<String, BackendFailure> {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return .failure(BackendFailure(
                message: L10n.t("proxy.error.empty_url", fallback: "请输入代理地址，例如 http://127.0.0.1:7890")
            ))
        }
        guard trimmed.rangeOfCharacter(from: .whitespacesAndNewlines) == nil else {
            return .failure(BackendFailure(
                message: L10n.t("proxy.error.invalid_url", fallback: "代理地址格式无效，请使用 http://host:port 格式")
            ))
        }

        let scheme: String
        let hadScheme: Bool
        var remainder: String
        if let schemeRange = trimmed.range(of: "://") {
            hadScheme = true
            scheme = String(trimmed[..<schemeRange.lowerBound]).lowercased()
            guard scheme == "http" || scheme == "https" else {
                return .failure(BackendFailure(
                    message: L10n.t("proxy.error.unsupported_scheme", fallback: "仅支持 http:// 或 https:// 代理地址")
                ))
            }
            remainder = String(trimmed[schemeRange.upperBound...])
        } else {
            hadScheme = false
            scheme = "http"
            remainder = trimmed
        }

        if remainder.hasSuffix("/") {
            remainder.removeLast()
        }
        guard !remainder.isEmpty,
              !remainder.contains("/"),
              !remainder.contains("?"),
              !remainder.contains("#") else {
            return .failure(BackendFailure(
                message: L10n.t("proxy.error.invalid_url", fallback: "代理地址格式无效，请使用 http://host:port 格式")
            ))
        }

        let userInfoPrefix: String
        let hostPort: String
        if let atIndex = remainder.lastIndex(of: "@") {
            let rawUserInfo = String(remainder[..<atIndex])
            guard !rawUserInfo.isEmpty else {
                return .failure(BackendFailure(
                    message: L10n.t("proxy.error.invalid_url", fallback: "代理地址格式无效，请使用 http://host:port 格式")
                ))
            }
            userInfoPrefix = rawUserInfo + "@"
            hostPort = String(remainder[remainder.index(after: atIndex)...])
        } else {
            userInfoPrefix = ""
            hostPort = remainder
        }

        let host: String
        let portString: String
        if hostPort.hasPrefix("[") {
            guard let closeBracket = hostPort.firstIndex(of: "]") else {
                return .failure(BackendFailure(
                    message: L10n.t("proxy.error.invalid_url", fallback: "代理地址格式无效，请使用 http://host:port 格式")
                ))
            }
            host = String(hostPort[...closeBracket])
            let afterBracket = hostPort[hostPort.index(after: closeBracket)...]
            guard afterBracket.hasPrefix(":") else {
                return .failure(BackendFailure(
                    message: L10n.t("proxy.error.missing_port", fallback: "代理地址缺少端口号，请使用 host:port 格式")
                ))
            }
            portString = String(afterBracket.dropFirst())
        } else if let colonIndex = hostPort.lastIndex(of: ":") {
            host = String(hostPort[..<colonIndex])
            portString = String(hostPort[hostPort.index(after: colonIndex)...])
            if host.contains(":") {
                return .failure(BackendFailure(
                    message: L10n.t("proxy.error.invalid_url", fallback: "代理地址格式无效，请使用 http://host:port 格式")
                ))
            }
        } else {
            return .failure(BackendFailure(
                message: L10n.t("proxy.error.missing_port", fallback: "代理地址缺少端口号，请使用 host:port 格式")
            ))
        }

        guard isValidProxyHost(host) else {
            return .failure(BackendFailure(
                message: L10n.t("proxy.error.invalid_url", fallback: "代理地址格式无效，请使用 http://host:port 格式")
            ))
        }

        guard !portString.isEmpty else {
            return .failure(BackendFailure(
                message: L10n.t("proxy.error.missing_port", fallback: "代理地址缺少端口号，请使用 host:port 格式")
            ))
        }

        let isAllAsciiDigits = portString.unicodeScalars.allSatisfy { $0.value >= 48 && $0.value <= 57 }
        guard isAllAsciiDigits else {
            let key = hadScheme ? "proxy.error.invalid_port" : "proxy.error.invalid_url"
            let fallback = hadScheme ? "代理端口无效，需为 1–65535 之间的整数" : "代理地址格式无效，请使用 http://host:port 格式"
            return .failure(BackendFailure(message: L10n.t(key, fallback: fallback)))
        }

        guard let port = Int(portString), (1...65535).contains(port) else {
            return .failure(BackendFailure(
                message: L10n.t("proxy.error.invalid_port", fallback: "代理端口无效，需为 1–65535 之间的整数")
            ))
        }

        return .success("\(scheme)://\(userInfoPrefix)\(host.lowercased()):\(port)")
    }

    /// 脱敏代理 URL 中的认证凭据，仅供 UI 副标题与日志展示；无凭据 URL 原样返回。
    static func redactProxyUrl(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return trimmed }

        let schemePrefix: String
        let rest: Substring
        if let schemeRange = trimmed.range(of: "://") {
            schemePrefix = String(trimmed[..<schemeRange.upperBound])
            rest = trimmed[schemeRange.upperBound...]
        } else {
            schemePrefix = ""
            rest = trimmed[...]
        }

        let authorityEnd = rest.firstIndex(where: { $0 == "/" || $0 == "?" || $0 == "#" }) ?? rest.endIndex
        let authority = rest[..<authorityEnd]
        let suffix = rest[authorityEnd...]

        guard let atIndex = authority.lastIndex(of: "@") else {
            return trimmed
        }
        let userInfo = authority[..<atIndex]
        let hostPart = authority[authority.index(after: atIndex)...]
        guard !userInfo.isEmpty else {
            return trimmed
        }

        let redactedUserInfo: String
        if let colonIndex = userInfo.firstIndex(of: ":") {
            let username = userInfo[..<colonIndex]
            redactedUserInfo = username.isEmpty ? "[REDACTED]" : "\(username):[REDACTED]"
        } else {
            redactedUserInfo = "[REDACTED]"
        }
        return "\(schemePrefix)\(redactedUserInfo)@\(hostPart)\(suffix)"
    }

    static func resolve(
        mode: AntigravityProxyMode,
        manualUrl: String,
        snapshot: SystemProxySnapshot? = nil
    ) -> ProxyResolution {
        switch mode {
        case .off:
            return .disabled
        case .manual:
            switch normalizeManualProxyUrl(manualUrl) {
            case .failure(let failure):
                return .invalidManual(failure.message)
            case .success(let normalized):
                let snap = snapshot ?? readSystemProxySnapshot()
                let noProxy = buildNoProxy(exceptions: snap.exceptions)
                return .active(
                    httpUrl: normalized,
                    httpsUrl: normalized,
                    noProxy: noProxy,
                    displayUrl: redactProxyUrl(normalized)
                )
            }
        case .system:
            let snap = snapshot ?? readSystemProxySnapshot()
            if snap.httpUrl != nil || snap.httpsUrl != nil {
                let httpUrl = snap.httpUrl ?? snap.httpsUrl!
                let httpsUrl = snap.httpsUrl ?? snap.httpUrl!
                let noProxy = buildNoProxy(exceptions: snap.exceptions)
                return .active(
                    httpUrl: httpUrl,
                    httpsUrl: httpsUrl,
                    noProxy: noProxy,
                    displayUrl: redactProxyUrl(httpsUrl)
                )
            }
            if let pac = snap.pacUrl, !pac.isEmpty {
                return .systemUnsupported(.pac(redactProxyUrl(pac)))
            }
            if let socks = snap.socksUrl, !socks.isEmpty {
                return .systemUnsupported(.socksOnly(redactProxyUrl(socks)))
            }
            return .systemNotConfigured
        }
    }

    static func launchEnvironment(for resolution: ProxyResolution) -> [String: String] {
        guard case let .active(httpUrl, httpsUrl, noProxy, _) = resolution else {
            return [:]
        }
        return [
            "HTTP_PROXY": httpUrl,
            "http_proxy": httpUrl,
            "HTTPS_PROXY": httpsUrl,
            "https_proxy": httpsUrl,
            "NO_PROXY": noProxy,
            "no_proxy": noProxy,
            "NODE_USE_ENV_PROXY": "1"
        ]
    }

    static func processEnvironment(for pid: pid_t) -> [String: String] {
        guard pid > 0 else { return [:] }
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
        var size: Int = 0
        guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size else {
            return [:]
        }
        guard size <= 4 * 1024 * 1024 else { return [:] }
        var buffer = [UInt8](repeating: 0, count: size)
        guard sysctl(&mib, 3, &buffer, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size else {
            return [:]
        }
        return parseProcArgs2Environment(buffer, length: size)
    }

    static func parseProcArgs2Environment(_ buffer: [UInt8], length: Int? = nil) -> [String: String] {
        let size = min(length ?? buffer.count, buffer.count)
        guard size > MemoryLayout<Int32>.size else { return [:] }
        let argc: Int32 = buffer.withUnsafeBytes { raw in
            guard raw.count >= MemoryLayout<Int32>.size else { return -1 }
            return raw.loadUnaligned(as: Int32.self)
        }
        guard argc >= 0, argc < 65_536 else { return [:] }

        var index = MemoryLayout<Int32>.size
        while index < size && buffer[index] != 0 { index += 1 }
        while index < size && buffer[index] == 0 { index += 1 }

        for _ in 0..<Int(argc) {
            guard index < size else { return [:] }
            while index < size && buffer[index] != 0 { index += 1 }
            index += 1
        }

        while index < size && buffer[index] == 0 { index += 1 }

        var env: [String: String] = [:]
        while index < size {
            if buffer[index] == 0 { break }
            let start = index
            while index < size && buffer[index] != 0 { index += 1 }
            if index > start,
               let entry = String(bytes: buffer[start..<index], encoding: .utf8),
               let eqIndex = entry.firstIndex(of: "=") {
                let key = String(entry[..<eqIndex])
                if !key.isEmpty {
                    let value = String(entry[entry.index(after: eqIndex)...])
                    env[key] = value
                }
            }
            index += 1
        }
        return env
    }

    static func inspectRunningAntigravity(
        expected: ProxyResolution,
        appPath: String = DesktopApplicationTarget().path
    ) -> RunningAntigravityProxyState {
        if let override = testRunningProxyStateOverride {
            return override
        }
        guard case let .active(expectedHttp, expectedHttps, _, _) = expected else {
            return .notRunning
        }

        let psOutput = readPsPidAndArgs()
        let pids = findAntigravityPids(inPsOutput: psOutput, appPath: appPath)
        guard pids.mainPid != nil || !pids.languageServerPids.isEmpty else {
            return .notRunning
        }

        let appEnv = pids.mainPid.map { processEnvironment(for: $0) }
        let lsEnvs = pids.languageServerPids.map { processEnvironment(for: $0) }
        return classifyRunningProxyState(
            expectedHttp: expectedHttp,
            expectedHttps: expectedHttps,
            appEnv: appEnv,
            languageServerEnvs: lsEnvs
        )
    }

    // MARK: - Internal Helpers

    static func buildNoProxy(exceptions: [String]) -> String {
        var result: [String] = []
        var seen = Set<String>()
        for entry in mandatoryNoProxyEntries + exceptions {
            let trimmed = entry.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            let lowered = trimmed.lowercased()
            if seen.insert(lowered).inserted {
                result.append(trimmed)
            }
        }
        return result.joined(separator: ",")
    }

    static func classifyRunningProxyState(
        expectedHttp: String,
        expectedHttps: String,
        appEnv: [String: String]?,
        languageServerEnvs: [[String: String]]
    ) -> RunningAntigravityProxyState {
        guard appEnv != nil || !languageServerEnvs.isEmpty else {
            return .notRunning
        }

        let appProxy = appEnv.flatMap(effectiveProxyValue(from:))
        let appMatches = appProxy.map { matchesExpected($0, expectedHttp: expectedHttp, expectedHttps: expectedHttps) } ?? false

        if !languageServerEnvs.isEmpty {
            var firstMismatch: String?
            var hasMissing = false
            for lsEnv in languageServerEnvs {
                if let lsProxy = effectiveProxyValue(from: lsEnv) {
                    if !matchesExpected(lsProxy, expectedHttp: expectedHttp, expectedHttps: expectedHttps) {
                        if firstMismatch == nil { firstMismatch = lsProxy }
                    }
                } else {
                    hasMissing = true
                }
            }
            if let lsMismatch = firstMismatch {
                if appMatches, let appInjected = appProxy {
                    return .overriddenByShell(
                        lsActualUrl: redactProxyUrl(lsMismatch),
                        appInjectedUrl: redactProxyUrl(appInjected),
                        expectedUrl: redactProxyUrl(expectedHttps)
                    )
                }
                return .mismatch(actualUrl: redactProxyUrl(lsMismatch), expectedUrl: redactProxyUrl(expectedHttps))
            }
            if hasMissing {
                return .missing
            }
            return .matched(activeUrl: redactProxyUrl(expectedHttps))
        }

        guard let appProxy else {
            return .missing
        }
        if appMatches {
            return .matched(activeUrl: redactProxyUrl(expectedHttps))
        }
        return .mismatch(actualUrl: redactProxyUrl(appProxy), expectedUrl: redactProxyUrl(expectedHttps))
    }

    private static func findAntigravityPids(
        inPsOutput psOutput: String,
        appPath: String
    ) -> (mainPid: pid_t?, languageServerPids: [pid_t]) {
        let standardizedAppPath = URL(fileURLWithPath: appPath).standardizedFileURL.path
        let macOSPrefix = standardizedAppPath + "/Contents/MacOS/"
        let contentsPrefix = standardizedAppPath + "/Contents/"

        var preferredMainPid: pid_t?
        var fallbackMainPid: pid_t?
        var languageServerPids: [pid_t] = []

        for rawLine in psOutput.split(separator: "\n") {
            let trimmed = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            guard let firstSpace = trimmed.firstIndex(where: { $0 == " " || $0 == "\t" }) else { continue }
            let pidPart = String(trimmed[..<firstSpace])
            guard let pid = pid_t(pidPart), pid > 0 else { continue }
            let args = trimmed[firstSpace...].trimmingCharacters(in: .whitespacesAndNewlines)
            guard !args.isEmpty else { continue }

            if args.hasPrefix(macOSPrefix) {
                if !args.contains("--type=") {
                    if preferredMainPid == nil { preferredMainPid = pid }
                } else if fallbackMainPid == nil {
                    fallbackMainPid = pid
                }
            } else if args.contains(contentsPrefix) && args.contains("language_server") {
                languageServerPids.append(pid)
            }
        }

        return (preferredMainPid ?? fallbackMainPid, languageServerPids)
    }

    private static func readPsPidAndArgs() -> String {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/ps")
        task.arguments = ["-ax", "-ww", "-o", "pid=,args="]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = FileHandle.nullDevice
        do {
            defer { try? pipe.fileHandleForReading.close() }
            try task.run()
            let data = (try? pipe.fileHandleForReading.readToEnd()) ?? Data()
            task.waitUntilExit()
            return String(data: data, encoding: .utf8) ?? ""
        } catch {
            return ""
        }
    }

    private static func effectiveProxyValue(from env: [String: String]) -> String? {
        for key in ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] {
            if let raw = env[key]?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty {
                return raw
            }
        }
        return nil
    }

    private static func normalizeForComparison(_ url: String) -> String {
        let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
        if case .success(let normalized) = normalizeManualProxyUrl(trimmed) {
            return normalized
        }
        var lowered = trimmed.lowercased()
        while lowered.hasSuffix("/") { lowered.removeLast() }
        return lowered
    }

    private static func matchesExpected(_ actual: String, expectedHttp: String, expectedHttps: String) -> Bool {
        let normalizedActual = normalizeForComparison(actual)
        return normalizedActual == normalizeForComparison(expectedHttps)
            || normalizedActual == normalizeForComparison(expectedHttp)
    }

    private static func isEnabled(_ value: Any?) -> Bool {
        if let boolVal = value as? Bool { return boolVal }
        if let intVal = value as? Int { return intVal != 0 }
        if let numVal = value as? NSNumber { return numVal.intValue != 0 }
        if let strVal = value as? String {
            return ["1", "true", "yes"].contains(strVal.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
        }
        return false
    }

    private static func parsePort(_ value: Any?) -> Int? {
        let port: Int?
        if let intVal = value as? Int {
            port = intVal
        } else if let numVal = value as? NSNumber {
            port = numVal.intValue
        } else if let strVal = value as? String {
            port = Int(strVal.trimmingCharacters(in: .whitespacesAndNewlines))
        } else {
            port = nil
        }
        guard let port, (1...65535).contains(port) else { return nil }
        return port
    }

    private static func formatProxyEndpoint(
        rawHost: String?,
        rawPort: Any?,
        defaultScheme: String,
        requirePort: Bool
    ) -> String? {
        guard let hostTrimmed = rawHost?.trimmingCharacters(in: .whitespacesAndNewlines),
              !hostTrimmed.isEmpty else {
            return nil
        }
        if hostTrimmed.contains("://") {
            var cleaned = hostTrimmed
            while cleaned.hasSuffix("/") { cleaned.removeLast() }
            if let port = parsePort(rawPort), !cleaned.contains(":\(port)") {
                return "\(cleaned):\(port)"
            }
            return cleaned
        }
        let formattedHost: String
        if hostTrimmed.contains(":") && !hostTrimmed.hasPrefix("[") {
            formattedHost = "[\(hostTrimmed)]"
        } else {
            formattedHost = hostTrimmed
        }
        if let port = parsePort(rawPort) {
            return "\(defaultScheme)://\(formattedHost):\(port)"
        }
        return requirePort ? nil : "\(defaultScheme)://\(formattedHost)"
    }

    private static func isValidProxyHost(_ host: String) -> Bool {
        guard !host.isEmpty else { return false }
        if host.hasPrefix("[") && host.hasSuffix("]") {
            let inner = String(host.dropFirst().dropLast())
            guard !inner.isEmpty else { return false }
            return inner.unicodeScalars.allSatisfy { scalar in
                let v = scalar.value
                return (v >= 48 && v <= 57) // 0-9
                    || (v >= 65 && v <= 70) // A-F
                    || (v >= 97 && v <= 102) // a-f
                    || v == 58 // :
                    || v == 46 // .
            }
        }
        guard !host.hasPrefix("."), !host.hasSuffix("."),
              !host.hasPrefix("-"), !host.hasSuffix("-"),
              !host.contains("..") else {
            return false
        }
        return host.unicodeScalars.allSatisfy { scalar in
            let v = scalar.value
            return (v >= 48 && v <= 57) // 0-9
                || (v >= 65 && v <= 90) // A-Z
                || (v >= 97 && v <= 122) // a-z
                || v == 46 // .
                || v == 45 // -
        }
    }
}
