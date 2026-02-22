import AppKit
import Combine
import Sparkle
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {

    /// Sparkle updater — checks GitHub Releases for new versions.
    static let updaterController = SPUStandardUpdaterController(
        startingUpdater: true,
        updaterDelegate: nil,
        userDriverDelegate: nil
    )

    var updaterController: SPUStandardUpdaterController { Self.updaterController }

    private let tooltipManager = StatusTooltipManager()
    private var tooltipCancellables = Set<AnyCancellable>()

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Start as accessory (no dock icon) — dock icon appears when main window opens
        NSApp.setActivationPolicy(.accessory)

        // Connect to gateway
        GatewayService.shared.connect()

        // Start hover tooltip tracking after a brief delay so MenuBarExtra exists
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            self?.tooltipManager.attachTracking()
            self?.startTooltipContentObserver()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // Keep running in menu bar when windows close
        false
    }

    func applicationWillTerminate(_ notification: Notification) {
        GatewayService.shared.disconnect()
        tooltipManager.teardown()
    }

    // MARK: - Tooltip Content Updates

    /// Observe state changes and update the tooltip content if it's visible.
    private func startTooltipContentObserver() {
        let gateway = GatewayService.shared
        let store = SessionStore.shared

        Publishers.CombineLatest4(
            gateway.$connectionState,
            gateway.$activeTools,
            store.$activeIsStreaming,
            store.$activeIsThinking
        )
        .debounce(for: .milliseconds(150), scheduler: RunLoop.main)
        .sink { [weak self] _ in
            Task { @MainActor in
                self?.tooltipManager.updateContent()
            }
        }
        .store(in: &tooltipCancellables)
    }
}
