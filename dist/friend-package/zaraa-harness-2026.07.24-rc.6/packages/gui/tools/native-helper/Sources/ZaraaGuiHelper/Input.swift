import Foundation
import CoreGraphics

enum InputError: Error {
    case eventCreateFailed
    case unknownKey(String)
}

func performClick(x: Int, y: Int, button: String, clicks: Int) throws {
    let pt = CGPoint(x: x, y: y)
    let mouseButton: CGMouseButton
    let downType: CGEventType
    let upType: CGEventType
    switch button {
    case "right":
        mouseButton = .right; downType = .rightMouseDown; upType = .rightMouseUp
    case "middle":
        mouseButton = .center; downType = .otherMouseDown; upType = .otherMouseUp
    default:
        mouseButton = .left; downType = .leftMouseDown; upType = .leftMouseUp
    }
    if let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: pt, mouseButton: mouseButton) {
        move.post(tap: .cghidEventTap)
    }
    let clamped = max(1, min(3, clicks))
    for i in 1...clamped {
        guard let down = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: pt, mouseButton: mouseButton),
              let up   = CGEvent(mouseEventSource: nil, mouseType: upType,   mouseCursorPosition: pt, mouseButton: mouseButton)
        else { throw InputError.eventCreateFailed }
        down.setIntegerValueField(.mouseEventClickState, value: Int64(i))
        up.setIntegerValueField(.mouseEventClickState, value: Int64(i))
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }
}

private let keyMap: [String: CGKeyCode] = [
    "cmd": 0x37, "command": 0x37,
    "shift": 0x38,
    "ctrl": 0x3B, "control": 0x3B,
    "option": 0x3A, "alt": 0x3A,
    "return": 0x24, "enter": 0x24,
    "tab": 0x30, "space": 0x31, "esc": 0x35, "escape": 0x35,
    "left": 0x7B, "right": 0x7C, "down": 0x7D, "up": 0x7E,
    "a": 0x00, "b": 0x0B, "c": 0x08, "d": 0x02, "e": 0x0E, "f": 0x03, "g": 0x05,
    "h": 0x04, "i": 0x22, "j": 0x26, "k": 0x28, "l": 0x25, "m": 0x2E, "n": 0x2D,
    "o": 0x1F, "p": 0x23, "q": 0x0C, "r": 0x0F, "s": 0x01, "t": 0x11, "u": 0x20,
    "v": 0x09, "w": 0x0D, "x": 0x07, "y": 0x10, "z": 0x06,
    "0": 0x1D, "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15,
    "5": 0x17, "6": 0x16, "7": 0x1A, "8": 0x1C, "9": 0x19,
]

func sendKeyChord(_ keys: [String]) throws {
    let codes: [CGKeyCode] = try keys.map { name in
        guard let code = keyMap[name.lowercased()] else { throw InputError.unknownKey(name) }
        return code
    }
    for code in codes {
        guard let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true) else { throw InputError.eventCreateFailed }
        e.post(tap: .cghidEventTap)
    }
    for code in codes.reversed() {
        guard let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else { throw InputError.eventCreateFailed }
        e.post(tap: .cghidEventTap)
    }
}
