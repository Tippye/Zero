#if canImport(SwiftUI)
import SwiftUI
#if canImport(CoreImage)
import CoreImage.CIFilterBuiltins
#endif

/// Shared authentication screen for macOS, iOS/iPadOS and watchOS targets.
public struct PairingLoginView: View {
    private let client: PairingClient
    private let deviceName: String
    private let onAuthorized: @MainActor () -> Void
    @State private var request: PairingRequest?
    @State private var busy = false
    @State private var message = ""
    public init(client: PairingClient, deviceName: String, onAuthorized: @escaping @MainActor () -> Void) {
        self.client = client; self.deviceName = deviceName; self.onAuthorized = onAuthorized
    }
    public var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                Text("Zero Mail").font(.headline)
                Text("在已登录设备上批准配对码 / Approve from a signed-in device")
                if let request {
                    #if canImport(CoreImage)
                    if let image = qr(request.verificationUriComplete.absoluteString) {
                        Image(decorative: image, scale: 1).interpolation(.none).resizable().scaledToFit().frame(maxWidth: 220, maxHeight: 220).padding(16).background(Color.white)
                    }
                    #endif
                    Text(request.userCode).font(.system(.title2, design: .monospaced)).accessibilityIdentifier("pairingCode")
                    Text(request.expiresAt, style: .relative)
                    Text(request.verificationUri.absoluteString).font(.footnote)
                }
                if !message.isEmpty { Text(message).font(.footnote) }
                Button("生成配对码 / Pair device") {
                    busy = true; message = ""
                    Task {
                        do { request = try await client.start(deviceName: deviceName) }
                        catch { message = "无法连接服务器，请重试。 / Connection failed." }
                        busy = false
                    }
                }.disabled(busy || request != nil).accessibilityIdentifier("pairDevice")
            }.padding()
        }
        .task(id: request?.requestId) {
            guard let pending = request else { return }
            do { try await client.waitForAuthorization(pending); onAuthorized() }
            catch is CancellationError { }
            catch { message = "配对未完成，请重试。 / Pairing failed or expired."; request = nil }
        }
    }
    #if canImport(CoreImage)
    private func qr(_ text: String) -> CGImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        guard let image = filter.outputImage else { return nil }
        let scaled = image.transformed(by: CGAffineTransform(scaleX: 8, y: 8))
        return CIContext().createCGImage(scaled, from: scaled.extent)
    }
    #endif
}
#endif
