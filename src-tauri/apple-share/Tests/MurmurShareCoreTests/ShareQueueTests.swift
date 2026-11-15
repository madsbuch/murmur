import Foundation
import Testing
import UniformTypeIdentifiers
@testable import MurmurShareCore

@Test func queueSurvivesRestartAndRetriesDoNotDuplicate() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("transfer.murmur-share")
    let item = SharedItem(id: UUID().uuidString.lowercased(), name: "Example.pdf",
                          mimeType: "application/pdf", content: Data("test contents".utf8))
    do {
        let queue = try ShareQueue(url: url)
        try queue.insert(item)
        try queue.insert(item)
        #expect(try queue.count() == 1)
    }
    #expect(try ShareQueue(url: url).count() == 1)
    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
    #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
}

@MainActor @Test func fileProvidersPreserveExactBytesAndNames() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("Example.pdf")
    let bytes = Data("%PDF-1.7\nshared fixture\n".utf8)
    try bytes.write(to: url)
    let provider = NSItemProvider(item: NSURL(fileURLWithPath: url.path), typeIdentifier: UTType.fileURL.identifier)
    let id = UUID().uuidString.lowercased()
    let item = try await ShareLoader.load(provider, id: id)
    #expect(item.id == id)
    #expect(item.name == "Example.pdf")
    #expect(item.mimeType == "application/pdf")
    #expect(item.content == bytes)
}

@MainActor @Test func imageRepresentationReadsProviderTemporaryFile() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("image.png")
    let bytes = Data([137, 80, 78, 71, 13, 10, 26, 10])
    try bytes.write(to: url)
    let provider = NSItemProvider()
    provider.suggestedName = "Screenshot"
    provider.registerFileRepresentation(forTypeIdentifier: UTType.png.identifier, fileOptions: [], visibility: .all) { completion in
        completion(url, false, nil)
        return nil
    }
    let item = try await ShareLoader.load(provider, id: UUID().uuidString.lowercased())
    #expect(item.name == "Screenshot.png")
    #expect(item.mimeType == "image/png")
    #expect(item.content == bytes)
}

@Test func queueRejectsInvalidFilesAndCountOverflow() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let queue = try ShareQueue(url: directory.appendingPathComponent("incoming.sqlite3"))
    #expect(throws: (any Error).self) {
        try queue.insert(SharedItem(id: UUID().uuidString.lowercased(), name: "../bad", mimeType: "image/png", content: Data()))
    }
    #expect(throws: (any Error).self) {
        try queue.insert(SharedItem(id: UUID().uuidString.lowercased(), name: "large.png", mimeType: "image/png",
                                    content: Data(repeating: 0, count: ShareQueue.maximumFileBytes + 1)))
    }
    for index in 0..<ShareQueue.maximumItems {
        try queue.insert(SharedItem(id: UUID().uuidString.lowercased(), name: "File-\(index).txt",
                                    mimeType: "text/plain", content: Data()))
    }
    #expect(throws: (any Error).self) {
        try queue.insert(SharedItem(id: UUID().uuidString.lowercased(), name: "extra.txt", mimeType: "text/plain", content: Data()))
    }
    #expect(try queue.count() == ShareQueue.maximumItems)
}

@Test func simultaneousShareSheetsNeverTruncateEachOthersInbox() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("incoming.sqlite3")
    try await withThrowingTaskGroup(of: Void.self) { group in
        for index in 0..<12 {
            group.addTask {
                let queue = try ShareQueue(url: url)
                try queue.insert(SharedItem(id: UUID().uuidString.lowercased(), name: "File-\(index).txt",
                                            mimeType: "text/plain", content: Data("shared".utf8)))
            }
        }
        try await group.waitForAll()
    }
    #expect(try ShareQueue(url: url).count() == 12)
}
