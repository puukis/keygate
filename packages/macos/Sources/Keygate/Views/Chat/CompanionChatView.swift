import SwiftUI
import Combine

/// Compact floating companion chat window — stays on-screen while you work.
///
/// Uses the same Combine-driven state pattern as `MenuContentView` because
/// floating panels have the same SwiftUI observation quirks as `MenuBarExtra`.
struct CompanionChatView: View {
    @EnvironmentObject var gateway: GatewayService
    @EnvironmentObject var store: SessionStore
    @EnvironmentObject var panelManager: FloatingPanelManager

    @State private var input = ""

    // Combine-driven local state (same workaround as MenuContentView)
    @State private var messages: [ChatMessage] = []
    @State private var isStreaming = false
    @State private var isThinking = false
    @State private var streamContent = ""
    @State private var isConnected = false
    @State private var hasSession = false
    @State private var alwaysOnTop = true

    var body: some View {
        VStack(spacing: 0) {
            companionHeader
            Divider().opacity(0.5)
            messageArea
            inputBar
        }
        .background(VisualEffectView(material: .popover, blendingMode: .behindWindow, state: .active))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        // Drive local state from Combine publishers
        .onReceive(store.$activeMessages) { messages = $0 }
        .onReceive(store.$activeIsStreaming) { isStreaming = $0 }
        .onReceive(store.$activeIsThinking) { isThinking = $0 }
        .onReceive(store.$activeStreamContent) { streamContent = $0 }
        .onReceive(gateway.$connectionState) { isConnected = $0.isConnected }
        .onReceive(store.$activeSessionId) { hasSession = $0 != nil }
        .onReceive(panelManager.$alwaysOnTop) { alwaysOnTop = $0 }
        .onAppear { syncAll(); ensureSession() }
        .onChange(of: isConnected) { ensureSession() }
    }

    private func syncAll() {
        messages = store.activeMessages
        isStreaming = store.activeIsStreaming
        isThinking = store.activeIsThinking
        streamContent = store.activeStreamContent
        isConnected = gateway.connectionState.isConnected
        hasSession = store.activeSessionId != nil
        alwaysOnTop = panelManager.alwaysOnTop
    }

    private func ensureSession() {
        if store.activeSession == nil && gateway.connectionState.isConnected {
            gateway.newSession()
        }
    }

    // MARK: - Header

    private var companionHeader: some View {
        HStack(spacing: 8) {
            // Branding
            RoundedRectangle(cornerRadius: 5)
                .fill(.linearGradient(
                    colors: [.purple, .indigo],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                ))
                .frame(width: 20, height: 20)
                .overlay(
                    Text("K")
                        .font(.system(size: 9, weight: .heavy))
                        .foregroundStyle(.white)
                )

            Text("Companion")
                .font(.system(size: 12, weight: .semibold))

            StatusDot(connected: isConnected)

            Spacer()

            // Always-on-top toggle
            HStack(spacing: 4) {
                Image(systemName: alwaysOnTop ? "pin.fill" : "pin")
                    .font(.system(size: 10))
                    .foregroundStyle(alwaysOnTop ? .purple : .secondary)

                Toggle(isOn: $alwaysOnTop) {
                    EmptyView()
                }
                .toggleStyle(.switch)
                .controlSize(.mini)
                .labelsHidden()
                .onChange(of: alwaysOnTop) {
                    panelManager.setAlwaysOnTop(alwaysOnTop)
                }
            }
            .help(alwaysOnTop ? "Window stays on top" : "Window can go behind other apps")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.ultraThinMaterial)
    }

    // MARK: - Messages

    private var messageArea: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(messages) { msg in
                        MessageBubble(message: msg, compact: true)
                            .id(msg.id)
                    }

                    if isStreaming {
                        MessageBubble(
                            message: ChatMessage(
                                role: "assistant",
                                content: streamContent + "▊",
                                attachments: nil
                            ),
                            compact: true
                        )
                        .id("streaming")
                    } else if isThinking {
                        ThinkingIndicator(compact: true)
                            .id("thinking")
                    }

                    if messages.isEmpty && !isStreaming {
                        companionEmptyState
                    }
                }
                .padding(10)
            }
            .onChange(of: messages.count) {
                withAnimation(.easeOut(duration: 0.2)) {
                    if isStreaming {
                        proxy.scrollTo("streaming", anchor: .bottom)
                    } else if let last = messages.last {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
            .onChange(of: streamContent) {
                withAnimation(.easeOut(duration: 0.1)) {
                    proxy.scrollTo("streaming", anchor: .bottom)
                }
            }
            .onChange(of: isThinking) {
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo("thinking", anchor: .bottom)
                }
            }
        }
        .frame(maxHeight: .infinity)
    }

    private var companionEmptyState: some View {
        VStack(spacing: 6) {
            Image(systemName: "sparkles")
                .font(.system(size: 20))
                .foregroundStyle(.purple.opacity(0.3))

            Text("Ask anything")
                .foregroundStyle(.tertiary)
                .font(.system(size: 12))
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 30)
    }

    // MARK: - Input

    private var inputBar: some View {
        HStack(alignment: .bottom, spacing: 6) {
            TextField("Ask…", text: $input, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.system(size: 12))
                .lineLimit(1...3)
                .padding(8)
                .background(.ultraThinMaterial)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .strokeBorder(.quaternary, lineWidth: 0.5)
                )
                .onSubmit { sendMessage() }

            Button(action: {
                if isStreaming {
                    stopStreaming()
                } else {
                    sendMessage()
                }
            }) {
                Image(systemName: isStreaming ? "stop.fill" : "arrow.up")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 26, height: 26)
                    .background(
                        isStreaming
                            ? AnyShapeStyle(Color.red)
                            : AnyShapeStyle(
                                LinearGradient(
                                    colors: [.purple, .indigo],
                                    startPoint: .topLeading,
                                    endPoint: .bottomTrailing
                                )
                            )
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 7))
            }
            .buttonStyle(.plain)
            .disabled(!isStreaming && input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
    }

    // MARK: - Helpers

    private func sendMessage() {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if store.activeSession == nil {
            gateway.pendingSendMessage = trimmed
            gateway.newSession()
        } else {
            gateway.sendMessage(trimmed)
        }
        input = ""
    }

    private func stopStreaming() {
        gateway.cancelActiveSessionRun()
    }
}
