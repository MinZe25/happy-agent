import AppKit

/// Owns the menu bar item: what it shows, when it refreshes, and how it follows the daemon.
///
/// Reading happens on background queues and everything visible is applied on the main thread. The
/// daemon's event stream is used only as a signal that something changed; the snapshots the menu
/// draws are always re-read, so a missed or unfamiliar event can never leave stale state behind.
final class MenuBarController: NSObject, NSMenuDelegate {
    private let client: DaemonClient
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let menu = NSMenu()
    private let headlineItem = NSMenuItem()
    private let separatorItem = NSMenuItem.separator()
    private let bodyItem = NSMenuItem()
    private let body = MenuBody()
    private let fetchQueue = DispatchQueue(label: "com.slopus.happy.menubar.fetch")
    private let streamQueue = DispatchQueue(label: "com.slopus.happy.menubar.stream")

    private var snapshot = DaemonSnapshot()
    private var workingSince: [String: Date] = [:]
    private var pendingRefresh: DispatchWorkItem?
    private var animation: Timer?
    private var openMenuTick: Timer?
    private var isMenuOpen = false
    private var phase = 0.0

    private static let planRefreshInterval: TimeInterval = 24 * 60 * 60
    /// A calm three seconds per turn, fast enough to read as activity and slow enough to ignore.
    private static let spinFrameInterval: TimeInterval = 1.0 / 30
    private static let spinPerFrame = 2 * Double.pi / (3 * 30)
    private static let refreshCoalescingDelay: TimeInterval = 0.2
    private static let reconnectDelay: TimeInterval = 2

    init(client: DaemonClient) {
        self.client = client
        super.init()
    }

    func start() {
        menu.delegate = self
        menu.autoenablesItems = false
        menu.showsStateColumn = false
        bodyItem.view = body.view
        for item in [headlineItem, separatorItem, bodyItem] {
            item.isEnabled = false
            menu.addItem(item)
        }
        statusItem.menu = menu
        statusItem.button?.image = StatusIcon.image(phase: 0, working: false)
        statusItem.button?.toolTip = "Happy Agent"
        Timer.scheduledTimer(withTimeInterval: MenuBarController.planRefreshInterval, repeats: true) {
            [weak self] _ in
            self?.refreshPlans()
        }
        refreshAgents()
        refreshPlans()
        streamQueue.async { [weak self] in self?.follow() }
    }

    // MARK: - Reading the daemon

    /// Follows the event stream for as long as it lasts, then waits and opens another one.
    private func follow() {
        while true {
            client.streamEventTypes { [weak self] type in
                guard let self, changesTheMenu(type) else { return }
                self.scheduleRefresh()
            }
            DispatchQueue.main.async { [weak self] in self?.markDisconnected() }
            Thread.sleep(forTimeInterval: MenuBarController.reconnectDelay)
            refreshAgents()
        }
    }

    private func changesTheMenu(_ type: String) -> Bool {
        if type == "provider.usage.updated" || type == "config.updated" { refreshPlans() }
        return type.hasPrefix("agent.") || type.hasPrefix("task.") || type.hasPrefix("bot.")
    }

    /// Coalesces the bursts of events a single turn produces into one read.
    private func scheduleRefresh() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.pendingRefresh?.cancel()
            let work = DispatchWorkItem { [weak self] in self?.refreshAgents() }
            self.pendingRefresh = work
            self.fetchQueue.asyncAfter(
                deadline: .now() + MenuBarController.refreshCoalescingDelay,
                execute: work
            )
        }
    }

    private func refreshAgents() {
        fetchQueue.async { [weak self] in
            guard let self else { return }
            let bots = self.client.get("/v0/bots")
            let tasks = self.client.get("/v0/tasks")
            guard let entries = DaemonSnapshotReader.work(botsBody: bots, tasksBody: tasks) else {
                DispatchQueue.main.async { [weak self] in self?.markDisconnected() }
                return
            }
            DispatchQueue.main.async { [weak self] in self?.apply(work: entries) }
        }
    }

    private func refreshPlans(refreshAccounts: Bool = false) {
        fetchQueue.async { [weak self] in
            guard let self else { return }
            if refreshAccounts { self.client.refreshUsage() }
            guard let read = DaemonSnapshotReader.plans(usageBody: self.client.get("/v0/usage"), configBody: self.client.get("/v0/config"))
            else {
                return
            }
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.snapshot.vendors = read.0
                self.snapshot.day = read.1
                if self.isMenuOpen { self.rebuildMenu() }
            }
        }
    }

    // MARK: - Applying what was read

    private func apply(work: [WorkEntry]) {
        snapshot.connected = true
        snapshot.work = work
        let now = Date()
        var running: [String: Date] = [:]
        for entry in work where entry.isWorking {
            running[entry.id] = workingSince[entry.id] ?? now
        }
        workingSince = running
        updateIcon()
        if isMenuOpen { rebuildMenu() }
    }

    private func markDisconnected() {
        snapshot.connected = false
        snapshot.work = []
        workingSince = [:]
        updateIcon()
        if isMenuOpen { rebuildMenu() }
    }

    // MARK: - Drawing

    private func updateIcon() {
        let working = !snapshot.working.isEmpty
        if working, animation == nil {
            let timer = Timer.scheduledTimer(
                withTimeInterval: MenuBarController.spinFrameInterval,
                repeats: true
            ) { [weak self] _ in
                guard let self else { return }
                self.phase += MenuBarController.spinPerFrame
                self.statusItem.button?.image = StatusIcon.image(phase: self.phase, working: true)
            }
            // The menu bar keeps drawing while a menu is tracking, so the star keeps turning.
            RunLoop.main.add(timer, forMode: .eventTracking)
            animation = timer
        }
        if !working {
            animation?.invalidate()
            animation = nil
            phase = 0
        }
        statusItem.button?.image = StatusIcon.image(phase: phase, working: working)
    }

    /// Replaces the rows in place: the items stay, so an open menu keeps its scroll position.
    private func rebuildMenu() {
        let headline = MenuContent.headline(snapshot)
        headlineItem.view = headline
        let rows = MenuContent.rows(snapshot: snapshot) { [weak self] id in
            self?.workingSince[id]
        }
        let resized = body.show(rows, maxHeight: bodyMaxHeight(below: headline))
        separatorItem.isHidden = body.isEmpty
        bodyItem.isHidden = body.isEmpty
        if resized { menu.itemChanged(bodyItem) }
    }

    /// What is left of the screen share once the headline, its separator, and the menu's own
    /// padding are drawn.
    private func bodyMaxHeight(below headline: NSView) -> CGFloat {
        let screen = statusItem.button?.window?.screen ?? NSScreen.main
        let available = (screen?.visibleFrame.height ?? 800) * MenuMetrics.screenShare
        return available - headline.frame.height - MenuMetrics.separatorHeight
            - MenuMetrics.menuPadding
    }

    // MARK: - NSMenuDelegate

    func menuNeedsUpdate(_ menu: NSMenu) {
        rebuildMenu()
    }

    func menuWillOpen(_ menu: NSMenu) {
        isMenuOpen = true
        // Overlay scrollers stay hidden until someone scrolls, so a list that runs past the bottom
        // shows its scroller once to say there is more.
        RunLoop.main.perform(inModes: [.eventTracking, .default]) { [weak self] in
            self?.body.view.flashScrollers()
        }
        refreshPlans(refreshAccounts: true)
        // Elapsed times are the only thing that moves without an event to announce it.
        openMenuTick = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            self?.rebuildMenu()
        }
        if let openMenuTick { RunLoop.main.add(openMenuTick, forMode: .eventTracking) }
    }

    func menuDidClose(_ menu: NSMenu) {
        isMenuOpen = false
        openMenuTick?.invalidate()
        openMenuTick = nil
    }
}
