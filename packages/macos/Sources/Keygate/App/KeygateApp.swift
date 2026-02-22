import SwiftUI

@main
struct KeygateApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var gateway = GatewayService.shared
    @StateObject private var store = SessionStore.shared

    @StateObject private var companionPanelManager = FloatingPanelManager()

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
                                        .environmentObject(companionPanelManager)
                                }
                            }) {
                                Image(systemName: "sparkles")
                                    .font(.system(size: 14, weight: .medium))
                                    .foregroundStyle(
                                        .linearGradient(
                                            colors: [.purple, .indigo],
                                            startPoint: .topLeading,
                                            endPoint: .bottomTrailing
                                        )
                                    )
                                    .symbolEffect(.pulse.wholeSymbol, options: .repeating)
                                    .frame(width: 32, height: 32)
                                    .background(.ultraThinMaterial)
                                    .clipShape(Circle())
                                    .shadow(color: .purple.opacity(0.25), radius: 4, y: 1)
                                    .help("Open Companion Chat Window")
                            }
                            .buttonStyle(.plain)
                            .padding(8)
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
