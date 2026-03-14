import SwiftUI

/// Shared message bubble used in both popover and full window chat.
struct MessageBubble: View {
    let message: ChatMessage
    var compact: Bool = false

    var body: some View {
        HStack {
            if message.isUser { Spacer(minLength: compact ? 40 : 80) }

            VStack(alignment: message.isUser ? .trailing : .leading, spacing: 4) {
                VStack(alignment: .leading, spacing: 8) {
                    if !message.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Text(LocalizedStringKey(message.content))
                            .font(.system(size: compact ? 13 : 14))
                            .lineSpacing(3)
                            .textSelection(.enabled)
                    }

                    if let attachments = message.attachments, !attachments.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(attachments) { attachment in
                                AttachmentCard(attachment: attachment, compact: compact, isUser: message.isUser)
                            }
                        }
                    }
                }
                    .padding(.horizontal, compact ? 12 : 14)
                    .padding(.vertical, compact ? 8 : 10)
                    .background(bubbleBackground)
                    .clipShape(bubbleShape)
                    .foregroundStyle(message.isUser ? .white : .primary)
                    .overlay(
                        !message.isUser
                            ? bubbleShape.strokeBorder(.quaternary.opacity(0.5), lineWidth: 0.5)
                            : nil
                    )
            }

            if message.isAssistant { Spacer(minLength: compact ? 40 : 80) }
        }
    }

    @ViewBuilder
    private var bubbleBackground: some View {
        if message.isUser {
            LinearGradient(
                colors: [Color.purple.opacity(0.85), Color.indigo.opacity(0.9)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        } else {
            VisualEffectView(material: .contentBackground, blendingMode: .withinWindow)
        }
    }

    private var bubbleShape: UnevenRoundedRectangle {
        if message.isUser {
            UnevenRoundedRectangle(
                topLeadingRadius: compact ? 12 : 14,
                bottomLeadingRadius: compact ? 12 : 14,
                bottomTrailingRadius: 4,
                topTrailingRadius: compact ? 12 : 14
            )
        } else {
            UnevenRoundedRectangle(
                topLeadingRadius: compact ? 12 : 14,
                bottomLeadingRadius: 4,
                bottomTrailingRadius: compact ? 12 : 14,
                topTrailingRadius: compact ? 12 : 14
            )
        }
    }
}

private struct AttachmentCard: View {
    let attachment: Attachment
    let compact: Bool
    let isUser: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button(action: openAttachment) {
                HStack(spacing: 8) {
                    Image(systemName: attachmentSymbol)
                        .font(.system(size: compact ? 11 : 12, weight: .semibold))

                    VStack(alignment: .leading, spacing: 2) {
                        Text(attachment.filename)
                            .font(.system(size: compact ? 11 : 12, weight: .semibold))
                            .lineLimit(1)
                        Text(attachmentMetaLabel)
                            .font(.system(size: compact ? 10 : 11))
                            .foregroundStyle(isUser ? .white.opacity(0.78) : .secondary)
                            .lineLimit(1)
                    }

                    Spacer(minLength: 0)

                    Image(systemName: "arrow.up.right.square")
                        .font(.system(size: compact ? 10 : 11, weight: .medium))
                        .foregroundStyle(isUser ? Color.white.opacity(0.78) : Color.secondary)
                }
                .padding(.horizontal, compact ? 10 : 12)
                .padding(.vertical, compact ? 8 : 9)
                .background((isUser ? Color.white : Color.primary).opacity(isUser ? 0.12 : 0.06))
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            .buttonStyle(.plain)

            if let preview = attachment.previewText?.trimmingCharacters(in: .whitespacesAndNewlines), !preview.isEmpty {
                Text(preview)
                    .font(.system(size: compact ? 11 : 12))
                    .foregroundStyle(isUser ? .white.opacity(0.88) : .secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
    }

    private var attachmentSymbol: String {
        switch attachment.kind {
        case "image": return "photo"
        case "audio": return "waveform"
        case "video": return "video"
        case "pdf": return "doc.richtext"
        default: return "paperclip"
        }
    }

    private var attachmentMetaLabel: String {
        var parts: [String] = []
        if let kind = attachment.kind {
            parts.append(kind.capitalized)
        }
        if let durationMs = attachment.durationMs {
            parts.append("\(max(1, durationMs / 1000))s")
        }
        if let width = attachment.width, let height = attachment.height {
            parts.append("\(width)x\(height)")
        }
        if let pageCount = attachment.pageCount {
            parts.append("\(pageCount) pages")
        }
        let sizeLabel = ByteCountFormatter.string(fromByteCount: Int64(attachment.sizeBytes), countStyle: .file)
        parts.append(sizeLabel)
        return parts.joined(separator: " · ")
    }

    private func openAttachment() {
        let rawURL = attachment.url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !rawURL.isEmpty else { return }

        let targetURL: URL?
        if rawURL.hasPrefix("http://") || rawURL.hasPrefix("https://") {
            targetURL = URL(string: rawURL)
        } else {
            targetURL = URL(string: rawURL, relativeTo: GatewayService.shared.baseURL)?.absoluteURL
        }

        if let targetURL {
            NSWorkspace.shared.open(targetURL)
        }
    }
}

/// Tool activity row shown between messages.
struct ToolActivityRow: View {
    let event: ToolEvent

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: event.isStart ? "bolt.fill" : "checkmark.circle.fill")
                .font(.system(size: 10))
                .foregroundStyle(event.isStart ? .orange : .green)

            Text(event.isStart ? "Running" : "Completed")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)

            Text(event.tool)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.tertiary)

            if let result = event.result, let output = result.output, !output.isEmpty {
                Text("— \(output.prefix(50))")
                    .font(.system(size: 11))
                    .foregroundStyle(.quaternary)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(.purple.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay(
            HStack(spacing: 0) {
                Rectangle().fill(.purple.opacity(0.3)).frame(width: 2)
                Spacer()
            }
        )
    }
}
