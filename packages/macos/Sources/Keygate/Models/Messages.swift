import Foundation

// MARK: - Server → Client

enum ServerMessage: Decodable {
    case connected(ConnectedPayload)
    case sessionSnapshot(SessionSnapshotPayload)
    case sessionChunk(SessionChunkPayload)
    case sessionMessageEnd(SessionMessageEndPayload)
    case sessionCancelled(SessionCancelledPayload)
    case sessionUserMessage(SessionUserMessagePayload)
    case messageReceived(MessageReceivedPayload)
    case confirmRequest(ConfirmRequestPayload)
    case toolStart(ToolStartPayload)
    case toolEnd(ToolEndPayload)
    case modeChanged(ModeChangedPayload)
    case modelChanged(ModelChangedPayload)
    case models(ModelsPayload)
    case sessionCreated(SessionCreatedPayload)
    case sessionSwitched(SessionSwitchedPayload)
    case sessionDeleted(SessionDeletedPayload)
    case sessionRenamed(SessionRenamedPayload)
    case sessionCleared(SessionClearedPayload)
    case contextUsage(ContextUsagePayload)
    case mcpBrowserStatus(MCPBrowserStatusPayload)
    case nodePairRequestResult(NodePairRequestResultPayload)
    case nodePairApproveResult(NodePairApproveResultPayload)
    case nodeRegisterResult(NodeRegisterResultPayload)
    case nodeInvokeRequest(NodeInvokeRequestPayload)
    case nodeStatusChanged(NodeStatusChangedPayload)
    case debugEvents(DebugEventsPayload)
    case debugEvent(DebugEventEnvelopePayload)
    case error(ErrorPayload)
    case unknown(String)

    private enum CodingKeys: String, CodingKey { case type }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)

        let single = try decoder.singleValueContainer()

        switch type {
        case "connected":           self = .connected(try single.decode(ConnectedPayload.self))
        case "session_snapshot":    self = .sessionSnapshot(try single.decode(SessionSnapshotPayload.self))
        case "session_chunk":       self = .sessionChunk(try single.decode(SessionChunkPayload.self))
        case "session_message_end": self = .sessionMessageEnd(try single.decode(SessionMessageEndPayload.self))
        case "session_cancelled":   self = .sessionCancelled(try single.decode(SessionCancelledPayload.self))
        case "session_user_message":self = .sessionUserMessage(try single.decode(SessionUserMessagePayload.self))
        case "message_received":    self = .messageReceived(try single.decode(MessageReceivedPayload.self))
        case "confirm_request":     self = .confirmRequest(try single.decode(ConfirmRequestPayload.self))
        case "tool_start":          self = .toolStart(try single.decode(ToolStartPayload.self))
        case "tool_end":            self = .toolEnd(try single.decode(ToolEndPayload.self))
        case "mode_changed":        self = .modeChanged(try single.decode(ModeChangedPayload.self))
        case "model_changed":       self = .modelChanged(try single.decode(ModelChangedPayload.self))
        case "models":              self = .models(try single.decode(ModelsPayload.self))
        case "session_created":     self = .sessionCreated(try single.decode(SessionCreatedPayload.self))
        case "session_switched":    self = .sessionSwitched(try single.decode(SessionSwitchedPayload.self))
        case "session_deleted":     self = .sessionDeleted(try single.decode(SessionDeletedPayload.self))
        case "session_renamed":     self = .sessionRenamed(try single.decode(SessionRenamedPayload.self))
        case "session_cleared":     self = .sessionCleared(try single.decode(SessionClearedPayload.self))
        case "context_usage":       self = .contextUsage(try single.decode(ContextUsagePayload.self))
        case "mcp_browser_status":  self = .mcpBrowserStatus(try single.decode(MCPBrowserStatusPayload.self))
        case "node_pair_request_result": self = .nodePairRequestResult(try single.decode(NodePairRequestResultPayload.self))
        case "node_pair_approve_result": self = .nodePairApproveResult(try single.decode(NodePairApproveResultPayload.self))
        case "node_register_result": self = .nodeRegisterResult(try single.decode(NodeRegisterResultPayload.self))
        case "node_invoke_request": self = .nodeInvokeRequest(try single.decode(NodeInvokeRequestPayload.self))
        case "node_status_changed": self = .nodeStatusChanged(try single.decode(NodeStatusChangedPayload.self))
        case "debug_events_result": self = .debugEvents(try single.decode(DebugEventsPayload.self))
        case "debug_event": self = .debugEvent(try single.decode(DebugEventEnvelopePayload.self))
        case "error":               self = .error(try single.decode(ErrorPayload.self))
        default:                    self = .unknown(type)
        }
    }
}

// MARK: - Payloads

struct ConnectedPayload: Decodable {
    let sessionId: String
    let mode: SecurityMode
    let spicyEnabled: Bool?
    let spicyObedienceEnabled: Bool?
    let llm: LLMConfig
    let discord: ChannelConfig?
    let slack: SlackConfig?
    let browser: BrowserConfig?
    let skills: SkillsConfig?
}

struct SessionSnapshotPayload: Decodable {
    let sessions: [SessionInfo]
}

struct SessionChunkPayload: Decodable {
    let sessionId: String
    let content: String
}

struct SessionMessageEndPayload: Decodable {
    let sessionId: String
    let content: String
}

struct SessionCancelledPayload: Decodable {
    let sessionId: String
    let reason: String?
}

struct SessionUserMessagePayload: Decodable {
    let sessionId: String
    let channelType: String
    let content: String
    let attachments: [Attachment]?
}

struct MessageReceivedPayload: Decodable {
    let sessionId: String
}

struct ConfirmRequestPayload: Decodable {
    let sessionId: String
    let prompt: String
    let details: ConfirmDetails?
}

struct ConfirmDetails: Decodable {
    let tool: String?
    let action: String?
    let summary: String?
    let command: String?
    let cwd: String?
    let path: String?
}

struct ToolStartPayload: Decodable {
    let sessionId: String
    let tool: String
    let args: [String: AnyCodable]?
}

struct ToolEndPayload: Decodable {
    let sessionId: String
    let tool: String
    let result: ToolResult?
}

struct ToolResult: Decodable {
    let success: Bool?
    let output: String?
    let error: String?
}

struct ModeChangedPayload: Decodable {
    let mode: SecurityMode
}

struct ModelChangedPayload: Decodable {
    let llm: LLMConfig
}

struct ModelsPayload: Decodable {
    let provider: String
    let models: [ModelInfo]
    let error: String?
}

struct SessionCreatedPayload: Decodable {
    let sessionId: String
}

struct SessionSwitchedPayload: Decodable {
    let sessionId: String
}

struct SessionDeletedPayload: Decodable {
    let sessionId: String
}

struct SessionRenamedPayload: Decodable {
    let sessionId: String
    let title: String
}

struct SessionClearedPayload: Decodable {
    let sessionId: String
}

struct ContextUsagePayload: Decodable {
    let sessionId: String
    let usedTokens: Int
    let limitTokens: Int
    let percent: Double
}

struct MCPBrowserStatusPayload: Decodable {
    let browser: BrowserConfig
}

struct NodePairRequestResultPayload: Decodable {
    let request: NodePairRequest
}

struct NodePairApproveResultPayload: Decodable {
    let node: NodeRecord
}

struct NodeRegisterResultPayload: Decodable {
    let node: NodeRecord
}

struct NodeInvokeRequestPayload: Decodable {
    let requestId: String
    let nodeId: String
    let capability: NodeCapability
    let params: [String: AnyCodable]?
}

struct NodeStatusChangedPayload: Decodable {
    let nodeId: String
    let online: Bool
    let lastSeenAt: String
}

struct DebugEventsPayload: Decodable {
    let sessionId: String
    let events: [DebugEvent]
}

struct DebugEventEnvelopePayload: Decodable {
    let sessionId: String
    let event: DebugEvent
}

struct ErrorPayload: Decodable {
    let error: String
}

// MARK: - Shared types

enum SecurityMode: String, Codable {
    case safe, spicy
}

struct LLMConfig: Codable {
    let provider: String
    let model: String
    let reasoningEffort: String?
}

struct ChannelConfig: Codable {
    let configured: Bool
    let prefix: String?
}

struct SlackConfig: Codable {
    let configured: Bool
}

struct BrowserConfig: Codable {
    let installed: Bool?
    let healthy: Bool?
    let serverName: String?
    let configuredVersion: String?
    let desiredVersion: String?
}

struct SkillsConfig: Codable {
    let loadedCount: Int?
    let eligibleCount: Int?
}

struct ModelInfo: Codable, Identifiable {
    let id: String
    let provider: String
    let displayName: String?
    let isDefault: Bool?
}

struct Attachment: Codable, Identifiable {
    let id: String
    let filename: String
    let contentType: String
    let sizeBytes: Int
    let url: String
}

enum NodeCapability: String, Codable, CaseIterable, Identifiable {
    case notify
    case location
    case camera
    case screen
    case shell
    case invoke

    var id: String { rawValue }
}

enum NodePermissionState: String, Codable {
    case granted
    case denied
    case unknown
}

struct NodePairRequest: Codable {
    let requestId: String
    let name: String
    let capabilities: [NodeCapability]
    let pairingCode: String
    let createdAt: String
    let expiresAt: String
}

struct NodeRecord: Codable, Identifiable {
    let id: String
    let name: String
    let capabilities: [NodeCapability]
    let trusted: Bool
    let authToken: String?
    let platform: String?
    let version: String?
    let online: Bool?
    let permissions: [String: NodePermissionState]?
    let createdAt: String
    let updatedAt: String
    let lastSeenAt: String
    let lastInvocationAt: String?
}

struct DebugEvent: Codable, Identifiable {
    let id: String
    let timestamp: String
    let type: String
    let message: String
    let data: [String: AnyCodable]?
}

// MARK: - Session

struct SessionInfo: Codable, Identifiable {
    let sessionId: String
    let channelType: String?
    let title: String?
    let updatedAt: String?
    let messages: [ChatMessage]?

    var id: String { sessionId }

    var channel: ChannelType {
        guard let ct = channelType else { return .web }
        return ChannelType(rawValue: ct) ?? .web
    }
}

enum ChannelType: String, Codable {
    case web, discord, terminal, slack
}

struct ChatMessage: Codable, Identifiable {
    let role: String
    let content: String
    let attachments: [Attachment]?

    var id: String { "\(role)-\(content.prefix(50).hashValue)" }

    var isUser: Bool { role == "user" }
    var isAssistant: Bool { role == "assistant" }
}

// MARK: - AnyCodable (lightweight JSON wrapper)

struct AnyCodable: Codable {
    let value: Any

    init(_ value: Any) { self.value = value }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let s = try? container.decode(String.self) { value = s }
        else if let i = try? container.decode(Int.self) { value = i }
        else if let d = try? container.decode(Double.self) { value = d }
        else if let b = try? container.decode(Bool.self) { value = b }
        else if let arr = try? container.decode([AnyCodable].self) { value = arr.map(\.value) }
        else if let dict = try? container.decode([String: AnyCodable].self) { value = dict.mapValues(\.value) }
        else { value = NSNull() }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        if let s = value as? String { try container.encode(s) }
        else if let i = value as? Int { try container.encode(i) }
        else if let d = value as? Double { try container.encode(d) }
        else if let b = value as? Bool { try container.encode(b) }
        else { try container.encodeNil() }
    }
}
