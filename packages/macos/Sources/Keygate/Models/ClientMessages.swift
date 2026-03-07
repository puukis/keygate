import Foundation

// MARK: - Client → Server messages

enum ClientMessage {
    case message(content: String, attachments: [Attachment]? = nil)
    case cancelSession(sessionId: String)
    case confirmResponse(decision: ConfirmDecision)
    case getSessionSnapshot
    case newSession
    case clearSession
    case deleteSession(sessionId: String)
    case renameSession(sessionId: String, title: String)
    case switchSession(sessionId: String)
    case setMode(SecurityMode)
    case enableSpicyMode
    case setSpicyObedience(enabled: Bool)
    case getModels(provider: String? = nil)
    case setModel(provider: String?, model: String, reasoningEffort: String? = nil)
    case nodePairRequest(nodeName: String, capabilities: [NodeCapability])
    case nodePairApprove(requestId: String, pairingCode: String)
    case nodeRegister(nodeId: String, authToken: String, platform: String, version: String, permissions: [String: String])
    case nodeHeartbeat(nodeId: String, authToken: String, platform: String, version: String, permissions: [String: String])
    case nodeInvokeResponse(requestId: String, nodeId: String, capability: NodeCapability, ok: Bool, message: String, payload: [String: Any]? = nil)
    case debugEvents(sessionId: String)

    var json: [String: Any] {
        switch self {
        case .message(let content, let attachments):
            var dict: [String: Any] = ["type": "message", "content": content]
            if let attachments, !attachments.isEmpty {
                dict["attachments"] = attachments.map { att in
                    ["id": att.id, "filename": att.filename, "contentType": att.contentType,
                     "sizeBytes": att.sizeBytes, "url": att.url] as [String: Any]
                }
            }
            return dict
        case .cancelSession(let sessionId):
            return ["type": "cancel_session", "sessionId": sessionId]
        case .confirmResponse(let decision):
            return ["type": "confirm_response", "decision": decision.rawValue]
        case .getSessionSnapshot:
            return ["type": "get_session_snapshot"]
        case .newSession:
            return ["type": "new_session"]
        case .clearSession:
            return ["type": "clear_session"]
        case .deleteSession(let sessionId):
            return ["type": "delete_session", "sessionId": sessionId]
        case .renameSession(let sessionId, let title):
            return ["type": "rename_session", "sessionId": sessionId, "title": title]
        case .switchSession(let sessionId):
            return ["type": "switch_session", "sessionId": sessionId]
        case .setMode(let mode):
            return ["type": "set_mode", "mode": mode.rawValue]
        case .enableSpicyMode:
            return ["type": "enable_spicy_mode", "riskAck": "I ACCEPT THE RISK"]
        case .setSpicyObedience(let enabled):
            return ["type": "set_spicy_obedience", "enabled": enabled]
        case .getModels(let provider):
            var dict: [String: Any] = ["type": "get_models"]
            if let provider { dict["provider"] = provider }
            return dict
        case .setModel(let provider, let model, let reasoningEffort):
            var dict: [String: Any] = ["type": "set_model", "model": model]
            if let provider { dict["provider"] = provider }
            if let reasoningEffort { dict["reasoningEffort"] = reasoningEffort }
            return dict
        case .nodePairRequest(let nodeName, let capabilities):
            return [
                "type": "node_pair_request",
                "nodeName": nodeName,
                "capabilities": capabilities.map(\.rawValue),
            ]
        case .nodePairApprove(let requestId, let pairingCode):
            return [
                "type": "node_pair_approve",
                "requestId": requestId,
                "pairingCode": pairingCode,
            ]
        case .nodeRegister(let nodeId, let authToken, let platform, let version, let permissions):
            return [
                "type": "node_register",
                "nodeId": nodeId,
                "authToken": authToken,
                "platform": platform,
                "version": version,
                "permissions": permissions,
            ]
        case .nodeHeartbeat(let nodeId, let authToken, let platform, let version, let permissions):
            return [
                "type": "node_heartbeat",
                "nodeId": nodeId,
                "authToken": authToken,
                "platform": platform,
                "version": version,
                "permissions": permissions,
            ]
        case .nodeInvokeResponse(let requestId, let nodeId, let capability, let ok, let message, let payload):
            var dict: [String: Any] = [
                "type": "node_invoke_response",
                "requestId": requestId,
                "nodeId": nodeId,
                "capability": capability.rawValue,
                "ok": ok,
                "message": message,
            ]
            if let payload { dict["payload"] = payload }
            return dict
        case .debugEvents(let sessionId):
            return [
                "type": "debug_events",
                "sessionId": sessionId,
            ]
        }
    }

    var data: Data? {
        try? JSONSerialization.data(withJSONObject: json)
    }
}

enum ConfirmDecision: String {
    case allowOnce = "allow_once"
    case allowAlways = "allow_always"
    case cancel = "cancel"
}
