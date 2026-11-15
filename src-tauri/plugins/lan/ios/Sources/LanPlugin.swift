import Foundation
import Darwin
import Tauri
import UIKit
import WebKit

private struct LanConfig: Decodable {
    let serviceName: String
    let networkId: String
    let deviceId: String
    let port: UInt16
}
private struct StartArgs: Decodable { let config: LanConfig }

/// System Bonjour supplies mDNS without requiring Apple's multicast entitlement.
final class LanPlugin: Plugin, NetServiceBrowserDelegate, NetServiceDelegate {
    private var desired: LanConfig?
    private var browser: NetServiceBrowser?
    private var advertisement: NetService?
    private var services: [String: NetService] = [:]
    private var refresh: Timer?
    private var observers: [NSObjectProtocol] = []

    @objc override public func load(webview: WKWebView) {
        observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.stopNative()
        })
        observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            if self?.desired != nil { self?.restart() }
        })
    }

    @objc public func start(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(StartArgs.self)
        DispatchQueue.main.async {
            self.desired = args.config
            self.restart()
            invoke.resolve()
        }
    }

    @objc public func stop(_ invoke: Invoke) {
        DispatchQueue.main.async {
            self.desired = nil
            self.stopNative()
            invoke.resolve()
        }
    }

    private func restart() {
        stopNative()
        guard let config = desired else { return }
        let service = NetService(domain: "local.", type: "_murmur._tcp.", name: config.serviceName, port: Int32(config.port))
        service.delegate = self
        service.setTXTRecord(NetService.data(fromTXTRecord: [
            "network": Data(config.networkId.utf8),
            "device": Data(config.deviceId.utf8),
            "v": Data("1".utf8)
        ]))
        advertisement = service
        service.publish()

        let finder = NetServiceBrowser()
        finder.delegate = self
        browser = finder
        finder.searchForServices(ofType: "_murmur._tcp.", inDomain: "local.")
        refresh = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            guard let self = self, self.desired != nil else { return }
            if self.browser == nil || self.advertisement == nil { self.restart(); return }
            // Refresh addresses after a Wi-Fi change, including peers already in the cache.
            for service in self.services.values { service.resolve(withTimeout: 8) }
        }
    }

    private func stopNative() {
        refresh?.invalidate()
        refresh = nil
        browser?.delegate = nil
        browser?.stop()
        browser = nil
        advertisement?.delegate = nil
        advertisement?.stop()
        advertisement = nil
        for service in services.values { service.delegate = nil; service.stop() }
        services.removeAll()
    }

    func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
        guard browser === self.browser else { return }
        services[service.name] = service
        service.delegate = self
        service.resolve(withTimeout: 8)
    }

    func netServiceBrowser(_ browser: NetServiceBrowser, didRemove service: NetService, moreComing: Bool) {
        guard browser === self.browser else { return }
        services.removeValue(forKey: service.name)?.stop()
    }

    func netServiceBrowser(_ browser: NetServiceBrowser, didNotSearch errorDict: [String: NSNumber]) {
        guard browser === self.browser else { return }
        browser.stop()
        self.browser = nil
        trigger("error", data: ["message": "Local network discovery is unavailable. Allow Murmur local network access in Settings. Retrying shortly."])
    }

    func netService(_ sender: NetService, didNotPublish errorDict: [String: NSNumber]) {
        guard sender === advertisement else { return }
        sender.stop()
        advertisement = nil
        trigger("error", data: ["message": "Local network advertising is unavailable. Retrying shortly."])
    }

    func netServiceDidResolveAddress(_ sender: NetService) {
        guard services[sender.name] === sender, let config = desired,
              let data = sender.txtRecordData() else { return }
        let txt = NetService.dictionary(fromTXTRecord: data)
        guard let networkData = txt["network"], let deviceData = txt["device"],
              let network = String(data: networkData, encoding: .utf8),
              let device = String(data: deviceData, encoding: .utf8),
              network == config.networkId, !device.isEmpty, device != config.deviceId,
              sender.port > 0 else { return }
        let addresses = (sender.addresses ?? []).compactMap { data -> String? in
            data.withUnsafeBytes { bytes -> String? in
                guard let base = bytes.baseAddress, bytes.count >= MemoryLayout<sockaddr>.size else { return nil }
                let address = base.assumingMemoryBound(to: sockaddr.self)
                var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                guard getnameinfo(address, socklen_t(data.count), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 else { return nil }
                // getnameinfo may return %en0; use a numeric zone so Rust's
                // SocketAddr parser works without invoking DNS resolution.
                let numericHost = String(cString: host).components(separatedBy: "%")[0]
                if Int32(address.pointee.sa_family) == AF_INET6,
                   bytes.count >= MemoryLayout<sockaddr_in6>.size {
                    let scope = base.assumingMemoryBound(to: sockaddr_in6.self).pointee.sin6_scope_id
                    if scope != 0 { return "\(numericHost)%\(scope)" }
                }
                return numericHost
            }
        }
        guard !addresses.isEmpty else { return }
        trigger("peer", data: ["deviceId": device, "networkId": network, "addresses": addresses, "port": sender.port])
    }

    deinit {
        refresh?.invalidate()
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        browser?.stop()
        advertisement?.stop()
        services.values.forEach { $0.stop() }
    }
}

@_cdecl("init_plugin_lan")
func initPlugin() -> Plugin { LanPlugin() }
