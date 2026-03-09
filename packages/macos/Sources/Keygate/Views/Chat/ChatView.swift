import SwiftUI
import AppKit
import UniformTypeIdentifiers

/// Full-window chat view with message history and input.
struct ChatView: View {
    @EnvironmentObject var gateway: GatewayService
    @EnvironmentObject var store: SessionStore
    @State private var input = ""
    @State private var pendingAttachments: [PendingImageAttachment] = []
    @State private var isUploadingAttachments = false
    @State private var composerError: String?

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

                    Text("\(llm.model)\(llm.reasoningEffort.map { " · \(reasoningEffortDisplayLabel($0))" } ?? "")")
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
        VStack(alignment: .leading, spacing: 8) {
            if !pendingAttachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(pendingAttachments) { attachment in
                            HStack(spacing: 6) {
                                Image(systemName: "photo")
                                    .font(.system(size: 11, weight: .semibold))
                                    .foregroundStyle(.purple)
                                Text(attachment.displayName)
                                    .font(.system(size: 11, weight: .medium))
                                    .lineLimit(1)
                                Button {
                                    removePendingAttachment(attachment.id)
                                } label: {
                                    Image(systemName: "xmark.circle.fill")
                                        .font(.system(size: 11))
                                        .foregroundStyle(.secondary)
                                }
                                .buttonStyle(.plain)
                            }
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(.ultraThinMaterial)
                            .clipShape(Capsule())
                        }
                    }
                }
            }

            HStack(alignment: .bottom, spacing: 10) {
                Button {
                    pickImageAttachments()
                } label: {
                    Image(systemName: "paperclip")
                        .font(.system(size: 14))
                        .foregroundStyle(.tertiary)
                }
                .buttonStyle(.plain)
                .padding(.bottom, 8)
                .disabled(isUploadingAttachments)

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
                    .disabled(isUploadingAttachments)

                Button(action: {
                    if session?.isStreaming == true {
                        stopStreaming()
                    } else {
                        sendMessage()
                    }
                }) {
                    Group {
                        if isUploadingAttachments {
                            ProgressView()
                                .progressViewStyle(.circular)
                                .tint(.white)
                        } else if session?.isStreaming == true {
                            Image(systemName: "stop.fill")
                                .font(.system(size: 14, weight: .semibold))
                        } else {
                            Image(systemName: "arrow.up")
                                .font(.system(size: 14, weight: .semibold))
                        }
                    }
                    .foregroundStyle(.white)
                    .frame(width: 34, height: 34)
                    .background(
                        session?.isStreaming == true
                            ? AnyShapeStyle(Color.red)
                            : AnyShapeStyle(
                                LinearGradient(
                                    colors: [.purple, .indigo],
                                    startPoint: .topLeading,
                                    endPoint: .bottomTrailing
                                )
                            )
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .shadow(
                        color: (session?.isStreaming == true ? Color.red : .purple).opacity(0.2),
                        radius: 5,
                        y: 2
                    )
                }
                .buttonStyle(.plain)
                .disabled(
                    isUploadingAttachments
                    || (
                        session?.isStreaming != true
                        && input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        && pendingAttachments.isEmpty
                    )
                )
                .padding(.bottom, 2)
            }

            if let composerError {
                Text(composerError)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.red)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
        .background(VisualEffectView(material: .contentBackground, blendingMode: .withinWindow))
    }

    private func sendMessage() {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !pendingAttachments.isEmpty else { return }

        let attachmentsToUpload = pendingAttachments
        Task {
            await sendMessageWithAttachments(
                content: trimmed,
                pending: attachmentsToUpload
            )
        }
    }

    private func stopStreaming() {
        gateway.cancelActiveSessionRun()
    }

    @MainActor
    private func sendMessageWithAttachments(content: String, pending: [PendingImageAttachment]) async {
        if isUploadingAttachments {
            return
        }

        isUploadingAttachments = true
        composerError = nil

        var uploaded: [Attachment] = []

        do {
            if !pending.isEmpty {
                guard let uploadSessionId = gateway.uploadSessionId else {
                    throw NSError(domain: "ChatView", code: 10, userInfo: [NSLocalizedDescriptionKey: "Upload session is unavailable. Reconnect and try again."])
                }

                for attachment in pending {
                    let result = try await gateway.uploadImageAttachment(fileURL: attachment.url, sessionId: uploadSessionId)
                    uploaded.append(result)
                }
            }

            gateway.sendMessage(content, attachments: uploaded.isEmpty ? nil : uploaded)
            input = ""
            pendingAttachments = []
        } catch {
            composerError = error.localizedDescription
        }

        isUploadingAttachments = false
    }

    private func pickImageAttachments() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        panel.allowedContentTypes = allowedAttachmentTypes()

        guard panel.runModal() == .OK else { return }
        addPendingAttachments(from: panel.urls)
    }

    private func addPendingAttachments(from urls: [URL]) {
        var next = pendingAttachments
        var seen = Set(next.map { $0.url.standardizedFileURL.path })
        var firstError: String?

        for url in urls {
            if next.count >= 5 {
                firstError = "You can attach up to 5 images per message."
                break
            }

            let key = url.standardizedFileURL.path
            if seen.contains(key) {
                continue
            }
            seen.insert(key)

            let values = try? url.resourceValues(forKeys: [.fileSizeKey])
            let sizeBytes = values?.fileSize ?? 0
            if sizeBytes <= 0 {
                firstError = "One attachment could not be read."
                continue
            }

            if sizeBytes > 10 * 1024 * 1024 {
                firstError = "Each image must be 10MB or smaller."
                continue
            }

            let mime = mimeType(for: url)
            if !["image/png", "image/jpeg", "image/webp", "image/gif"].contains(mime) {
                firstError = "Only PNG, JPEG, WEBP, and GIF images are supported."
                continue
            }

            next.append(PendingImageAttachment(url: url, mimeType: mime, sizeBytes: sizeBytes))
        }

        pendingAttachments = next
        composerError = firstError
    }

    private func removePendingAttachment(_ id: UUID) {
        pendingAttachments.removeAll(where: { $0.id == id })
    }

    private func allowedAttachmentTypes() -> [UTType] {
        var types: [UTType] = [.png, .jpeg, .gif]
        if let webp = UTType(filenameExtension: "webp") {
            types.append(webp)
        }
        return types
    }

    private func mimeType(for url: URL) -> String {
        guard
            let type = UTType(filenameExtension: url.pathExtension.lowercased()),
            let preferred = type.preferredMIMEType
        else {
            return "application/octet-stream"
        }
        return preferred
    }
}

private struct PendingImageAttachment: Identifiable {
    let id = UUID()
    let url: URL
    let mimeType: String
    let sizeBytes: Int

    var displayName: String {
        url.lastPathComponent
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
