import Foundation
import ImageIO
import Tauri
import UIKit

private struct ClipboardImageArgs: Decodable { let dataBase64: String }

private enum ClipboardFailure: LocalizedError {
    case missing, invalid, tooLarge, tooManyPixels
    var errorDescription: String? {
        switch self {
        case .missing: return "The clipboard does not contain an image. Copy an image and try again."
        case .invalid: return "The clipboard image is invalid or uses an unsupported format."
        case .tooLarge: return "Clipboard images must be no larger than 25 MiB."
        case .tooManyPixels: return "Clipboard images must contain no more than 40 million pixels."
        }
    }
}

/// Separate native plugin sharing the existing iOS package only for linking.
final class ShareInboxPlugin: Plugin {
    private let clipboardQueue = DispatchQueue(label: "app.murmur.notes.clipboard", qos: .userInitiated)
    private static let maxImageBytes = 25 * 1024 * 1024
    private static let maxImagePixels = 40_000_000.0

    @objc public func sourceDatabase(_ invoke: Invoke) {
        let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.app.murmur.notes")
        if let container {
            invoke.resolve(["path": container.appendingPathComponent("incoming-shares.sqlite3").path])
        } else {
            invoke.resolve(["path": NSNull()])
        }
    }

    /// UIPasteboard is inspected only after the user chooses Paste image.
    @objc public func readClipboardImage(_ invoke: Invoke) {
        DispatchQueue.main.async {
            let pasteboard = UIPasteboard.general
            // Prefer encoded PNG bytes to avoid decoding an unbounded image.
            if let data = pasteboard.data(forPasteboardType: "public.png") {
                self.clipboardQueue.async { self.resolveImage(data, invoke: invoke) }
            } else if let image = pasteboard.image {
                self.clipboardQueue.async {
                    do {
                        let width = image.size.width * image.scale
                        let height = image.size.height * image.scale
                        try Self.validateDimensions(width: Double(width), height: Double(height))
                        guard let data = image.pngData() else { throw ClipboardFailure.invalid }
                        self.resolveImage(data, invoke: invoke)
                    } catch { invoke.reject(error.localizedDescription) }
                }
            } else {
                invoke.reject(ClipboardFailure.missing.localizedDescription)
            }
        }
    }

    @objc public func writeClipboardImage(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(ClipboardImageArgs.self)
        guard args.dataBase64.utf8.count <= ((Self.maxImageBytes + 2) / 3) * 4 else {
            invoke.reject(ClipboardFailure.tooLarge.localizedDescription)
            return
        }
        clipboardQueue.async {
            do {
                guard let data = Data(base64Encoded: args.dataBase64) else { throw ClipboardFailure.invalid }
                try Self.validatePng(data)
                DispatchQueue.main.async {
                    UIPasteboard.general.setData(data, forPasteboardType: "public.png")
                    invoke.resolve()
                }
            } catch { invoke.reject(error.localizedDescription) }
        }
    }

    private func resolveImage(_ data: Data, invoke: Invoke) {
        do {
            try Self.validatePng(data)
            invoke.resolve([
                "name": "Clipboard image.png",
                "mimeType": "image/png",
                "dataBase64": data.base64EncodedString()
            ])
        } catch { invoke.reject(error.localizedDescription) }
    }

    private static func validatePng(_ data: Data) throws {
        guard !data.isEmpty, data.count <= maxImageBytes else { throw ClipboardFailure.tooLarge }
        let options = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, options),
              let type = CGImageSourceGetType(source), type as String == "public.png",
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, options) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
              let height = properties[kCGImagePropertyPixelHeight] as? NSNumber
        else { throw ClipboardFailure.invalid }
        try validateDimensions(width: width.doubleValue, height: height.doubleValue)
    }

    private static func validateDimensions(width: Double, height: Double) throws {
        guard width.isFinite, height.isFinite, width > 0, height > 0 else { throw ClipboardFailure.invalid }
        guard width * height <= maxImagePixels else { throw ClipboardFailure.tooManyPixels }
    }
}

@_cdecl("init_plugin_share_inbox")
func initShareInboxPlugin() -> Plugin { ShareInboxPlugin() }
