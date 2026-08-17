import Foundation
import CoreGraphics

func performScroll(x: Int, y: Int, dx: Int, dy: Int) throws {
    // Move cursor to scroll origin so the wheel events affect the right view.
    let pt = CGPoint(x: x, y: y)
    if let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: pt, mouseButton: .left) {
        move.post(tap: .cghidEventTap)
    }
    // Two-axis scroll wheel event in pixel units.
    // wheel1 = vertical (dy), wheel2 = horizontal (dx).
    guard let scroll = CGEvent(
        scrollWheelEvent2Source: nil,
        units: .pixel,
        wheelCount: 2,
        wheel1: Int32(dy),
        wheel2: Int32(dx),
        wheel3: 0
    ) else {
        throw InputError.eventCreateFailed
    }
    scroll.post(tap: .cghidEventTap)
}
