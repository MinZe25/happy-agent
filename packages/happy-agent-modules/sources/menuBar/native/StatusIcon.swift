import AppKit

/// The glyph in the menu bar: Happy's H, the same mark as the app icon and `logo.png`.
///
/// The mark is a three-by-three grid with seven cells filled — two columns of three joined by the
/// middle cell — and only its four outer corners rounded. It is drawn as a template image, so
/// macOS tints it exactly like every other menu bar icon and inverts it while the menu is open.
/// At rest every cell is drawn at full strength; while agents work, a cell or two at a time dims
/// softly and comes back.
enum StatusIcon {
    private static let size = NSSize(width: 18, height: 18)

    /// The seven filled cells as (column, row), counted from the top left.
    static let cells: [(column: Int, row: Int)] = [
        (0, 0), (2, 0),
        (0, 1), (1, 1), (2, 1),
        (0, 2), (2, 2),
    ]

    /// The middle cell, which carries the working state on its own when motion is reduced.
    static let bridge = 3

    /// The mark with every cell at full strength.
    static var resting: NSImage { image(strengths: Array(repeating: 1, count: cells.count)) }

    /// The mark with each cell drawn at its own strength, from 0 for gone to 1 for full.
    static func image(strengths: [Double]) -> NSImage {
        let image = NSImage(size: size, flipped: true) { rect in
            drawMark(in: rect, strengths: strengths)
            return true
        }
        image.isTemplate = true
        return image
    }

    /// The mark is 14 points tall in the 18-point image — 4-point cells, 1-point gaps — the height
    /// and weight of a filled SF Symbol such as `lock.fill` beside it, with the system's padding
    /// around it. Only the cells are drawn: nothing fills the image behind them. Wider gaps break
    /// the H into a grid of dots and narrower ones vanish at 1x, so the gap is one point.
    ///
    /// Cells, gaps, and placement are whole device pixels, so the gaps stay crisp lines at 1x and
    /// 2x instead of blurring into the cells around them.
    private static func drawMark(in rect: NSRect, strengths: [Double]) {
        let scale = NSGraphicsContext.current.map {
            $0.cgContext.userSpaceToDeviceSpaceTransform.a.magnitude
        } ?? 2
        let pixel = 1 / max(scale, 1)
        let cell = (4 * scale).rounded() * pixel
        let gap = max(scale.rounded(), 1) * pixel
        let mark = cell * 3 + gap * 2
        let origin = NSPoint(
            x: ((rect.midX - mark / 2) / pixel).rounded(.down) * pixel,
            y: ((rect.midY - mark / 2) / pixel).rounded(.down) * pixel
        )
        // The logo rounds its outer corners by about three tenths of a cell.
        let radius = cell * 0.3
        for (index, position) in cells.enumerated() {
            let strength = index < strengths.count ? strengths[index] : 1
            guard strength > 0 else { continue }
            let frame = NSRect(
                x: origin.x + CGFloat(position.column) * (cell + gap),
                y: origin.y + CGFloat(position.row) * (cell + gap),
                width: cell,
                height: cell
            )
            NSColor.black.withAlphaComponent(CGFloat(min(strength, 1))).setFill()
            cellPath(frame, column: position.column, row: position.row, radius: radius).fill()
        }
    }

    /// A square cell, rounded only at the corner it shares with the mark's outline.
    private static func cellPath(
        _ frame: NSRect,
        column: Int,
        row: Int,
        radius: CGFloat
    ) -> NSBezierPath {
        let corner: (x: CGFloat, y: CGFloat)?
        switch (column, row) {
        case (0, 0): corner = (frame.minX, frame.minY)
        case (2, 0): corner = (frame.maxX, frame.minY)
        case (0, 2): corner = (frame.minX, frame.maxY)
        case (2, 2): corner = (frame.maxX, frame.maxY)
        default: corner = nil
        }
        guard let corner else { return NSBezierPath(rect: frame) }
        let path = NSBezierPath()
        let points = [
            NSPoint(x: frame.minX, y: frame.minY),
            NSPoint(x: frame.maxX, y: frame.minY),
            NSPoint(x: frame.maxX, y: frame.maxY),
            NSPoint(x: frame.minX, y: frame.maxY),
        ]
        // Walk the square; at the rounded corner, cut in by the radius on both sides and arc
        // across.
        for (index, point) in points.enumerated() {
            let previous = points[(index + 3) % 4]
            let next = points[(index + 1) % 4]
            if point.x == corner.x && point.y == corner.y {
                let into = towards(point, previous, by: radius)
                let out = towards(point, next, by: radius)
                if index == 0 { path.move(to: into) } else { path.line(to: into) }
                path.curve(
                    to: out,
                    controlPoint1: towards(point, previous, by: radius * 0.45),
                    controlPoint2: towards(point, next, by: radius * 0.45)
                )
            } else if index == 0 {
                path.move(to: point)
            } else {
                path.line(to: point)
            }
        }
        path.close()
        return path
    }

    private static func towards(_ from: NSPoint, _ to: NSPoint, by distance: CGFloat) -> NSPoint {
        let length = hypot(to.x - from.x, to.y - from.y)
        guard length > 0 else { return from }
        return NSPoint(
            x: from.x + (to.x - from.x) / length * distance,
            y: from.y + (to.y - from.y) / length * distance
        )
    }
}

/// The working animation: cells of the H dim and come back at random, a cell or two at a time.
///
/// Each flash is a soft pulse rather than a blink — strength eases down and back up along half a
/// sine wave — and a new one starts every half second or so, never on a cell that is still
/// flashing, so the mark always reads as an H and something is always quietly happening.
struct StatusIconAnimation {
    /// Ten frames a second is smooth enough for a slow pulse and costs next to nothing.
    static let frameInterval: TimeInterval = 0.1
    static let flashDuration: TimeInterval = 0.9
    static let flashGap: ClosedRange<TimeInterval> = 0.3...0.65
    static let maxFlashing = 2
    /// How far a flashing cell dims at the bottom of its pulse.
    static let dimmest = 0.25

    private var flashes: [Int: TimeInterval] = [:]
    private var nextFlash: TimeInterval?
    private var lastCell: Int?

    /// Advances to `time` and returns each cell's strength, or `nil` when nothing changed since
    /// the last frame and there is nothing to redraw.
    mutating func step<Random: RandomNumberGenerator>(
        at time: TimeInterval,
        using random: inout Random
    ) -> [Double]? {
        let before = flashes.count
        flashes = flashes.filter { time - $0.value < StatusIconAnimation.flashDuration }
        let ended = flashes.count != before
        if nextFlash == nil || time >= nextFlash! {
            startFlash(at: time, using: &random)
            nextFlash = time + .random(in: StatusIconAnimation.flashGap, using: &random)
        }
        guard !flashes.isEmpty || ended else { return nil }
        return StatusIcon.cells.indices.map { index in
            guard let start = flashes[index] else { return 1 }
            let progress = (time - start) / StatusIconAnimation.flashDuration
            return 1 - (1 - StatusIconAnimation.dimmest) * sin(Double.pi * progress)
        }
    }

    private mutating func startFlash<Random: RandomNumberGenerator>(
        at time: TimeInterval,
        using random: inout Random
    ) {
        guard flashes.count < StatusIconAnimation.maxFlashing else { return }
        let candidates = StatusIcon.cells.indices.filter { flashes[$0] == nil && $0 != lastCell }
        guard let cell = candidates.randomElement(using: &random) else { return }
        flashes[cell] = time
        lastCell = cell
    }
}
