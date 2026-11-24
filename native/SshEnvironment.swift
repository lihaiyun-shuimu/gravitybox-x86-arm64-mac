import Cocoa

enum SshHostState: String {
    case online
    case authExpired = "auth_expired"
    case offlineRecent = "offline_recent"
    case historicalOnly = "historical_only"

    init(rawSessionState: String?) {
        let normalized = (rawSessionState ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        switch normalized {
        case "", "connected", "online":
            self = .online
        case "auth_expired":
            self = .authExpired
        case "disconnected", "offline_recent", "offline":
            self = .offlineRecent
        case "historical_only":
            self = .historicalOnly
        default:
            self = .online
        }
    }

    var sortPriority: Int {
        switch self {
        case .online: return 3
        case .authExpired: return 2
        case .offlineRecent: return 1
        case .historicalOnly: return 0
        }
    }

    var isOnlineOrAuthExpired: Bool {
        self == .online || self == .authExpired
    }

    var isOfflineLike: Bool {
        self == .offlineRecent || self == .historicalOnly
    }

    var isLiveOrRecent: Bool {
        self != .historicalOnly
    }

    var localizedStateLabel: String {
        switch self {
        case .online:
            return L10n.t("ssh.picker.state.online", fallback: "在线")
        case .authExpired:
            return L10n.t("ssh.picker.state.auth_expired", fallback: "授权已过期")
        case .offlineRecent:
            return L10n.t("ssh.picker.state.offline_recent", fallback: "离线快照")
        case .historicalOnly:
            return L10n.t("ssh.picker.state.historical_only", fallback: "历史记录")
        }
    }
}

enum QuotaFreshness: String, Equatable {
    case fresh
    case stale
    case errorFallback = "error_fallback"
    case authExpired = "auth_expired"
    case offlineSnapshot = "offline_snapshot"
    case unknown

    init(rawValueOrNil raw: String?) {
        let normalized = (raw ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        switch normalized {
        case "fresh":
            self = .fresh
        case "stale":
            self = .stale
        case "error_fallback":
            self = .errorFallback
        case "auth_expired":
            self = .authExpired
        case "offline_snapshot":
            self = .offlineSnapshot
        default:
            self = .unknown
        }
    }

    var isStaleOrDegraded: Bool {
        switch self {
        case .fresh, .unknown:
            return false
        case .stale, .errorFallback, .authExpired, .offlineSnapshot:
            return true
        }
    }
}

enum EnvironmentScope: Equatable, Hashable {
    case all
    case local
    case remote(environmentId: String)

    init(rawEnvironmentId: String?) {
        let trimmed = (rawEnvironmentId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty || trimmed == "all" {
            self = .all
        } else if trimmed == "local" {
            self = .local
        } else if trimmed.hasPrefix("env:") {
            let inner = String(trimmed.dropFirst("env:".count)).trimmingCharacters(in: .whitespacesAndNewlines)
            if inner.isEmpty || inner == "all" {
                self = .all
            } else if inner == "local" {
                self = .local
            } else {
                self = .remote(environmentId: inner)
            }
        } else {
            self = .remote(environmentId: trimmed)
        }
    }

    var rawEnvironmentId: String {
        switch self {
        case .all:
            return "all"
        case .local:
            return "local"
        case .remote(let environmentId):
            return environmentId
        }
    }

    var overviewKey: String {
        switch self {
        case .all:
            return "all"
        case .local:
            return "local"
        case .remote(let environmentId):
            return "env:\(environmentId)"
        }
    }

    var isAll: Bool { self == .all }
    var isLocal: Bool { self == .local }
    var isRemote: Bool {
        if case .remote = self { return true }
        return false
    }

    var remoteEnvironmentId: String? {
        if case .remote(let environmentId) = self { return environmentId }
        return nil
    }
}

struct CanonicalHostEnvironment {
    let environmentId: String
    let hostLabel: String
    let primaryRemoteKey: String
    let windowCount: Int
    let state: SshHostState
    let email: String
    let name: String
    let tier: String
    let matchedLocalAccountId: String?
    let lastError: String
    let quotaLastUpdated: Double
    let observedAt: Double
    let lastFocusedAt: Double
    let rawSession: [String: Any]
    let kind: String
    let focused: Bool
    let probing: Bool
    let quotaFreshness: QuotaFreshness
    let lastUsageSyncedAt: Double
    let machineId: String?
    let usageSharePct: Double?

    init(
        environmentId: String,
        hostLabel: String,
        primaryRemoteKey: String,
        windowCount: Int,
        state: SshHostState,
        email: String,
        name: String,
        tier: String,
        matchedLocalAccountId: String?,
        lastError: String,
        quotaLastUpdated: Double,
        observedAt: Double,
        lastFocusedAt: Double,
        rawSession: [String: Any],
        kind: String = "ssh",
        focused: Bool = false,
        probing: Bool = false,
        quotaFreshness: QuotaFreshness = .unknown,
        lastUsageSyncedAt: Double = 0,
        machineId: String? = nil,
        usageSharePct: Double? = nil
    ) {
        self.environmentId = environmentId
        self.hostLabel = hostLabel
        self.primaryRemoteKey = primaryRemoteKey
        self.windowCount = windowCount
        self.state = state
        self.email = email
        self.name = name
        self.tier = tier
        self.matchedLocalAccountId = matchedLocalAccountId
        self.lastError = lastError
        self.quotaLastUpdated = quotaLastUpdated
        self.observedAt = observedAt
        self.lastFocusedAt = lastFocusedAt
        self.rawSession = rawSession
        self.kind = kind
        self.focused = focused
        self.probing = probing
        self.quotaFreshness = quotaFreshness
        self.lastUsageSyncedAt = lastUsageSyncedAt
        self.machineId = machineId
        self.usageSharePct = usageSharePct
    }

    var isLocal: Bool {
        kind == "local" || environmentId == "local"
    }

    var cleanHostLabel: String {
        if isLocal {
            return L10n.t("ssh.scope.local", fallback: "本机")
        }
        let cleaned = SshEnvironmentResolver.cleanHostLabel(hostLabel)
        return cleaned.isEmpty ? L10n.t("ssh.remote_fallback", fallback: "远端") : cleaned
    }

    var displayName: String {
        if !email.isEmpty {
            return AccountIdentity.displayName(name: name, email: email)
        }
        return cleanHostLabel
    }

    var effectiveQuotaTimestamp: Double {
        if quotaLastUpdated > 0 {
            return quotaLastUpdated > 10_000_000_000 ? quotaLastUpdated / 1000.0 : quotaLastUpdated
        }
        if observedAt > 0 {
            return observedAt > 10_000_000_000 ? observedAt / 1000.0 : observedAt
        }
        return 0
    }
}

enum SshEnvironmentResolver {
    private struct HostAccumulator {
        let firstIndex: Int
        var winningSession: [String: Any]
        var winningState: SshHostState
        var winningLastFocusedAt: Double
        var winningObservedAt: Double
        var hostLabel: String
        var primaryRemoteKey: String
        var windowCount: Int
        var focused: Bool
        var probing: Bool
    }

    /// Priority SSOT parser for backend-unified `environments: EnvironmentNode[]` payloads.
    static func parseEnvironments(from rawNodes: [[String: Any]]) -> [CanonicalHostEnvironment] {
        var parsed: [(index: Int, node: CanonicalHostEnvironment)] = []
        var seenIds = Set<String>()

        for (index, raw) in rawNodes.enumerated() {
            let envId = ((raw["environmentId"] as? String) ?? (raw["id"] as? String) ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !envId.isEmpty, !seenIds.contains(envId) else { continue }
            seenIds.insert(envId)

            let rawKind = ((raw["kind"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let kind = (rawKind == "local" || envId == "local") ? "local" : "ssh"

            let rawState = (raw["lifecycleState"] as? String)
                ?? (raw["state"] as? String)
                ?? ((raw["online"] as? Bool) == false ? "offline_recent" : "online")
            let state = SshHostState(rawSessionState: rawState)

            let rawHostLabel = ((raw["hostLabel"] as? String)
                ?? (raw["host_label"] as? String)
                ?? (raw["label"] as? String)
                ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let cleanedHost = cleanHostLabel(rawHostLabel)
            let resolvedHostLabel: String
            if kind == "local" {
                resolvedHostLabel = cleanedHost.isEmpty ? L10n.t("ssh.scope.local", fallback: "本机") : cleanedHost
            } else {
                resolvedHostLabel = cleanedHost.isEmpty ? L10n.t("ssh.remote_fallback", fallback: "远端") : cleanedHost
            }

            let explicitWindowCount = (raw["windowCount"] as? Int)
                ?? (raw["windowCount"] as? NSNumber)?.intValue
            let windowCount = explicitWindowCount.map { max(0, $0) } ?? (state.isOfflineLike ? 0 : 1)

            let email = ((raw["accountEmail"] as? String) ?? (raw["email"] as? String) ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let name = ((raw["accountName"] as? String) ?? (raw["name"] as? String) ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let tierRaw = (raw["tier"] as? String)
                ?? (raw["subscription_tier"] as? String)
                ?? (raw["activeTier"] as? String)
            let tier = AccountIdentity.normalizeTier(tierRaw)

            let rawMatchedId = (raw["matchedLocalAccountId"] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let matchedId = (rawMatchedId?.isEmpty == false) ? rawMatchedId : nil

            let primaryRemoteKey = ((raw["primaryRemoteKey"] as? String) ?? (raw["remoteKey"] as? String) ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let lastError = (raw["lastError"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

            let quotaLastUpdated = QuotaPresentation.number(raw["lastQuotaObservedAt"])
                ?? QuotaPresentation.number(raw["quotaLastUpdated"])
                ?? QuotaPresentation.number((raw["quota"] as? [String: Any])?["last_updated"])
                ?? 0
            let observedAt = QuotaPresentation.number(raw["observedAt"])
                ?? (quotaLastUpdated > 0 ? quotaLastUpdated : 0)
            let lastFocusedAt = QuotaPresentation.number(raw["lastFocusedAt"]) ?? 0
            let lastUsageSyncedAt = QuotaPresentation.number(raw["lastUsageSyncedAt"]) ?? 0

            let focused = (raw["focused"] as? Bool) ?? false
            let probing = (raw["probing"] as? Bool) ?? false
            let freshness = QuotaFreshness(rawValueOrNil: raw["quotaFreshness"] as? String)
            let machineId = (raw["machineId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            let sharePct = QuotaPresentation.number(raw["sharePct"])
                ?? QuotaPresentation.number(raw["usageSharePct"])

            var normalizedSession = raw
            if normalizedSession["environmentId"] == nil {
                normalizedSession["environmentId"] = envId
            }
            if normalizedSession["hostLabel"] == nil {
                normalizedSession["hostLabel"] = resolvedHostLabel
            }
            if normalizedSession["email"] == nil && !email.isEmpty {
                normalizedSession["email"] = email
            }
            if normalizedSession["name"] == nil && !name.isEmpty {
                normalizedSession["name"] = name
            }
            if normalizedSession["subscription_tier"] == nil && !tier.isEmpty {
                normalizedSession["subscription_tier"] = tier
            }
            if normalizedSession["quotaLastUpdated"] == nil && quotaLastUpdated > 0 {
                normalizedSession["quotaLastUpdated"] = quotaLastUpdated
            }
            if normalizedSession["observedAt"] == nil && observedAt > 0 {
                normalizedSession["observedAt"] = observedAt
            }
            if let quotaDict = raw["quota"] as? [String: Any] {
                for (k, v) in quotaDict where normalizedSession[k] == nil {
                    normalizedSession[k] = v
                }
            }

            let node = CanonicalHostEnvironment(
                environmentId: envId,
                hostLabel: resolvedHostLabel,
                primaryRemoteKey: primaryRemoteKey,
                windowCount: windowCount,
                state: state,
                email: email,
                name: name,
                tier: tier,
                matchedLocalAccountId: matchedId,
                lastError: lastError,
                quotaLastUpdated: quotaLastUpdated,
                observedAt: observedAt,
                lastFocusedAt: lastFocusedAt,
                rawSession: normalizedSession,
                kind: kind,
                focused: focused,
                probing: probing,
                quotaFreshness: freshness,
                lastUsageSyncedAt: lastUsageSyncedAt,
                machineId: (machineId?.isEmpty == false) ? machineId : nil,
                usageSharePct: sharePct
            )
            parsed.append((index: index, node: node))
        }

        return parsed.sorted { lhs, rhs in
            if lhs.node.isLocal != rhs.node.isLocal {
                return lhs.node.isLocal
            }
            if lhs.node.state.sortPriority != rhs.node.state.sortPriority {
                return lhs.node.state.sortPriority > rhs.node.state.sortPriority
            }
            if lhs.node.lastFocusedAt != rhs.node.lastFocusedAt {
                return lhs.node.lastFocusedAt > rhs.node.lastFocusedAt
            }
            if lhs.node.observedAt != rhs.node.observedAt {
                return lhs.node.observedAt > rhs.node.observedAt
            }
            return lhs.index < rhs.index
        }.map(\.node)
    }

    static func aggregateHosts(
        from remoteSessions: [[String: Any]],
        envIdProvider: ([String: Any]) -> String
    ) -> [CanonicalHostEnvironment] {
        var order: [String] = []
        var grouped: [String: HostAccumulator] = [:]

        for (index, row) in remoteSessions.enumerated() {
            let envId = envIdProvider(row).trimmingCharacters(in: .whitespacesAndNewlines)
            let rawHost = (row["hostLabel"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let cleanedHost = cleanHostLabel(rawHost)
            let fallbackId = cleanedHost.isEmpty ? "ssh:remote" : "ssh:\(cleanedHost.lowercased())"
            let resolvedEnvId = envId.isEmpty ? fallbackId : envId
            let rawState = (row["lifecycleState"] as? String) ?? (row["state"] as? String)
            let state = SshHostState(rawSessionState: rawState)
            let lastFocusedAt = QuotaPresentation.number(row["lastFocusedAt"]) ?? 0
            let observedAt = QuotaPresentation.number(row["observedAt"]) ?? 0
            let rawRemoteKey = ((row["primaryRemoteKey"] as? String) ?? (row["remoteKey"] as? String) ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let explicitWindowCount = (row["windowCount"] as? Int)
                ?? (row["windowCount"] as? NSNumber)?.intValue
            let rowWindowCount = explicitWindowCount.map { max(0, $0) } ?? (state.isOfflineLike ? 0 : 1)
            let rowFocused = (row["focused"] as? Bool) ?? false
            let rowProbing = (row["probing"] as? Bool) ?? false
            let resolvedLabel = cleanedHost.isEmpty ? L10n.t("ssh.remote_fallback", fallback: "远端") : cleanedHost

            if var acc = grouped[resolvedEnvId] {
                acc.windowCount += rowWindowCount
                acc.focused = acc.focused || rowFocused
                let shouldReplace =
                    state.sortPriority > acc.winningState.sortPriority
                    || (state.sortPriority == acc.winningState.sortPriority && lastFocusedAt > acc.winningLastFocusedAt)
                    || (state.sortPriority == acc.winningState.sortPriority
                        && lastFocusedAt == acc.winningLastFocusedAt
                        && observedAt > acc.winningObservedAt)
                if shouldReplace {
                    acc.winningSession = row
                    acc.winningState = state
                    acc.winningLastFocusedAt = lastFocusedAt
                    acc.winningObservedAt = observedAt
                    acc.probing = rowProbing
                    if !cleanedHost.isEmpty {
                        acc.hostLabel = cleanedHost
                    }
                    if !rawRemoteKey.isEmpty {
                        acc.primaryRemoteKey = rawRemoteKey
                    }
                } else {
                    if acc.hostLabel == L10n.t("ssh.remote_fallback", fallback: "远端") && !cleanedHost.isEmpty {
                        acc.hostLabel = cleanedHost
                    }
                    if acc.primaryRemoteKey.isEmpty && !rawRemoteKey.isEmpty {
                        acc.primaryRemoteKey = rawRemoteKey
                    }
                    acc.probing = acc.probing && rowProbing
                }
                grouped[resolvedEnvId] = acc
            } else {
                order.append(resolvedEnvId)
                grouped[resolvedEnvId] = HostAccumulator(
                    firstIndex: index,
                    winningSession: row,
                    winningState: state,
                    winningLastFocusedAt: lastFocusedAt,
                    winningObservedAt: observedAt,
                    hostLabel: resolvedLabel,
                    primaryRemoteKey: rawRemoteKey,
                    windowCount: rowWindowCount,
                    focused: rowFocused,
                    probing: rowProbing
                )
            }
        }

        let sortedEntries = order.compactMap { envId -> (envId: String, acc: HostAccumulator)? in
            guard let acc = grouped[envId] else { return nil }
            return (envId, acc)
        }.sorted { lhs, rhs in
            if lhs.acc.winningState.sortPriority != rhs.acc.winningState.sortPriority {
                return lhs.acc.winningState.sortPriority > rhs.acc.winningState.sortPriority
            }
            if lhs.acc.winningLastFocusedAt != rhs.acc.winningLastFocusedAt {
                return lhs.acc.winningLastFocusedAt > rhs.acc.winningLastFocusedAt
            }
            if lhs.acc.winningObservedAt != rhs.acc.winningObservedAt {
                return lhs.acc.winningObservedAt > rhs.acc.winningObservedAt
            }
            return lhs.acc.firstIndex < rhs.acc.firstIndex
        }

        return sortedEntries.map { entry in
            let row = entry.acc.winningSession
            let email = ((row["accountEmail"] as? String) ?? (row["email"] as? String) ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let name = ((row["accountName"] as? String) ?? (row["name"] as? String) ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let tierRaw = (row["subscription_tier"] as? String)
                ?? (row["tier"] as? String)
                ?? (row["activeTier"] as? String)
            let tier = AccountIdentity.normalizeTier(tierRaw)
            let rawMatchedId = (row["matchedLocalAccountId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            let matchedId = (rawMatchedId?.isEmpty == false) ? rawMatchedId : nil
            let lastError = (row["lastError"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let quotaLastUpdated = QuotaPresentation.number(row["lastQuotaObservedAt"])
                ?? QuotaPresentation.number(row["quotaLastUpdated"])
                ?? 0
            let freshness = QuotaFreshness(rawValueOrNil: row["quotaFreshness"] as? String)
            let lastUsageSyncedAt = QuotaPresentation.number(row["lastUsageSyncedAt"]) ?? 0
            let machineId = (row["machineId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)

            return CanonicalHostEnvironment(
                environmentId: entry.envId,
                hostLabel: entry.acc.hostLabel,
                primaryRemoteKey: entry.acc.primaryRemoteKey,
                windowCount: entry.acc.windowCount,
                state: entry.acc.winningState,
                email: email,
                name: name,
                tier: tier,
                matchedLocalAccountId: matchedId,
                lastError: lastError,
                quotaLastUpdated: quotaLastUpdated,
                observedAt: entry.acc.winningObservedAt,
                lastFocusedAt: entry.acc.winningLastFocusedAt,
                rawSession: row,
                kind: entry.envId == "local" ? "local" : "ssh",
                focused: entry.acc.focused,
                probing: entry.acc.probing,
                quotaFreshness: freshness,
                lastUsageSyncedAt: lastUsageSyncedAt,
                machineId: (machineId?.isEmpty == false) ? machineId : nil
            )
        }
    }

    static func mergeEnvironments(
        primaryNodes: [CanonicalHostEnvironment],
        legacyRemoteSessions: [[String: Any]],
        availableEnvironments: [[String: Any]],
        usageShareByEnvId: [String: Double] = [:]
    ) -> [CanonicalHostEnvironment] {
        var nodesById: [String: CanonicalHostEnvironment] = [:]
        var orderedIds: [String] = []

        func upsert(_ node: CanonicalHostEnvironment) {
            if nodesById[node.environmentId] == nil {
                orderedIds.append(node.environmentId)
                nodesById[node.environmentId] = node
            } else if let existing = nodesById[node.environmentId] {
                let resolvedShare = node.usageSharePct ?? existing.usageSharePct ?? usageShareByEnvId[node.environmentId]
                nodesById[node.environmentId] = CanonicalHostEnvironment(
                    environmentId: existing.environmentId,
                    hostLabel: existing.hostLabel,
                    primaryRemoteKey: existing.primaryRemoteKey.isEmpty ? node.primaryRemoteKey : existing.primaryRemoteKey,
                    windowCount: existing.windowCount > 0 ? existing.windowCount : node.windowCount,
                    state: existing.state.sortPriority >= node.state.sortPriority ? existing.state : node.state,
                    email: existing.email.isEmpty ? node.email : existing.email,
                    name: existing.name.isEmpty ? node.name : existing.name,
                    tier: existing.tier.isEmpty ? node.tier : existing.tier,
                    matchedLocalAccountId: existing.matchedLocalAccountId ?? node.matchedLocalAccountId,
                    lastError: existing.lastError.isEmpty ? node.lastError : existing.lastError,
                    quotaLastUpdated: max(existing.quotaLastUpdated, node.quotaLastUpdated),
                    observedAt: max(existing.observedAt, node.observedAt),
                    lastFocusedAt: max(existing.lastFocusedAt, node.lastFocusedAt),
                    rawSession: existing.rawSession,
                    kind: existing.kind,
                    focused: existing.focused || node.focused,
                    probing: existing.probing && node.probing,
                    quotaFreshness: existing.quotaFreshness != .unknown ? existing.quotaFreshness : node.quotaFreshness,
                    lastUsageSyncedAt: max(existing.lastUsageSyncedAt, node.lastUsageSyncedAt),
                    machineId: existing.machineId ?? node.machineId,
                    usageSharePct: resolvedShare
                )
            }
        }

        if !primaryNodes.isEmpty {
            for node in primaryNodes {
                let withShare = CanonicalHostEnvironment(
                    environmentId: node.environmentId,
                    hostLabel: node.hostLabel,
                    primaryRemoteKey: node.primaryRemoteKey,
                    windowCount: node.windowCount,
                    state: node.state,
                    email: node.email,
                    name: node.name,
                    tier: node.tier,
                    matchedLocalAccountId: node.matchedLocalAccountId,
                    lastError: node.lastError,
                    quotaLastUpdated: node.quotaLastUpdated,
                    observedAt: node.observedAt,
                    lastFocusedAt: node.lastFocusedAt,
                    rawSession: node.rawSession,
                    kind: node.kind,
                    focused: node.focused,
                    probing: node.probing,
                    quotaFreshness: node.quotaFreshness,
                    lastUsageSyncedAt: node.lastUsageSyncedAt,
                    machineId: node.machineId,
                    usageSharePct: node.usageSharePct ?? usageShareByEnvId[node.environmentId]
                )
                upsert(withShare)
            }
        } else {
            let aggregated = aggregateHosts(from: legacyRemoteSessions) { row in
                if let envId = (row["environmentId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !envId.isEmpty {
                    return envId
                }
                let rawHost = (row["hostLabel"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let cleaned = cleanHostLabel(rawHost)
                return cleaned.isEmpty ? "ssh:remote" : "ssh:\(cleaned.lowercased())"
            }
            for host in aggregated {
                upsert(host)
            }
        }

        // Merge any historical-only usage environments not present in primaryNodes / remoteSessions
        for env in availableEnvironments {
            let envId = ((env["environmentId"] as? String) ?? (env["id"] as? String) ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !envId.isEmpty else { continue }
            let kindStr = ((env["kind"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let isLocal = envId == "local" || kindStr == "local"
            if isLocal {
                if nodesById["local"] == nil {
                    upsert(CanonicalHostEnvironment(
                        environmentId: "local",
                        hostLabel: L10n.t("ssh.scope.local", fallback: "本机"),
                        primaryRemoteKey: "",
                        windowCount: 1,
                        state: .online,
                        email: "",
                        name: "",
                        tier: "",
                        matchedLocalAccountId: nil,
                        lastError: "",
                        quotaLastUpdated: 0,
                        observedAt: 0,
                        lastFocusedAt: 0,
                        rawSession: env,
                        kind: "local",
                        usageSharePct: usageShareByEnvId["local"]
                    ))
                }
                continue
            }
            guard kindStr == "ssh" || envId.hasPrefix("ssh:") || envId.hasPrefix("host:") else { continue }
            if nodesById[envId] != nil { continue }

            let rawHost = ((env["hostLabel"] as? String)
                ?? (env["host_label"] as? String)
                ?? (env["label"] as? String)
                ?? envId).trimmingCharacters(in: .whitespacesAndNewlines)
            let cleaned = cleanHostLabel(rawHost)
            let resolvedLabel = cleaned.isEmpty ? L10n.t("ssh.remote_fallback", fallback: "远端") : cleaned
            let rawState = (env["lifecycleState"] as? String) ?? (env["state"] as? String)
            let online = env["online"] as? Bool
            let state: SshHostState
            if let rawState, !rawState.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                state = SshHostState(rawSessionState: rawState)
            } else if online == true {
                state = .online
            } else {
                state = .historicalOnly
            }
            upsert(CanonicalHostEnvironment(
                environmentId: envId,
                hostLabel: resolvedLabel,
                primaryRemoteKey: (env["primaryRemoteKey"] as? String) ?? (env["remoteKey"] as? String) ?? "",
                windowCount: state.isOfflineLike ? 0 : ((env["windowCount"] as? Int) ?? 1),
                state: state,
                email: (env["accountEmail"] as? String) ?? (env["email"] as? String) ?? "",
                name: (env["accountName"] as? String) ?? (env["name"] as? String) ?? "",
                tier: AccountIdentity.normalizeTier(env["tier"] as? String ?? env["subscription_tier"] as? String),
                matchedLocalAccountId: nil,
                lastError: "",
                quotaLastUpdated: 0,
                observedAt: 0,
                lastFocusedAt: 0,
                rawSession: env,
                kind: "ssh",
                quotaFreshness: state == .offlineRecent || state == .historicalOnly ? .offlineSnapshot : .unknown,
                usageSharePct: usageShareByEnvId[envId]
            ))
        }

        return orderedIds.compactMap { nodesById[$0] }.sorted { lhs, rhs in
            if lhs.isLocal != rhs.isLocal { return lhs.isLocal }
            if lhs.state.sortPriority != rhs.state.sortPriority {
                return lhs.state.sortPriority > rhs.state.sortPriority
            }
            if lhs.lastFocusedAt != rhs.lastFocusedAt {
                return lhs.lastFocusedAt > rhs.lastFocusedAt
            }
            if lhs.observedAt != rhs.observedAt {
                return lhs.observedAt > rhs.observedAt
            }
            return lhs.cleanHostLabel.localizedCaseInsensitiveCompare(rhs.cleanHostLabel) == .orderedAscending
        }
    }

    static func resolveQuotaFreshness(
        forHost host: CanonicalHostEnvironment,
        staleThresholdSeconds: TimeInterval,
        now: Date = Date()
    ) -> QuotaFreshness {
        switch host.state {
        case .authExpired:
            return .authExpired
        case .offlineRecent, .historicalOnly:
            return .offlineSnapshot
        case .online:
            break
        }
        if host.quotaFreshness == .errorFallback || !host.lastError.isEmpty {
            return .errorFallback
        }
        if host.quotaFreshness == .stale {
            return .stale
        }
        let stamp = host.effectiveQuotaTimestamp
        if stamp > 0 && now.timeIntervalSince1970 - stamp > staleThresholdSeconds {
            return .stale
        }
        let contract = QuotaPresentation.contract(host.rawSession)
        if contract.displayGroups.contains(where: { grp in
            grp.windows.contains(where: { $0.effectiveStale(at: now) })
        }) {
            return .stale
        }
        if host.quotaFreshness != .unknown {
            return host.quotaFreshness
        }
        return stamp > 0 || !contract.displayGroups.isEmpty ? .fresh : .unknown
    }

    static func resolveQuotaFreshness(
        forAccount account: [String: Any],
        staleThresholdSeconds: TimeInterval,
        now: Date = Date()
    ) -> QuotaFreshness {
        if let readiness = account["credentialReadiness"] as? [String: Any],
           (readiness["state"] as? String) == "needs_authorization" {
            return .authExpired
        }
        if let err = (account["quota_refresh_error"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
           !err.isEmpty,
           !InterfaceText.isInternalDualWindowError(err) {
            return .errorFallback
        }
        let explicit = QuotaFreshness(rawValueOrNil: (account["quotaFreshness"] as? String) ?? ((account["quota"] as? [String: Any])?["quotaFreshness"] as? String))
        if explicit == .authExpired || explicit == .errorFallback || explicit == .offlineSnapshot || explicit == .stale {
            return explicit
        }
        let quota = account["quota"] as? [String: Any]
        let stamp = QuotaPresentation.number(quota?["last_updated"])
            ?? QuotaPresentation.number(account["quota_last_updated"])
            ?? QuotaPresentation.number(account["lastQuotaObservedAt"])
            ?? 0
        if stamp > 0 {
            let normalized = stamp > 10_000_000_000 ? stamp / 1000.0 : stamp
            if now.timeIntervalSince1970 - normalized > staleThresholdSeconds {
                return .stale
            }
        }
        if let staleGroups = quota?["stale_groups"] as? [[String: Any]], !staleGroups.isEmpty {
            return .stale
        }
        if explicit != .unknown {
            return explicit
        }
        return stamp > 0 ? .fresh : .unknown
    }

    /// Non-destructive display-time fusion: merges fresher online SSH quota into matching local accounts
    /// without mutating persisted local storage fields like `persisted_quota_last_updated`.
    static func fuseAccountQuota(
        account: [String: Any],
        hosts: [CanonicalHostEnvironment]
    ) -> [String: Any] {
        var result = account
        let matching = matchingHosts(forAccount: account, hosts: hosts)
        let activeRemoteIds = matching.filter { $0.state.isLiveOrRecent }.map(\.environmentId)
        if !activeRemoteIds.isEmpty {
            let existingIds = (account["activeRemoteEnvIds"] as? [String]) ?? []
            var mergedIds = existingIds
            for envId in activeRemoteIds where !mergedIds.contains(envId) {
                mergedIds.append(envId)
            }
            result["activeRemoteEnvIds"] = mergedIds
        }

        let hasOnlineRemote = matching.contains(where: { $0.state == .online })
        if hasOnlineRemote {
            // Live SSH observation supersedes local standby cooling notice for display.
            result.removeValue(forKey: "standbyRefreshStatus")
        }

        let quotaDict = account["quota"] as? [String: Any]
        let localStampRaw = QuotaPresentation.number(quotaDict?["last_updated"])
            ?? QuotaPresentation.number(account["quota_last_updated"])
            ?? 0
        let localStamp = localStampRaw > 10_000_000_000 ? localStampRaw / 1000.0 : localStampRaw

        let eligibleRemote = matching
            .filter { $0.state == .online && !$0.probing }
            .filter { !$0.rawSession.isEmpty && !QuotaPresentation.contract($0.rawSession).displayGroups.isEmpty }
            .max { lhs, rhs in lhs.effectiveQuotaTimestamp < rhs.effectiveQuotaTimestamp }

        guard let bestRemote = eligibleRemote else {
            return result
        }
        let remoteStamp = bestRemote.effectiveQuotaTimestamp
        let shouldAdoptRemote = remoteStamp > localStamp || (localStamp <= 0 && !QuotaPresentation.contract(bestRemote.rawSession).displayGroups.isEmpty)
        guard shouldAdoptRemote else {
            if remoteStamp == localStamp && remoteStamp > 0 {
                let existingSource = (result["quotaSourceEnvironmentId"] as? String)?
                    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                if existingSource.isEmpty {
                    result["quotaSourceEnvironmentId"] = bestRemote.environmentId
                }
            }
            return result
        }

        let remoteRaw = bestRemote.rawSession
        let quotaKeys = [
            "quota",
            "quotaGroups",
            "familyWindows",
            "familyModelQuota",
            "argonStatus",
            "carbonStatus",
            "standaloneModels",
            "refreshState",
            "quotaWarnings"
        ]
        for key in quotaKeys {
            if let value = remoteRaw[key] {
                result[key] = value
            }
        }
        if remoteStamp > 0 {
            result["quota_last_updated"] = remoteStamp
            if var q = result["quota"] as? [String: Any] {
                q["last_updated"] = remoteStamp
                result["quota"] = q
            }
        }
        if !bestRemote.tier.isEmpty {
            result["subscription_tier"] = bestRemote.tier
        }
        result["quotaSourceEnvironmentId"] = bestRemote.environmentId
        if bestRemote.quotaFreshness != .unknown {
            result["quotaFreshness"] = bestRemote.quotaFreshness.rawValue
        } else {
            result["quotaFreshness"] = QuotaFreshness.fresh.rawValue
        }
        // Live SSH observation supersedes local standby cooling notice for display.
        result.removeValue(forKey: "standbyRefreshStatus")
        return result
    }

    static func fuseAccountsQuota(
        accounts: [[String: Any]],
        hosts: [CanonicalHostEnvironment]
    ) -> [[String: Any]] {
        guard !hosts.isEmpty else { return accounts }
        return accounts.map { fuseAccountQuota(account: $0, hosts: hosts) }
    }

    static func matchingHosts(
        forAccount account: [String: Any],
        hosts: [CanonicalHostEnvironment]
    ) -> [CanonicalHostEnvironment] {
        let accountId = (account["id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let accountEmail = (account["email"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !accountId.isEmpty || !accountEmail.isEmpty else { return [] }
        return hosts.filter { hostMatchesAccount($0, accountId: accountId, accountEmail: accountEmail) }
    }

    static func unmanagedHosts(
        accounts: [[String: Any]],
        hosts: [CanonicalHostEnvironment]
    ) -> [CanonicalHostEnvironment] {
        let pairs: [(id: String, email: String)] = accounts.map { acc in
            let id = (acc["id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let email = (acc["email"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return (id, email)
        }
        return hosts.filter { host in
            guard !host.isLocal else { return false }
            guard host.state == .online || host.state == .authExpired || host.state == .offlineRecent else {
                return false
            }
            if host.probing && host.email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return false
            }
            return !pairs.contains { pair in
                hostMatchesAccount(host, accountId: pair.id, accountEmail: pair.email)
            }
        }
    }

    static func isSameAccountAsLocal(host: CanonicalHostEnvironment, localEmail: String) -> Bool? {
        let trimmedHost = host.email.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedLocal = localEmail.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedHost.isEmpty, !trimmedLocal.isEmpty else { return nil }
        return trimmedHost.caseInsensitiveCompare(trimmedLocal) == .orderedSame
    }

    static func cleanHostLabel(_ raw: String) -> String {
        var result = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        for suffix in ["（离线）", " (Offline)", "(Offline)"] {
            if result.hasSuffix(suffix) {
                result = String(result.dropLast(suffix.count)).trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
        let prefixes = ["ssh: ", "ssh · ", "ssh:", "ssh ·", "host:"]
        var matched = true
        while matched {
            matched = false
            let lower = result.lowercased()
            for prefix in prefixes where lower.hasPrefix(prefix) {
                result = String(result.dropFirst(prefix.count)).trimmingCharacters(in: .whitespacesAndNewlines)
                matched = true
                break
            }
        }
        if result.caseInsensitiveCompare("ssh") == .orderedSame {
            return ""
        }
        return result
    }

    private static func hostMatchesAccount(
        _ host: CanonicalHostEnvironment,
        accountId: String,
        accountEmail: String
    ) -> Bool {
        if !accountId.isEmpty, let matchedId = host.matchedLocalAccountId, matchedId == accountId {
            return true
        }
        if !accountEmail.isEmpty, !host.email.isEmpty {
            return host.email.caseInsensitiveCompare(accountEmail) == .orderedSame
        }
        return false
    }
}

enum SshTerminalIcon {
    private static var cache: [Int: NSImage] = [:]
    private static let cacheLock = NSLock()

    static func image(pointSize: CGFloat = 13) -> NSImage {
        let clamped = max(8, pointSize)
        let key = Int(round(clamped * 2))
        cacheLock.lock()
        if let cached = cache[key] {
            cacheLock.unlock()
            return cached
        }
        cacheLock.unlock()

        let s = CGFloat(key) / 2.0
        let img = NSImage(size: NSSize(width: s, height: s), flipped: false) { _ in
            let strokeW = max(0.95, round(s * 0.088 * 2.0) / 2.0)
            let frameH = s * 0.80
            let frameRect = NSRect(
                x: strokeW * 0.55,
                y: (s - frameH) * 0.5,
                width: s - strokeW * 1.1,
                height: frameH
            )
            let cornerR = max(1.6, s * 0.165)
            let outerPath = NSBezierPath(roundedRect: frameRect, xRadius: cornerR, yRadius: cornerR)
            outerPath.lineWidth = strokeW

            let titleBarH = frameRect.height * 0.27
            let titleBarY = frameRect.maxY - titleBarH
            NSGraphicsContext.saveGraphicsState()
            outerPath.addClip()
            NSColor.black.withAlphaComponent(0.20).setFill()
            NSRect(x: frameRect.minX, y: titleBarY, width: frameRect.width, height: titleBarH).fill()
            NSGraphicsContext.restoreGraphicsState()

            NSColor.black.setStroke()
            outerPath.stroke()

            let sepPath = NSBezierPath()
            sepPath.move(to: NSPoint(x: frameRect.minX + strokeW * 0.35, y: titleBarY))
            sepPath.line(to: NSPoint(x: frameRect.maxX - strokeW * 0.35, y: titleBarY))
            sepPath.lineWidth = max(0.85, strokeW * 0.85)
            sepPath.stroke()

            let bodyMinY = frameRect.minY + strokeW * 0.45
            let bodyMaxY = titleBarY - strokeW * 0.45
            let bodyH = max(2.0, bodyMaxY - bodyMinY)
            let promptMidY = bodyMinY + bodyH * 0.50
            let chevHalfH = bodyH * 0.23
            let chevLeftX = frameRect.minX + frameRect.width * 0.22
            let chevTipX = frameRect.minX + frameRect.width * 0.42

            let promptPath = NSBezierPath()
            promptPath.move(to: NSPoint(x: chevLeftX, y: promptMidY + chevHalfH))
            promptPath.line(to: NSPoint(x: chevTipX, y: promptMidY))
            promptPath.line(to: NSPoint(x: chevLeftX, y: promptMidY - chevHalfH))

            let underLeftX = frameRect.minX + frameRect.width * 0.51
            let underRightX = frameRect.minX + frameRect.width * 0.76
            let underY = promptMidY - chevHalfH * 0.82
            promptPath.move(to: NSPoint(x: underLeftX, y: underY))
            promptPath.line(to: NSPoint(x: underRightX, y: underY))

            promptPath.lineWidth = max(0.95, strokeW * 0.92)
            promptPath.lineCapStyle = .round
            promptPath.lineJoinStyle = .round
            promptPath.stroke()
            return true
        }
        img.isTemplate = true
        cacheLock.lock()
        if let existing = cache[key] {
            cacheLock.unlock()
            return existing
        }
        cache[key] = img
        cacheLock.unlock()
        return img
    }
}

/// Single source of truth for SSH status dots, icons, and grouped environment menus.
enum SshEnvironmentVisuals {
    static func statusDotChar(for state: SshHostState) -> String {
        switch state {
        case .online, .authExpired:
            return "●"
        case .offlineRecent, .historicalOnly:
            return "○"
        }
    }

    static func isStatusDotFilled(for state: SshHostState) -> Bool {
        state == .online || state == .authExpired
    }

    static func statusDotColor(for state: SshHostState) -> NSColor {
        NSColor(name: nil) { appearance in
            statusDotColor(for: state, appearance: appearance)
        }
    }

    static func statusDotColor(for state: SshHostState, appearance: NSAppearance) -> NSColor {
        let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        switch state {
        case .online:
            return isDark
                ? NSColor(srgbRed: 74/255, green: 222/255, blue: 128/255, alpha: 0.96)
                : NSColor(srgbRed: 22/255, green: 163/255, blue: 74/255, alpha: 0.94)
        case .authExpired:
            return isDark
                ? NSColor(srgbRed: 251/255, green: 191/255, blue: 36/255, alpha: 1.0)
                : NSColor(srgbRed: 217/255, green: 119/255, blue: 6/255, alpha: 1.0)
        case .offlineRecent, .historicalOnly:
            return isDark
                ? NSColor(srgbRed: 142/255, green: 142/255, blue: 147/255, alpha: 0.90)
                : NSColor(srgbRed: 156/255, green: 163/255, blue: 175/255, alpha: 1.0)
        }
    }

    static func leadingIcon(for kind: EnvironmentContextPill.Item.Kind, pointSize: CGFloat = 12) -> NSImage? {
        switch kind {
        case .all:
            let img = NSImage(systemSymbolName: "square.3.layers.3d", accessibilityDescription: nil)?
                .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: pointSize, weight: .medium))
            img?.isTemplate = true
            return img
        case .local:
            let img = NSImage(systemSymbolName: "laptopcomputer", accessibilityDescription: nil)?
                .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: pointSize, weight: .medium))
            img?.isTemplate = true
            return img
        case .ssh:
            return SshTerminalIcon.image(pointSize: pointSize)
        }
    }

    static func makeMenuItem(
        for item: EnvironmentContextPill.Item,
        fontSize: CGFloat = 13,
        tabStopLocation: CGFloat? = nil
    ) -> NSMenuItem {
        let cleanTitle: String
        switch item.kind {
        case .all:
            let raw = item.hostLabel.trimmingCharacters(in: .whitespacesAndNewlines)
            cleanTitle = raw.isEmpty ? L10n.t("ssh.scope.all", fallback: "全部") : raw
        case .local:
            let raw = item.hostLabel.trimmingCharacters(in: .whitespacesAndNewlines)
            cleanTitle = raw.isEmpty ? L10n.t("ssh.scope.local", fallback: "本机") : raw
        case .ssh:
            let cleaned = SshEnvironmentResolver.cleanHostLabel(item.hostLabel)
            cleanTitle = cleaned.isEmpty ? L10n.t("ssh.remote_fallback", fallback: "远端") : cleaned
        }

        let menuItem = NSMenuItem(title: cleanTitle, action: nil, keyEquivalent: "")
        menuItem.representedObject = item.id
        menuItem.isEnabled = true
        menuItem.toolTip = nil
        menuItem.image = leadingIcon(for: item.kind, pointSize: 12)

        let font = NSFont.menuFont(ofSize: fontSize)
        let secondaryFont = NSFont.monospacedDigitSystemFont(ofSize: max(11, fontSize - 1.5), weight: .regular)
        let dotFont = NSFont.systemFont(ofSize: 8.5, weight: .bold)

        let attr = NSMutableAttributedString()
        if item.kind == .ssh {
            attr.append(NSAttributedString(
                string: "\(statusDotChar(for: item.state)) ",
                attributes: [
                    .foregroundColor: statusDotColor(for: item.state),
                    .font: dotFont,
                    .baselineOffset: 1.0
                ]
            ))
        }

        let primaryColor: NSColor = (item.kind == .ssh && item.state.isOfflineLike)
            ? .secondaryLabelColor
            : .labelColor
        var rowPrimary = cleanTitle
        if item.kind == .ssh {
            if item.state != .online {
                rowPrimary += " · \(item.state.localizedStateLabel)"
            } else if let email = item.email?.trimmingCharacters(in: .whitespacesAndNewlines), !email.isEmpty {
                let displayEmail = email.count > 22 ? String(email.prefix(20)) + "…" : email
                rowPrimary += " · \(displayEmail)"
            }
        }
        attr.append(NSAttributedString(string: rowPrimary, attributes: [
            .foregroundColor: primaryColor,
            .font: font
        ]))

        let secondary = item.secondaryText?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !secondary.isEmpty {
            let resolvedTabX = tabStopLocation ?? 186
            let para = NSMutableParagraphStyle()
            para.tabStops = [NSTextTab(textAlignment: .right, location: resolvedTabX)]
            attr.addAttribute(.paragraphStyle, value: para, range: NSRange(location: 0, length: attr.length))
            attr.append(NSAttributedString(string: "\t\(secondary)", attributes: [
                .foregroundColor: NSColor.secondaryLabelColor,
                .font: secondaryFont
            ]))
            attr.addAttribute(.paragraphStyle, value: para, range: NSRange(location: 0, length: attr.length))
        }

        menuItem.attributedTitle = attr
        return menuItem
    }

    static func buildGroupedMenu(
        items: [EnvironmentContextPill.Item],
        fontSize: CGFloat = 13,
        minimumWidth: CGFloat = 188
    ) -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false

        let menuFont = NSFont.menuFont(ofSize: fontSize)
        let secondaryFont = NSFont.monospacedDigitSystemFont(ofSize: max(11, fontSize - 1.5), weight: .regular)
        var maxPrimaryW: CGFloat = 0
        var maxSecondaryW: CGFloat = 0
        for item in items {
            let primaryStr: String
            switch item.kind {
            case .all, .local:
                primaryStr = item.hostLabel
            case .ssh:
                let cleaned = SshEnvironmentResolver.cleanHostLabel(item.hostLabel)
                let base = cleaned.isEmpty ? L10n.t("ssh.remote_fallback", fallback: "远端") : cleaned
                if item.state != .online {
                    primaryStr = "● \(base) · \(item.state.localizedStateLabel)"
                } else if let email = item.email, !email.isEmpty {
                    let shortEmail = email.count > 22 ? String(email.prefix(20)) + "…" : email
                    primaryStr = "● \(base) · \(shortEmail)"
                } else {
                    primaryStr = "● \(base)"
                }
            }
            maxPrimaryW = max(maxPrimaryW, ceil((primaryStr as NSString).size(withAttributes: [.font: menuFont]).width))
            if let sec = item.secondaryText, !sec.isEmpty {
                maxSecondaryW = max(maxSecondaryW, ceil((sec as NSString).size(withAttributes: [.font: secondaryFont]).width))
            }
        }
        let hasSecondary = maxSecondaryW > 0
        let tabStopLocation: CGFloat? = hasSecondary ? max(160, min(260, maxPrimaryW + maxSecondaryW + 24)) : nil
        if let tabStopLocation {
            menu.minimumWidth = max(minimumWidth, tabStopLocation + 38)
        } else {
            menu.minimumWidth = max(minimumWidth, maxPrimaryW + 56)
        }

        let baseGroup = items.filter { $0.kind == .all || $0.kind == .local }
        let onlineSshGroup = items.filter { $0.kind == .ssh && $0.state.isOnlineOrAuthExpired }
        let offlineSshGroup = items.filter { $0.kind == .ssh && $0.state.isOfflineLike }

        for item in baseGroup {
            menu.addItem(makeMenuItem(for: item, fontSize: fontSize, tabStopLocation: tabStopLocation))
        }

        if !onlineSshGroup.isEmpty {
            if !menu.items.isEmpty {
                menu.addItem(.separator())
            }
            menu.addItem(NSMenuItem.sectionHeader(title: L10n.t("ssh.picker.group.online", fallback: "在线 SSH")))
            for item in onlineSshGroup {
                menu.addItem(makeMenuItem(for: item, fontSize: fontSize, tabStopLocation: tabStopLocation))
            }
        }

        if !offlineSshGroup.isEmpty {
            if !menu.items.isEmpty {
                menu.addItem(.separator())
            }
            menu.addItem(NSMenuItem.sectionHeader(title: L10n.t("ssh.picker.group.offline", fallback: "离线 / 历史 SSH")))
            for item in offlineSshGroup {
                menu.addItem(makeMenuItem(for: item, fontSize: fontSize, tabStopLocation: tabStopLocation))
            }
        }

        return menu
    }
}

final class SshHostTagBadge: NSView {
    enum Scale {
        case regular
        case compact

        var height: CGFloat { self == .regular ? 19.0 : 17.0 }
        var cornerRadius: CGFloat { self == .regular ? 5.5 : 4.5 }
        var dotSize: CGFloat { 5.5 }
        var iconSize: CGFloat { self == .regular ? 11.5 : 10.5 }
        var fontSize: CGFloat { 10.5 }
        var leadingPad: CGFloat { self == .regular ? 6.0 : 5.5 }
        var trailingPad: CGFloat { self == .regular ? 6.5 : 5.5 }
        var dotToIconGap: CGFloat { self == .regular ? 4.5 : 4.0 }
        var iconToTextGap: CGFloat { self == .regular ? 3.5 : 3.0 }
    }

    override var allowsVibrancy: Bool { false }
    let scale: Scale
    let label = text("", size: 10.5, weight: .medium)
    var showStatusDot: Bool {
        didSet {
            guard oldValue != showStatusDot else { return }
            labelLeadingConstraint.constant = leadingContentInset
            invalidateIntrinsicContentSize()
            needsDisplay = true
        }
    }
    private(set) var hostLabel: String = ""
    private(set) var state: SshHostState = .online
    private(set) var windowCount: Int = 1
    private(set) var extraCount: Int = 0
    private var labelLeadingConstraint: NSLayoutConstraint!

    private var leadingContentInset: CGFloat {
        let dotPart: CGFloat = showStatusDot ? (scale.dotSize + scale.dotToIconGap) : 0
        return scale.leadingPad + dotPart + scale.iconSize + scale.iconToTextGap
    }

    init(scale: Scale = .regular, showStatusDot: Bool = true) {
        self.scale = scale
        self.showStatusDot = showStatusDot
        super.init(frame: .zero)
        label.setAccessibilityElement(false)
        label.font = .systemFont(ofSize: scale.fontSize, weight: .medium)
        label.lineBreakMode = .byTruncatingTail
        label.maximumNumberOfLines = 1
        label.allowsDefaultTighteningForTruncation = false
        addSubview(label)
        label.translatesAutoresizingMaskIntoConstraints = false
        labelLeadingConstraint = label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: leadingContentInset)
        NSLayoutConstraint.activate([
            labelLeadingConstraint,
            label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -scale.trailingPad),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
            heightAnchor.constraint(equalToConstant: scale.height)
        ])
        setContentHuggingPriority(.required, for: .horizontal)
        setContentCompressionResistancePriority(.required, for: .horizontal)
        setContentHuggingPriority(.required, for: .vertical)
        setContentCompressionResistancePriority(.required, for: .vertical)
        setAccessibilityElement(true)
        setAccessibilityRole(.staticText)
        update(hostLabel: "", state: .online, windowCount: 1, extraCount: 0, showStatusDot: showStatusDot)
    }

    convenience init(
        hostLabel: String,
        state: SshHostState = .online,
        windowCount: Int = 1,
        extraCount: Int = 0,
        scale: Scale = .regular,
        showStatusDot: Bool = true
    ) {
        self.init(scale: scale, showStatusDot: showStatusDot)
        update(hostLabel: hostLabel, state: state, windowCount: windowCount, extraCount: extraCount, showStatusDot: showStatusDot)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func update(
        hostLabel: String,
        state: SshHostState = .online,
        windowCount: Int = 1,
        extraCount: Int = 0,
        showStatusDot: Bool? = nil
    ) {
        if let showStatusDot, showStatusDot != self.showStatusDot {
            self.showStatusDot = showStatusDot
        }
        let cleaned = SshEnvironmentResolver.cleanHostLabel(hostLabel)
        let resolvedHost = cleaned.isEmpty ? L10n.t("ssh.remote_fallback", fallback: "远端") : cleaned
        let clampedWindows = max(0, windowCount)
        let clampedExtra = max(0, extraCount)

        self.hostLabel = resolvedHost
        self.state = state
        self.windowCount = clampedWindows
        self.extraCount = clampedExtra

        let displayText = clampedExtra > 0 ? "\(resolvedHost) +\(clampedExtra)" : resolvedHost
        if label.stringValue != displayText {
            label.stringValue = displayText
        }
        applyResolvedColors()

        var a11yParts: [String] = []
        if clampedWindows > 1 {
            a11yParts.append(
                L10n.t(
                    "ssh.picker.tooltip_host_windows",
                    ["host": resolvedHost, "count": clampedWindows],
                    fallback: "\(resolvedHost) · \(clampedWindows) 个窗口"
                )
            )
        } else {
            a11yParts.append(resolvedHost)
        }
        if self.showStatusDot && state != .online {
            a11yParts.append(state.localizedStateLabel)
        }
        if clampedExtra > 0 {
            a11yParts.append("+\(clampedExtra)")
        }
        setAccessibilityLabel(a11yParts.joined(separator: " · "))
        invalidateIntrinsicContentSize()
        needsDisplay = true
    }

    override var intrinsicContentSize: NSSize {
        let width = leadingContentInset + ceil(label.intrinsicContentSize.width) + scale.trailingPad
        return NSSize(width: width, height: scale.height)
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyResolvedColors()
        needsDisplay = true
    }

    private func applyResolvedColors() {
        let currentState = state
        let isMutedOffline = showStatusDot && currentState.isOfflineLike
        label.textColor = NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            if isMutedOffline {
                return isDark
                    ? NSColor(srgbRed: 152/255, green: 152/255, blue: 157/255, alpha: 1.0)
                    : NSColor(srgbRed: 107/255, green: 114/255, blue: 128/255, alpha: 1.0)
            }
            return isDark
                ? NSColor(srgbRed: 235/255, green: 235/255, blue: 240/255, alpha: 1.0)
                : NSColor(srgbRed: 55/255, green: 65/255, blue: 81/255, alpha: 1.0)
        }
    }

    override func draw(_ rect: NSRect) {
        guard bounds.width > 2 && bounds.height > 2 else { return }
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua

        let outerRect = bounds.insetBy(dx: 0.25, dy: 0.25)
        let cornerR = max(1.0, scale.cornerRadius - 0.25)
        let path = NSBezierPath(roundedRect: outerRect, xRadius: cornerR, yRadius: cornerR)

        let bgColor: NSColor = isDark
            ? NSColor.white.withAlphaComponent(0.08)
            : NSColor(srgbRed: 243/255, green: 244/255, blue: 246/255, alpha: 1.0)
        bgColor.setFill()
        path.fill()

        let borderColor: NSColor
        if showStatusDot && state == .authExpired {
            borderColor = isDark
                ? NSColor(srgbRed: 251/255, green: 191/255, blue: 36/255, alpha: 0.45)
                : NSColor(srgbRed: 217/255, green: 119/255, blue: 6/255, alpha: 0.42)
        } else {
            borderColor = isDark
                ? NSColor.white.withAlphaComponent(0.12)
                : NSColor.black.withAlphaComponent(0.085)
        }
        borderColor.setStroke()
        path.lineWidth = 0.5
        path.stroke()

        // Unified status dot (5.5pt): solid for online/authExpired, hollow ○ for offlineRecent/historicalOnly
        if showStatusDot {
            let dotColor = SshEnvironmentVisuals.statusDotColor(for: state, appearance: effectiveAppearance)
            let dotRect = NSRect(
                x: scale.leadingPad,
                y: (bounds.height - scale.dotSize) * 0.5,
                width: scale.dotSize,
                height: scale.dotSize
            )
            if SshEnvironmentVisuals.isStatusDotFilled(for: state) {
                dotColor.setFill()
                NSBezierPath(ovalIn: dotRect).fill()
            } else {
                dotColor.setStroke()
                let ring = NSBezierPath(ovalIn: dotRect.insetBy(dx: 0.65, dy: 0.65))
                ring.lineWidth = 1.15
                ring.stroke()
            }
        }

        // Vector terminal icon (SshTerminalIcon)
        let iconX = showStatusDot ? (scale.leadingPad + scale.dotSize + scale.dotToIconGap) : scale.leadingPad
        let iconRect = NSRect(
            x: iconX,
            y: (bounds.height - scale.iconSize) * 0.5,
            width: scale.iconSize,
            height: scale.iconSize
        )
        let iconTint: NSColor
        if showStatusDot && state.isOfflineLike {
            iconTint = isDark
                ? NSColor(srgbRed: 142/255, green: 142/255, blue: 147/255, alpha: 0.95)
                : NSColor(srgbRed: 107/255, green: 114/255, blue: 128/255, alpha: 0.95)
        } else {
            iconTint = isDark
                ? NSColor(white: 0.78, alpha: 1.0)
                : NSColor(srgbRed: 75/255, green: 85/255, blue: 99/255, alpha: 1.0)
        }
        let iconImg = SshTerminalIcon.image(pointSize: scale.iconSize)
        if let cg = NSGraphicsContext.current?.cgContext {
            cg.saveGState()
            cg.beginTransparencyLayer(in: iconRect, auxiliaryInfo: nil)
            iconImg.draw(
                in: iconRect,
                from: .zero,
                operation: .sourceOver,
                fraction: 1.0,
                respectFlipped: isFlipped,
                hints: [.interpolation: NSNumber(value: NSImageInterpolation.high.rawValue)]
            )
            cg.setBlendMode(.sourceAtop)
            iconTint.setFill()
            cg.fill(iconRect)
            cg.endTransparencyLayer()
            cg.restoreGState()
        }
    }
}

/// Unified anchored context selector pill shared across MenuPanel, Overview, Usage, and UsageLog.
final class EnvironmentContextPill: NSView, NSMenuDelegate {
    enum VisualStyle: Equatable {
        case headerPill
        case menuHeaderPill
    }

    struct Item: Equatable {
        enum Kind: Equatable {
            case all
            case local
            case ssh
        }

        let id: String
        let scope: EnvironmentScope
        let hostLabel: String
        let kind: Kind
        let state: SshHostState
        let windowCount: Int
        let email: String?
        let secondaryText: String?

        init(
            scope: EnvironmentScope,
            hostLabel: String,
            state: SshHostState = .online,
            windowCount: Int = 1,
            email: String? = nil,
            secondaryText: String? = nil
        ) {
            self.scope = scope
            self.id = scope.rawEnvironmentId
            switch scope {
            case .all:
                self.kind = .all
            case .local:
                self.kind = .local
            case .remote:
                self.kind = .ssh
            }
            self.hostLabel = hostLabel
            self.state = state
            self.windowCount = windowCount
            self.email = email
            self.secondaryText = secondaryText
        }

        #if NATIVE_UI_TEST
        init(option: EnvironmentPickerControl.Option, secondaryText: String? = nil) {
            self.id = option.id
            self.scope = EnvironmentScope(rawEnvironmentId: option.id)
            switch option.kind {
            case .all: self.kind = .all
            case .local: self.kind = .local
            case .ssh: self.kind = .ssh
            }
            self.hostLabel = option.hostLabel
            self.state = option.state
            self.windowCount = option.windowCount
            self.email = nil
            self.secondaryText = secondaryText
        }
        #endif
    }

    final class TriggerButton: NSButton {
        var visualStyle: VisualStyle = .headerPill {
            didSet {
                guard oldValue != visualStyle else { return }
                updateTrackingAreas()
                needsDisplay = true
            }
        }
        var compact: Bool = true {
            didSet {
                guard oldValue != compact else { return }
                needsDisplay = true
            }
        }
        var isActiveState: Bool = false {
            didSet {
                guard oldValue != isActiveState else { return }
                needsDisplay = true
            }
        }
        var itemKind: Item.Kind = .all {
            didSet {
                guard oldValue != itemKind else { return }
                needsDisplay = true
            }
        }
        var hostState: SshHostState = .online {
            didSet {
                guard oldValue != hostState else { return }
                needsDisplay = true
            }
        }
        var displayTitle: String = "" {
            didSet {
                guard oldValue != displayTitle else { return }
                if title != displayTitle {
                    title = displayTitle
                }
                setAccessibilityValue(displayTitle)
                needsDisplay = true
            }
        }
        var onPress: (() -> Void)?

        private var hoverTracking: NSTrackingArea?
        private let hoverMotion = DesignMotion()
        private let pressMotion = DesignMotion()
        private var hoverProgress: CGFloat = 0
        private var pressProgress: CGFloat = 0
        private var lastHighlighted = false
        var hovered = false {
            didSet {
                guard oldValue != hovered else { return }
                let target: CGFloat = hovered ? 1.0 : 0.0
                hoverMotion.animate(in: self, from: hoverProgress, to: target, curve: .hover, threshold: 0.02) { [weak self] val in
                    guard let self else { return }
                    self.hoverProgress = val
                    self.needsDisplay = true
                }
            }
        }

        override var isHighlighted: Bool {
            didSet {
                guard isHighlighted != lastHighlighted else { return }
                lastHighlighted = isHighlighted
                let target: CGFloat = isHighlighted ? 1.0 : 0.0
                pressMotion.animate(in: self, from: pressProgress, to: target, curve: .press, threshold: 0.01) { [weak self] val in
                    guard let self else { return }
                    self.pressProgress = val
                    self.needsDisplay = true
                }
            }
        }

        override var allowsVibrancy: Bool { false }
        override var isOpaque: Bool { false }
        override var wantsDefaultClipping: Bool { true }

        override init(frame frameRect: NSRect) {
            super.init(frame: frameRect)
            isBordered = false
            bezelStyle = .inline
            focusRingType = .none
            setButtonType(.momentaryChange)
            refusesFirstResponder = false
            toolTip = nil
            setAccessibilityElement(true)
            setAccessibilityRole(.popUpButton)
        }

        required init?(coder: NSCoder) {
            fatalError("init(coder:) has not been implemented")
        }

        deinit {
            hoverMotion.cancel()
            pressMotion.cancel()
        }

        override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
            true
        }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if window == nil {
                hoverMotion.cancel()
                pressMotion.cancel()
                hoverProgress = 0
                pressProgress = 0
                hovered = false
                isHighlighted = false
            }
        }

        override func viewDidChangeEffectiveAppearance() {
            super.viewDidChangeEffectiveAppearance()
            needsDisplay = true
        }

        override func updateTrackingAreas() {
            super.updateTrackingAreas()
            if let area = hoverTracking { removeTrackingArea(area) }
            let inPopover = (visualStyle == .menuHeaderPill) || Design.isInPopover(self)
            let activeOption: NSTrackingArea.Options = inPopover ? .activeAlways : .activeInActiveApp
            let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, activeOption, .inVisibleRect], owner: self)
            hoverTracking = area
            addTrackingArea(area)
        }

        override func mouseEntered(with event: NSEvent) {
            if isEnabled { hovered = true }
        }

        override func mouseExited(with event: NSEvent) {
            hovered = false
        }

        override func mouseDown(with event: NSEvent) {
            guard isEnabled else { return }
            if let panel = window as? MenuFloatingPanel, !panel.isKeyWindow {
                panel.makeKey()
            }
            isHighlighted = true
            needsDisplay = true
            defer {
                if isHighlighted {
                    isHighlighted = false
                    needsDisplay = true
                }
            }
            onPress?()
        }

        override func keyDown(with event: NSEvent) {
            // Space (49), Return (36), DownArrow (125)
            if isEnabled && (event.keyCode == 49 || event.keyCode == 36 || event.keyCode == 125) {
                onPress?()
                return
            }
            super.keyDown(with: event)
        }

        override func performClick(_ sender: Any?) {
            guard isEnabled else { return }
            onPress?()
        }

        override func draw(_ dirtyRect: NSRect) {
            let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let hp = isEnabled ? hoverProgress : 0
            let pp = isHighlighted ? max(pressProgress, 0.72) : pressProgress
            let enableScale: CGFloat = isEnabled ? 1.0 : 0.45

            let rect = bounds.insetBy(dx: 0.5, dy: 0.5)
            guard rect.width > 2 && rect.height > 2 else { return }
            let cornerR: CGFloat = visualStyle == .menuHeaderPill ? Design.Radius.controlCompact : Design.Radius.control
            let path = NSBezierPath(roundedRect: rect, xRadius: cornerR, yRadius: cornerR)

            let fillColor: NSColor
            let borderColor: NSColor
            switch visualStyle {
            case .headerPill:
                if isActiveState {
                    fillColor = Design.blue.withAlphaComponent((isDark ? (0.20 + 0.04 * hp - 0.03 * pp) : (0.10 + 0.035 * hp - 0.02 * pp)) * enableScale)
                    borderColor = Design.blue.withAlphaComponent((isDark ? (0.38 + 0.10 * hp) : (0.26 + 0.10 * hp)) * enableScale)
                } else {
                    fillColor = isDark
                        ? NSColor.white.withAlphaComponent((0.08 + 0.045 * hp - 0.02 * pp) * enableScale)
                        : NSColor.white.withAlphaComponent((0.82 + 0.10 * hp - 0.06 * pp) * enableScale)
                    if isDark {
                        borderColor = NSColor.white.withAlphaComponent((0.12 + 0.06 * hp) * enableScale)
                    } else if isEnabled && hp > 0.05 {
                        borderColor = Design.blue.withAlphaComponent((0.16 * hp + 0.085 * (1.0 - hp)) * enableScale)
                    } else {
                        borderColor = NSColor.black.withAlphaComponent(0.085 * enableScale)
                    }
                }
            case .menuHeaderPill:
                if isActiveState {
                    fillColor = Design.blue.withAlphaComponent((isDark ? (0.22 + 0.04 * hp - 0.03 * pp) : (0.11 + 0.035 * hp - 0.02 * pp)) * enableScale)
                    borderColor = Design.blue.withAlphaComponent((isDark ? (0.38 + 0.08 * hp) : (0.28 + 0.08 * hp)) * enableScale)
                } else {
                    fillColor = isDark
                        ? NSColor.white.withAlphaComponent((0.085 + 0.045 * hp - 0.02 * pp) * enableScale)
                        : NSColor.white.withAlphaComponent((0.56 + 0.16 * hp - 0.08 * pp) * enableScale)
                    borderColor = isDark
                        ? NSColor.white.withAlphaComponent((0.12 + 0.05 * hp) * enableScale)
                        : NSColor.black.withAlphaComponent((0.08 + 0.04 * hp) * enableScale)
                }
            }

            fillColor.setFill()
            path.fill()

            if window?.firstResponder === self {
                Design.blue.setStroke()
                path.lineWidth = 1.5
                path.stroke()
            } else {
                borderColor.setStroke()
                path.lineWidth = 0.5
                path.stroke()
            }

            let activeFg = isDark
                ? NSColor(srgbRed: 112/255, green: 184/255, blue: 1.0, alpha: 1.0)
                : NSColor(srgbRed: 0.0, green: 94.0 / 255.0, blue: 196.0 / 255.0, alpha: 1.0)
            let fgColor: NSColor
            if !isEnabled {
                fgColor = Design.secondary.withAlphaComponent(0.55)
            } else if isActiveState {
                fgColor = activeFg
            } else {
                fgColor = Design.primary
            }

            var xOffset: CGFloat = compact ? 9.0 : 10.0

            // Only SSH state draws a single 5.5pt status dot to the left of SshTerminalIcon.
            if itemKind == .ssh {
                let dotSize: CGFloat = 5.5
                let dotRect = NSRect(x: xOffset, y: (bounds.height - dotSize) * 0.5, width: dotSize, height: dotSize)
                let dotColor = SshEnvironmentVisuals.statusDotColor(for: hostState, appearance: effectiveAppearance)
                    .withAlphaComponent(isEnabled ? 1.0 : 0.45)
                if SshEnvironmentVisuals.isStatusDotFilled(for: hostState) {
                    dotColor.setFill()
                    NSBezierPath(ovalIn: dotRect).fill()
                } else {
                    dotColor.setStroke()
                    let ring = NSBezierPath(ovalIn: dotRect.insetBy(dx: 0.65, dy: 0.65))
                    ring.lineWidth = 1.15
                    ring.stroke()
                }
                xOffset += dotSize + 4.5
            }

            let iconBox: CGFloat = compact ? 11.5 : 12.5
            if let iconImg = SshEnvironmentVisuals.leadingIcon(for: itemKind, pointSize: iconBox) {
                let rawSz = iconImg.size
                let scale = (rawSz.width > 0 && rawSz.height > 0) ? min(iconBox / rawSz.width, iconBox / rawSz.height) : 1.0
                let iconW = max(4.0, round(rawSz.width * scale * 2.0) / 2.0)
                let iconH = max(4.0, round(rawSz.height * scale * 2.0) / 2.0)
                let iconRect = NSRect(
                    x: xOffset,
                    y: (bounds.height - iconH) * 0.5,
                    width: iconW,
                    height: iconH
                )
                let iconColor: NSColor
                if !isEnabled {
                    iconColor = Design.secondary.withAlphaComponent(0.50)
                } else if isActiveState {
                    iconColor = activeFg
                } else if hp > 0.25 {
                    iconColor = Design.primary
                } else {
                    iconColor = Design.secondary
                }
                if iconImg.isTemplate, let cg = NSGraphicsContext.current?.cgContext {
                    cg.saveGState()
                    cg.beginTransparencyLayer(in: iconRect, auxiliaryInfo: nil)
                    iconImg.draw(
                        in: iconRect,
                        from: .zero,
                        operation: .sourceOver,
                        fraction: 1.0,
                        respectFlipped: isFlipped,
                        hints: [.interpolation: NSNumber(value: NSImageInterpolation.high.rawValue)]
                    )
                    cg.setBlendMode(.sourceAtop)
                    iconColor.setFill()
                    cg.fill(iconRect)
                    cg.endTransparencyLayer()
                    cg.restoreGState()
                } else {
                    iconImg.draw(
                        in: iconRect,
                        from: .zero,
                        operation: .sourceOver,
                        fraction: isEnabled ? 1.0 : 0.50,
                        respectFlipped: isFlipped,
                        hints: [.interpolation: NSNumber(value: NSImageInterpolation.high.rawValue)]
                    )
                }
                xOffset += iconW + 4.5
            }

            let fontSize: CGFloat = compact ? 11.5 : 12.0
            let drawFont = NSFont.systemFont(ofSize: fontSize, weight: .medium)
            let textH = (displayTitle as NSString).size(withAttributes: [.font: drawFont]).height
            let trailingZone: CGFloat = compact ? 19.0 : 21.0
            let titleWidth = max(0, bounds.width - xOffset - trailingZone)
            let titleY = round(((bounds.height - textH) * 0.5) * 2.0) / 2.0
            let titleRect = NSRect(
                x: xOffset,
                y: titleY,
                width: titleWidth,
                height: ceil(textH) + 1
            )
            let paraStyle = NSMutableParagraphStyle()
            paraStyle.alignment = .left
            paraStyle.lineBreakMode = .byTruncatingTail
            (displayTitle as NSString).draw(in: titleRect, withAttributes: [
                .font: drawFont,
                .foregroundColor: fgColor,
                .paragraphStyle: paraStyle
            ])

            // Delicate single downward chevron
            let cx = bounds.maxX - (compact ? 10.5 : 11.5)
            let cy = bounds.midY
            let ySign: CGFloat = isFlipped ? 1.0 : -1.0
            let chev = NSBezierPath()
            chev.move(to: NSPoint(x: cx - 2.8, y: cy - 1.3 * ySign))
            chev.line(to: NSPoint(x: cx, y: cy + 1.7 * ySign))
            chev.line(to: NSPoint(x: cx + 2.8, y: cy - 1.3 * ySign))
            chev.lineWidth = 1.2
            chev.lineCapStyle = .round
            chev.lineJoinStyle = .round
            let chevColor: NSColor
            if !isEnabled {
                chevColor = Design.secondary.withAlphaComponent(0.45)
            } else if isActiveState {
                chevColor = activeFg.withAlphaComponent(0.90)
            } else if hp > 0.25 {
                chevColor = Design.primary
            } else {
                chevColor = Design.secondary
            }
            chevColor.setStroke()
            chev.stroke()
        }
    }

    private struct RenderFingerprint: Equatable {
        let style: VisualStyle
        let items: [Item]
        var selectedId: String
        var isActive: Bool
        let locale: String
        let maxWidth: CGFloat
        let minWidth: CGFloat
        let pillHeight: CGFloat
    }

    let style: VisualStyle
    let triggerButton = TriggerButton(frame: .zero)
    let compact: Bool
    var isEnabled: Bool {
        get { triggerButton.isEnabled }
        set {
            triggerButton.isEnabled = newValue
            triggerButton.needsDisplay = true
        }
    }
    var minWidth: CGFloat {
        didSet {
            guard oldValue != minWidth else { return }
            syncLayoutWidth()
        }
    }
    var maxWidth: CGFloat {
        didSet {
            guard oldValue != maxWidth else { return }
            syncLayoutWidth()
        }
    }
    var pillHeight: CGFloat {
        didSet {
            guard oldValue != pillHeight else { return }
            heightConstraint.constant = pillHeight
            invalidateIntrinsicContentSize()
            triggerButton.needsDisplay = true
        }
    }
    var onSelectScope: ((EnvironmentScope) -> Void)?
    #if NATIVE_UI_TEST
    var onSelectId: ((String) -> Void)?
    #endif

    private(set) var items: [Item] = []
    private(set) var selectedScope: EnvironmentScope = .all
    var selectedId: String { selectedScope.rawEnvironmentId }
    private(set) var isActive: Bool = false
    var displayTitle: String { triggerButton.displayTitle }

    private var renderedFingerprint: RenderFingerprint?
    private var heightConstraint: NSLayoutConstraint!
    private var widthConstraint: NSLayoutConstraint!
    private var maxWidthConstraint: NSLayoutConstraint!
    private var isMenuTrackingOpen = false
    private var pendingUpdate: (items: [Item], selectedScope: EnvironmentScope, isActive: Bool)?

    init(
        style: VisualStyle = .headerPill,
        compact: Bool = true,
        minWidth: CGFloat = 68,
        maxWidth: CGFloat = 154,
        height: CGFloat? = nil
    ) {
        self.style = style
        self.compact = compact
        self.minWidth = max(54, minWidth)
        self.maxWidth = max(self.minWidth, maxWidth)
        self.pillHeight = height ?? (style == .menuHeaderPill ? 24.0 : 26.0)
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        triggerButton.visualStyle = style
        triggerButton.compact = compact
        triggerButton.translatesAutoresizingMaskIntoConstraints = false
        triggerButton.target = self
        triggerButton.action = #selector(triggerButtonPressed(_:))
        triggerButton.onPress = { [weak self] in
            self?.presentMenu()
        }

        addSubview(triggerButton)
        heightConstraint = heightAnchor.constraint(equalToConstant: pillHeight)
        widthConstraint = widthAnchor.constraint(equalToConstant: self.minWidth)
        widthConstraint.priority = NSLayoutConstraint.Priority(998)
        maxWidthConstraint = widthAnchor.constraint(lessThanOrEqualToConstant: self.maxWidth)
        maxWidthConstraint.priority = .required
        NSLayoutConstraint.activate([
            triggerButton.leadingAnchor.constraint(equalTo: leadingAnchor),
            triggerButton.trailingAnchor.constraint(equalTo: trailingAnchor),
            triggerButton.topAnchor.constraint(equalTo: topAnchor),
            triggerButton.bottomAnchor.constraint(equalTo: bottomAnchor),
            heightConstraint,
            widthConstraint,
            maxWidthConstraint
        ])
        setContentHuggingPriority(NSLayoutConstraint.Priority(998), for: .horizontal)
        setContentCompressionResistancePriority(NSLayoutConstraint.Priority(995), for: .horizontal)
        setContentHuggingPriority(.required, for: .vertical)
        setContentCompressionResistancePriority(.required, for: .vertical)
        triggerButton.setAccessibilityLabel(L10n.t("ssh.scope.a11y", fallback: "切换环境"))
        setAccessibilityElement(false)
        isHidden = true
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override var allowsVibrancy: Bool { false }
    override var isOpaque: Bool { false }

    override func setAccessibilityLabel(_ accessibilityLabel: String?) {
        super.setAccessibilityLabel(accessibilityLabel)
        let resolved = (accessibilityLabel?.isEmpty == false)
            ? accessibilityLabel
            : L10n.t("ssh.scope.a11y", fallback: "切换环境")
        triggerButton.setAccessibilityLabel(resolved)
    }

    override var intrinsicContentSize: NSSize {
        if isHidden {
            return .zero
        }
        return NSSize(width: widthConstraint.constant, height: pillHeight)
    }

    func update(
        items incoming: [Item],
        selectedScope rawScope: EnvironmentScope,
        isActive explicitActive: Bool? = nil
    ) {
        let hasSshItems = incoming.contains { $0.kind == .ssh }
        let selectedExists = incoming.contains { $0.scope == rawScope }
        let resolvedScope: EnvironmentScope
        if selectedExists {
            resolvedScope = rawScope
        } else if let first = incoming.first {
            resolvedScope = first.scope
        } else {
            resolvedScope = rawScope
        }

        if !hasSshItems && !resolvedScope.isRemote {
            self.items = incoming
            self.selectedScope = resolvedScope
            self.isActive = false
            self.renderedFingerprint = nil
            self.pendingUpdate = nil
            if !isHidden {
                isHidden = true
                invalidateIntrinsicContentSize()
            }
            return
        }

        let resolvedActive = explicitActive ?? !resolvedScope.isAll
        if isMenuTrackingOpen {
            pendingUpdate = (items: incoming, selectedScope: resolvedScope, isActive: resolvedActive)
            return
        }

        applyUpdate(items: incoming, selectedScope: resolvedScope, isActive: resolvedActive)
    }

    #if NATIVE_UI_TEST
    func update(
        options: [EnvironmentPickerControl.Option],
        selectedId: String,
        isActive explicitActive: Bool? = nil,
        secondaryTextById: [String: String] = [:]
    ) {
        let mapped = options.map { Item(option: $0, secondaryText: secondaryTextById[$0.id]) }
        let scope = EnvironmentScope(rawEnvironmentId: selectedId)
        update(items: mapped, selectedScope: scope, isActive: explicitActive)
    }
    #endif

    func buildMenu() -> NSMenu {
        let menu = SshEnvironmentVisuals.buildGroupedMenu(
            items: items,
            fontSize: compact ? 12.5 : 13,
            minimumWidth: max(188, widthConstraint.constant)
        )
        menu.delegate = self
        let activeId = selectedScope.rawEnvironmentId
        for menuItem in menu.items {
            guard let itemId = menuItem.representedObject as? String else { continue }
            menuItem.target = self
            menuItem.action = #selector(menuItemSelected(_:))
            menuItem.isEnabled = true
            menuItem.state = (itemId == activeId) ? .on : .off
        }
        return menu
    }

    func presentMenu() {
        guard triggerButton.isEnabled, !isMenuTrackingOpen else { return }
        let menu = buildMenu()
        guard !menu.items.isEmpty else {
            if triggerButton.isHighlighted {
                triggerButton.isHighlighted = false
                triggerButton.needsDisplay = true
            }
            return
        }
        if let panel = window as? MenuFloatingPanel, !panel.isKeyWindow {
            panel.makeKey()
        }
        isMenuTrackingOpen = true
        triggerButton.isHighlighted = true
        triggerButton.needsDisplay = true
        defer {
            isMenuTrackingOpen = false
            triggerButton.isHighlighted = false
            triggerButton.hovered = false
            triggerButton.needsDisplay = true
            flushPendingUpdateIfNeeded()
        }
        Design.popUpMenu(menu, below: self)
    }

    @discardableResult
    func selectItem(id nextId: String, notify: Bool = true) -> Bool {
        guard items.contains(where: { $0.id == nextId }) else { return false }
        applySelection(id: nextId, notify: notify)
        return true
    }

    private func applyUpdate(items incoming: [Item], selectedScope resolvedScope: EnvironmentScope, isActive resolvedActive: Bool) {
        let wasHidden = isHidden
        if wasHidden {
            isHidden = false
        }
        self.items = incoming
        self.selectedScope = resolvedScope
        self.isActive = resolvedActive

        let fingerprint = RenderFingerprint(
            style: style,
            items: incoming,
            selectedId: resolvedScope.rawEnvironmentId,
            isActive: resolvedActive,
            locale: L10n.shared.currentLocale,
            maxWidth: maxWidth,
            minWidth: minWidth,
            pillHeight: pillHeight
        )
        if !wasHidden, renderedFingerprint == fingerprint {
            return
        }
        renderedFingerprint = fingerprint

        let selectedItem = incoming.first(where: { $0.scope == resolvedScope }) ?? incoming.first
        applyTriggerPresentation(for: selectedItem, scope: resolvedScope, isActive: resolvedActive)
        syncLayoutWidth()
    }

    private func cleanCollapsedTitle(for item: Item?, scope: EnvironmentScope) -> String {
        let kind = item?.kind ?? {
            switch scope {
            case .all: return .all
            case .local: return .local
            case .remote: return .ssh
            }
        }()
        switch kind {
        case .all:
            let raw = item?.hostLabel.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return raw.isEmpty ? L10n.t("ssh.scope.all", fallback: "全部") : raw
        case .local:
            let raw = item?.hostLabel.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return raw.isEmpty ? L10n.t("ssh.scope.local", fallback: "本机") : raw
        case .ssh:
            let rawHost = item?.hostLabel ?? scope.remoteEnvironmentId ?? ""
            let cleaned = SshEnvironmentResolver.cleanHostLabel(rawHost)
            return cleaned.isEmpty ? L10n.t("ssh.remote_fallback", fallback: "远端") : cleaned
        }
    }

    private func applyTriggerPresentation(for item: Item?, scope: EnvironmentScope, isActive: Bool) {
        let resolvedKind: Item.Kind = item?.kind ?? {
            switch scope {
            case .all: return .all
            case .local: return .local
            case .remote: return .ssh
            }
        }()
        triggerButton.visualStyle = style
        triggerButton.compact = compact
        triggerButton.isActiveState = isActive
        triggerButton.itemKind = resolvedKind
        triggerButton.hostState = item?.state ?? .online
        triggerButton.displayTitle = cleanCollapsedTitle(for: item, scope: scope)
        triggerButton.needsDisplay = true
    }

    private func fittedWidth() -> CGFloat {
        let leftPad: CGFloat = compact ? 9.0 : 10.0
        let trailingZone: CGFloat = compact ? 19.0 : 21.0
        let dotPart: CGFloat = (triggerButton.itemKind == .ssh) ? (5.5 + 4.5) : 0.0
        let iconSize: CGFloat = compact ? 11.5 : 12.5
        let iconPart: CGFloat = iconSize + 4.5
        let fontSize: CGFloat = compact ? 11.5 : 12.0
        let drawFont = NSFont.systemFont(ofSize: fontSize, weight: .medium)
        let titleW = ceil((triggerButton.displayTitle as NSString).size(withAttributes: [.font: drawFont]).width)
        let raw = leftPad + dotPart + iconPart + titleW + trailingZone
        return min(maxWidth, max(minWidth, ceil(raw)))
    }

    private func syncLayoutWidth() {
        let clamped = fittedWidth()
        widthConstraint.constant = clamped
        maxWidthConstraint.constant = maxWidth
        triggerButton.invalidateIntrinsicContentSize()
        invalidateIntrinsicContentSize()
    }

    private func flushPendingUpdateIfNeeded() {
        guard !isMenuTrackingOpen, let pending = pendingUpdate else { return }
        pendingUpdate = nil
        applyUpdate(items: pending.items, selectedScope: pending.selectedScope, isActive: pending.isActive)
    }

    func menuWillOpen(_ menu: NSMenu) {
        isMenuTrackingOpen = true
    }

    func menuDidClose(_ menu: NSMenu) {
        if !isMenuTrackingOpen {
            flushPendingUpdateIfNeeded()
        }
    }

    @objc private func triggerButtonPressed(_ sender: TriggerButton) {
        presentMenu()
    }

    @objc private func menuItemSelected(_ sender: NSMenuItem) {
        guard let nextId = sender.representedObject as? String else { return }
        applySelection(id: nextId, notify: true)
    }

    private func applySelection(id nextId: String, notify: Bool) {
        let nextScope = EnvironmentScope(rawEnvironmentId: nextId)
        selectedScope = nextScope
        if let matched = items.first(where: { $0.id == nextId }) {
            let nextActive = !nextScope.isAll
            isActive = nextActive
            applyTriggerPresentation(for: matched, scope: nextScope, isActive: nextActive)
            syncLayoutWidth()
            renderedFingerprint?.selectedId = nextId
            renderedFingerprint?.isActive = nextActive
        } else {
            renderedFingerprint = nil
        }
        if notify {
            onSelectScope?(nextScope)
            #if NATIVE_UI_TEST
            onSelectId?(nextId)
            #endif
        }
    }
}

#if NATIVE_UI_TEST
/// @testonly 仅保留供 Wave 3 更新 `test/native-ui.swift:5605-5638` 前保持类型检查通过；业务侧已全量迁移至 `EnvironmentContextPill`。
final class EnvironmentPickerControl: NSView {
    struct Option: Equatable {
        enum Kind: Equatable {
            case all
            case local
            case ssh
        }

        let id: String
        let hostLabel: String
        let kind: Kind
        let state: SshHostState
        let windowCount: Int
        let tooltip: String?

        init(
            id: String,
            hostLabel: String,
            kind: Kind,
            state: SshHostState = .online,
            windowCount: Int = 1,
            tooltip: String? = nil
        ) {
            self.id = id
            self.hostLabel = hostLabel
            self.kind = kind
            self.state = state
            self.windowCount = windowCount
            self.tooltip = tooltip
        }
    }

    private struct RenderFingerprint: Equatable {
        let options: [Option]
        var selectedId: String
        let usePopUp: Bool
        let locale: String
        var fitsSelectedTitleOnly: Bool
        var popUpMaxWidth: CGFloat?
    }

    var includeAll: Bool
    let compact: Bool
    var allTitle: String
    var localTitle: String
    var maxSegmentedRemoteCount: Int
    var maxSegmentedWidth: CGFloat?
    var fitsSelectedTitleOnly: Bool {
        didSet {
            guard oldValue != fitsSelectedTitleOnly else { return }
            if let cell = popUpButton.cell as? DesignPopUpCell {
                cell.fitsSelectedTitleOnly = fitsSelectedTitleOnly
            }
            if isUsingPopUp && !isHidden {
                syncPopUpLayoutWidth()
                invalidateIntrinsicContentSize()
            }
            renderedFingerprint?.fitsSelectedTitleOnly = fitsSelectedTitleOnly
        }
    }
    var popUpMaxWidth: CGFloat? {
        didSet {
            guard oldValue != popUpMaxWidth else { return }
            if isUsingPopUp && !isHidden {
                syncPopUpLayoutWidth()
                invalidateIntrinsicContentSize()
            }
            renderedFingerprint?.popUpMaxWidth = popUpMaxWidth
        }
    }
    var forcePopUpOnly: Bool {
        didSet {
            guard oldValue != forcePopUpOnly, !isHidden, !options.isEmpty else { return }
            let usePopUp = evaluateShouldUsePopUp(for: options)
            if usePopUp != isUsingPopUp {
                applyPresentationMode(options: options, selectedId: selectedId, animated: false, usePopUp: usePopUp)
                renderedFingerprint = RenderFingerprint(
                    options: options,
                    selectedId: selectedId,
                    usePopUp: usePopUp,
                    locale: L10n.shared.currentLocale,
                    fitsSelectedTitleOnly: fitsSelectedTitleOnly,
                    popUpMaxWidth: popUpMaxWidth
                )
            }
        }
    }

    let segmentedControl: DesignSegmentedControl
    let popUpButton: NSPopUpButton
    var onSelect: ((String) -> Void)?

    private let contentStack = NSStackView()
    private(set) var options: [Option] = []
    private(set) var selectedId: String = "local"
    private(set) var isUsingPopUp: Bool = false
    private var segmentIds: [String] = []
    private var renderedFingerprint: RenderFingerprint?

    init(
        includeAll: Bool = true,
        compact: Bool = false,
        allTitle: String = L10n.t("ssh.context.all", fallback: "总计"),
        localTitle: String = L10n.t("ssh.context.local", fallback: "本机"),
        maxSegmentedRemoteCount: Int = 1,
        maxSegmentedWidth: CGFloat? = nil,
        forcePopUpOnly: Bool = false,
        fitsSelectedTitleOnly: Bool = false,
        popUpMaxWidth: CGFloat? = nil
    ) {
        self.includeAll = includeAll
        self.compact = compact
        self.allTitle = allTitle
        self.localTitle = localTitle
        self.maxSegmentedRemoteCount = max(0, maxSegmentedRemoteCount)
        self.maxSegmentedWidth = maxSegmentedWidth
        self.forcePopUpOnly = forcePopUpOnly
        self.fitsSelectedTitleOnly = fitsSelectedTitleOnly
        self.popUpMaxWidth = popUpMaxWidth

        let segMaxW: CGFloat = compact ? 132 : 185
        self.segmentedControl = DesignSegmentedControl(
            labels: [],
            trackingMode: .selectOne,
            target: nil,
            action: nil,
            compact: compact,
            equalWidthSegments: false,
            maxSegmentWidth: segMaxW
        )
        self.popUpButton = DesignPopUpButton(frame: .zero, pullsDown: false)

        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        segmentedControl.target = self
        segmentedControl.action = #selector(segmentSelectionChanged(_:))

        popUpButton.controlSize = compact ? .small : .regular
        popUpButton.autoenablesItems = false
        popUpButton.target = self
        popUpButton.action = #selector(popUpSelectionChanged(_:))
        Design.applyControls(popUpButton)
        if let cell = popUpButton.cell as? DesignPopUpCell {
            cell.leadingSymbolName = nil
            cell.leadingImage = SshTerminalIcon.image(pointSize: compact ? 11.5 : 12.5)
            cell.fitsSelectedTitleOnly = fitsSelectedTitleOnly
        }

        contentStack.orientation = .horizontal
        contentStack.alignment = .centerY
        contentStack.spacing = 0
        contentStack.detachesHiddenViews = true
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        contentStack.addArrangedSubview(segmentedControl)
        contentStack.addArrangedSubview(popUpButton)
        addSubview(contentStack)
        NSLayoutConstraint.activate([
            contentStack.leadingAnchor.constraint(equalTo: leadingAnchor),
            contentStack.trailingAnchor.constraint(equalTo: trailingAnchor),
            contentStack.topAnchor.constraint(equalTo: topAnchor),
            contentStack.bottomAnchor.constraint(equalTo: bottomAnchor)
        ])

        popUpButton.isHidden = true
        let defaultA11y = L10n.t("ssh.picker.a11y", fallback: "切换环境视角")
        segmentedControl.setAccessibilityLabel(defaultA11y)
        popUpButton.setAccessibilityLabel(defaultA11y)
        setAccessibilityElement(false)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func setAccessibilityLabel(_ accessibilityLabel: String?) {
        super.setAccessibilityLabel(accessibilityLabel)
        let resolved = (accessibilityLabel?.isEmpty == false)
            ? accessibilityLabel
            : L10n.t("ssh.picker.a11y", fallback: "切换环境视角")
        segmentedControl.setAccessibilityLabel(resolved)
        popUpButton.setAccessibilityLabel(resolved)
    }

    override var intrinsicContentSize: NSSize {
        if isHidden {
            return .zero
        }
        return isUsingPopUp ? popUpButton.intrinsicContentSize : segmentedControl.intrinsicContentSize
    }

    override func layout() {
        super.layout()
        if !isHidden && !options.isEmpty {
            let shouldUsePopUp = evaluateShouldUsePopUp(for: options)
            if shouldUsePopUp != isUsingPopUp {
                applyPresentationMode(options: options, selectedId: selectedId, animated: false, usePopUp: shouldUsePopUp)
                renderedFingerprint = RenderFingerprint(
                    options: options,
                    selectedId: selectedId,
                    usePopUp: shouldUsePopUp,
                    locale: L10n.shared.currentLocale,
                    fitsSelectedTitleOnly: fitsSelectedTitleOnly,
                    popUpMaxWidth: popUpMaxWidth
                )
            }
        }
    }

    func update(options incoming: [Option], selectedId rawSelectedId: String, animated: Bool = false) {
        let effectiveOptions = includeAll ? incoming : incoming.filter { $0.kind != .all }
        let sshOptions = effectiveOptions.filter { $0.kind == .ssh }
        let normalizedSelected = rawSelectedId.trimmingCharacters(in: .whitespacesAndNewlines)

        if sshOptions.isEmpty && (normalizedSelected.isEmpty || normalizedSelected == "all" || normalizedSelected == "local" || !effectiveOptions.contains(where: { $0.id == normalizedSelected })) {
            let wasHidden = isHidden
            self.options = effectiveOptions
            self.selectedId = normalizedSelected.isEmpty ? (includeAll ? "all" : "local") : normalizedSelected
            self.segmentIds = []
            self.renderedFingerprint = nil
            if !wasHidden {
                self.isHidden = true
                invalidateIntrinsicContentSize()
            }
            return
        }

        let wasHidden = isHidden
        if wasHidden {
            self.isHidden = false
        }
        self.options = effectiveOptions
        let resolvedSelectedId: String
        if effectiveOptions.contains(where: { $0.id == normalizedSelected }) {
            resolvedSelectedId = normalizedSelected
        } else {
            resolvedSelectedId = effectiveOptions.first?.id ?? (includeAll ? "all" : "local")
        }
        self.selectedId = resolvedSelectedId

        let usePopUp = evaluateShouldUsePopUp(for: effectiveOptions)
        let fingerprint = RenderFingerprint(
            options: effectiveOptions,
            selectedId: resolvedSelectedId,
            usePopUp: usePopUp,
            locale: L10n.shared.currentLocale,
            fitsSelectedTitleOnly: fitsSelectedTitleOnly,
            popUpMaxWidth: popUpMaxWidth
        )
        if !wasHidden, renderedFingerprint == fingerprint {
            return
        }
        renderedFingerprint = fingerprint
        applyPresentationMode(options: effectiveOptions, selectedId: resolvedSelectedId, animated: animated, usePopUp: usePopUp)
    }

    private func evaluateShouldUsePopUp(for effectiveOptions: [Option]) -> Bool {
        let sshCount = effectiveOptions.filter { $0.kind == .ssh }.count
        if forcePopUpOnly && sshCount > 0 {
            return true
        }
        if sshCount > maxSegmentedRemoteCount {
            return true
        }
        let labels = effectiveOptions.map { segmentDisplayTitle(for: $0) }
        let estimatedWidth = estimatedSegmentedWidth(for: labels)
        let availableWidth = resolvedWidthBudget()
        return estimatedWidth > availableWidth
    }

    private func resolvedWidthBudget() -> CGFloat {
        let viewWidth = bounds.width > 40 ? bounds.width : (superview?.bounds.width ?? 0)
        if let maxSegmentedWidth {
            return viewWidth > 40 ? min(viewWidth, maxSegmentedWidth) : maxSegmentedWidth
        }
        if viewWidth > 40 {
            return viewWidth
        }
        return compact ? 250 : 380
    }

    private func estimatedSegmentedWidth(for labels: [String]) -> CGFloat {
        guard !labels.isEmpty else { return 0 }
        let fontSize: CGFloat = compact ? 11.5 : 12
        let hPad: CGFloat = compact ? 18 : 22
        let minW: CGFloat = compact ? 44 : 54
        let segMaxW: CGFloat = compact ? 132 : 185
        let font = NSFont.systemFont(ofSize: fontSize, weight: .semibold)
        var total: CGFloat = 6
        for (idx, label) in labels.enumerated() {
            let textW = ceil((label as NSString).size(withAttributes: [.font: font]).width) + hPad
            total += min(segMaxW, max(minW, textW))
            if idx > 0 { total += 2 }
        }
        return total
    }

    private func applyPresentationMode(
        options effectiveOptions: [Option],
        selectedId resolvedSelectedId: String,
        animated: Bool,
        usePopUp: Bool
    ) {
        isUsingPopUp = usePopUp
        if usePopUp {
            segmentedControl.isHidden = true
            popUpButton.isHidden = false
            rebuildPopUpMenu(options: effectiveOptions, selectedId: resolvedSelectedId)
        } else {
            popUpButton.isHidden = true
            segmentedControl.isHidden = false
            segmentIds = effectiveOptions.map(\.id)
            let labels = effectiveOptions.map { segmentDisplayTitle(for: $0) }
            let selectedIdx = segmentIds.firstIndex(of: resolvedSelectedId) ?? 0
            segmentedControl.updateSegments(
                labels: labels,
                tooltips: nil,
                selectedIndex: selectedIdx,
                animated: animated && Design.shouldAnimate(in: segmentedControl)
            )
        }
        invalidateIntrinsicContentSize()
    }

    private func segmentDisplayTitle(for option: Option) -> String {
        switch option.kind {
        case .all:
            return option.hostLabel.isEmpty ? allTitle : option.hostLabel
        case .local:
            return option.hostLabel.isEmpty ? localTitle : option.hostLabel
        case .ssh:
            let resolved = Self.resolvedDisplayHostLabel(option.hostLabel, fallbackId: option.id)
            return Self.compactHostLabel(resolved, maxLength: compact ? 12 : 16)
        }
    }

    private func rebuildPopUpMenu(options effectiveOptions: [Option], selectedId resolvedSelectedId: String) {
        let menu = NSMenu()
        menu.autoenablesItems = false

        let baseGroup = effectiveOptions.filter { $0.kind == .all || $0.kind == .local }
        let onlineSshGroup = effectiveOptions.filter { $0.kind == .ssh && $0.state.isOnlineOrAuthExpired }
        let offlineSshGroup = effectiveOptions.filter { $0.kind == .ssh && $0.state.isOfflineLike }

        for opt in baseGroup {
            menu.addItem(makeMenuItem(for: opt))
        }

        if !onlineSshGroup.isEmpty {
            if !menu.items.isEmpty {
                menu.addItem(.separator())
            }
            menu.addItem(NSMenuItem.sectionHeader(title: L10n.t("ssh.picker.group.online", fallback: "在线 SSH")))
            for opt in onlineSshGroup {
                menu.addItem(makeMenuItem(for: opt))
            }
        }

        if !offlineSshGroup.isEmpty {
            if !menu.items.isEmpty {
                menu.addItem(.separator())
            }
            menu.addItem(NSMenuItem.sectionHeader(title: L10n.t("ssh.picker.group.offline", fallback: "离线 / 历史 SSH")))
            for opt in offlineSshGroup {
                menu.addItem(makeMenuItem(for: opt))
            }
        }

        popUpButton.menu = menu
        if let targetItem = menu.items.first(where: { ($0.representedObject as? String) == resolvedSelectedId }) {
            popUpButton.select(targetItem)
        } else if let firstSelectable = menu.items.first(where: { $0.representedObject != nil }) {
            popUpButton.select(firstSelectable)
        }

        let selectedOption = effectiveOptions.first(where: { $0.id == resolvedSelectedId }) ?? effectiveOptions.first
        if let cell = popUpButton.cell as? DesignPopUpCell {
            cell.fitsSelectedTitleOnly = fitsSelectedTitleOnly
            applyLeadingIcon(for: selectedOption?.kind ?? .ssh, to: cell)
        }

        syncPopUpLayoutWidth()
    }

    private func resolvedPopUpMaxWidth() -> CGFloat {
        if let popUpMaxWidth {
            return popUpMaxWidth
        }
        return maxSegmentedWidth ?? (compact ? 210 : 280)
    }

    private func syncPopUpLayoutWidth() {
        let maxPopupW = resolvedPopUpMaxWidth()
        _ = Design.syncPopUpWidth(popUpButton, maxWidth: maxPopupW)
        if let existingMax = popUpButton.constraints.first(where: { $0.identifier == "env-picker-popup-max-width" }) {
            existingMax.constant = maxPopupW
        } else {
            let maxC = popUpButton.widthAnchor.constraint(lessThanOrEqualToConstant: maxPopupW)
            maxC.identifier = "env-picker-popup-max-width"
            maxC.priority = NSLayoutConstraint.Priority(999)
            maxC.isActive = true
        }
        popUpButton.invalidateIntrinsicContentSize()
    }

    private func applyLeadingIcon(for kind: Option.Kind, to cell: DesignPopUpCell) {
        switch kind {
        case .all:
            cell.leadingImage = nil
            cell.leadingSymbolName = "square.3.layers.3d"
        case .local:
            cell.leadingImage = nil
            cell.leadingSymbolName = "laptopcomputer"
        case .ssh:
            cell.leadingImage = SshTerminalIcon.image(pointSize: compact ? 11.5 : 12.5)
            cell.leadingSymbolName = nil
        }
    }

    private func makeMenuItem(for option: Option) -> NSMenuItem {
        let plainTitle: String
        let iconKind: EnvironmentContextPill.Item.Kind
        switch option.kind {
        case .all:
            plainTitle = option.hostLabel.isEmpty ? allTitle : option.hostLabel
            iconKind = .all
        case .local:
            plainTitle = option.hostLabel.isEmpty ? localTitle : option.hostLabel
            iconKind = .local
        case .ssh:
            let host = Self.resolvedDisplayHostLabel(option.hostLabel, fallbackId: option.id)
            iconKind = .ssh
            switch option.state {
            case .online:
                plainTitle = option.windowCount > 1 ? "\(host) (\(option.windowCount))" : host
            case .authExpired, .offlineRecent, .historicalOnly:
                plainTitle = "\(host) · \(option.state.localizedStateLabel)"
            }
        }

        let item = NSMenuItem(title: plainTitle, action: nil, keyEquivalent: "")
        item.representedObject = option.id
        item.isEnabled = true
        item.toolTip = nil
        item.image = SshEnvironmentVisuals.leadingIcon(for: iconKind, pointSize: 12)
        if option.kind == .ssh {
            item.attributedTitle = makeAttributedSshMenuTitle(for: option, plainTitle: plainTitle)
        }
        return item
    }

    private func makeAttributedSshMenuTitle(for option: Option, plainTitle: String) -> NSAttributedString {
        let dotColor = SshEnvironmentVisuals.statusDotColor(for: option.state)
        let dotChar = "\(SshEnvironmentVisuals.statusDotChar(for: option.state)) "
        let font = NSFont.menuFont(ofSize: compact ? 12 : 13)
        let dotFont = NSFont.systemFont(ofSize: 8.5, weight: .bold)
        let attr = NSMutableAttributedString(
            string: dotChar,
            attributes: [.foregroundColor: dotColor, .font: dotFont, .baselineOffset: 1.0]
        )
        let textColor: NSColor = option.state.isOfflineLike ? NSColor.secondaryLabelColor : NSColor.labelColor
        attr.append(NSAttributedString(string: plainTitle, attributes: [.foregroundColor: textColor, .font: font]))
        return attr
    }

    static func cleanHostLabel(_ raw: String) -> String {
        SshEnvironmentResolver.cleanHostLabel(raw)
    }

    private static func resolvedDisplayHostLabel(_ rawHost: String, fallbackId: String) -> String {
        let cleaned = cleanHostLabel(rawHost)
        if !cleaned.isEmpty {
            return cleaned
        }
        let cleanedId = cleanHostLabel(fallbackId)
        if !cleanedId.isEmpty {
            return cleanedId
        }
        return L10n.t("ssh.remote_fallback", fallback: "远端")
    }

    private static func compactHostLabel(_ raw: String, maxLength: Int) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return L10n.t("ssh.remote_fallback", fallback: "远端") }
        guard trimmed.count > maxLength, maxLength > 3 else { return trimmed }
        return String(trimmed.prefix(maxLength - 1)) + "…"
    }

    @objc private func segmentSelectionChanged(_ sender: DesignSegmentedControl) {
        let idx = sender.selectedSegment
        guard segmentIds.indices.contains(idx) else { return }
        let nextId = segmentIds[idx]
        selectedId = nextId
        renderedFingerprint?.selectedId = nextId
        onSelect?(nextId)
    }

    @objc private func popUpSelectionChanged(_ sender: NSPopUpButton) {
        guard let nextId = sender.selectedItem?.representedObject as? String else { return }
        selectedId = nextId
        if let cell = sender.cell as? DesignPopUpCell,
           let matched = options.first(where: { $0.id == nextId }) {
            applyLeadingIcon(for: matched.kind, to: cell)
            if fitsSelectedTitleOnly {
                syncPopUpLayoutWidth()
                invalidateIntrinsicContentSize()
            }
            sender.needsDisplay = true
        }
        renderedFingerprint?.selectedId = nextId
        onSelect?(nextId)
    }
}
#endif
