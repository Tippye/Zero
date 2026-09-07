#if !os(watchOS)
import SwiftUI
import WebKit

/// A separate, ephemeral renderer with no scripts, remote resources or app credentials.
struct HTMLMailView: View {
    let html: String
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            SafeHTML(html: html).navigationTitle("邮件排版")
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }
        #if os(macOS)
        .frame(minWidth: 640, minHeight: 500)
        #endif
    }
}
private final class MailNavigationDelegate: NSObject, WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.navigationType == .other, action.request.url?.absoluteString == "about:blank" { decisionHandler(.allow) }
        else { decisionHandler(.cancel) }
    }
}
private func makeMailWebView(delegate: MailNavigationDelegate) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.defaultWebpagePreferences.allowsContentJavaScript = false
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    let view = WKWebView(frame: .zero, configuration: configuration)
    view.navigationDelegate = delegate
    return view
}
private func loadMailHTML(_ html: String, into view: WKWebView) {
    let prefix = """
    <!doctype html><html><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>body{font:16px -apple-system;padding:16px;overflow-wrap:anywhere}img{max-width:100%;height:auto}pre{white-space:pre-wrap}table{max-width:100%}</style></head><body>
    """
    view.loadHTMLString(prefix + html + "</body></html>", baseURL: nil)
}
#if os(macOS)
private struct SafeHTML: NSViewRepresentable {
    let html: String
    func makeCoordinator() -> MailNavigationDelegate { MailNavigationDelegate() }
    func makeNSView(context: Context) -> WKWebView { makeMailWebView(delegate: context.coordinator) }
    func updateNSView(_ view: WKWebView, context: Context) { loadMailHTML(html, into: view) }
}
#else
private struct SafeHTML: UIViewRepresentable {
    let html: String
    func makeCoordinator() -> MailNavigationDelegate { MailNavigationDelegate() }
    func makeUIView(context: Context) -> WKWebView { makeMailWebView(delegate: context.coordinator) }
    func updateUIView(_ view: WKWebView, context: Context) { loadMailHTML(html, into: view) }
}
#endif
#endif
