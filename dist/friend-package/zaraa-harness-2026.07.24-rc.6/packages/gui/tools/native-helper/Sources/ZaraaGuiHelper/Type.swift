import Foundation
import CoreGraphics

// ANSI keyboard virtual key codes for printable ASCII.
// (keyCode, requiresShift)
private let asciiKeyMap: [Character: (CGKeyCode, Bool)] = [
    // lowercase letters
    "a": (0x00, false), "b": (0x0B, false), "c": (0x08, false), "d": (0x02, false),
    "e": (0x0E, false), "f": (0x03, false), "g": (0x05, false), "h": (0x04, false),
    "i": (0x22, false), "j": (0x26, false), "k": (0x28, false), "l": (0x25, false),
    "m": (0x2E, false), "n": (0x2D, false), "o": (0x1F, false), "p": (0x23, false),
    "q": (0x0C, false), "r": (0x0F, false), "s": (0x01, false), "t": (0x11, false),
    "u": (0x20, false), "v": (0x09, false), "w": (0x0D, false), "x": (0x07, false),
    "y": (0x10, false), "z": (0x06, false),
    // uppercase letters (same key, with shift)
    "A": (0x00, true), "B": (0x0B, true), "C": (0x08, true), "D": (0x02, true),
    "E": (0x0E, true), "F": (0x03, true), "G": (0x05, true), "H": (0x04, true),
    "I": (0x22, true), "J": (0x26, true), "K": (0x28, true), "L": (0x25, true),
    "M": (0x2E, true), "N": (0x2D, true), "O": (0x1F, true), "P": (0x23, true),
    "Q": (0x0C, true), "R": (0x0F, true), "S": (0x01, true), "T": (0x11, true),
    "U": (0x20, true), "V": (0x09, true), "W": (0x0D, true), "X": (0x07, true),
    "Y": (0x10, true), "Z": (0x06, true),
    // digits
    "0": (0x1D, false), "1": (0x12, false), "2": (0x13, false), "3": (0x14, false),
    "4": (0x15, false), "5": (0x17, false), "6": (0x16, false), "7": (0x1A, false),
    "8": (0x1C, false), "9": (0x19, false),
    // shifted digits
    ")": (0x1D, true), "!": (0x12, true), "@": (0x13, true), "#": (0x14, true),
    "$": (0x15, true), "%": (0x17, true), "^": (0x16, true), "&": (0x1A, true),
    "*": (0x1C, true), "(": (0x19, true),
    // whitespace / control
    " ": (0x31, false),
    "\t": (0x30, false),
    "\n": (0x24, false),
    "\r": (0x24, false),
    // punctuation (unshifted)
    "-": (0x1B, false), "=": (0x18, false),
    "[": (0x21, false), "]": (0x1E, false), "\\": (0x2A, false),
    ";": (0x29, false), "'": (0x27, false),
    ",": (0x2B, false), ".": (0x2F, false), "/": (0x2C, false),
    "`": (0x32, false),
    // shifted punctuation
    "_": (0x1B, true), "+": (0x18, true),
    "{": (0x21, true), "}": (0x1E, true), "|": (0x2A, true),
    ":": (0x29, true), "\"": (0x27, true),
    "<": (0x2B, true), ">": (0x2F, true), "?": (0x2C, true),
    "~": (0x32, true),
]

private let kShiftKeyCode: CGKeyCode = 0x38

func sendText(_ text: String) throws {
    for ch in text {
        if let (keyCode, needsShift) = asciiKeyMap[ch] {
            if needsShift {
                guard let shiftDown = CGEvent(keyboardEventSource: nil, virtualKey: kShiftKeyCode, keyDown: true) else {
                    throw InputError.eventCreateFailed
                }
                shiftDown.flags = .maskShift
                shiftDown.post(tap: .cghidEventTap)
            }
            guard let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
                  let up   = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false)
            else { throw InputError.eventCreateFailed }
            if needsShift {
                down.flags = .maskShift
                up.flags = .maskShift
            }
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
            if needsShift {
                if let shiftUp = CGEvent(keyboardEventSource: nil, virtualKey: kShiftKeyCode, keyDown: false) {
                    shiftUp.post(tap: .cghidEventTap)
                }
            }
        } else {
            // Fall back to Unicode injection — works for any character incl. emoji,
            // accented Latin, CJK, etc. Uses keyCode 0 with the unicode string set.
            guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
                  let up   = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
            else { throw InputError.eventCreateFailed }
            let scalars = Array(String(ch).utf16)
            scalars.withUnsafeBufferPointer { buf in
                if let base = buf.baseAddress {
                    down.keyboardSetUnicodeString(stringLength: buf.count, unicodeString: base)
                    up.keyboardSetUnicodeString(stringLength: buf.count, unicodeString: base)
                }
            }
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
        }
    }
}
