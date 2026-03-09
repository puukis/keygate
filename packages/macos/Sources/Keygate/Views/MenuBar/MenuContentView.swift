import SwiftUI
import Combine

/// Menu bar popover content — compact chat + quick actions.
///
/// `MenuBarExtra(.window)` has known issues with SwiftUI observation —
/// `@EnvironmentObject` / `@ObservedObject` changes don't reliably
/// trigger re-renders inside the popover window. We work around this
/// by keeping local `@State` copies driven via Combine `onReceive`.
struct MenuContentView: View {
    @EnvironmentObject var gateway: GatewayService
    @EnvironmentObject var store: SessionStore
    @State private var input = ""
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openSettings) private var openSettings

    // Local state driven by Combine — works reliably in MenuBarExtra
    @State private var messages: [ChatMessage] = []
    @State private var isStreaming = false
    @State private var isThinking = false
    @State private var streamContent = ""
    @State private var isConnected = false
    @State private var hasSession = false

    var body: some View {
        VStack(spacing: 0) {
            header
            modelBar
            messageArea
            inputBar
            shortcutHint
        }
        .frame(width: 380, height: 500)
        .background(VisualEffectView(material: .popover, blendingMode: .behindWindow, state: .active))
        // Drive local state from Combine publishers — workaround for MenuBarExtra
        .onReceive(store.$activeMessages) { messages = $0 }
        .onReceive(store.$activeIsStreaming) { isStreaming = $0 }
        .onReceive(store.$activeIsThinking) { isThinking = $0 }
        .onReceive(store.$activeStreamContent) { streamContent = $0 }
        .onReceive(gateway.$connectionState) { isConnected = $0.isConnected }
        .onReceive(store.$activeSessionId) { hasSession = $0 != nil }
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
    }

    private func ensureSession() {
        if store.activeSession == nil && gateway.connectionState.isConnected {
            gateway.newSession()
        }
    }

    // MARK: - Messages

    private var messageArea: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
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
                        VStack(spacing: 8) {
                            Image(systemName: "diamond.fill")
                                .font(.system(size: 24))
                                .foregroundStyle(.purple.opacity(0.3))
                            Text("No messages yet — say something!")
                                .foregroundStyle(.tertiary)
                                .font(.system(size: 13))
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.top, 40)
                    }
                }
                .padding(12)
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

    // MARK: - Header

    private var header: some View {
        HStack {
            HStack(spacing: 8) {
                RoundedRectangle(cornerRadius: 6)
                    .fill(.linearGradient(
                        colors: [.purple, .indigo],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    ))
                    .frame(width: 24, height: 24)
                    .overlay(Text("K").font(.system(size: 11, weight: .heavy)).foregroundStyle(.white))

                Text("Keygate").font(.system(size: 14, weight: .semibold))

                StatusDot(connected: gateway.connectionState.isConnected)
            }

            Spacer()

            HStack(spacing: 2) {
                MenuBarButton(icon: "plus", tooltip: "New Session") {
                    gateway.newSession()
                }
                MenuBarButton(icon: "arrow.up.left.and.arrow.down.right", tooltip: "Open Full Window") {
                    openWindow(id: "main")
                    NSApp.setActivationPolicy(.regular)
                    NSApp.activate(ignoringOtherApps: true)
                }
                MenuBarButton(icon: "gearshape", tooltip: "Settings") {
                    openSettings()
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.ultraThinMaterial)
    }

    // MARK: - Model bar

    private var modelBar: some View {
        HStack(spacing: 8) {
            if let llm = gateway.llmConfig {
                Text(llm.provider.replacingOccurrences(of: "openai-codex", with: "Codex"))
                    .font(.system(size: 10, weight: .semibold))
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(.purple.opacity(0.15))
                    .foregroundStyle(.purple)
                    .clipShape(RoundedRectangle(cornerRadius: 4))

                Text(llm.model)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)

                Spacer()

                if let effort = llm.reasoningEffort {
                    Text("Reasoning: \(reasoningEffortDisplayLabel(effort))")
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.quaternary.opacity(0.3))
                        .clipShape(RoundedRectangle(cornerRadius: 4))
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 7)
        .background(Color.primary.opacity(0.02))
    }

    // MARK: - Input

    private var inputBar: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Ask Keygate anything...", text: $input, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.system(size: 13))
                .lineLimit(1...4)
                .padding(9)
                .background(.ultraThinMaterial)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
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
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 30, height: 30)
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
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            }
            .buttonStyle(.plain)
            .disabled(!isStreaming && input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    private var shortcutHint: some View {
        HStack(spacing: 4) {
            KeyboardShortcutLabel("⌘⇧K")
            Text("toggle")
            Text("·").foregroundStyle(.quaternary)
            KeyboardShortcutLabel("⌘N")
            Text("new session")
        }
        .font(.system(size: 10))
        .foregroundStyle(.quaternary)
        .padding(.vertical, 6)
    }

    private func sendMessage() {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if store.activeSession == nil {
            // Queue the message — it will be sent once the session is created
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

// MARK: - Small components

struct MenuBarButton: View {
    let icon: String
    let tooltip: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 12))
                .frame(width: 26, height: 26)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .help(tooltip)
    }
}

struct StatusDot: View {
    let connected: Bool

    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(connected ? .green : .orange)
                .frame(width: 6, height: 6)
                .shadow(color: connected ? .green.opacity(0.4) : .clear, radius: 3)
            Text(connected ? "Running" : "Connecting…")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(connected ? .green : .orange)
        }
    }
}

struct KeyboardShortcutLabel: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(.system(size: 10, weight: .medium))
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(.quaternary.opacity(0.3))
            .clipShape(RoundedRectangle(cornerRadius: 3))
            .foregroundStyle(.tertiary)
    }
}
