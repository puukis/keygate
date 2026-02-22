import SwiftUI

@main
struct KeygateApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var gateway = GatewayService.shared
    @StateObject private var store = SessionStore.shared

    @StateObject private var companionPanelManager = FloatingPanelManager<CompanionChatView>()

    var body: some Scene {
        MenuBarExtra {
            MenuContentView()
                .environmentObject(gateway)
                .environmentObject(store)
                .overlay(
                    HStack {
                        Spacer()
                        VStack {
                            Spacer()
                            Button(action: {
                                companionPanelManager.show(size: CGSize(width: 280, height: 380)) {
                                    CompanionChatView()
                                        .environmentObject(gateway)
                                        .environmentObject(store)
                                }
                            }) {
                                Image(systemName: "pin")
                                    .font(.system(size: 13))
                                    .foregroundStyle(.purple)
                                    .padding(8)
                                    .background(.ultraThinMaterial)
                                    .clipShape(Circle())
                                    .help("Open Companion Chat Window")
                            }
                        }
                    }
                )
        } label: {
            StatusItemLabel(state: gateway.connectionState)
        }
        .menuBarExtraStyle(.window)

        Window("Keygate", id: "main") {
            MainWindowView()
                .environmentObject(gateway)
                .environmentObject(store)
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 960, height: 700)
        .windowResizability(.contentSize)

        Settings {
            SettingsRootView()
                .environmentObject(gateway)
                .environmentObject(store)
        }
    }
}
