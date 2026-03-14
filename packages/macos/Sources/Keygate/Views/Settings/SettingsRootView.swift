import Sparkle
import SwiftUI

/// Settings window — tabbed macOS-native layout.
struct SettingsRootView: View {
    var body: some View {
        TabView {
            GeneralSettingsTab()
                .tabItem { Label("General", systemImage: "gearshape") }

            AppearanceSettingsTab()
                .tabItem { Label("Appearance", systemImage: "paintbrush") }

            LLMSettingsTab()
                .tabItem { Label("LLM", systemImage: "brain") }

            SecuritySettingsTab()
                .tabItem { Label("Security", systemImage: "lock.shield") }

            BrowserSettingsTab()
                .tabItem { Label("Browser", systemImage: "globe") }

            RuntimeSettingsTab()
                .tabItem { Label("Runtime", systemImage: "waveform.path.ecg") }

            IntegrationsSettingsTab()
                .tabItem { Label("Integrations", systemImage: "puzzlepiece.extension") }
        }
        .frame(width: 520, height: 420)
    }
}

// MARK: - General

/// Stored appearance key for background material.
/// Values map to NSVisualEffectView.Material raw values.
/// Default 0 = headerView (raw value 10) — see `AppearanceSettingsTab`.
enum AppearanceMaterial: Int, CaseIterable, Identifiable {
    case headerView = 0
    case titlebar = 1
    case contentBackground = 2
    case underPageBackground = 3
    case sidebar = 4
    case hudWindow = 5
    case fullScreenUI = 6

    var id: Int { rawValue }

    var label: String {
        switch self {
        case .headerView: "Header View (default)"
        case .titlebar: "Titlebar"
        case .contentBackground: "Content Background"
        case .underPageBackground: "Under Page"
        case .sidebar: "Sidebar"
        case .hudWindow: "HUD Window"
        case .fullScreenUI: "Full Screen UI"
        }
    }

    var nsMaterial: NSVisualEffectView.Material {
        switch self {
        case .headerView: .headerView
        case .titlebar: .titlebar
        case .contentBackground: .contentBackground
        case .underPageBackground: .underPageBackground
        case .sidebar: .sidebar
        case .hudWindow: .hudWindow
        case .fullScreenUI: .fullScreenUI
        }
    }
}

// MARK: - Appearance

struct AppearanceSettingsTab: View {
    @AppStorage("windowOpacity") private var windowOpacity: Double = 1.0
    @AppStorage("backgroundMaterial") private var backgroundMaterial: Int = AppearanceMaterial.headerView.rawValue
    @AppStorage("vibrancyEnabled") private var vibrancyEnabled: Bool = true
    @AppStorage("backgroundBlur") private var backgroundBlur: Double = 0.0

    private var selectedMaterial: AppearanceMaterial {
        AppearanceMaterial(rawValue: backgroundMaterial) ?? .headerView
    }

    var body: some View {
        Form {
            Section("Background") {
                Toggle("Enable vibrancy / blur", isOn: $vibrancyEnabled)

                Picker("Material", selection: $backgroundMaterial) {
                    ForEach(AppearanceMaterial.allCases) { material in
                        Text(material.label).tag(material.rawValue)
                    }
                }
                .disabled(!vibrancyEnabled)

                Text("Controls the blur style used behind the main window and sidebar.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Transparency") {
                HStack {
                    Text("Background opacity")
                    Spacer()
                    Text("\(Int(windowOpacity * 100))%")
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }

                Slider(value: $windowOpacity, in: 0.4...1.0, step: 0.05)

                Text("Lower values make the background more see-through. Text and controls remain fully visible.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Background Blur") {
                HStack {
                    Text("Blur radius")
                    Spacer()
                    Text(backgroundBlur > 0 ? "\(Int(backgroundBlur))" : "Off")
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }

                Slider(value: $backgroundBlur, in: 0...80, step: 1)

                Text("Adds an extra frosted-glass blur to the window background. Works best with lower opacity values.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section {
                Button("Reset to Default") {
                    windowOpacity = 1.0
                    backgroundBlur = 0.0
                    backgroundMaterial = AppearanceMaterial.headerView.rawValue
                    vibrancyEnabled = true
                }
            }

            Section {
                previewSwatch
            } header: {
                Text("Preview")
            }
        }
        .formStyle(.grouped)
    }

    private var previewSwatch: some View {
        ZStack {
            // Checkerboard to show transparency
            Canvas { context, size in
                let step: CGFloat = 10
                for row in 0..<Int(size.height / step) + 1 {
                    for col in 0..<Int(size.width / step) + 1 {
                        let isLight = (row + col) % 2 == 0
                        let rect = CGRect(x: CGFloat(col) * step, y: CGFloat(row) * step, width: step, height: step)
                        context.fill(Path(rect), with: .color(isLight ? .gray.opacity(0.15) : .gray.opacity(0.25)))
                    }
                }
            }

            if vibrancyEnabled {
                VisualEffectView(
                    material: selectedMaterial.nsMaterial,
                    blendingMode: .behindWindow,
                    state: .active
                )
                .opacity(windowOpacity)
            } else {
                Color(nsColor: .windowBackgroundColor)
                    .opacity(windowOpacity)
            }

            Text("Keygate")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(.primary)
        }
        .frame(height: 60)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(.quaternary, lineWidth: 0.5)
        )
    }
}

struct GeneralSettingsTab: View {
    @EnvironmentObject var gateway: GatewayService
    @AppStorage("launchAtLogin") private var launchAtLogin = false

    /// Sparkle updater reference — accessed via static property.
    private let updater = AppDelegate.updaterController.updater

    var body: some View {
        Form {
            Section("Gateway") {
                LabeledContent("Host") {
                    Text("\(gateway.host):\(gateway.port)")
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }

                LabeledContent("Status") {
                    HStack(spacing: 5) {
                        Circle()
                            .fill(gateway.connectionState.isConnected ? .green : .red)
                            .frame(width: 7, height: 7)
                        Text(gateway.connectionState.isConnected ? "Connected" : "Disconnected")
                    }
                }

                Button(gateway.connectionState.isConnected ? "Reconnect" : "Connect") {
                    gateway.disconnect()
                    gateway.connect()
                }
            }

            Section("Startup") {
                Toggle("Launch at login", isOn: $launchAtLogin)
            }

            Section("About") {
                LabeledContent("Version") {
                    Text(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "—")
                        .foregroundStyle(.secondary)
                }

                Button("Check for Updates…") {
                    updater.checkForUpdates()
                }
            }
        }
        .formStyle(.grouped)
    }
}

// MARK: - LLM

struct LLMSettingsTab: View {
    @EnvironmentObject var gateway: GatewayService
    @State private var selectedModel: String = ""
    @State private var selectedProvider: String = ""
    @State private var reasoningEffort: String = "medium"

    var body: some View {
        Form {
            Section("Current Model") {
                if let llm = gateway.llmConfig {
                    LabeledContent("Provider") {
                        Text(llm.provider)
                            .foregroundStyle(.secondary)
                    }
                    LabeledContent("Model") {
                        Text(llm.model)
                            .foregroundStyle(.secondary)
                    }
                    if let effort = llm.reasoningEffort {
                        LabeledContent("Reasoning Effort") {
                            Text(reasoningEffortDisplayLabel(effort))
                                .foregroundStyle(.secondary)
                        }
                    }
                } else {
                    Text("Not connected")
                        .foregroundStyle(.tertiary)
                }
            }

            Section("Switch Model") {
                Picker("Model", selection: $selectedModel) {
                    Text("—").tag("")
                    ForEach(gateway.availableModels) { model in
                        Text(model.displayName ?? model.id).tag(model.id)
                    }
                }

                Picker("Reasoning Effort", selection: $reasoningEffort) {
                    Text("Low").tag("low")
                    Text("Medium").tag("medium")
                    Text("High").tag("high")
                    Text("Extra High").tag("xhigh")
                }

                Button("Apply") {
                    guard !selectedModel.isEmpty else { return }
                    let provider = gateway.availableModels.first { $0.id == selectedModel }?.provider
                    gateway.setModel(provider: provider, model: selectedModel, reasoningEffort: reasoningEffort)
                }
                .disabled(selectedModel.isEmpty)
            }

            Section {
                Button("Refresh Models") {
                    gateway.requestModels()
                }
            }
        }
        .formStyle(.grouped)
        .onAppear {
            selectedModel = gateway.llmConfig?.model ?? ""
            reasoningEffort = gateway.llmConfig?.reasoningEffort ?? "medium"
        }
    }
}

// MARK: - Security

struct SecuritySettingsTab: View {
    @EnvironmentObject var gateway: GatewayService
    @State private var confirmSpicy = false

    var body: some View {
        Form {
            Section("Mode") {
                Picker("Security mode", selection: Binding(
                    get: { gateway.mode },
                    set: { gateway.setMode($0) }
                )) {
                    Text("Safe").tag(SecurityMode.safe)
                    Text("Spicy").tag(SecurityMode.spicy)
                }
                .pickerStyle(.segmented)

                if gateway.mode == .safe {
                    Text("All shell commands and file writes require your approval before execution.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Text("Commands run without confirmation. Use with caution.")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }

            if gateway.mode == .spicy {
                Section("Spicy Options") {
                    if !gateway.spicyEnabled {
                        Button("Enable Spicy Mode") {
                            confirmSpicy = true
                        }
                        .alert("Enable Spicy Mode?", isPresented: $confirmSpicy) {
                            Button("Cancel", role: .cancel) {}
                            Button("I Accept the Risk", role: .destructive) {
                                gateway.send(.enableSpicyMode)
                            }
                        } message: {
                            Text("Spicy mode allows commands to execute without confirmation. This is potentially dangerous.")
                        }
                    } else {
                        Toggle("Spicy Obedience", isOn: Binding(
                            get: { gateway.spicyObedienceEnabled },
                            set: { gateway.send(.setSpicyObedience(enabled: $0)) }
                        ))

                        Text("When on, the agent follows instructions without safety guardrails.")
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }
            }
        }
        .formStyle(.grouped)
    }
}

// MARK: - Browser

struct BrowserSettingsTab: View {
    @EnvironmentObject var gateway: GatewayService

    var body: some View {
        Form {
            Section("MCP Browser") {
                if let browser = gateway.browserConfig {
                    LabeledContent("Installed") {
                        Image(systemName: browser.installed == true ? "checkmark.circle.fill" : "xmark.circle")
                            .foregroundColor(browser.installed == true ? .green : .red)
                    }
                    LabeledContent("Healthy") {
                        Image(systemName: browser.healthy == true ? "checkmark.circle.fill" : "xmark.circle")
                            .foregroundColor(browser.healthy == true ? .green : .red)
                    }
                    if let serverName = browser.serverName {
                        LabeledContent("Server") {
                            Text(serverName).foregroundStyle(.secondary)
                        }
                    }
                    if let version = browser.configuredVersion {
                        LabeledContent("Version") {
                            Text(version).foregroundStyle(.secondary)
                        }
                    }
                    if let desired = browser.desiredVersion, desired != browser.configuredVersion {
                        LabeledContent("Update Available") {
                            Text(desired).foregroundStyle(.orange)
                        }
                    }
                } else {
                    Text("Not configured or not connected")
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .formStyle(.grouped)
    }
}

// MARK: - Runtime

struct RuntimeSettingsTab: View {
    @EnvironmentObject var gateway: GatewayService

    private var recentActionItems: [ChannelActionPayload] {
        Array(gateway.recentChannelActions.prefix(10))
    }

    var body: some View {
        Form {
            Section("Overview") {
                HStack {
                    LabeledContent("WebChat Links") {
                        Text("\(gateway.runtimeStatus?.webchat?.activeLinks ?? 0)")
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    LabeledContent("Voice Sessions") {
                        Text("\(gateway.activeVoiceSessions.count)")
                            .foregroundStyle(.secondary)
                    }
                }

                HStack {
                    LabeledContent("Canvas Surfaces") {
                        Text("\(gateway.canvasSurfaces.count)")
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    LabeledContent("Media") {
                        Text(gateway.runtimeStatus?.media?.enabled == true ? "Enabled" : "Off")
                            .foregroundStyle(.secondary)
                    }
                }

                Button("Refresh Runtime Status") {
                    gateway.refreshRuntimeStatusNow()
                }
                .disabled(!gateway.connectionState.isConnected)
            }

            Section("WebChat") {
                LabeledContent("Enabled") {
                    Text(gateway.runtimeStatus?.webchat?.enabled == true ? "Yes" : "No")
                        .foregroundStyle(.secondary)
                }
                if let guestPath = gateway.runtimeStatus?.webchat?.guestPath {
                    LabeledContent("Guest Path") {
                        Text(guestPath)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }
            }

            Section("Canvas") {
                if let basePath = gateway.runtimeStatus?.canvas?.basePath {
                    LabeledContent("Base Path") {
                        Text(basePath)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }
                if let a2uiPath = gateway.runtimeStatus?.canvas?.a2uiPath {
                    LabeledContent("A2UI Path") {
                        Text(a2uiPath)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }

                if gateway.canvasSurfaces.isEmpty {
                    Text("No live canvas surfaces")
                        .foregroundStyle(.tertiary)
                } else {
                    ForEach(gateway.canvasSurfaces) { surface in
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(surface.surfaceId)
                                    .font(.system(size: 12, weight: .semibold))
                                Text(surface.sessionId)
                                    .font(.system(size: 11))
                                    .foregroundStyle(.secondary)
                                if let statusText = surface.statusText, !statusText.isEmpty {
                                    Text(statusText)
                                        .font(.system(size: 11))
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            Button("Open") {
                                gateway.openCanvasSurface(surface)
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                        }
                    }
                }
            }

            Section("Memory") {
                LabeledContent("Backend") {
                    Text(gateway.runtimeStatus?.memory?.backend ?? "—")
                        .foregroundStyle(.secondary)
                }
                LabeledContent("Target") {
                    Text(gateway.runtimeStatus?.memory?.targetBackend ?? "—")
                        .foregroundStyle(.secondary)
                }
                LabeledContent("Migration") {
                    Text(gateway.runtimeStatus?.memory?.migrationPhase ?? "—")
                        .foregroundStyle(.secondary)
                }
                LabeledContent("Batch Mode") {
                    Text(gateway.runtimeStatus?.memory?.batchMode ?? "—")
                        .foregroundStyle(.secondary)
                }
                if let multimodal = gateway.runtimeStatus?.memory?.multimodal, !multimodal.isEmpty {
                    LabeledContent("Modalities") {
                        Text(multimodal.joined(separator: ", "))
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Section("Voice") {
                if gateway.activeVoiceSessions.isEmpty {
                    Text("No active voice sessions")
                        .foregroundStyle(.tertiary)
                } else {
                    ForEach(gateway.activeVoiceSessions) { voice in
                        VStack(alignment: .leading, spacing: 3) {
                            Text("\(voice.guildId) · \(voice.channelId)")
                                .font(.system(size: 12, weight: .semibold))
                            Text("Session \(voice.sessionId)")
                                .font(.system(size: 11))
                                .foregroundStyle(.secondary)
                            Text(voice.status.capitalized)
                                .font(.system(size: 11))
                                .foregroundStyle(voice.status == "error" ? .red : .secondary)
                            if let error = voice.error, !error.isEmpty {
                                Text(error)
                                    .font(.system(size: 11))
                                    .foregroundStyle(.red)
                            }
                        }
                    }
                }
            }

            Section("Recent Channel Actions") {
                if gateway.recentChannelActions.isEmpty {
                    Text("No channel actions yet")
                        .foregroundStyle(.tertiary)
                } else {
                    RecentChannelActionsList(actions: recentActionItems)
                }
            }
        }
        .formStyle(.grouped)
        .onAppear {
            gateway.refreshRuntimeStatusNow()
        }
    }
}

private struct RecentChannelActionsList: View {
    let actions: [ChannelActionPayload]

    var body: some View {
        Text(summary)
            .font(.system(size: 11))
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var summary: String {
        actions.map { action in
            let result = action.ok ? "OK" : (action.error ?? "Failed")
            return "\(action.channel) · \(action.action)\n\(action.sessionId)\n\(result)"
        }.joined(separator: "\n\n")
    }
}

// MARK: - Integrations

struct IntegrationsSettingsTab: View {
    @EnvironmentObject var gateway: GatewayService

    var body: some View {
        Form {
            Section("Device Node") {
                if let node = gateway.nodeRecord {
                    LabeledContent("Node") {
                        Text(node.name).foregroundStyle(.secondary)
                    }
                    LabeledContent("Status") {
                        HStack(spacing: 6) {
                            Circle()
                                .fill((node.online ?? false) ? .green : .orange)
                                .frame(width: 7, height: 7)
                            Text((node.online ?? false) ? "Online" : "Offline")
                                .foregroundStyle(.secondary)
                        }
                    }
                    LabeledContent("Capabilities") {
                        Text(node.capabilities.map(\.rawValue).joined(separator: ", "))
                            .foregroundStyle(.secondary)
                    }
                    LabeledContent("Last Seen") {
                        Text(node.lastSeenAt.isEmpty ? "—" : node.lastSeenAt)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Text("Not paired").foregroundStyle(.tertiary)
                }

                ForEach(NodeCapability.allCases.filter { $0 != .invoke }) { capability in
                    Toggle(capability.rawValue.capitalized, isOn: Binding(
                        get: { gateway.nodeCapabilitySelection.contains(capability) },
                        set: { gateway.setNodeCapabilityEnabled(capability, enabled: $0) }
                    ))
                }

                HStack {
                    Button("Start Pairing") {
                        gateway.requestNodePairing()
                    }
                    .disabled(gateway.connectionState.isConnected == false)

                    if gateway.nodePairRequest != nil {
                        Button("Approve Pairing") {
                            gateway.approveNodePairing()
                        }
                        .disabled(gateway.connectionState.isConnected == false)
                    }

                    if gateway.nodeRecord != nil {
                        Button("Forget Node") {
                            gateway.forgetPairedNode()
                        }
                    }
                }

                if let request = gateway.nodePairRequest {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Pairing Code: \(request.pairingCode)")
                            .font(.system(.body, design: .monospaced))
                        Text("Expires: \(request.expiresAt)")
                            .foregroundStyle(.secondary)
                    }
                }

                if !gateway.nodePermissions.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(gateway.nodePermissions.keys.sorted(), id: \.self) { key in
                            HStack {
                                Text(key.capitalized)
                                Spacer()
                                Text(gateway.nodePermissions[key] ?? "unknown")
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }

                if !gateway.nodeLastInvocationStatus.isEmpty {
                    Text(gateway.nodeLastInvocationStatus)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Section("Discord") {
                if let discord = gateway.discordConfig {
                    LabeledContent("Configured") {
                        Image(systemName: discord.configured ? "checkmark.circle.fill" : "xmark.circle")
                            .foregroundColor(discord.configured ? .green : .secondary)
                    }
                    if let prefix = discord.prefix {
                        LabeledContent("Prefix") {
                            Text(prefix).foregroundStyle(.secondary)
                        }
                    }
                } else {
                    Text("Not configured").foregroundStyle(.tertiary)
                }
            }

            Section("Slack") {
                if let slack = gateway.slackConfig {
                    LabeledContent("Configured") {
                        Image(systemName: slack.configured ? "checkmark.circle.fill" : "xmark.circle")
                            .foregroundColor(slack.configured ? .green : .secondary)
                    }
                } else {
                    Text("Not configured").foregroundStyle(.tertiary)
                }
            }

            Section("Skills") {
                if let skills = gateway.skillsConfig {
                    LabeledContent("Loaded") {
                        Text("\(skills.loadedCount ?? 0)").foregroundStyle(.secondary)
                    }
                    LabeledContent("Eligible") {
                        Text("\(skills.eligibleCount ?? 0)").foregroundStyle(.secondary)
                    }
                } else {
                    Text("Not connected").foregroundStyle(.tertiary)
                }
            }
        }
        .formStyle(.grouped)
    }
}
