import AppKit
import Sparkle
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {

    /// Sparkle updater — checks GitHub Releases for new versions.
    static let updaterController = SPUStandardUpdaterController(
        startingUpdater: true,
        updaterDelegate: nil,
        userDriverDelegate: nil
    )

    var updaterController: SPUStandardUpdaterController { Self.updaterController }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Start as accessory (no dock icon) — dock icon appears when main window opens
        NSApp.setActivationPolicy(.accessory)

        // Connect to gateway
        GatewayService.shared.connect()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // Keep running in menu bar when windows close
        false
    }

    func applicationWillTerminate(_ notification: Notification) {
        GatewayService.shared.disconnect()
    }
}
