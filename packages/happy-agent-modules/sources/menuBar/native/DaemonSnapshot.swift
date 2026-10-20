import Foundation

/// One task or bot, and whether it or any agent working under it is busy right now.
struct WorkEntry {
    let id: String
    let name: String
    let isWorking: Bool
}

/// Which quota window this is, in the order a row shows its gauges from left to right. Fable's
/// allowance never gets a gauge; it is only ever named in the tooltip.
enum PlanWindowKind: Int, Comparable {
    case session
    case week
    case month
    case fable

    var label: String {
        switch self {
        case .session: return "Session"
        case .week: return "Week"
        case .month: return "Month"
        case .fable: return "Fable"
        }
    }

    static func < (left: PlanWindowKind, right: PlanWindowKind) -> Bool {
        left.rawValue < right.rawValue
    }
}

/// One named quota window: how much is spent, and when it starts over.
struct PlanWindow {
    let kind: PlanWindowKind
    let usedPercent: Double
    let resetsAt: Date?

    /// What is left, the way a battery reads: 100 when nothing is spent, 0 when it is gone.
    var remainingPercent: Double { min(max(100 - usedPercent, 0), 100) }
    var isFull: Bool { usedPercent >= 100 }
}

/// One provider account's plan: the windows its row draws as gauges, and Claude's separate Fable
/// allowance, which has no gauge of its own.
struct PlanEntry {
    let vendorType: String
    let vendor: String
    let name: String
    let planName: String?
    let windows: [PlanWindow]
    let fable: PlanWindow?
    let exhausted: Bool

    /// Every window the vendor reported that the menu speaks about, in tooltip order.
    var allWindows: [PlanWindow] { windows + (fable.map { [$0] } ?? []) }

    /// The window that holds the account back: while any window is full, Fable included, the one
    /// that resets last, since the account stays blocked until every full window has started over;
    /// otherwise the gauge with the least left.
    var limiting: PlanWindow? {
        let full = allWindows.filter(\.isFull)
        if !full.isEmpty {
            return full.max { ($0.resetsAt ?? .distantPast) < ($1.resetsAt ?? .distantPast) }
        }
        return windows.max { $0.usedPercent < $1.usedPercent }
    }

    var isBlocked: Bool { exhausted || allWindows.contains(where: \.isFull) }

    /// Whether this gauge is the one keeping a blocked account blocked. Fable is a weekly
    /// allowance without a gauge, so when it is the block the week's gauge stands in for it.
    func isBlocking(_ window: PlanWindow) -> Bool {
        guard isBlocked, let limiting else { return false }
        return limiting.kind == window.kind || (limiting.kind == .fable && window.kind == .week)
    }
}

/// The accounts of one vendor, in the order the desktop model picker lists them.
struct PlanVendor {
    let type: String
    let name: String
    let plans: [PlanEntry]

    /// The gauge columns this vendor's rows share, so every row lines up under one header.
    var columns: [PlanWindowKind] {
        Array(Set(plans.flatMap { $0.windows.map(\.kind) })).sorted()
    }
}

struct TokenTotals {
    var input = 0
    var output = 0

    var total: Int { input + output }
    var isEmpty: Bool { total == 0 }
}

/// Everything the menu draws, as of the last successful read.
struct DaemonSnapshot {
    var connected = false
    var work: [WorkEntry] = []
    var vendors: [PlanVendor] = []
    var day = TokenTotals()

    var working: [WorkEntry] { work.filter(\.isWorking) }
}

/// Reads the daemon's tasks, bots, and usage into the shape the menu draws.
///
/// Tasks and bots are the units a person thinks in, so the menu lists nothing else: a subtask or
/// subagent is not a row of its own but makes the task or bot it works under count as working.
enum DaemonSnapshotReader {
    /// `nil` when the daemon is not answering. A daemon without tasks answers `404` on the task
    /// list, which leaves the bots alone rather than looking like a lost connection.
    static func work(botsBody: Any?, tasksBody: Any?) -> [WorkEntry]? {
        guard let bots = (botsBody as? [String: Any])?["bots"] as? [[String: Any]] else {
            return nil
        }
        let tasks = (tasksBody as? [String: Any])?["tasks"] as? [[String: Any]] ?? []
        return (bots + tasks).compactMap { row in
            guard let id = row["id"] as? String, row["status"] as? String == "active" else {
                return nil
            }
            let agent = row["agent"] as? [String: Any]
            return WorkEntry(
                id: id,
                name: row["name"] as? String ?? "Untitled",
                isWorking: agent.map(isWorking) ?? false
            )
        }
    }

    /// An agent is working while it runs a turn, while one of its subagents runs, or while any
    /// subtask under it is working.
    private static func isWorking(_ agent: [String: Any]) -> Bool {
        if let status = agent["status"] as? String, status != "idle" { return true }
        if let subagents = agent["subagents"] as? [String: Any],
            (number(subagents["running"]) ?? 0) > 0
        {
            return true
        }
        let subtasks = agent["subtasks"] as? [[String: Any]] ?? []
        return subtasks.contains(where: isWorking)
    }

    /// Accounts arrive in configuration order, which is the order the desktop model picker uses:
    /// a vendor appears where its first account does, and its accounts follow in the same order.
    /// Hidden accounts are left out there, so they are left out here.
    static func plans(usageBody: Any?, configBody: Any? = nil) -> ([PlanVendor], TokenTotals)? {
        guard let body = usageBody as? [String: Any] else { return nil }
        let config = (configBody as? [String: Any])?["config"] as? [String: Any]
        let configured = config?["providers"] as? [String: [String: Any]] ?? [:]
        var vendors: [(type: String, plans: [PlanEntry])] = []
        for provider in body["providers"] as? [[String: Any]] ?? [] {
            guard let id = provider["providerId"] as? String else { continue }
            guard provider["enabled"] as? Bool ?? true else { continue }
            guard !(provider["hidden"] as? Bool ?? configured[id]?["hidden"] as? Bool ?? false)
            else { continue }
            guard let usage = provider["usage"] as? [String: Any] else { continue }
            let reported = usage["windows"] as? [String: Any]
            let windows = usageWindows(reported)
            guard !windows.isEmpty else { continue }
            let type = provider["type"] as? String ?? "unknown"
            let plan = PlanEntry(
                vendorType: type,
                vendor: vendorName(type),
                name: configured[id]?["name"] as? String ?? providerName(id),
                planName: (usage["planName"] as? String).flatMap { $0.isEmpty ? nil : $0 },
                windows: windows,
                fable: window(reported?["fableWeekly"], kind: .fable),
                exhausted: usage["exhausted"] as? Bool ?? false
            )
            if let index = vendors.firstIndex(where: { $0.type == type }) {
                vendors[index].plans.append(plan)
            } else {
                vendors.append((type, [plan]))
            }
        }
        let grouped = vendors.map {
            PlanVendor(type: $0.type, name: vendorName($0.type), plans: $0.plans)
        }
        return (grouped, totals(body["day"]))
    }

    /// A configured provider's ID as something to read. A person names their own accounts, so an
    /// unfamiliar ID becomes words rather than being shown as the raw identifier it is.
    private static func providerName(_ id: String) -> String {
        switch id {
        case "claude", "codex", "grok": return "Current CLI"
        case "bedrock": return "Bedrock"
        default:
            return id
                .split(whereSeparator: { $0 == "_" || $0 == "-" || $0 == "." })
                .map { $0.prefix(1).uppercased() + $0.dropFirst() }
                .joined(separator: " ")
        }
    }

    private static func vendorName(_ type: String) -> String {
        switch type {
        case "claude": return "Claude"
        case "codex": return "Codex"
        case "grok": return "Grok"
        case "bedrock": return "Amazon Bedrock"
        case "smart": return "Pool"
        default: return "Provider"
        }
    }

    /// Every provider shows the same pair: the session and the week when the vendor reports them,
    /// and a monthly window only when there is no session, so a week-and-month pair still has
    /// both. Claude's separate Fable allowance is read on its own and never becomes a gauge.
    private static func usageWindows(_ windows: [String: Any]?) -> [PlanWindow] {
        guard let windows else { return [] }
        var shown: [PlanWindow] = []
        if let session = window(windows["fiveHour"], kind: .session) {
            shown.append(session)
        }
        if let week = window(windows["weekly"], kind: .week) {
            shown.append(week)
        }
        if shown.count < 2, let month = window(windows["monthly"], kind: .month) {
            shown.append(month)
        }
        return shown
    }

    private static func window(_ raw: Any?, kind: PlanWindowKind) -> PlanWindow? {
        guard let body = raw as? [String: Any], let percent = number(body["usedPercent"]) else {
            return nil
        }
        return PlanWindow(kind: kind, usedPercent: percent, resetsAt: date(body["resetsAt"]))
    }

    /// JSONSerialization turns whole numbers into `NSNumber`/`Int`, so a direct `as? Double` misses
    /// the percentages and timestamps a vendor reports as integers.
    private static func number(_ value: Any?) -> Double? {
        if let n = value as? NSNumber { return n.doubleValue }
        if let n = value as? Double { return n }
        if let n = value as? Int { return Double(n) }
        return nil
    }

    private static func date(_ value: Any?) -> Date? {
        guard let ms = number(value) else { return nil }
        return Date(timeIntervalSince1970: ms / 1000)
    }

    private static func totals(_ window: Any?) -> TokenTotals {
        var totals = TokenTotals()
        guard let providers = window as? [String: Any] else { return totals }
        for models in providers.values {
            guard let models = models as? [String: Any] else { continue }
            for usage in models.values {
                guard let usage = usage as? [String: Any] else { continue }
                totals.input += usage["input"] as? Int ?? 0
                totals.output += usage["output"] as? Int ?? 0
            }
        }
        return totals
    }
}
