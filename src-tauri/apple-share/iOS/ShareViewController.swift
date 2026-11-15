import UIKit
import MurmurShareCore

@objc(ShareViewController)
final class ShareViewController: UIViewController {
    private let status = UILabel()
    private let saveButton = UIButton(type: .system)
    private let cancelButton = UIButton(type: .system)
    private var providers: [NSItemProvider] = []
    private var identifiers: [String] = []
    private var saved = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        preferredContentSize = CGSize(width: 420, height: 300)
        let title = UILabel()
        title.text = "Add files to Murmur"
        title.font = .preferredFont(forTextStyle: .headline)
        title.adjustsFontForContentSizeCategory = true
        title.numberOfLines = 0
        status.numberOfLines = 0
        status.font = .preferredFont(forTextStyle: .body)
        status.adjustsFontForContentSizeCategory = true
        saveButton.setTitle("Save to Murmur", for: .normal)
        saveButton.addTarget(self, action: #selector(saveFiles), for: .touchUpInside)
        cancelButton.setTitle("Cancel", for: .normal)
        cancelButton.addTarget(self, action: #selector(close), for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [title, status, saveButton, cancelButton])
        stack.axis = .vertical
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scroll)
        scroll.addSubview(stack)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24),
            stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -48),
        ])
        do {
            providers = try ShareLoader.providers(from: extensionContext)
            identifiers = providers.map { _ in UUID().uuidString.lowercased() }
            status.text = "\(providers.count) file(s). Open Murmur afterward to choose the network."
        } catch {
            status.text = error.localizedDescription
            saveButton.isHidden = true
        }
    }

    @objc private func saveFiles() {
        guard !saved else { close(); return }
        saveButton.isEnabled = false
        cancelButton.isEnabled = false
        Task { @MainActor in
            var completed = 0
            do {
                guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: ShareQueue.appGroup) else {
                    throw ShareFailure.message("The shared inbox is unavailable. This installation must be signed with Murmur’s App Group enabled.")
                }
                let queue = try ShareQueue(url: container.appendingPathComponent(ShareQueue.databaseName))
                for (provider, identifier) in zip(providers, identifiers) {
                    status.text = "Saving file \(completed + 1) of \(providers.count)…"
                    let item = try await ShareLoader.load(provider, id: identifier)
                    try await Task.detached { try queue.insert(item) }.value
                    completed += 1
                }
                saved = true
                status.text = "Saved. Open Murmur to import these files into a network."
                saveButton.setTitle("Done", for: .normal)
                cancelButton.isHidden = true
            } catch {
                let prefix = completed == 0 ? "" : "\(completed) file(s) saved. "
                status.text = prefix + error.localizedDescription
                saveButton.setTitle("Try again", for: .normal)
                cancelButton.setTitle("Close", for: .normal)
            }
            saveButton.isEnabled = true
            cancelButton.isEnabled = true
        }
    }

    @objc private func close() {
        extensionContext?.completeRequest(returningItems: nil)
    }
}
