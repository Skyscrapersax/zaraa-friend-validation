import Foundation

struct CommandEnvelope: Decodable {
    let id: String
    let cmd: String
    let x: Int?
    let y: Int?
    let button: String?
    let clicks: Int?
    let text: String?
    let keys: [String]?
    let region: Region?
    let fromX: Int?
    let fromY: Int?
    let toX: Int?
    let toY: Int?
    let dx: Int?
    let dy: Int?
}

struct Region: Decodable {
    let x: Int
    let y: Int
    let w: Int
    let h: Int
}

struct OkResponse: Encodable {
    let id: String
    let ok: Bool = true
}

struct CaptureResponse: Encodable {
    let id: String
    let ok: Bool = true
    let png_b64: String
    let width: Int
    let height: Int
}

struct ErrorResponse: Encodable {
    let id: String
    let ok: Bool = false
    let error: String
}

struct FrontmostAppResponse: Encodable {
    let id: String
    let ok: Bool = true
    let bundle_id: String?
}

func writeLine<T: Encodable>(_ value: T) {
    let enc = JSONEncoder()
    if let data = try? enc.encode(value),
       let s = String(data: data, encoding: .utf8) {
        FileHandle.standardOutput.write(Data((s + "\n").utf8))
    }
}
