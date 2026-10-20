import AppKit

/// The menu's measurements, matched to a native macOS menu: 13-point text, 22-point rows, and
/// the same insets as an ordinary item.
enum MenuMetrics {
    static let width: CGFloat = 340
    static let inset: CGFloat = 14
    static let rowHeight: CGFloat = 22
    static let headerHeight: CGFloat = 24
    static let headerTop: CGFloat = 6
    static let separatorHeight: CGFloat = 11
    static let font = NSFont.menuFont(ofSize: 13)
    static let detailFont = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular)

    static let planGap: CGFloat = 6
    static let planMinimumWidth: CGFloat = 28
    static let nameMinimumWidth: CGFloat = 80
    static let gaugeDiameter: CGFloat = 12
    static let gaugeLine: CGFloat = 2
    static let gaugeTextGap: CGFloat = 3
    static let gaugeGap: CGFloat = 8
    static let resetGap: CGFloat = 10
    static let yellowBelow = 25.0
    static let redBelow = 10.0

    /// Taller than this share of the screen, the lists scroll rather than the menu growing.
    static let screenShare: CGFloat = 0.7
    /// What the menu itself adds above its first item and below its last.
    static let menuPadding: CGFloat = 12
}

/// Builds the menu from a snapshot: a headline, then what is working, then what the plans have
/// left. Every row is a read-only line drawn to the native menu's measurements.
enum MenuContent {
    /// What is working, with the last day's tokens as a quiet aside on the same line.
    static func headline(_ snapshot: DaemonSnapshot) -> MenuLineView {
        let tokens = snapshot.connected && !snapshot.day.isEmpty
        return MenuLineView(
            text: headlineText(snapshot),
            detail: tokens ? "\(compact(snapshot.day.total)) tokens in 24h" : nil
        )
    }

    /// The working tasks and bots, longest-running first, then each vendor's accounts.
    static func rows(
        snapshot: DaemonSnapshot,
        workingSince: (String) -> Date?
    ) -> [NSView] {
        var rows: [NSView] = []
        let now = Date()
        let working = snapshot.working
            .map { (entry: $0, since: workingSince($0.id) ?? now) }
            .enumerated()
            .sorted { ($0.element.since, $0.offset) < ($1.element.since, $1.offset) }
            .map(\.element)
        for (entry, since) in working {
            rows.append(MenuLineView(text: entry.name, detail: duration(since: since, now: now)))
        }
        var previousColumns: [PlanWindowKind]?
        for vendor in snapshot.vendors {
            if previousColumns == nil && !rows.isEmpty { rows.append(MenuSeparatorView()) }
            rows.append(
                PlanHeaderView(vendor: vendor, labelsColumns: vendor.columns != previousColumns)
            )
            previousColumns = vendor.columns
            for plan in vendor.plans {
                rows.append(PlanRowView(entry: plan, columns: vendor.columns))
            }
        }
        return rows
    }

    private static func headlineText(_ snapshot: DaemonSnapshot) -> String {
        guard snapshot.connected else { return "Waiting for Happy Agent…" }
        let count = snapshot.working.count
        return count == 0 ? "All idle" : "\(count) working"
    }

    private static func compact(_ count: Int) -> String {
        if count >= 1_000_000 { return String(format: "%.1fM", Double(count) / 1_000_000) }
        if count >= 1_000 { return "\(count / 1_000)K" }
        return "\(count)"
    }

    /// Elapsed working time, once it has been running long enough to be worth reading.
    private static func duration(since: Date, now: Date) -> String? {
        let seconds = Int(now.timeIntervalSince(since))
        guard seconds >= 2 else { return nil }
        if seconds < 60 { return "\(seconds)s" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m \(seconds % 60)s" }
        return "\(minutes / 60)h \(minutes % 60)m"
    }
}

/// The scrolling part of the menu below the headline.
///
/// NSMenu itself only scrolls when it runs into the edge of the screen, so the lists live in a
/// scroll view of their own that stops growing at a share of the screen. Rows are replaced in
/// place while the menu is open, keeping the person's scroll position.
final class MenuBody {
    let view = NSScrollView(
        frame: NSRect(x: 0, y: 0, width: MenuMetrics.width, height: MenuMetrics.rowHeight)
    )
    private let document = FlippedView(
        frame: NSRect(x: 0, y: 0, width: MenuMetrics.width, height: 0)
    )

    init() {
        view.drawsBackground = false
        view.hasVerticalScroller = true
        view.autohidesScrollers = true
        view.scrollerStyle = .overlay
        view.verticalScrollElasticity = .none
        view.autoresizingMask = [.width]
        view.documentView = document
    }

    var isEmpty: Bool { document.subviews.isEmpty }

    /// Lays out `rows`, returning whether the menu has to change height to fit them.
    @discardableResult
    func show(_ rows: [NSView], maxHeight: CGFloat) -> Bool {
        let offset = view.contentView.bounds.origin.y
        document.subviews = []
        var y: CGFloat = 0
        for row in rows {
            row.frame = NSRect(x: 0, y: y, width: MenuMetrics.width, height: row.frame.height)
            row.autoresizingMask = [.width]
            document.addSubview(row)
            y += row.frame.height
        }
        document.frame.size = NSSize(width: view.frame.width, height: y)
        let height = min(y, max(maxHeight, MenuMetrics.rowHeight * 4))
        let resized = view.frame.height != height
        view.frame.size.height = height
        // A scroller that is always shown takes its width from the rows rather than covering them.
        view.tile()
        document.frame.size.width = view.contentSize.width
        let restored = min(offset, max(y - height, 0))
        view.contentView.scroll(to: NSPoint(x: 0, y: restored))
        view.reflectScrolledClipView(view.contentView)
        return resized
    }
}

/// One line: text on the left, and an optional quieter detail right-aligned on the same line.
final class MenuLineView: NSView {
    private let text: String
    private let detail: String?

    init(text: String, detail: String?) {
        self.text = text
        self.detail = detail
        super.init(
            frame: NSRect(x: 0, y: 0, width: MenuMetrics.width, height: MenuMetrics.rowHeight)
        )
        autoresizingMask = [.width]
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("MenuLineView is created in code.")
    }

    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        var end = bounds.width - MenuMetrics.inset
        if let detail {
            let line = NSAttributedString(
                string: detail,
                attributes: [
                    .font: MenuMetrics.detailFont,
                    .foregroundColor: NSColor.secondaryLabelColor,
                ]
            )
            let width = ceil(line.size().width)
            drawLine(line, in: NSRect(x: end - width, y: 0, width: width, height: bounds.height))
            end -= width + MenuMetrics.resetGap
        }
        drawLine(
            text,
            font: MenuMetrics.font,
            color: .labelColor,
            in: NSRect(
                x: MenuMetrics.inset,
                y: 0,
                width: end - MenuMetrics.inset,
                height: bounds.height
            )
        )
    }
}

/// The same hairline a native separator item draws, for use inside the scrolling body.
final class MenuSeparatorView: NSView {
    init() {
        super.init(
            frame: NSRect(x: 0, y: 0, width: MenuMetrics.width, height: MenuMetrics.separatorHeight)
        )
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("MenuSeparatorView is created in code.")
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.separatorColor.setFill()
        let scale = window?.backingScaleFactor ?? 2
        NSRect(
            x: MenuMetrics.inset,
            y: floor(bounds.midY),
            width: bounds.width - MenuMetrics.inset * 2,
            height: 1 / scale
        ).fill()
    }
}

final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

/// Draws one line of text centred vertically in `rect`, cut short with an ellipsis if it is too
/// long to fit.
func drawLine(_ text: NSAttributedString, in rect: NSRect, alignment: NSTextAlignment = .left) {
    let line = NSMutableAttributedString(attributedString: text)
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = alignment
    paragraph.lineBreakMode = .byTruncatingTail
    line.addAttribute(
        .paragraphStyle,
        value: paragraph,
        range: NSRange(location: 0, length: line.length)
    )
    let height = ceil(line.size().height)
    line.draw(
        in: NSRect(x: rect.minX, y: rect.midY - height / 2, width: rect.width, height: height)
    )
}

func drawLine(
    _ text: String,
    font: NSFont,
    color: NSColor,
    in rect: NSRect,
    alignment: NSTextAlignment = .left
) {
    drawLine(
        NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: color]),
        in: rect,
        alignment: alignment
    )
}
