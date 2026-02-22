import SwiftUI

/// Full-window chat view with message history and input.
struct ChatView: View {
    @EnvironmentObject var gateway: GatewayService
    @EnvironmentObject var store: SessionStore
    @State private var input = ""

    var session: SessionState?

    var body: some View {
        VStack(spacing: 0) {
            chatHeader
            Divider()
            messagesArea
            Divider()
            inputArea
        }
        .overlay {
            if let confirmation = gateway.pendingConfirmation {
                Color.black.opacity(0.3)
                    .ignoresSafeArea()
                    .onTapGesture { /* block */ }

                ConfirmationOverlay(
                    confirmation: confirmation,
                    onAllow: { gateway.confirmAllow() },
                    onAllowAlways: { gateway.confirmAllowAlways() },
                    onDeny: { gateway.confirmDeny() }
                )
                .transition(.scale(scale: 0.95).combined(with: .opacity))
            }
        }
        .animation(.spring(duration: 0.25), value: gateway.pendingConfirmation != nil)
    }

    // MARK: - Header

    private var chatHeader: some View {
        HStack {
            HStack(spacing: 8) {
                Text(session?.displayTitle ?? "No Session")
                    .font(.system(size: 14, weight: .semibold))

                ModeBadge(mode: gateway.mode)
            }

            Spacer()

            if let llm = gateway.llmConfig {
                HStack(spacing: 6) {
                    Text(llm.provider.replacingOccurrences(of: "openai-codex", with: "Codex"))
                        .font(.system(size: 10, weight: .semibold))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(.purple.opacity(0.12))
                        .foregroundStyle(.purple)
                        .clipShape(RoundedRectangle(cornerRadius: 4))

                    Text("\(llm.model)\(llm.reasoningEffort.map { " · \($0.capitalized)" } ?? "")")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }
            }

            if let usage = gateway.contextUsage {
                ContextBadge(usage: usage)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 10)
        .background(VisualEffectView(material: .headerView, blendingMode: .withinWindow))
    }

    // MARK: - Messages

    private var messagesArea: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if let session {
                        ForEach(session.messages) { msg in
                            MessageBubble(message: msg)
                                .id(msg.id)
                        }

                        // Tool events interleaved
                        ForEach(session.toolEvents) { event in
                            ToolActivityRow(event: event)
                        }

                        // Streaming
                        if session.isStreaming {
                            MessageBubble(
                                message: ChatMessage(
                                    role: "assistant",
                                    content: session.streamContent + "▊",
                                    attachments: nil
                                )
                            )
                            .id("streaming")
                        } else if session.isThinking {
                            ThinkingIndicator()
                                .id("thinking")
                        }
                    } else {
                        emptyState
                    }
                }
                .padding(24)
            }
            .onChange(of: session?.messages.count) {
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo("streaming", anchor: .bottom)
                }
            }
            .onChange(of: session?.streamContent) {
                withAnimation(.easeOut(duration: 0.1)) {
                    proxy.scrollTo("streaming", anchor: .bottom)
                }
            }
            .onChange(of: session?.isThinking) {
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo("thinking", anchor: .bottom)
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "diamond.fill")
                .font(.system(size: 32))
                .foregroundStyle(.purple.opacity(0.3))

            Text("Start a conversation")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(.secondary)

            Text("Ask Keygate anything — run commands, manage files, or get help with code.")
                .font(.system(size: 13))
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 300)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.top, 100)
    }

    // MARK: - Input

    private var inputArea: some View {
        HStack(alignment: .bottom, spacing: 10) {
            Button {
                // TODO: File attachment picker
            } label: {
                Image(systemName: "paperclip")
                    .font(.system(size: 14))
                    .foregroundStyle(.tertiary)
            }
            .buttonStyle(.plain)
            .padding(.bottom, 8)

            TextField("Ask Keygate anything...", text: $input, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.system(size: 14))
                .lineLimit(1...8)
                .padding(10)
                .background(.ultraThinMaterial)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .overlay(
                    RoundedRectangle(cornerRadius: 12)
                        .strokeBorder(.quaternary, lineWidth: 0.5)
                )
                .onSubmit { sendMessage() }

            Button(action: sendMessage) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 34, height: 34)
                    .background(
                        .linearGradient(
                            colors: [.purple, .indigo],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .shadow(color: .purple.opacity(0.2), radius: 5, y: 2)
            }
            .buttonStyle(.plain)
            .disabled(input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .padding(.bottom, 2)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
        .background(VisualEffectView(material: .contentBackground, blendingMode: .withinWindow))
    }

    private func sendMessage() {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        gateway.sendMessage(trimmed)
        input = ""
    }
}

// MARK: - Small components

struct ModeBadge: View {
    let mode: SecurityMode

    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(mode == .safe ? .green : .orange)
                .frame(width: 6, height: 6)
            Text(mode == .safe ? "Safe Mode" : "Spicy Mode")
                .font(.system(size: 10, weight: .medium))
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(mode == .safe ? .green.opacity(0.1) : .orange.opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: 5))
        .foregroundStyle(mode == .safe ? .green : .orange)
    }
}

struct ContextBadge: View {
    let usage: ContextUsagePayload

    var body: some View {
        HStack(spacing: 4) {
            ProgressView(value: usage.percent / 100)
                .progressViewStyle(.linear)
                .frame(width: 40)
                .tint(usage.percent > 80 ? .orange : .purple)

            Text("\(Int(usage.percent))%")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(.tertiary)
        }
        .help("Context: \(usage.usedTokens) / \(usage.limitTokens) tokens")
    }
}
