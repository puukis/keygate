import AppKit
import Foundation
import WebKit

@MainActor
final class CanvasWindowManager: NSObject {
    static let shared = CanvasWindowManager()

    private var controllers: [String: CanvasWindowController] = [:]

    func present(surface: CanvasStatePayload, baseURL: URL, reveal: Bool = true) {
        let key = surface.id
        if let controller = controllers[key] {
            controller.update(surface: surface, baseURL: baseURL)
            if reveal {
                controller.showWindow(nil)
                controller.window?.makeKeyAndOrderFront(nil)
            }
            return
        }

        let controller = CanvasWindowController(
            surface: surface,
            baseURL: baseURL
        ) { [weak self] surfaceKey in
            self?.controllers.removeValue(forKey: surfaceKey)
        }
        controllers[key] = controller
        controller.showWindow(nil)
        controller.window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func close(sessionId: String, surfaceId: String) {
        let key = "\(sessionId):\(surfaceId)"
        guard let controller = controllers.removeValue(forKey: key) else { return }
        controller.close()
    }
}

@MainActor
private final class CanvasWindowController: NSWindowController, NSWindowDelegate, WKNavigationDelegate {
    private let surfaceKey: String
    private let webView: WKWebView
    private let onClose: (String) -> Void
    private var currentSurface: CanvasStatePayload
    private var currentBaseURL: URL
    private var loadedURL: URL?

    init(
        surface: CanvasStatePayload,
        baseURL: URL,
        onClose: @escaping (String) -> Void
    ) {
        self.surfaceKey = surface.id
        self.currentSurface = surface
        self.currentBaseURL = baseURL
        self.onClose = onClose

        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.websiteDataStore = .default()
        self.webView = WKWebView(frame: .zero, configuration: configuration)
        self.webView.setValue(false, forKey: "drawsBackground")

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 980, height: 720),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = CanvasWindowController.windowTitle(for: surface)
        window.contentView = webView
        window.isReleasedWhenClosed = false
        window.identifier = NSUserInterfaceItemIdentifier(surface.id)

        super.init(window: window)

        window.delegate = self
        webView.navigationDelegate = self
        update(surface: surface, baseURL: baseURL)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func update(surface: CanvasStatePayload, baseURL: URL) {
        currentSurface = surface
        currentBaseURL = baseURL
        window?.title = Self.windowTitle(for: surface)

        guard let targetURL = Self.canvasURL(for: surface, baseURL: baseURL) else { return }
        if loadedURL != targetURL {
            loadedURL = targetURL
            webView.load(URLRequest(url: targetURL))
            return
        }

        dispatchCurrentSurface()
    }

    func windowWillClose(_ notification: Notification) {
        onClose(surfaceKey)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        dispatchCurrentSurface()
    }

    private func dispatchCurrentSurface() {
        struct CanvasBridgePayload: Encodable {
            let type = "canvas_state"
            let sessionId: String
            let surfaceId: String
            let path: String
            let mode: String
            let state: AnyCodable?
            let statusText: String?
        }

        let payload = CanvasBridgePayload(
            sessionId: currentSurface.sessionId,
            surfaceId: currentSurface.surfaceId,
            path: currentSurface.path,
            mode: currentSurface.mode,
            state: currentSurface.state,
            statusText: currentSurface.statusText
        )

        guard
            let data = try? JSONEncoder().encode(payload),
            let json = String(data: data, encoding: .utf8)
        else {
            return
        }

        let script = """
        window.dispatchEvent(new CustomEvent('keygate:canvas-state', { detail: \(json) }));
        """
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    private static func windowTitle(for surface: CanvasStatePayload) -> String {
        let label = surface.statusText?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let label, !label.isEmpty {
            return "Canvas · \(label)"
        }
        return "Canvas · \(surface.surfaceId)"
    }

    private static func canvasURL(for surface: CanvasStatePayload, baseURL: URL) -> URL? {
        let rawPath = surface.path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !rawPath.isEmpty else { return nil }

        let resolvedURL: URL
        if rawPath.hasPrefix("http://") || rawPath.hasPrefix("https://") {
            guard let directURL = URL(string: rawPath) else { return nil }
            resolvedURL = directURL
        } else {
            guard let relativeURL = URL(string: rawPath, relativeTo: baseURL)?.absoluteURL else { return nil }
            resolvedURL = relativeURL
        }

        guard var components = URLComponents(url: resolvedURL, resolvingAgainstBaseURL: false) else {
            return resolvedURL
        }

        var queryItems = components.queryItems ?? []
        upsertQueryItem(&queryItems, name: "sessionId", value: surface.sessionId)
        upsertQueryItem(&queryItems, name: "surfaceId", value: surface.surfaceId)
        components.queryItems = queryItems
        return components.url
    }

    private static func upsertQueryItem(_ queryItems: inout [URLQueryItem], name: String, value: String) {
        if let index = queryItems.firstIndex(where: { $0.name == name }) {
            queryItems[index] = URLQueryItem(name: name, value: value)
        } else {
            queryItems.append(URLQueryItem(name: name, value: value))
        }
    }
}
