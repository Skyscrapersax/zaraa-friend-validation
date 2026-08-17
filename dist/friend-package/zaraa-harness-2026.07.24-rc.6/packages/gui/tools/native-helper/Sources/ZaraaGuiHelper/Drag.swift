import Foundation
import CoreGraphics

func performDrag(fromX: Int, fromY: Int, toX: Int, toY: Int, button: String) throws {
    let from = CGPoint(x: fromX, y: fromY)
    let to = CGPoint(x: toX, y: toY)
    let mouseButton: CGMouseButton
    let downType: CGEventType
    let upType: CGEventType
    let dragType: CGEventType
    switch button {
    case "right":
        mouseButton = .right; downType = .rightMouseDown; upType = .rightMouseUp; dragType = .rightMouseDragged
    case "middle":
        mouseButton = .center; downType = .otherMouseDown; upType = .otherMouseUp; dragType = .otherMouseDragged
    default:
        mouseButton = .left; downType = .leftMouseDown; upType = .leftMouseUp; dragType = .leftMouseDragged
    }

    // Move to start
    if let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: from, mouseButton: mouseButton) {
        move.post(tap: .cghidEventTap)
    }
    // Press
    guard let down = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: from, mouseButton: mouseButton) else {
        throw InputError.eventCreateFailed
    }
    down.post(tap: .cghidEventTap)

    // Intermediate dragged events — 15 steps at ~60fps
    let steps = 15
    for i in 1...steps {
        let t = Double(i) / Double(steps)
        let x = Double(fromX) + (Double(toX) - Double(fromX)) * t
        let y = Double(fromY) + (Double(toY) - Double(fromY)) * t
        let pt = CGPoint(x: x, y: y)
        if let drag = CGEvent(mouseEventSource: nil, mouseType: dragType, mouseCursorPosition: pt, mouseButton: mouseButton) {
            drag.post(tap: .cghidEventTap)
        }
        usleep(16_000) // ~16ms
    }

    // Release
    guard let up = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: to, mouseButton: mouseButton) else {
        throw InputError.eventCreateFailed
    }
    up.post(tap: .cghidEventTap)
}
