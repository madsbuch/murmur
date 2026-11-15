import AppKit
import MurmurShareCore

@objc(ShareViewController)
final class ShareViewController: NSViewController {
    private let status = NSTextField(wrappingLabelWithString: "")
    private let saveButton = NSButton(title: "Add to Murmur", target: nil, action: nil)
    private let cancelButton = NSButton(title: "Cancel", target: nil, action: nil)
    private var providers: [NSItemProvider] = []
    private var identifiers: [String] = []
    private var transferURL: URL?
    private var handedOff = false

    override func loadView() {
        view = NSView(frame: NSRect(x: 0, y: 0, width: 430, height: 280))
        let title = NSTextField(labelWithString: "Add files to Murmur")
        title.font = .boldSystemFont(ofSize: 17)
        saveButton.target = self
        saveButton.action = #selector(saveFiles)
        saveButton.bezelStyle = .rounded
        cancelButton.target = self
        cancelButton.action = #selector(close)
        cancelButton.bezelStyle = .rounded
        let buttons = NSStackView(views: [cancelButton, saveButton])
        buttons.orientation = .horizontal
        buttons.spacing = 12
        let stack = NSStackView(views: [title, status, buttons])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 20
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: view.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: view.bottomAnchor, constant: -24),
        ])
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        do {
            providers = try ShareLoader.providers(from: extensionContext)
            identifiers = providers.map { _ in UUID().uuidString.lowercased() }
            status.stringValue = "\(providers.count) file(s). Choose the network in Murmur."
        } catch {
            status.stringValue = error.localizedDescription
            saveButton.isHidden = true
        }
    }

    @objc private func saveFiles() {
        saveButton.isEnabled = false
        cancelButton.isEnabled = false
        Task { @MainActor in
            do {
                let url: URL
                if let existing = transferURL {
                    url = existing
                } else {
                    let directory = FileManager.default.temporaryDirectory
                        .appendingPathComponent("murmur-share-" + UUID().uuidString.lowercased(), isDirectory: true)
                    url = directory.appendingPathComponent("Incoming.murmur-share")
                    transferURL = url
                }
                if !handedOff {
                    let queue = try ShareQueue(url: url)
                    for (offset, pair) in zip(providers, identifiers).enumerated() {
                        status.stringValue = "Preparing file \(offset + 1) of \(providers.count)…"
                        let item = try await ShareLoader.load(pair.0, id: pair.1)
                        try await Task.detached { try queue.insert(item) }.value
                    }
                }
                let application = Bundle.main.bundleURL.deletingLastPathComponent()
                    .deletingLastPathComponent().deletingLastPathComponent()
                guard Bundle(url: application)?.bundleIdentifier == "app.murmur.notes" else {
                    throw ShareFailure.message("Murmur could not be found. Reinstall the app and try again.")
                }
                status.stringValue = "Opening Murmur…"
                handedOff = true
                try await openHost(application: application, transfer: url)
                // The host creates this empty acknowledgement only after its
                // SQLite commit. It never mutates the source transfer file.
                let acknowledgement = url.appendingPathExtension("received")
                for _ in 0..<150 {
                    if FileManager.default.fileExists(atPath: acknowledgement.path) {
                        try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
                        extensionContext?.completeRequest(returningItems: nil)
                        return
                    }
                    try await Task.sleep(nanoseconds: 200_000_000)
                }
                throw ShareFailure.message("Murmur has not accepted the files yet. Open Murmur, clear any full inbox, then try again.")
            } catch {
                status.stringValue = error.localizedDescription
                saveButton.title = "Try again"
                saveButton.isEnabled = true
                cancelButton.title = "Close"
                cancelButton.isEnabled = true
            }
        }
    }

    private func openHost(application: URL, transfer: URL) async throws {
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            NSWorkspace.shared.open([transfer], withApplicationAt: application, configuration: configuration) { _, error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume() }
            }
        }
    }

    @objc private func close() {
        if !handedOff, let transferURL {
            try? FileManager.default.removeItem(at: transferURL.deletingLastPathComponent())
        }
        extensionContext?.completeRequest(returningItems: nil)
    }
}
