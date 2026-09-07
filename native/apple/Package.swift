// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ZeroPairing",
    platforms: [.macOS(.v13), .iOS(.v16), .watchOS(.v9)],
    products: [.library(name: "ZeroPairing", targets: ["ZeroPairing"]), .library(name: "ZeroMail", targets: ["ZeroMail"])],
    targets: [.target(name: "ZeroPairing"), .target(name: "ZeroMail", dependencies: ["ZeroPairing"]),
              .testTarget(name: "ZeroPairingTests", dependencies: ["ZeroPairing"]),
              .testTarget(name: "ZeroMailTests", dependencies: ["ZeroMail"])]
)
