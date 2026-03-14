import SwiftUI

/// Sidebar with session list — shown in the full main window.
struct SessionSidebar: View {
    @EnvironmentObject var gateway: GatewayService
    @EnvironmentObject var store: SessionStore
    @Environment(\.openSettings) private var openSettings
    @AppStorage("backgroundMaterial") private var backgroundMaterial: Int = AppearanceMaterial.headerView.rawValue
    @AppStorage("vibrancyEnabled") private var vibrancyEnabled: Bool = true
    @AppStorage("windowOpacity") private var windowOpacity: Double = 1.0
    @AppStorage("backgroundBlur") private var backgroundBlur: Double = 0.0
    @State private var hoveredSession: String?
    @State private var renamingSession: SessionState?
    @State private var renameDraft: String = ""

    private var sidebarMaterial: NSVisualEffectView.Material {
        (AppearanceMaterial(rawValue: backgroundMaterial) ?? .headerView).nsMaterial
    }

    var body: some View {
        VStack(spacing: 0) {
            sidebarHeader
            sessionList
            sidebarFooter
        }
        .frame(width: 240)
        .background {
            if vibrancyEnabled {
                VisualEffectView(
                    material: sidebarMaterial,
                    blendingMode: .behindWindow
                )
                .opacity(windowOpacity)
            } else {
                Color(nsColor: .windowBackgroundColor)
                    .opacity(windowOpacity)
            }
        }
        .sheet(item: $renamingSession) { session in
            VStack(alignment: .leading, spacing: 12) {
                Text("Rename Session")
                    .font(.system(size: 14, weight: .semibold))
                TextField("Session title", text: $renameDraft)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit {
                        commitRename(for: session)
                    }
                HStack {
                    Spacer()
                    Button("Cancel") {
                        renamingSession = nil
                    }
                    Button("Save") {
                        commitRename(for: session)
                    }
                    .keyboardShortcut(.defaultAction)
                }
            }
            .padding(20)
            .frame(width: 340)
        }
    }

    // MARK: - Header

    private var sidebarHeader: some View {
        HStack {
            Text("Sessions")
                .font(.system(size: 11, weight: .semibold))
                .textCase(.uppercase)
                .tracking(1)
                .foregroundStyle(.quaternary)

            Spacer()

            Button {
                gateway.newSession()
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 12))
                    .frame(width: 22, height: 22)
                    .background(.purple.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 5))
                    .foregroundStyle(.purple)
                    .overlay(
                        RoundedRectangle(cornerRadius: 5)
                            .strokeBorder(.purple.opacity(0.15), lineWidth: 0.5)
                    )
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    // MARK: - List

    private var sessionList: some View {
        ScrollView {
            LazyVStack(spacing: 2) {
                if !store.webSessions.isEmpty {
                    ForEach(store.webSessions) { session in
                        SessionRow(
                            session: session,
                            isActive: session.sessionId == store.activeSessionId,
                            isHovered: hoveredSession == session.sessionId
                        )
                        .onTapGesture {
                            gateway.switchSession(session.sessionId)
                            store.activeSessionId = session.sessionId
                        }
                        .onHover { hovering in
                            hoveredSession = hovering ? session.sessionId : nil
                        }
                        .contextMenu {
                            Button("Rename…") {
                                renameDraft = session.title ?? ""
                                renamingSession = session
                            }
                            Button("Clear Messages") {
                                gateway.switchSession(session.sessionId)
                                store.activeSessionId = session.sessionId
                                gateway.clearSession()
                            }
                            Divider()
                            Button("Delete", role: .destructive) {
                                gateway.deleteSession(session.sessionId)
                            }
                        }
                    }
                }

                if !store.otherSessions.isEmpty {
                    Divider().padding(.horizontal, 12).padding(.vertical, 6)
                    Text("Other Channels")
                        .font(.system(size: 10, weight: .semibold))
                        .textCase(.uppercase)
                        .tracking(0.8)
                        .foregroundStyle(.quaternary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 14)
                        .padding(.bottom, 4)

                    ForEach(store.otherSessions) { session in
                        SessionRow(
                            session: session,
                            isActive: session.sessionId == store.activeSessionId,
                            isHovered: hoveredSession == session.sessionId
                        )
                        .onTapGesture {
                            store.activeSessionId = session.sessionId
                        }
                        .onHover { hovering in
                            hoveredSession = hovering ? session.sessionId : nil
                        }
                    }
                }
            }
            .padding(.horizontal, 8)
        }
    }

    // MARK: - Footer

    private var sidebarFooter: some View {
        HStack {
            HStack(spacing: 5) {
                Circle()
                    .fill(gateway.connectionState.isConnected ? .green : .red)
                    .frame(width: 6, height: 6)
                    .shadow(color: gateway.connectionState.isConnected ? .green.opacity(0.3) : .clear, radius: 3)

                Text(gateway.connectionState.isConnected ? "Gateway running" : "Disconnected")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(gateway.connectionState.isConnected ? .green : .red)
            }

            Spacer()

            Button {
                openSettings()
            } label: {
                Image(systemName: "gearshape")
                    .font(.system(size: 13))
                    .foregroundStyle(.quaternary)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Color.primary.opacity(0.02))
    }

    private func commitRename(for session: SessionState) {
        gateway.renameSession(session.sessionId, title: renameDraft)
        renamingSession = nil
    }
}

// MARK: - Session Row

struct SessionRow: View {
    let session: SessionState
    let isActive: Bool
    let isHovered: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(session.displayTitle)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(isActive ? .purple : .primary)
                .lineLimit(1)

            HStack(spacing: 6) {
                ChannelBadge(channel: session.channelType)

                if let updatedAt = session.updatedAt {
                    Text(relativeTime(updatedAt))
                        .font(.system(size: 11))
                        .foregroundStyle(.quaternary)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(isActive ? .purple.opacity(0.08) : (isHovered ? .primary.opacity(0.04) : .clear))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(
                    isActive ? Color.purple.opacity(0.1) : (isHovered ? Color.primary.opacity(0.08) : Color.clear),
                    lineWidth: 0.5
                )
        )
    }

    private func relativeTime(_ iso: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: iso) else { return iso }

        let interval = Date().timeIntervalSince(date)
        if interval < 60 { return "just now" }
        if interval < 3600 { return "\(Int(interval / 60)) min ago" }
        if interval < 86400 { return "\(Int(interval / 3600)) hr ago" }
        return "\(Int(interval / 86400)) days ago"
    }
}

struct ChannelBadge: View {
    let channel: ChannelType

    var body: some View {
        Text(channel.rawValue.uppercased())
            .font(.system(size: 9, weight: .semibold))
            .tracking(0.5)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(backgroundColor)
            .foregroundStyle(foregroundColor)
            .clipShape(RoundedRectangle(cornerRadius: 4))
            .overlay(
                RoundedRectangle(cornerRadius: 4)
                    .strokeBorder(borderColor, lineWidth: 0.5)
            )
    }

    private var backgroundColor: Color {
        switch channel {
        case .web:      .purple.opacity(0.1)
        case .webchat:  .pink.opacity(0.12)
        case .discord:  .blue.opacity(0.1)
        case .terminal: .green.opacity(0.1)
        case .slack:    .orange.opacity(0.1)
        case .telegram: .cyan.opacity(0.12)
        case .whatsapp: .green.opacity(0.14)
        }
    }

    private var foregroundColor: Color {
        switch channel {
        case .web:      .purple
        case .webchat:  .pink
        case .discord:  .blue
        case .terminal: .green
        case .slack:    .orange
        case .telegram: .cyan
        case .whatsapp: .green
        }
    }

    private var borderColor: Color {
        switch channel {
        case .web:      .purple.opacity(0.08)
        case .webchat:  .pink.opacity(0.12)
        case .discord:  .blue.opacity(0.08)
        case .terminal: .green.opacity(0.08)
        case .slack:    .orange.opacity(0.08)
        case .telegram: .cyan.opacity(0.12)
        case .whatsapp: .green.opacity(0.12)
        }
    }
}
