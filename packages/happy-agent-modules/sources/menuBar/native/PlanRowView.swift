import AppKit

/// One provider account on a single line: its name and plan, a small gauge for each window, and
/// when the window holding it back starts over.
///
/// A gauge reads like a battery — the ring and the number are what is left, not what is spent —
/// and turns yellow when little is left and red when almost nothing is. The row never highlights
/// and never accepts a click; it is a readout inside the menu.
final class PlanRowView: NSView {
    private let entry: PlanEntry
    private let columns: [PlanWindowKind]

    init(entry: PlanEntry, columns: [PlanWindowKind]) {
        self.entry = entry
        self.columns = columns
        super.init(
            frame: NSRect(x: 0, y: 0, width: MenuMetrics.width, height: MenuMetrics.rowHeight)
        )
        autoresizingMask = [.width]
        toolTip = PlanRowView.tooltip(entry)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("PlanRowView is created in code.")
    }

    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        let layout = PlanColumns(columns: columns, width: bounds.width)
        let limiting = entry.limiting
        for (index, kind) in columns.enumerated() {
            guard let window = entry.windows.first(where: { $0.kind == kind }) else { continue }
            let level = GaugeLevel(window: window, blocked: entry.isBlocking(window))
            drawGauge(window: window, level: level, in: layout.gauge(index))
        }

        if let reset = limiting?.resetsAt {
            drawLine(
                resetPhrase(reset),
                font: MenuMetrics.detailFont,
                color: entry.isBlocked ? .systemRed : .secondaryLabelColor,
                in: layout.reset,
                alignment: .right
            )
        }

        // A long account name gives way to the plan, but only down to a readable length; past that
        // the plan is shortened, and left out rather than squeezed into an unreadable stub.
        let end = layout.namesEnd
        let name = NSAttributedString(
            string: entry.name,
            attributes: [.font: MenuMetrics.font, .foregroundColor: NSColor.labelColor]
        )
        let fullName = ceil(name.size().width)
        let plan = entry.planName.map {
            ceil(NSAttributedString(string: $0, attributes: [.font: MenuMetrics.font]).size().width)
        }
        let room = end - MenuMetrics.inset
        let besidePlan = plan.map { room - $0 - MenuMetrics.planGap } ?? room
        let nameWidth = min(
            fullName,
            room,
            max(besidePlan, min(fullName, MenuMetrics.nameMinimumWidth))
        )
        drawLine(
            name,
            in: NSRect(x: MenuMetrics.inset, y: 0, width: nameWidth, height: bounds.height)
        )
        let planStart = MenuMetrics.inset + nameWidth + MenuMetrics.planGap
        if let planName = entry.planName, let plan,
            end - planStart >= min(plan, MenuMetrics.planMinimumWidth)
        {
            drawLine(
                planName,
                font: MenuMetrics.font,
                color: .secondaryLabelColor,
                in: NSRect(x: planStart, y: 0, width: end - planStart, height: bounds.height)
            )
        }
    }

    /// The share left, right-aligned against its ring, so rings line up down the column and
    /// every number sits right beside its own.
    private func drawGauge(window: PlanWindow, level: GaugeLevel, in cell: NSRect) {
        let diameter = MenuMetrics.gaugeDiameter
        let ring = NSRect(
            x: cell.maxX - diameter,
            y: cell.midY - diameter / 2,
            width: diameter,
            height: diameter
        ).insetBy(dx: MenuMetrics.gaugeLine / 2, dy: MenuMetrics.gaugeLine / 2)
        let track = NSBezierPath(ovalIn: ring)
        track.lineWidth = MenuMetrics.gaugeLine
        NSColor.quaternaryLabelColor.setStroke()
        track.stroke()

        let remaining = window.remainingPercent / 100
        if remaining > 0 {
            // Clockwise from twelve o'clock, like every other progress ring. The view is flipped,
            // so increasing angles already run clockwise on screen.
            let arc = NSBezierPath()
            arc.appendArc(
                withCenter: NSPoint(x: ring.midX, y: ring.midY),
                radius: ring.width / 2,
                startAngle: -90,
                endAngle: -90 + 360 * CGFloat(remaining),
                clockwise: false
            )
            arc.lineWidth = MenuMetrics.gaugeLine
            arc.lineCapStyle = remaining < 1 ? .round : .butt
            level.ring.setStroke()
            arc.stroke()
        }

        let text = NSRect(
            x: cell.minX,
            y: 0,
            width: cell.width - diameter - MenuMetrics.gaugeTextGap,
            height: bounds.height
        )
        drawLine(
            "\(Int(window.remainingPercent.rounded()))%",
            font: MenuMetrics.detailFont,
            color: level.text,
            in: text,
            alignment: .right
        )
    }

    /// Every window the vendor reported, Fable included, with its exact local reset time; a
    /// blocked account first says until when.
    static func tooltip(_ entry: PlanEntry) -> String {
        var lines = entry.allWindows.map { window -> String in
            let left = "\(window.kind.label): \(Int(window.remainingPercent.rounded()))% left"
            guard let reset = window.resetsAt else { return left }
            return "\(left), resets \(resetPhrase(reset, precise: true))"
        }
        if entry.isBlocked, let limiting = entry.limiting {
            let reached = limiting.isFull ? "\(limiting.kind.label) limit reached" : "Out of usage"
            let reset = limiting.resetsAt.map { ", resets \(resetPhrase($0, precise: true))" } ?? ""
            lines.insert(reached + reset, at: 0)
        }
        return lines.joined(separator: "\n")
    }
}

/// A vendor's name above its accounts, with the names of the gauge columns when they differ from
/// the vendor above.
final class PlanHeaderView: NSView {
    private let vendor: PlanVendor
    private let labelsColumns: Bool

    init(vendor: PlanVendor, labelsColumns: Bool) {
        self.vendor = vendor
        self.labelsColumns = labelsColumns
        super.init(
            frame: NSRect(x: 0, y: 0, width: MenuMetrics.width, height: MenuMetrics.headerHeight)
        )
        autoresizingMask = [.width]
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("PlanHeaderView is created in code.")
    }

    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        let layout = PlanColumns(columns: vendor.columns, width: bounds.width)
        drawLine(
            headerText(vendor.name.uppercased(), kern: 0.6),
            in: line(MenuMetrics.inset, layout.namesEnd - MenuMetrics.inset)
        )
        guard labelsColumns else { return }
        for (index, kind) in vendor.columns.enumerated() {
            let cell = layout.gauge(index)
            drawLine(headerText(kind.label), in: line(cell.minX, cell.width), alignment: .right)
        }
        let reset = layout.reset
        drawLine(headerText("Resets"), in: line(reset.minX, reset.width), alignment: .right)
    }

    /// The header's text sits low in its row, close to the accounts it names.
    private func line(_ x: CGFloat, _ width: CGFloat) -> NSRect {
        NSRect(
            x: x,
            y: MenuMetrics.headerTop,
            width: width,
            height: bounds.height - MenuMetrics.headerTop
        )
    }

    private func headerText(_ text: String, kern: CGFloat = 0) -> NSAttributedString {
        NSAttributedString(
            string: text,
            attributes: [
                .font: NSFont.systemFont(ofSize: 10, weight: .semibold),
                .foregroundColor: NSColor.tertiaryLabelColor,
                .kern: kern,
            ]
        )
    }
}

/// Where a vendor's columns sit, measured from the right edge so every vendor's week, session,
/// and reset line up however many columns it has.
private struct PlanColumns {
    let columns: [PlanWindowKind]
    let width: CGFloat

    var reset: NSRect {
        NSRect(
            x: width - MenuMetrics.inset - PlanColumns.resetWidth,
            y: 0,
            width: PlanColumns.resetWidth,
            height: MenuMetrics.rowHeight
        )
    }

    func gauge(_ index: Int) -> NSRect {
        let fromRight = CGFloat(columns.count - 1 - index)
        let right = reset.minX - MenuMetrics.resetGap
            - fromRight * (PlanColumns.gaugeWidth + MenuMetrics.gaugeGap)
        return NSRect(
            x: right - PlanColumns.gaugeWidth,
            y: 0,
            width: PlanColumns.gaugeWidth,
            height: MenuMetrics.rowHeight
        )
    }

    var namesEnd: CGFloat {
        (columns.isEmpty ? reset.minX : gauge(0).minX) - MenuMetrics.resetGap
    }

    /// Wide enough for "100%" beside its ring.
    static let gaugeWidth: CGFloat = {
        let digits = NSAttributedString(string: "100%", attributes: [.font: MenuMetrics.detailFont])
        return MenuMetrics.gaugeDiameter + MenuMetrics.gaugeTextGap + ceil(digits.size().width)
    }()

    /// Wide enough for the longest clock time this locale writes.
    static let resetWidth: CGFloat = {
        var parts = DateComponents()
        parts.year = 2026
        parts.month = 1
        parts.day = 1
        parts.hour = 22
        parts.minute = 58
        let sample = localCalendar.date(from: parts) ?? Date()
        let text = NSAttributedString(
            string: clockTime(sample),
            attributes: [.font: MenuMetrics.detailFont]
        )
        return ceil(text.size().width)
    }()
}

/// The gauge's colors: quiet while there is room, yellow when little is left, red when almost
/// nothing is or the account cannot be used until this window starts over.
private struct GaugeLevel {
    let ring: NSColor
    let text: NSColor

    init(window: PlanWindow, blocked: Bool) {
        let left = window.remainingPercent
        if blocked || left < MenuMetrics.redBelow {
            ring = .systemRed
            text = .systemRed
        } else if left < MenuMetrics.yellowBelow {
            ring = .systemYellow
            text = .secondaryLabelColor
        } else {
            ring = .secondaryLabelColor
            text = .secondaryLabelColor
        }
    }
}

/// A clock time when the reset is under a day away; otherwise the weekday, or the date once the
/// weekday could be mistaken for this week's. The tooltip adds the clock time to any reset that is
/// not today, so nothing is lost by the brevity.
func resetPhrase(_ date: Date, precise: Bool = false) -> String {
    let remaining = date.timeIntervalSinceNow
    if precise {
        if localCalendar.isDateInToday(date) { return clockTime(date) }
        let day = localFormatter(remaining < 6 * 24 * 60 * 60 ? "EEE" : "MMM d").string(from: date)
        return "\(day) \(clockTime(date))"
    }
    if remaining < 24 * 60 * 60 { return clockTime(date) }
    return localFormatter(remaining < 6 * 24 * 60 * 60 ? "EEE" : "MMM d").string(from: date)
}

private func clockTime(_ date: Date) -> String {
    let formatter = localFormatter(nil)
    formatter.timeStyle = .short
    formatter.dateStyle = .none
    return formatter.string(from: date)
}

/// Every reset is written in the Mac's own time zone and locale — never UTC, an ISO string, or
/// the daemon's zone — and both follow the system, so a Mac that changes zone shows the new
/// local time.
private var localCalendar: Calendar {
    var calendar = Calendar.autoupdatingCurrent
    calendar.timeZone = TimeZone.autoupdatingCurrent
    return calendar
}

private func localFormatter(_ template: String?) -> DateFormatter {
    let formatter = DateFormatter()
    formatter.locale = Locale.autoupdatingCurrent
    formatter.timeZone = TimeZone.autoupdatingCurrent
    formatter.calendar = localCalendar
    if let template { formatter.setLocalizedDateFormatFromTemplate(template) }
    return formatter
}
