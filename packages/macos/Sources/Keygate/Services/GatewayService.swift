import Foundation
import SwiftUI
import os

/// Connection state for the gateway.
enum ConnectionState: Equatable {
    case disconnected
    case connecting
    case connected
    case error(String)

    var isConnected: Bool {
        if case .connected = self { return true }
        return false
    }
}

/// Pending confirmation from the server.
struct PendingConfirmation: Identifiable {
    let id = UUID()
    let sessionId: String
    let prompt: String
    let details: ConfirmDetails?
}

/// Central service connecting the macOS app to the Keygate gateway over WebSocket.
@MainActor
final class GatewayService: ObservableObject {
    static let shared = GatewayService()

    private let logger = Logger(subsystem: "dev.keygate.app", category: "Gateway")
    private var client: WebSocketClient?

    // Connection
    @Published var connectionState: ConnectionState = .disconnected
    @Published var sessionId: String?

    // Server state
    @Published var mode: SecurityMode = .safe
    @Published var spicyEnabled = false
    @Published var spicyObedienceEnabled = false
    @Published var llmConfig: LLMConfig?
    @Published var availableModels: [ModelInfo] = []
    @Published var discordConfig: ChannelConfig?
    @Published var slackConfig: SlackConfig?
    @Published var browserConfig: BrowserConfig?
    @Published var skillsConfig: SkillsConfig?

    // Streaming state per session
    @Published var streamingSessionId: String?
    @Published var streamBuffer: String = ""

    // Tool activity
    @Published var activeTools: [String: String] = [:] // sessionId -> tool name

    // Confirmations
    @Published var pendingConfirmation: PendingConfirmation?

    // Pending message waiting for session creation
    @Published var pendingSendMessage: String?

    // Context usage
    @Published var contextUsage: ContextUsagePayload?

    let host: String
    let port: Int

    private init() {
        self.host = ProcessInfo.processInfo.environment["KEYGATE_HOST"] ?? "127.0.0.1"
        self.port = Int(ProcessInfo.processInfo.environment["KEYGATE_PORT"] ?? "18790") ?? 18790
    }

    var baseURL: URL {
        URL(string: "http://\(host):\(port)")!
    }

    var wsURL: URL {
        URL(string: "ws://\(host):\(port)/ws")!
    }

    // MARK: - Connection

    func connect() {
        connectionState = .connecting
        let ws = WebSocketClient(url: wsURL)

        ws.onConnect = { [weak self] in
            self?.connectionState = .connected
            self?.logger.info("Gateway connected")
        }

        ws.onDisconnect = { [weak self] in
            self?.connectionState = .disconnected
            self?.logger.info("Gateway disconnected — will retry")
        }

        ws.onMessage = { [weak self] message in
            self?.handleMessage(message)
        }

        client = ws
        ws.connect()
    }

    func disconnect() {
        client?.disconnect()
        client = nil
        connectionState = .disconnected
    }

    // MARK: - Send

    func send(_ message: ClientMessage) {
        client?.send(message)
    }

    func sendMessage(_ content: String) {
        // Optimistically show the user's message immediately
        if let sid = sessionId {
            let msg = ChatMessage(role: "user", content: content, attachments: nil)
            SessionStore.shared.appendMessage(sessionId: sid, message: msg)
        }
        send(.message(content: content))
    }

    func confirmAllow() {
        send(.confirmResponse(decision: .allowOnce))
        pendingConfirmation = nil
    }

    func confirmAllowAlways() {
        send(.confirmResponse(decision: .allowAlways))
        pendingConfirmation = nil
    }

    func confirmDeny() {
        send(.confirmResponse(decision: .cancel))
        pendingConfirmation = nil
    }

    func newSession() {
        send(.newSession)
    }

    func switchSession(_ id: String) {
        send(.switchSession(sessionId: id))
    }

    func deleteSession(_ id: String) {
        send(.deleteSession(sessionId: id))
    }

    func renameSession(_ id: String, title: String) {
        send(.renameSession(sessionId: id, title: title))
    }

    func clearSession() {
        send(.clearSession)
    }

    func setMode(_ mode: SecurityMode) {
        send(.setMode(mode))
    }

    func setModel(provider: String?, model: String, reasoningEffort: String? = nil) {
        send(.setModel(provider: provider, model: model, reasoningEffort: reasoningEffort))
    }

    func requestModels(provider: String? = nil) {
        send(.getModels(provider: provider))
    }

    // MARK: - Message handling

    /// Strip "web:" prefix the server adds to session IDs in some payloads.
    private func normalizeSessionId(_ id: String) -> String {
        id.hasPrefix("web:") ? String(id.dropFirst(4)) : id
    }

    private func handleMessage(_ message: ServerMessage) {
        switch message {
        case .connected(let payload):
            sessionId = normalizeSessionId(payload.sessionId)
            SessionStore.shared.ensureSession(id: payload.sessionId)
            SessionStore.shared.activeSessionId = payload.sessionId
            mode = payload.mode
            spicyEnabled = payload.spicyEnabled ?? false
            spicyObedienceEnabled = payload.spicyObedienceEnabled ?? false
            llmConfig = payload.llm
            discordConfig = payload.discord
            slackConfig = payload.slack
            browserConfig = payload.browser
            skillsConfig = payload.skills
            requestModels(provider: payload.llm.provider)

        case .sessionSnapshot(let payload):
            SessionStore.shared.updateSessions(payload.sessions)
            // Ensure activeSessionId is set if the store doesn't have one yet
            if SessionStore.shared.activeSessionId == nil, let sid = sessionId {
                SessionStore.shared.activeSessionId = sid
            }

        case .sessionChunk(let payload):
            let sid = normalizeSessionId(payload.sessionId)
            streamingSessionId = sid
            streamBuffer += payload.content
            SessionStore.shared.appendStreamChunk(
                sessionId: sid,
                chunk: payload.content
            )

        case .sessionMessageEnd(let payload):
            let sid = normalizeSessionId(payload.sessionId)
            streamingSessionId = nil
            streamBuffer = ""
            SessionStore.shared.finalizeStream(
                sessionId: sid,
                content: payload.content
            )

        case .sessionUserMessage(let payload):
            let sid = normalizeSessionId(payload.sessionId)
            // Skip if we already optimistically inserted this message
            let isDuplicate = SessionStore.shared.lastMessage(sessionId: sid, role: "user")?.content == payload.content
            if !isDuplicate {
                let msg = ChatMessage(
                    role: "user",
                    content: payload.content,
                    attachments: payload.attachments
                )
                SessionStore.shared.appendMessage(sessionId: sid, message: msg)
            }

        case .messageReceived(let payload):
            let sid = normalizeSessionId(payload.sessionId)
            SessionStore.shared.setThinking(sessionId: sid, true)

        case .confirmRequest(let payload):
            let sid = normalizeSessionId(payload.sessionId)
            pendingConfirmation = PendingConfirmation(
                sessionId: sid,
                prompt: payload.prompt,
                details: payload.details
            )

        case .toolStart(let payload):
            let sid = normalizeSessionId(payload.sessionId)
            activeTools[sid] = payload.tool
            SessionStore.shared.addToolEvent(
                sessionId: sid,
                tool: payload.tool,
                isStart: true
            )

        case .toolEnd(let payload):
            let sid = normalizeSessionId(payload.sessionId)
            activeTools.removeValue(forKey: sid)
            SessionStore.shared.addToolEvent(
                sessionId: sid,
                tool: payload.tool,
                isStart: false,
                result: payload.result
            )

        case .modeChanged(let payload):
            mode = payload.mode

        case .modelChanged(let payload):
            llmConfig = payload.llm

        case .models(let payload):
            availableModels = payload.models

        case .sessionCreated(let payload):
            let sid = normalizeSessionId(payload.sessionId)
            sessionId = sid
            SessionStore.shared.ensureSession(id: sid)
            SessionStore.shared.activeSessionId = sid
            // Send any message that was waiting for session creation
            if let pending = pendingSendMessage {
                pendingSendMessage = nil
                sendMessage(pending)
            }

        case .sessionSwitched(let payload):
            let sid = normalizeSessionId(payload.sessionId)
            sessionId = sid
            SessionStore.shared.activeSessionId = sid

        case .sessionDeleted:
            break // session_snapshot will follow

        case .sessionRenamed:
            break // session_snapshot will follow

        case .sessionCleared(let payload):
            SessionStore.shared.clearMessages(sessionId: normalizeSessionId(payload.sessionId))

        case .contextUsage(let payload):
            // contextUsage sessionId also needs normalization for matching
            contextUsage = payload

        case .mcpBrowserStatus(let payload):
            browserConfig = payload.browser

        case .error(let payload):
            logger.error("Server error: \(payload.error)")

        case .unknown(let type):
            logger.debug("Unknown message type: \(type)")
        }
    }
}
