import Foundation
import SwiftUI

/// A tool execution event in the chat timeline.
struct ToolEvent: Identifiable {
    let id = UUID()
    let tool: String
    let isStart: Bool
    let result: ToolResult?
    let timestamp = Date()
}

/// Local chat state for a session — derived from server snapshots + live streaming.
@MainActor
final class SessionState: ObservableObject, @preconcurrency Identifiable {
    let sessionId: String
    let channelType: ChannelType
    @Published var title: String?
    @Published var updatedAt: String?
    @Published var messages: [ChatMessage]
    @Published var toolEvents: [ToolEvent] = []
    @Published var streamContent: String = ""
    @Published var isStreaming = false
    @Published var isThinking = false

    var id: String { sessionId }

    var displayTitle: String {
        title ?? "New Session"
    }

    var isReadOnly: Bool {
        channelType != .web
    }

    init(sessionId: String, channelType: ChannelType = .web) {
        self.sessionId = sessionId
        self.channelType = channelType
        self.messages = []
    }

    init(from info: SessionInfo) {
        self.sessionId = SessionStore.normalizeSessionId(info.sessionId)
        self.channelType = info.channel
        self.title = info.title
        self.updatedAt = info.updatedAt
        self.messages = info.messages ?? []
    }
}

/// Manages all sessions. Singleton used by both GatewayService and views.
///
/// Every mutation explicitly calls `objectWillChange.send()` so that
/// SwiftUI views observing the store re-render when any child session changes.
@MainActor
final class SessionStore: ObservableObject {
    static let shared = SessionStore()

    @Published var sessions: [SessionState] = []
    @Published var activeSessionId: String? {
        didSet { syncActive() }
    }

    /// Flat published copies of the active session's data so SwiftUI can observe them directly.
    @Published var activeMessages: [ChatMessage] = []
    @Published var activeStreamContent: String = ""
    @Published var activeIsStreaming: Bool = false
    @Published var activeIsThinking: Bool = false

    var activeSession: SessionState? {
        sessions.first { $0.sessionId == activeSessionId }
    }

    var webSessions: [SessionState] {
        sessions.filter { $0.channelType == .web }
    }

    var otherSessions: [SessionState] {
        sessions.filter { $0.channelType != .web }
    }

    private init() {}

    /// Strip "web:" prefix the server adds to session IDs.
    static func normalizeSessionId(_ id: String) -> String {
        id.hasPrefix("web:") ? String(id.dropFirst(4)) : id
    }

    /// Sync the flat published properties from the active session.
    private func syncActive() {
        if let s = activeSession {
            activeMessages = s.messages
            activeStreamContent = s.streamContent
            activeIsStreaming = s.isStreaming
            activeIsThinking = s.isThinking
        } else {
            activeMessages = []
            activeStreamContent = ""
            activeIsStreaming = false
            activeIsThinking = false
        }
    }

    /// Ensure a session exists in the store. Creates a stub if needed.
    func ensureSession(id: String) {
        let normalized = Self.normalizeSessionId(id)
        guard !sessions.contains(where: { $0.sessionId == normalized }) else { return }
        let stub = SessionState(sessionId: normalized, channelType: .web)
        sessions.append(stub)
        syncActive()
    }

    func updateSessions(_ infos: [SessionInfo]) {
        var newMap: [String: SessionInfo] = [:]
        for info in infos {
            let nid = Self.normalizeSessionId(info.sessionId)
            newMap[nid] = info
        }

        // Remove sessions that no longer exist, but never remove the active session
        sessions.removeAll { session in
            session.sessionId != activeSessionId && newMap[session.sessionId] == nil
        }

        // Update existing and add new
        for info in infos {
            let nid = Self.normalizeSessionId(info.sessionId)
            if let existing = sessions.first(where: { $0.sessionId == nid }) {
                existing.title = info.title
                existing.updatedAt = info.updatedAt
                if !existing.isStreaming, let snapshotMessages = info.messages {
                    // Only overwrite local messages if the snapshot actually provides them
                    existing.messages = snapshotMessages
                }
            } else {
                sessions.append(SessionState(from: info))
            }
        }

        sessions.sort { ($0.updatedAt ?? "") > ($1.updatedAt ?? "") }
        syncActive()
    }

    func appendMessage(sessionId: String, message: ChatMessage) {
        ensureSession(id: sessionId)
        guard let session = sessions.first(where: { $0.sessionId == sessionId }) else { return }
        session.messages.append(message)
        syncActive()
    }

    func lastMessage(sessionId: String, role: String) -> ChatMessage? {
        guard let session = sessions.first(where: { $0.sessionId == sessionId }) else { return nil }
        return session.messages.last { $0.role == role }
    }

    func setThinking(sessionId: String, _ value: Bool) {
        ensureSession(id: sessionId)
        guard let session = sessions.first(where: { $0.sessionId == sessionId }) else { return }
        session.isThinking = value
        syncActive()
    }

    func appendStreamChunk(sessionId: String, chunk: String) {
        ensureSession(id: sessionId)
        guard let session = sessions.first(where: { $0.sessionId == sessionId }) else { return }
        session.isStreaming = true
        session.isThinking = false
        session.streamContent += chunk
        syncActive()
    }

    func finalizeStream(sessionId: String, content: String) {
        ensureSession(id: sessionId)
        guard let session = sessions.first(where: { $0.sessionId == sessionId }) else { return }
        session.isStreaming = false
        session.isThinking = false
        session.streamContent = ""
        session.messages.append(ChatMessage(role: "assistant", content: content, attachments: nil))
        syncActive()
    }

    func clearMessages(sessionId: String) {
        guard let session = sessions.first(where: { $0.sessionId == sessionId }) else { return }
        session.messages.removeAll()
        session.toolEvents.removeAll()
        session.streamContent = ""
        session.isStreaming = false
        session.isThinking = false
        syncActive()
    }

    func addToolEvent(sessionId: String, tool: String, isStart: Bool, result: ToolResult? = nil) {
        guard let session = sessions.first(where: { $0.sessionId == sessionId }) else { return }
        session.toolEvents.append(ToolEvent(tool: tool, isStart: isStart, result: result))
        syncActive()
    }
}
