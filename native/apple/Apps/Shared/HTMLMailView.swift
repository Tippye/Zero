#if !os(watchOS)
import SwiftUI
import WebKit

/// HTML is the default body, while text-only messages remain native selectable text.
struct MailMessageBody: View {
    let html: String
    let text: String
    @State private var height: CGFloat = 96
    @State private var failed = false
    @State private var plainText = false
    @ScaledMetric(relativeTo: .body) private var fontSize = 16.0
    private var hasHTML: Bool { !html.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if hasHTML, !plainText, !failed {
                SafeHTML(html: html, fontSize: fontSize, onHeight: { height = $0 }, onFailure: { failed = true })
                    .frame(height: height)
                    .background(Color.white)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            } else {
                Text(text.isEmpty ? "此邮件没有纯文本正文。" : text)
                    .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
            }
            if failed {
                Text("邮件排版加载失败。").font(.caption).foregroundStyle(.secondary)
                Button("重试邮件排版") { failed = false; plainText = false }
            }
            if hasHTML, !text.isEmpty {
                Button(plainText ? "显示邮件排版" : "显示纯文本") { plainText.toggle() }
                    .font(.caption).accessibilityIdentifier("toggleMailBodyFormat")
            }
        }
    }
}

/// A separate expanded view uses the same isolated renderer and can scroll any length.
struct HTMLMailView: View {
    let html: String
    @Environment(\.dismiss) private var dismiss
    @State private var failed = false
    var body: some View {
        NavigationStack {
            Group {
                if failed { VStack { Text("邮件排版加载失败。"); Button("重试") { failed = false } } }
                else { SafeHTML(html: html, onFailure: { failed = true }) }
            }.navigationTitle("邮件排版")
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }
        #if os(macOS)
        .frame(minWidth: 640, minHeight: 500)
        #endif
    }
}

private final class MailNavigationDelegate: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    static let maximumInlineHeight: CGFloat = 8_000
    var onHeight: ((CGFloat) -> Void)?
    var onFailure: (() -> Void)?
    private var loadedHTML: String?
    private var loadedFontSize: Double?
    private var navigation: WKNavigation?

    func load(_ html: String, fontSize: Double, into view: WKWebView) {
        // SwiftUI updates this representable for selection, AI, preferences and layout.
        // Reloading identical HTML on every update interrupts WebKit and resets scrolling.
        guard loadedHTML != html || loadedFontSize != fontSize else { return }
        loadedHTML = html; loadedFontSize = fontSize
        let prefix = """
        <!doctype html><html><head><meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>html{color-scheme:light;background:#fff}body{color:#1d1d1f;font:\(fontSize)px/1.45 -apple-system;margin:0;padding:12px;overflow-wrap:anywhere}img{max-width:100%;height:auto}pre{white-space:pre-wrap}table{max-width:100%}</style></head><body>
        """
        navigation = view.loadHTMLString(prefix + html + "</body></html>", baseURL: nil)
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.navigationType == .other, action.targetFrame?.isMainFrame == true,
           action.request.url?.absoluteString == "about:blank" { decisionHandler(.allow) }
        else { decisionHandler(.cancel) }
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let size = message.body as? [String: Double],
              let height = size["height"], height.isFinite, height > 0 else { return }
        #if os(iOS)
        if onHeight != nil, let view = message.webView {
            let width = size["width"] ?? 0
            view.scrollView.isScrollEnabled = height > Self.maximumInlineHeight || width > view.bounds.width + 1
        }
        #endif
        onHeight?(min(Self.maximumInlineHeight, max(44, ceil(height))))
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if navigation === self.navigation, (error as NSError).code != NSURLErrorCancelled { onFailure?() }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if navigation === self.navigation, (error as NSError).code != NSURLErrorCancelled { onFailure?() }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { onFailure?() }
}

private func makeMailWebView(delegate: MailNavigationDelegate) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.defaultWebpagePreferences.allowsContentJavaScript = false
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    // App-owned layout code runs in its own world. Email scripts remain disabled.
    configuration.userContentController.add(delegate, contentWorld: .defaultClient, name: "zeroMailLayout")
    configuration.userContentController.addUserScript(WKUserScript(source: """
    (() => {
      const body = document.body;
      if (!body) return;
      body.style.setProperty('height', 'auto', 'important');
      body.style.setProperty('min-height', '0', 'important');
      let previous = '';
      const measure = () => {
        const css = getComputedStyle(body);
        const height = Math.ceil(body.getBoundingClientRect().height + (parseFloat(css.marginTop) || 0) + (parseFloat(css.marginBottom) || 0));
        const width = Math.ceil(body.scrollWidth);
        const size = JSON.stringify({height, width});
        if (size !== previous) { previous = size; window.webkit.messageHandlers.zeroMailLayout.postMessage({height, width}); }
      };
      new ResizeObserver(measure).observe(body);
      window.addEventListener('load', measure);
      window.addEventListener('resize', measure);
      document.addEventListener('load', measure, true);
      measure();
    })();
    """, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: .defaultClient))
    let view = WKWebView(frame: .zero, configuration: configuration)
    view.navigationDelegate = delegate
    view.underPageBackgroundColor = .white
    #if os(iOS)
    view.scrollView.bounces = false
    #endif
    return view
}
#if os(macOS)
private struct SafeHTML: NSViewRepresentable {
    let html: String
    var fontSize = 16.0
    var onHeight: ((CGFloat) -> Void)? = nil
    var onFailure: (() -> Void)? = nil
    func makeCoordinator() -> MailNavigationDelegate { MailNavigationDelegate() }
    func makeNSView(context: Context) -> WKWebView { makeMailWebView(delegate: context.coordinator) }
    func updateNSView(_ view: WKWebView, context: Context) {
        context.coordinator.onHeight = onHeight; context.coordinator.onFailure = onFailure
        context.coordinator.load(html, fontSize: fontSize, into: view)
    }
    static func dismantleNSView(_ view: WKWebView, coordinator: MailNavigationDelegate) {
        view.stopLoading(); view.navigationDelegate = nil
        view.configuration.userContentController.removeScriptMessageHandler(forName: "zeroMailLayout", contentWorld: .defaultClient)
    }
}
#else
private struct SafeHTML: UIViewRepresentable {
    let html: String
    var fontSize = 16.0
    var onHeight: ((CGFloat) -> Void)? = nil
    var onFailure: (() -> Void)? = nil
    func makeCoordinator() -> MailNavigationDelegate { MailNavigationDelegate() }
    func makeUIView(context: Context) -> WKWebView { makeMailWebView(delegate: context.coordinator) }
    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.onHeight = onHeight; context.coordinator.onFailure = onFailure
        context.coordinator.load(html, fontSize: fontSize, into: view)
    }
    static func dismantleUIView(_ view: WKWebView, coordinator: MailNavigationDelegate) {
        view.stopLoading(); view.navigationDelegate = nil
        view.configuration.userContentController.removeScriptMessageHandler(forName: "zeroMailLayout", contentWorld: .defaultClient)
    }
}
#endif
#endif
