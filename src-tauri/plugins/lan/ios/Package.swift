// swift-tools-version:5.3
import PackageDescription

let package = Package(
    name: "tauri-plugin-lan",
    platforms: [.iOS(.v13)],
    products: [.library(name: "tauri-plugin-lan", type: .static, targets: ["tauri-plugin-lan"])],
    dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
    targets: [.target(name: "tauri-plugin-lan", dependencies: [.byName(name: "Tauri")], path: "Sources")]
)
