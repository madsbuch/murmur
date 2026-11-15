import Foundation
import UniformTypeIdentifiers

@MainActor
public enum ShareLoader {
    public static func providers(from context: NSExtensionContext?) throws -> [NSItemProvider] {
        let items = context?.inputItems.compactMap { $0 as? NSExtensionItem } ?? []
        let providers = items.flatMap { $0.attachments ?? [] }
        guard !providers.isEmpty else { throw ShareFailure.message("No files were shared.") }
        guard providers.count <= ShareQueue.maximumItems else {
            throw ShareFailure.message("Share up to 32 files at a time.")
        }
        return providers
    }

    public static func load(_ provider: NSItemProvider, id: String) async throws -> SharedItem {
        if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            return try await withCheckedThrowingContinuation { continuation in
                provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, error in
                    do {
                        if let error { throw error }
                        let candidate: URL?
                        if let url = item as? URL {
                            candidate = url
                        } else if let bytes = item as? Data, bytes.count <= 8192,
                                  let text = String(data: bytes, encoding: .utf8) {
                            candidate = URL(string: text.trimmingCharacters(in: .controlCharacters))
                        } else if let text = item as? String, text.utf8.count <= 8192 {
                            candidate = URL(string: text)
                        } else {
                            candidate = nil
                        }
                        guard let url = candidate, url.isFileURL else {
                            throw ShareFailure.message("The shared item is not a local file.")
                        }
                        let scoped = url.startAccessingSecurityScopedResource()
                        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                        let type = UTType(filenameExtension: url.pathExtension)
                        continuation.resume(returning: try read(url: url, id: id, suggestedName: nil,
                            mimeType: type?.preferredMIMEType ?? "application/octet-stream", suffix: nil))
                    } catch { continuation.resume(throwing: error) }
                }
            }
        }
        let identifiers = provider.registeredTypeIdentifiers
        guard let identifier = identifiers.first(where: { identifier in
            guard let type = UTType(identifier) else { return false }
            return type.conforms(to: .data) && !type.conforms(to: .url)
        }) else {
            throw ShareFailure.message("This app did not provide a file or image. Save the item as a file and share it again.")
        }
        let type = UTType(identifier)
        let mimeType = type?.preferredMIMEType ?? "application/octet-stream"
        let suggestedName = provider.suggestedName
        let suffix = type?.preferredFilenameExtension
        return try await withCheckedThrowingContinuation { continuation in
            provider.loadFileRepresentation(forTypeIdentifier: identifier) { url, error in
                do {
                    if let error { throw error }
                    guard let url else { throw ShareFailure.message("The shared file could not be read.") }
                    // Read before returning: the provider removes this temporary
                    // file as soon as its completion handler returns.
                    continuation.resume(returning: try read(url: url, id: id, suggestedName: suggestedName,
                                                            mimeType: mimeType, suffix: suffix))
                } catch { continuation.resume(throwing: error) }
            }
        }
    }

    private nonisolated static func read(url: URL, id: String, suggestedName: String?, mimeType: String, suffix: String?) throws -> SharedItem {
        let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
        guard values.isRegularFile == true, let size = values.fileSize,
              size >= 0, size <= ShareQueue.maximumFileBytes else {
            throw ShareFailure.message("Each shared file must be 25 MB or smaller. Folders cannot be shared.")
        }
        var name = suggestedName ?? url.lastPathComponent
        if name.isEmpty || name == "." || name == ".." { name = mimeType.hasPrefix("image/") ? "Image" : "Shared file" }
        if URL(fileURLWithPath: name).pathExtension.isEmpty, let suffix { name += "." + suffix }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var content = Data()
        while let chunk = try handle.read(upToCount: min(1024 * 1024, ShareQueue.maximumFileBytes + 1 - content.count)), !chunk.isEmpty {
            content.append(chunk)
            if content.count > ShareQueue.maximumFileBytes {
                throw ShareFailure.message("Each shared file must be 25 MB or smaller.")
            }
        }
        guard content.count == size else { throw ShareFailure.message("The shared file changed while it was being read. Try sharing it again.") }
        return SharedItem(id: id, name: name, mimeType: mimeType, content: content)
    }
}
