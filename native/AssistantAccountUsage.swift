import Cocoa

extension Assistant {
    private static let uiBootstrapCacheSchemaVersion = 2

    func loadUIBootstrapSnapshot() {
        #if !NATIVE_UI_TEST
        let url = state.appendingPathComponent("ui-bootstrap-cache-v1.json")
        guard let data = try? Data(contentsOf: url),
              let raw = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              (raw["schema"] as? Int) == Self.uiBootstrapCacheSchemaVersion else { return }
        if let dash = raw["dashboardSummary"] as? [String: Any] {
            cachedDashboardBootstrapSummary = dash
            if let usg = dash["usage"] as? [String: Any], let periodsMap = usg["periods"] as? [String: Any] {
                for p in ["today", "7d", "30d", "all"] {
                    if var item = periodsMap[p] as? [String: Any] {
                        item.removeValue(forKey: "periods")
                        cachedUsageReportsByPeriod[p] = item
                        bootstrappedUsagePeriods.insert(p)
                    }
                }
            }
        }
        if let accPayload = raw["accountsPayload"] as? [String: Any],
           let list = accPayload["accounts"] as? [[String: Any]] {
            cachedAccountsBootstrapPayload = accPayload
            let resolvedActive = accPayload["activeId"] as? String ?? (accPayload["currentAccountId"] as? String ?? "")
            activeAccountId = resolvedActive
            cachedAccounts = list.enumerated().sorted { lhs, rhs in
                let l = lhs.element["id"] as? String == resolvedActive
                let r = rhs.element["id"] as? String == resolvedActive
                return l == r ? lhs.offset < rhs.offset : l
            }.map(\.element)
            bootstrappedAccounts = true
        }
        if let usageByPeriod = raw["usageByPeriod"] as? [String: [String: Any]] {
            for (p, var report) in usageByPeriod where ["today", "7d", "30d", "all"].contains(p) {
                report.removeValue(forKey: "periods")
                cachedUsageReportsByPeriod[p] = report
                bootstrappedUsagePeriods.insert(p)
            }
        }
        #endif
    }

    func scheduleUIBootstrapSave() {
        #if !NATIVE_UI_TEST
        uiBootstrapSaveWorkItem?.cancel()
        let dashSnap = cachedDashboardBootstrapSummary
        let accSnap = cachedAccountsBootstrapPayload
        let usageSnap = cachedUsageReportsByPeriod
        let targetURL = state.appendingPathComponent("ui-bootstrap-cache-v1.json")
        let work = DispatchWorkItem { [weak self] in
            guard self != nil else { return }
            var doc: [String: Any] = ["schema": Self.uiBootstrapCacheSchemaVersion, "savedAt": Date().timeIntervalSince1970]
            if let dashSnap, JSONSerialization.isValidJSONObject(dashSnap) {
                doc["dashboardSummary"] = dashSnap
            }
            if let accSnap, JSONSerialization.isValidJSONObject(accSnap) {
                doc["accountsPayload"] = accSnap
            }
            var validUsage: [String: Any] = [:]
            for (k, v) in usageSnap where ["today", "7d", "30d", "all"].contains(k) && JSONSerialization.isValidJSONObject(v) {
                validUsage[k] = v
            }
            if !validUsage.isEmpty {
                doc["usageByPeriod"] = validUsage
            }
            guard JSONSerialization.isValidJSONObject(doc),
                  let bytes = try? JSONSerialization.data(withJSONObject: doc) else { return }
            try? bytes.write(to: targetURL, options: .atomic)
            chmod(targetURL.path, 0o600)
        }
        uiBootstrapSaveWorkItem = work
        uiBootstrapQueue.asyncAfter(deadline: .now() + 0.35, execute: work)
        #endif
    }

    func ingestUsagePeriods(from rawPeriods: [String: Any]?, fetchedAt: Date) {
        guard let rawPeriods else { return }
        for p in ["today", "7d", "30d", "all"] {
            guard var item = rawPeriods[p] as? [String: Any] else { continue }
            item.removeValue(forKey: "periods")
            cachedUsageReportsByPeriod[p] = item
            usageLastFetchTimeByPeriod[p] = fetchedAt
            usageLastSuccessAtByPeriod[p] = fetchedAt
            usageNextRetryAtByPeriod.removeValue(forKey: p)
            usageRemoteSyncRevisionByPeriod[p] = statusValue.remoteSyncRevision
            usageFetchErrorsByPeriod[p] = nil
            bootstrappedUsagePeriods.remove(p)
            if p == "today" {
                syncUsageEnvironmentsFromReport(item)
            }
        }
    }

    func fetchUsageSummary(period: String, environmentId: String? = nil, accountId: String? = nil, force: Bool = false, allowCached: Bool = true, completion: ((Result<[String: Any], Error>) -> Void)? = nil) {
        let trimmedEnv = environmentId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let resolvedEnv = trimmedEnv.isEmpty ? "all" : trimmedEnv
        let trimmedAcc = accountId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let resolvedAcc = trimmedAcc.isEmpty ? "all" : trimmedAcc
        let isDefaultAllFilter = (resolvedEnv == "all" && resolvedAcc == "all")
        let cacheKey = isDefaultAllFilter ? period : "\(period)|env=\(resolvedEnv)|acc=\(resolvedAcc)"
        let cacheRevisionMatches = (usageRemoteSyncRevisionByPeriod[cacheKey] ?? statusValue.remoteSyncRevision) == statusValue.remoteSyncRevision
        if !force && allowCached && cacheRevisionMatches,
           !bootstrappedUsagePeriods.contains(cacheKey),
           let cached = cachedUsageReportsByPeriod[cacheKey],
           let lastAt = usageLastFetchTimeByPeriod[cacheKey],
           Date().timeIntervalSince(lastAt) < 15.0,
           ((cached["summary"] as? [String: Any])?["failedDatabasesCount"] as? Int ?? 0) == 0 {
            completion?(.success(cached))
            return
        }
        if force {
            usageAutoHealAttemptsByPeriod[cacheKey] = 0
        }
        if let completion {
            usageWaitersByPeriod[cacheKey, default: []].append(completion)
        }
        if usageInFlightByPeriod[cacheKey] == true {
            if force {
                usagePendingForceByPeriod.insert(cacheKey)
                if resolvedAcc == "all" {
                    usageManualRefreshPeriods.insert(cacheKey)
                    menuPanelController?.syncHeaderRefreshState()
                }
            }
            return
        }
        usageInFlightByPeriod[cacheKey] = true
        let generation = (usageGenerationByPeriod[cacheKey] ?? 0) + 1
        usageGenerationByPeriod[cacheKey] = generation
        if force && resolvedAcc == "all" {
            usageManualRefreshPeriods.insert(cacheKey)
            menuPanelController?.syncHeaderRefreshState()
        }
        var payload: [String: Any] = ["command": "usage_summary", "period": period]
        if resolvedEnv != "all" { payload["environmentId"] = resolvedEnv }
        if resolvedAcc != "all" { payload["accountId"] = resolvedAcc }
        if force { payload["force"] = true }
        bridge.send(payload) { [weak self] response in
            guard let self else { return }
            if self.usagePendingForceByPeriod.remove(cacheKey) != nil {
                self.usageInFlightByPeriod[cacheKey] = false
                self.fetchUsageSummary(period: period, environmentId: resolvedEnv, accountId: resolvedAcc, force: true, allowCached: false)
                return
            }
            self.usageInFlightByPeriod[cacheKey] = false
            if resolvedAcc == "all" {
                self.usageManualRefreshPeriods.remove(cacheKey)
            }
            guard generation >= (self.usageGenerationByPeriod[cacheKey] ?? 0) else {
                if resolvedAcc == "all" {
                    self.menuPanelController?.syncHeaderRefreshState()
                }
                return
            }
            let fetchedAt = Date()
            self.usageLastFetchTimeByPeriod[cacheKey] = fetchedAt
            self.bootstrappedUsagePeriods.remove(cacheKey)
            let waiters = self.usageWaitersByPeriod.removeValue(forKey: cacheKey) ?? []
            var resolvedResponse = response
            switch response {
            case .failure(let error):
                self.usageFetchErrorsByPeriod[cacheKey] = error.localizedDescription
                self.usageNextRetryAtByPeriod[cacheKey] = fetchedAt.addingTimeInterval(15.0)
            case .success(let value):
                self.usageFetchErrorsByPeriod[cacheKey] = nil
                self.usageLastSuccessAtByPeriod[cacheKey] = fetchedAt
                self.usageNextRetryAtByPeriod.removeValue(forKey: cacheKey)
                self.usageRemoteSyncRevisionByPeriod[cacheKey] = self.statusValue.remoteSyncRevision
                if isDefaultAllFilter, let periodsMap = value["periods"] as? [String: Any] {
                    self.ingestUsagePeriods(from: periodsMap, fetchedAt: fetchedAt)
                }
                var cleanValue = value
                cleanValue.removeValue(forKey: "periods")
                self.cachedUsageReportsByPeriod[cacheKey] = cleanValue
                self.syncUsageEnvironmentsFromReport(cleanValue)
                resolvedResponse = .success(cleanValue)
                if isDefaultAllFilter {
                    self.scheduleUIBootstrapSave()
                }
                let failedCount = (cleanValue["summary"] as? [String: Any])?["failedDatabasesCount"] as? Int ?? 0
                if failedCount == 0 {
                    self.usageAutoHealAttemptsByPeriod[cacheKey] = 0
                } else {
                    #if !NATIVE_UI_TEST
                    let attempts = self.usageAutoHealAttemptsByPeriod[cacheKey, default: 0]
                    if attempts < 2 && !self.usageAutoHealPendingPeriods.contains(cacheKey) && self.reachable && !self.quitting {
                        self.usageAutoHealAttemptsByPeriod[cacheKey] = attempts + 1
                        self.usageAutoHealPendingPeriods.insert(cacheKey)
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
                            guard let self else { return }
                            self.usageAutoHealPendingPeriods.remove(cacheKey)
                            guard self.reachable && !self.quitting else { return }
                            self.fetchUsageSummary(period: period, environmentId: resolvedEnv, accountId: resolvedAcc, force: false, allowCached: false)
                        }
                    }
                    #endif
                }
                if force && self.contentVisible && self.currentPage == 2 {
                    self.usagePage?.update(force: false)
                }
                if force && isDefaultAllFilter && period == "today" && self.contentVisible && self.currentPage == 0 {
                    self.overview?.update(force: false)
                }
            }
            if resolvedAcc == "all" {
                self.menuPanelController?.onUsageReportUpdated(period: period, environmentId: resolvedEnv, result: resolvedResponse)
                self.menuPanelController?.syncHeaderRefreshState()
            }
            for waiter in waiters { waiter(resolvedResponse) }
        }
    }

    func refreshSingleAccountQuota(id: String, completion: ((Result<[String: Any], Error>) -> Void)? = nil) {
        guard !id.isEmpty else {
            completion?(.failure(BackendFailure(message: L10n.t("assistant_account.invalid_id"))))
            return
        }
        guard reachable else {
            completion?(.failure(BackendFailure(message: L10n.t("assistant_account.service_not_ready"))))
            return
        }
        guard !refreshingAccountIds.contains(id) else {
            completion?(.failure(BackendFailure(message: L10n.t("assistant_account.refresh_in_progress"))))
            return
        }
        singleAccountRefreshErrors[id] = nil
        singleAccountRefreshNotices[id] = nil
        refreshingAccountIds.insert(id)
        updateQuotaRefreshControls()
        menuPanelController?.syncFromAssistant()
        bridge.send(["command": "quota_refresh", "id": id]) { [weak self] response in
            guard let self else { return }
            self.refreshingAccountIds.remove(id)
            switch response {
            case .failure(let error):
                self.singleAccountRefreshErrors[id] = error.localizedDescription
                self.singleAccountRefreshNotices[id] = nil
            case .success(let value):
                self.singleAccountRefreshErrors[id] = nil
                if value["standbyDeferred"] as? Bool == true {
                    let notice = (value["notice"] as? String ?? value["message"] as? String)?
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    self.singleAccountRefreshNotices[id] = (notice?.isEmpty == false) ? notice : nil
                } else {
                    self.singleAccountRefreshNotices[id] = nil
                }
                if let globalErr = self.quotaRefreshError, !InterfaceText.isMultiAccountSummary(globalErr) {
                    self.quotaRefreshError = nil
                }
                if value["environments"] != nil || value["remoteSessions"] != nil {
                    self.syncEnvironmentsFromPayload(value, notifyUI: false)
                }
                if var updated = value["account"] as? [String: Any] {
                    if updated["id"] == nil { updated["id"] = id }
                    self.applyRefreshedAccountInPlace(updated, id: id)
                }
                self.fetchAccountList(notifyPage: true)
                self.overview?.update(force: true)
                self.refresh()
            }
            self.updateQuotaRefreshControls()
            self.menuPanelController?.syncFromAssistant()
            completion?(response)
        }
    }

    func applyRefreshedAccountInPlace(_ updated: [String: Any], id: String) {
        if let idx = cachedAccounts.firstIndex(where: { ($0["id"] as? String) == id }) {
            cachedAccounts[idx] = updated
        }
        if var payload = cachedAccountsBootstrapPayload,
           var list = payload["accounts"] as? [[String: Any]],
           let idx = list.firstIndex(where: { ($0["id"] as? String) == id }) {
            list[idx] = updated
            payload["accounts"] = list
            cachedAccountsBootstrapPayload = payload
            accountsPage?.fetch(payload)
        } else if !cachedAccounts.isEmpty {
            accountsPage?.fetch([
                "accounts": cachedAccounts,
                "activeId": activeAccountId,
                "currentAccountId": activeAccountId,
                "pendingSwitch": accountsPage?.hasPendingSwitch ?? false
            ])
        }
        scheduleUIBootstrapSave()
    }

    /// @testonly 保留供 test/native-ui.swift 验证菜单切号状态机，生产环境已统一由 MenuPanelController 承载。
    func buildAccountSwitchMenu() -> NSMenu {
        let switchSubmenu = NSMenu(title: L10n.t("assistant_account.switch_submenu"))
        switchSubmenu.showsStateColumn = true
        if cachedAccounts.isEmpty {
            let emptyItem = NSMenuItem(title: L10n.t("assistant_account.no_snapshots"), action: nil, keyEquivalent: "")
            emptyItem.isEnabled = false
            switchSubmenu.addItem(emptyItem)
        } else {
            let ordered = cachedAccounts.enumerated().sorted { lhs, rhs in
                let l = lhs.element["id"] as? String == activeAccountId
                let r = rhs.element["id"] as? String == activeAccountId
                return l == r ? lhs.offset < rhs.offset : l
            }.map(\.element)
            for acc in ordered {
                let id = acc["id"] as? String ?? ""
                let accEmail = acc["email"] as? String ?? L10n.t("assistant_account.unknown_account")
                let label = acc["name"] as? String ?? ""
                let displayName = label.isEmpty ? accEmail : "\(label) · \(accEmail)"
                let accTier = AccountIdentity.normalizeTier(acc["subscription_tier"] as? String)
                let title = [displayName, accTier, QuotaPresentation.menuQuotaText(acc)].filter { !$0.isEmpty }.joined(separator: " · ")
                let accItem = NSMenuItem(title: title, action: #selector(switchAccountFromMenu(_:)), keyEquivalent: "")
                accItem.target = self
                accItem.representedObject = id
                let isBlocked = acc["disabled"] as? Bool == true || acc["validation_blocked"] as? Bool == true
                let isCurrent = id == activeAccountId || (activeAccountId.isEmpty && accEmail == statusValue.activeAccountEmail)
                accItem.isEnabled = !isBlocked && !isCurrent
                if isCurrent { accItem.state = .on }
                switchSubmenu.addItem(accItem)
            }
        }
        switchSubmenu.addItem(.separator())
        let manageItem = NSMenuItem(title: L10n.t("assistant_account.manage_accounts"), action: #selector(showAccountsFromMenuCard), keyEquivalent: "")
        manageItem.target = self
        switchSubmenu.addItem(manageItem)
        return switchSubmenu
    }
    @objc func showAccountsFromMenuCard() {
        closeMenuPopover()
        showAccounts()
    }
    func switchAccountByIdFromMenu(_ id: String) {
        guard !id.isEmpty, id != activeAccountId else { return }
        closeMenuPopover()
        let targetAccount = cachedAccounts.first(where: { ($0["id"] as? String) == id })
        let email = targetAccount?["email"] as? String ?? ""
        let name = targetAccount?["name"] as? String ?? ""
        requestInteractiveAccountSwitch(id: id, email: email, name: name)
    }

    func invalidateUsageReportCache() {
        cachedUsageReportsByPeriod.removeAll()
        usageLastFetchTimeByPeriod.removeAll()
        usageLastSuccessAtByPeriod.removeAll()
        usageNextRetryAtByPeriod.removeAll()
        usageRemoteSyncRevisionByPeriod.removeAll()
        usageFetchErrorsByPeriod.removeAll()
        bootstrappedUsagePeriods.removeAll()
        overview?.metricsKey = ""
        usagePage?.metricsKey = ""
        if contentVisible && currentPage == 2 {
            usagePage?.fetch()
        }
        if menuTracking || isMenuPanelShown {
            let periodKey = menuPanelController.map { MenuPanelController.periods[$0.selectedPeriod] } ?? "today"
            let envId = menuPanelController?.selectedEnvironmentId ?? usageFilterScope.rawEnvironmentId
            fetchUsageSummary(period: periodKey, environmentId: envId, force: true, allowCached: false)
            menuPanelController?.syncFromAssistant()
        }
    }

    /// @testonly 保留供 test/native-ui.swift 验证菜单切号状态机，生产环境已统一由 MenuPanelController 承载。
    @objc func switchAccountFromMenu(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        switchAccountByIdFromMenu(id)
    }
    func requestInteractiveAccountSwitch(id: String, email: String, name: String, completion: (() -> Void)? = nil) {
        guard !id.isEmpty, !accountSwitchInFlight, reachable else { return }
        accountSwitchInFlight = true
        bridge.send(["command": "account_switch_preflight", "id": id]) { [weak self] result in
            guard let self else { return }
            guard case .success(let payload) = result else {
                self.accountSwitchInFlight = false
                if case .failure(let error) = result {
                    self.showMessage(L10n.t("assistant_account.preflight_failed", ["error": error.localizedDescription]), error: true)
                }
                return
            }
            let appRunning = payload["appRunning"] as? Bool == true
            let insidersRunning = payload["insidersRunning"] as? Bool == true
            let stableRunning = (payload["stableRunning"] as? Bool) ?? (appRunning && !insidersRunning)
            let shouldQuitAndRelaunch = !insidersRunning && (stableRunning || Self.isAntigravityRunning())
            let hasRunningTask = (payload["hasRunningTask"] as? Bool == true) || (payload["safe"] as? Bool == false)
            let display: String
            if !name.isEmpty && name.caseInsensitiveCompare(email) != .orderedSame && !email.isEmpty {
                display = L10n.shared.isEnglish ? "\(name) (\(email))" : "\(name)（\(email)）"
            } else {
                display = email.isEmpty ? (name.isEmpty ? L10n.t("assistant_account.target_fallback") : name) : email
            }
            if insidersRunning {
                self.accountSwitchInFlight = false
                self.showMessage(L10n.t("assistant_account.insiders_running"), error: true)
                return
            }
            let performSwitch = { [weak self] in
                guard let self else { return }
                self.suppressLifecycleAutoQuit(seconds: 75.0)
                self.bridge.send(["command": "account_switch", "id": id, "target": "all", "autoRefreshToken": true]) { [weak self] response in
                    guard let self else { return }; self.accountSwitchInFlight = false
                    switch response {
                    case .failure(let error):
                        if shouldQuitAndRelaunch { self.relaunchAntigravityAfterSwitch() }
                        self.showMessage(L10n.t("assistant_account.switch_failed", ["error": error.localizedDescription]), error: true)
                    case .success(let value):
                        self.singleAccountRefreshNotices[id] = nil
                        self.singleAccountRefreshErrors[id] = nil
                        self.showMessage(value["message"] as? String ?? L10n.t("assistant_account.switched_to", ["email": email]))
                        if shouldQuitAndRelaunch { self.relaunchAntigravityAfterSwitch() }
                        self.invalidateUsageReportCache()
                        self.refresh(); self.accountsPage?.fetch(); self.overview?.fetch(); completion?()
                    }
                }
            }
            let execute: (Bool) -> Void = { [weak self] confirmed in
                guard let self else { return }
                guard confirmed else { self.accountSwitchInFlight = false; return }
                #if NATIVE_UI_TEST
                if self.confirmSwitchForTesting != nil {
                    self.bridge.send(["command": "account_switch", "id": id, "target": "all", "autoRefreshToken": true]) { [weak self] response in
                        guard let self else { return }; self.accountSwitchInFlight = false
                        if case .success(let value) = response {
                            self.singleAccountRefreshNotices[id] = nil
                            self.singleAccountRefreshErrors[id] = nil
                            self.showMessage(value["message"] as? String ?? L10n.t("assistant_account.switched_to", ["email": email]))
                            if shouldQuitAndRelaunch { self.relaunchAntigravityAfterSwitch() }
                            self.invalidateUsageReportCache()
                            self.refresh(); self.accountsPage?.fetch(); self.overview?.fetch(); completion?()
                        }
                    }
                    return
                }
                #endif
                if shouldQuitAndRelaunch {
                    self.quitAntigravityAndWait { [weak self] exited in
                        guard let self else { return }
                        guard exited else {
                            self.accountSwitchInFlight = false
                            self.showMessage(L10n.t("assistant_account.quit_first"), error: true)
                            return
                        }
                        performSwitch()
                    }
                } else {
                    performSwitch()
                }
            }
            let sshCount = payload["activeSshWindowsCount"] as? Int ?? 0
            let sshHostsList = payload["activeSshHosts"] as? [String] ?? []
            let sep = L10n.shared.isEnglish ? ", " : "、"
            let sshHostsSummary = sshHostsList.isEmpty ? "SSH" : sshHostsList.joined(separator: sep)
            var sshWarningSuffix = sshCount > 0
                ? "\n\n" + L10n.t("ssh.preflight.active_windows_warning", ["count": sshCount, "hosts": sshHostsSummary])
                : ""
            let sharedRemoteHosts = SshEnvironmentResolver.matchingHosts(
                forAccount: ["id": id, "email": email],
                hosts: self.canonicalRemoteHosts()
            ).filter { $0.state.isOnlineOrAuthExpired }
            if !sharedRemoteHosts.isEmpty {
                let sharedHostsSummary = sharedRemoteHosts.map(\.hostLabel).joined(separator: sep)
                sshWarningSuffix += "\n\n" + L10n.t(
                    "accounts.ssh.shared_switch_confirm_note",
                    ["hosts": sharedHostsSummary],
                    fallback: L10n.shared.isEnglish
                        ? "Note: This account is also active on SSH host(s) (\(sharedHostsSummary)). Switching locally won't alter remote logins, though SSH windows will briefly disconnect during restart."
                        : "提示：该账号当前也正在 SSH 主机（\(sharedHostsSummary)）上使用；切换本机账号不会修改远端登录态，但本机重启期间 SSH 窗口会暂时断连。"
                )
            }
            if hasRunningTask {
                #if NATIVE_UI_TEST
                if self.confirmSwitchForTesting != nil {
                    self.accountSwitchInFlight = false
                    return
                }
                #endif
                let busyAlert = NSAlert()
                busyAlert.alertStyle = .warning
                busyAlert.messageText = L10n.t("assistant_account.switch_prompt_title", ["display": display])
                busyAlert.informativeText = L10n.t("assistant_account.switch_busy_body") + sshWarningSuffix
                busyAlert.addButton(withTitle: L10n.t("assistant_account.switch_busy_confirm"))
                busyAlert.addButton(withTitle: L10n.t("common.cancel"))
                self.presentSheetAlert(busyAlert) { execute($0 == .alertFirstButtonReturn) }
                return
            }
            #if NATIVE_UI_TEST
            if let confirm = self.confirmSwitchForTesting { confirm(display, execute); return }
            #endif
            let alert = NSAlert()
            alert.alertStyle = .informational
            alert.messageText = L10n.t("assistant_account.switch_prompt_title", ["display": display])
            alert.informativeText = (appRunning
                ? L10n.t("assistant_account.switch_ready_body")
                : L10n.t("assistant_account.switch_stopped_body")) + sshWarningSuffix
            alert.addButton(withTitle: L10n.t("assistant_account.switch_confirm"))
            alert.addButton(withTitle: L10n.t("common.cancel"))
            self.presentSheetAlert(alert) { execute($0 == .alertFirstButtonReturn) }
        }
    }
    @objc func refreshAccountQuotas() {
        guard !quotaRefreshing, pendingAccountTaskId == nil, reachable else { return }
        quotaRefreshing = true; quotaRefreshStartedAt = Date(); quotaRefreshError = nil; updateQuotaRefreshControls()
        let poll = Timer(timeInterval: 0.35, repeats: true) { [weak self] _ in self?.refresh(taskPollOnly: true) }
        quotaRefreshPollTimer?.invalidate(); quotaRefreshPollTimer = poll
        RunLoop.main.add(poll, forMode: .common); RunLoop.main.add(poll, forMode: .eventTracking)
        bridge.send(["command": "quota_refresh_start"]) { [weak self] response in
            guard let self else { return }
            switch response {
            case .failure(let error): self.finishQuotaRefresh(error: error.localizedDescription)
            case .success(let value):
                guard let id = value["taskId"] as? String, !id.isEmpty else { self.finishQuotaRefresh(error: L10n.t("assistant_account.refresh_task_missing")); return }
                self.pendingAccountTaskId = id; self.refresh(taskPollOnly: true)
            }
        }
    }
    func finishQuotaRefresh(error: String?) {
        quotaRefreshing = false; quotaRefreshStartedAt = nil; pendingAccountTaskId = nil; quotaRefreshError = error; quotaRefreshPollTimer?.invalidate(); quotaRefreshPollTimer = nil
        let now = Date()
        lastAutoQuotaRefreshTriggerAt = now
        pendingAutoQuotaRefresh = false
        if let minutes = configuration?.value.quotaRefreshMinutes, [5, 10, 15, 30, 60].contains(minutes) {
            nextScheduledQuotaRefreshAt = now.addingTimeInterval(TimeInterval(minutes * 60))
        }
        if error == nil {
            singleAccountRefreshErrors.removeAll()
            singleAccountRefreshNotices.removeAll()
        }
        configureQuotaRefreshTimer(preserveSchedule: true)
        updateQuotaRefreshControls(); fetchAccountList(notifyPage: true); overview?.update(force: true); menuPanelController?.syncFromAssistant(); refresh()
    }
    func updateQuotaRefreshControls() {
        let available = reachable && (pendingAccountTaskId == nil || quotaRefreshing)
        let overviewActiveId = ((overview?.lastSuccessfulSummary?["accounts"] as? [String: Any])?["currentAccountId"] as? String) ?? activeAccountId
        func apply(_ view: NSView) {
            if let control = view as? QuotaRefreshButton {
                let cid = control.identifier?.rawValue ?? ""
                let isOverviewHeroBtn = (control === overview?.refreshQuotaButton)
                if isOverviewHeroBtn && selectedOverviewRemoteSession() != nil {
                    control.applyGlobalRefreshState(globalBusy: remoteQuotaRefreshing, available: available, error: nil, cardBusy: remoteQuotaRefreshing)
                } else {
                    let targetId = isOverviewHeroBtn ? overviewActiveId : cid
                    let isCardBusy = !targetId.isEmpty && refreshingAccountIds.contains(targetId)
                    let resolvedErr = (isOverviewHeroBtn && !targetId.isEmpty ? singleAccountRefreshErrors[targetId] : nil) ?? quotaRefreshError
                    control.applyGlobalRefreshState(globalBusy: quotaRefreshing, available: available, error: resolvedErr, cardBusy: isCardBusy)
                }
            }
            for child in view.subviews { apply(child) }
        }
        apply(pageHost)
        updateStatusItemState()
        if menuTracking || isMenuPanelShown {
            menuPanelController?.syncFromAssistant()
        }
    }
    func fetchAccountList(notifyPage: Bool = true, completion: ((Result<[String: Any], Error>) -> Void)? = nil) {
        if let completion { accountListWaiters.append(completion) }
        if notifyPage { accountListPendingNotifyPage = true }
        guard !accountListInFlight else {
            accountListPendingRefetch = true
            return
        }
        accountListInFlight = true
        accountListGeneration += 1
        let generation = accountListGeneration
        let requestRevision = statusValue.accountsRevision
        let requestLiveEmail = statusValue.liveAccountEmail
        accountListInFlightRevision = requestRevision
        accountListInFlightLiveEmail = requestLiveEmail
        lastAccountListFetchAt = Date()
        bridge.send(["command": "account_list"]) { [weak self] res in
            guard let self else { return }
            let shouldPendingRefetch = self.accountListPendingRefetch
            let pendingNotify = self.accountListPendingNotifyPage
            self.accountListPendingRefetch = false
            self.accountListInFlight = false
            let waiters = self.accountListWaiters
            let shouldNotifyPage = self.accountListPendingNotifyPage
            self.accountListWaiters.removeAll()
            self.accountListPendingNotifyPage = false
            if case .success(let val) = res, generation >= self.accountListGeneration, let list = val["accounts"] as? [[String: Any]] {
                self.hasLoadedAccountsOnce = true
                self.bootstrappedAccounts = false
                if val["environments"] != nil || val["environmentsRevision"] != nil || val["focusedEnvironmentId"] != nil {
                    self.syncEnvironmentsFromPayload(val, notifyUI: false)
                }
                self.cachedAccountsBootstrapPayload = val
                if self.statusValue.accountsRevision == requestRevision {
                    self.lastFetchedAccountsRevision = requestRevision
                }
                if self.statusValue.liveAccountEmail == requestLiveEmail {
                    self.lastFetchedLiveEmail = requestLiveEmail
                }
                var resolvedActiveId = val["activeId"] as? String ?? (val["currentAccountId"] as? String ?? "")
                if !self.statusValue.liveAccountEmail.isEmpty,
                   let live = list.first(where: { ($0["email"] as? String ?? "").caseInsensitiveCompare(self.statusValue.liveAccountEmail) == .orderedSame }),
                   let id = live["id"] as? String {
                    resolvedActiveId = id
                }
                self.activeAccountId = resolvedActiveId
                self.cachedAccounts = list.enumerated().sorted { lhs, rhs in
                    let l = lhs.element["id"] as? String == resolvedActiveId
                    let r = rhs.element["id"] as? String == resolvedActiveId
                    return l == r ? lhs.offset < rhs.offset : l
                }.map(\.element)
                if let cachedRec = self.cachedRecommendedAccountId,
                   cachedRec == resolvedActiveId || !self.cachedAccounts.contains(where: { ($0["id"] as? String) == cachedRec }) {
                    self.cachedRecommendedAccountId = nil
                }
                if let globalErr = self.quotaRefreshError, InterfaceText.isMultiAccountSummary(globalErr) {
                    let anyAccountHasIssue = self.cachedAccounts.contains { acc in
                        if acc["disabled"] as? Bool == true { return false }
                        let err = (acc["quota_refresh_error"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                        if !err.isEmpty && !InterfaceText.isInternalDualWindowError(err) { return true }
                        if let quota = acc["quota"] as? [String: Any],
                           let stale = quota["stale_groups"] as? [[String: Any]], !stale.isEmpty {
                            return true
                        }
                        return false
                    }
                    if !anyAccountHasIssue {
                        self.quotaRefreshError = nil
                    }
                }
                self.scheduleUIBootstrapSave()
                self.updateQuotaRefreshControls()
                self.menuPanelController?.syncFromAssistant()
                if shouldNotifyPage { self.accountsPage?.fetch(val) }
                self.refreshRecommendedAccountIfNeeded()
                self.checkAndTriggerOverdueQuotaRefreshIfNeeded()
            }
            for waiter in waiters { waiter(res) }
            if shouldPendingRefetch {
                self.fetchAccountList(notifyPage: pendingNotify)
            }
        }
    }

    func refreshRecommendedAccountIfNeeded(force: Bool = false) {
        if cachedAccounts.count <= 1 {
            if cachedRecommendedAccountId != nil {
                cachedRecommendedAccountId = nil
                accountsPage?.recommendedAccountId = nil
                menuPanelController?.syncFromAssistant(updateSize: true)
            }
            return
        }
        guard reachable,
              !(contentVisible && currentPage == 1),
              (menuTracking || isMenuPanelShown),
              !recommendationPreviewInFlight else { return }
        let fingerprint = "\(lastFetchedAccountsRevision)|\(activeAccountId)|\(cachedAccounts.count)"
        guard force || fingerprint != lastRecommendedAccountsFingerprint else { return }
        recommendationPreviewInFlight = true
        bridge.send(["command": "auto_switch_best", "preview": true]) { [weak self] res in
            guard let self else { return }
            self.recommendationPreviewInFlight = false
            guard case .success(let value) = res else { return }
            self.lastRecommendedAccountsFingerprint = fingerprint
            let candidate = value["account"] as? [String: Any]
            let candidateId = candidate?["id"] as? String
            let shouldSwitch = value["shouldSwitch"] as? Bool ?? false
            let nextId = (shouldSwitch && candidateId != nil && candidateId != self.activeAccountId) ? candidateId : nil
            if self.cachedRecommendedAccountId != nextId {
                self.cachedRecommendedAccountId = nextId
                self.accountsPage?.recommendedAccountId = nextId
                self.menuPanelController?.syncFromAssistant(updateSize: true)
            }
        }
    }
    func failPendingQuotaRefresh(_ message: String, cancelBackendTask: Bool = false) {
        guard quotaRefreshing || pendingAccountTaskId != nil else { return }
        let staleTaskId = pendingAccountTaskId
        quotaRefreshing = false; pendingAccountTaskId = nil; quotaRefreshStartedAt = nil
        quotaRefreshError = message; quotaRefreshPollTimer?.invalidate(); quotaRefreshPollTimer = nil
        if cancelBackendTask, let staleTaskId, !staleTaskId.isEmpty, reachable {
            bridge.send(["command": "task_cancel", "id": staleTaskId]) { _ in }
        }
    }
}
