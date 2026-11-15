import Foundation
import GRDB

public enum ShareFailure: LocalizedError, Sendable {
    case message(String)
    public var errorDescription: String? {
        switch self { case .message(let message): return message }
    }
}

public struct SharedItem: Sendable {
    public let id: String
    public let name: String
    public let mimeType: String
    public let content: Data

    public init(id: String, name: String, mimeType: String, content: Data) {
        self.id = id
        self.name = name
        self.mimeType = mimeType
        self.content = content
    }
}

/// The extension's durable inbox uses SQLite. The host consumes the same rows
/// through Diesel and acknowledges only after its own durable transaction.
public final class ShareQueue: Sendable {
    public static let maximumFileBytes = 25 * 1024 * 1024
    public static let maximumQueueBytes = 100 * 1024 * 1024
    public static let maximumItems = 32
    public static let appGroup = "group.app.murmur.notes"
    public static let databaseName = "incoming-shares.sqlite3"
    private let database: DatabaseQueue

    public init(url: URL) throws {
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        do {
            // Exclusive creation is essential when two share sheets start at
            // once; FileManager.createFile can truncate an existing database.
            try Data().write(to: url, options: .withoutOverwriting)
        } catch {
            guard (error as? CocoaError)?.code == .fileWriteFileExists else { throw error }
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        var configuration = Configuration()
        configuration.busyMode = .timeout(5)
        // A transfer is a single portable SQLite file; no WAL sidecar needs to
        // be handed to the host. FULL makes successful sharing durable.
        configuration.prepareDatabase { db in
            try db.execute(sql: "PRAGMA auto_vacuum = FULL")
            try db.execute(sql: "PRAGMA journal_mode = DELETE")
            try db.execute(sql: "PRAGMA synchronous = FULL")
        }
        database = try DatabaseQueue(path: url.path, configuration: configuration)
        try database.write { db in
            // STRICT arrived in SQLite 3.37. Older supported Apple systems use
            // identical columns with explicit type checks instead.
            let strict = Database.sqliteLibVersionNumber >= 3_037_000 ? " STRICT" : ""
            try db.execute(sql: """
                CREATE TABLE IF NOT EXISTS incoming_shares (
                    id TEXT PRIMARY KEY NOT NULL CHECK(typeof(id) = 'text'),
                    name TEXT NOT NULL CHECK(typeof(name) = 'text'),
                    mime_type TEXT NOT NULL CHECK(typeof(mime_type) = 'text'),
                    content BLOB NOT NULL CHECK(typeof(content) = 'blob' AND length(content) <= 26214400),
                    created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer')
                )
                """ + strict)
        }
    }

    public func insert(_ item: SharedItem) throws {
        guard UUID(uuidString: item.id)?.uuidString.lowercased() == item.id else {
            throw ShareFailure.message("The shared file has an invalid identifier.")
        }
        guard !item.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              item.name != ".", item.name != "..", item.name.unicodeScalars.count <= 255,
              item.name.utf8.count <= 1024,
              !item.name.contains("/"), !item.name.contains("\\"),
              item.name.rangeOfCharacter(from: .controlCharacters) == nil else {
            throw ShareFailure.message("The shared file has an invalid name.")
        }
        let tokens = item.mimeType.split(separator: "/", omittingEmptySubsequences: false)
        let tokenCharacters = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$&^_.+-")
        guard item.mimeType.utf8.count <= 127, tokens.count == 2,
              tokens.allSatisfy({ !$0.isEmpty && $0.unicodeScalars.allSatisfy(tokenCharacters.contains) }) else {
            throw ShareFailure.message("The shared file has an invalid content type.")
        }
        guard item.content.count <= Self.maximumFileBytes else {
            throw ShareFailure.message("Each shared file must be 25 MB or smaller.")
        }
        guard let timestamp = Int64(exactly: (Date().timeIntervalSince1970 * 1000).rounded(.down)) else {
            throw ShareFailure.message("The device clock could not be read.")
        }
        try database.write { db in
            if try Bool.fetchOne(db, sql: "SELECT EXISTS(SELECT 1 FROM incoming_shares WHERE id = ?)",
                                 arguments: [item.id]) == true { return }
            let count = try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM incoming_shares") ?? 0
            let bytes = try Int.fetchOne(db, sql: "SELECT COALESCE(SUM(length(content)), 0) FROM incoming_shares") ?? 0
            guard count < Self.maximumItems, bytes <= Self.maximumQueueBytes - item.content.count else {
                throw ShareFailure.message("Murmur’s inbox is full (32 files or 100 MB). Open Murmur and import or discard pending files first.")
            }
            try db.execute(sql: "INSERT INTO incoming_shares (id, name, mime_type, content, created_at) VALUES (?, ?, ?, ?, ?)",
                           arguments: [item.id, item.name, item.mimeType, item.content, timestamp])
        }
    }

    public func count() throws -> Int {
        try database.read { db in try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM incoming_shares") ?? 0 }
    }
}
