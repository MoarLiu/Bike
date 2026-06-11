import Foundation

enum AiEndpoint: String, Codable, CaseIterable, Identifiable {
    case responses
    case chatCompletions = "chat_completions"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .responses: "Responses"
        case .chatCompletions: "Chat/completions"
        }
    }

    var path: String {
        switch self {
        case .responses: "responses"
        case .chatCompletions: "chat/completions"
        }
    }
}

enum AiNodeAction: String, CaseIterable, Identifiable {
    case generate
    case polish

    var id: String { rawValue }

    var title: String {
        switch self {
        case .generate: "生成"
        case .polish: "润色"
        }
    }

    var systemImage: String {
        switch self {
        case .generate: "sparkles"
        case .polish: "wand.and.stars"
        }
    }
}

struct AiApiConfig: Codable, Equatable {
    var endpoint: AiEndpoint
    var baseUrl: String
    var apiKey: String
    var model: String

    static let `default` = AiApiConfig(
        endpoint: .responses,
        baseUrl: "https://api.openai.com/v1",
        apiKey: "",
        model: "gpt-5.5"
    )
}

struct AiActionContext {
    var documentTitle: String
    var topicText: String
    var note: String
    var existingChildren: [String]
}

struct AiGeneratedNode: Equatable {
    var text: String
    var children: [AiGeneratedNode] = []
}

struct AiActionResult: Equatable {
    var text: String?
    var children: [AiGeneratedNode]?
}

enum AiServiceError: LocalizedError {
    case invalidConfig(String)
    case invalidEndpoint
    case emptyResponse
    case invalidJSON
    case invalidStructure
    case missingPolishText
    case htmlEndpoint
    case requestFailed(String)

    var errorDescription: String? {
        switch self {
        case .invalidConfig(let message): message
        case .invalidEndpoint: "API baseurl 需要以 http:// 或 https:// 开头"
        case .emptyResponse: "AI 返回内容为空"
        case .invalidJSON: "AI 返回内容不是有效 JSON"
        case .invalidStructure: "AI 返回 JSON 结构不正确"
        case .missingPolishText: "AI 没有返回润色文本"
        case .htmlEndpoint: "AI 端点返回了 HTML 页面，请检查 API baseurl 和协议端点是否匹配"
        case .requestFailed(let message): message
        }
    }
}

enum AiConfigStore {
    private static let key = "bike-ai-config"
    private static let legacyKey = "local-outline-ai-config"

    static func load() -> AiApiConfig {
        let defaults = UserDefaults.standard
        guard let data = defaults.data(forKey: key) ?? defaults.data(forKey: legacyKey),
              let parsed = try? JSONDecoder().decode(AiApiConfig.self, from: data) else {
            return .default
        }
        return normalize(parsed)
    }

    @discardableResult
    static func save(_ config: AiApiConfig) -> AiApiConfig {
        let normalized = normalize(config)
        if let data = try? JSONEncoder().encode(normalized) {
            UserDefaults.standard.set(data, forKey: key)
            UserDefaults.standard.removeObject(forKey: legacyKey)
        }
        return normalized
    }

    static func normalize(_ config: AiApiConfig) -> AiApiConfig {
        AiApiConfig(
            endpoint: config.endpoint,
            baseUrl: config.baseUrl.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: #"/+$"#, with: "", options: .regularExpression),
            apiKey: config.apiKey.trimmingCharacters(in: .whitespacesAndNewlines),
            model: config.model.trimmingCharacters(in: .whitespacesAndNewlines)
        )
    }

    static func validationMessage(for config: AiApiConfig) -> String? {
        let normalized = normalize(config)
        if normalized.baseUrl.isEmpty { return "请输入 API baseurl" }
        if !normalized.baseUrl.lowercased().hasPrefix("http://"), !normalized.baseUrl.lowercased().hasPrefix("https://") {
            return "API baseurl 需要以 http:// 或 https:// 开头"
        }
        if normalized.apiKey.isEmpty { return "请输入 API key" }
        if normalized.model.isEmpty { return "请输入大模型名称" }
        return nil
    }
}

enum AiService {
    private typealias JSONRecord = [String: Any]

    private static let systemPrompt = [
        "你是 Bike 的大纲写作助手。",
        "必须只输出 JSON，不要输出 Markdown 代码块、解释或多余文字。",
        "内容使用中文，短句优先，适合作为大纲主题。"
    ].joined(separator: "\n")

    private static let generationInstructions = [
        "任务：基于当前主题生成子主题。",
        "输出 JSON 结构：{\"children\":[{\"text\":\"子主题\",\"children\":[{\"text\":\"更细子主题\"}]}]}。",
        "最多生成 3 层子节点。每个节点 text 不超过 36 个中文字符。",
        "避免重复已有子主题，不要生成空节点。"
    ].joined(separator: "\n")

    private static let polishInstructions = [
        "任务：润色并重写当前主题文字。",
        "输出 JSON 结构：{\"text\":\"润色后的主题\"}。",
        "保留原意，让表达更清晰、准确、简洁。只返回一个主题文本。"
    ].joined(separator: "\n")

    static func generatedNodesToOutlineNodes(_ nodes: [AiGeneratedNode]?, depth: Int = 1) -> [OutlineNodeDTO] {
        guard let nodes, !nodes.isEmpty, depth <= 3 else { return [] }
        return nodes.map { item in
            OutlineNodeDTO(
                text: item.text.trimmingCharacters(in: .whitespacesAndNewlines),
                children: generatedNodesToOutlineNodes(item.children, depth: depth + 1)
            )
        }
    }

    static func run(config: AiApiConfig, action: AiNodeAction, context: AiActionContext) async throws -> AiActionResult {
        if let message = AiConfigStore.validationMessage(for: config) {
            throw AiServiceError.invalidConfig(message)
        }

        let normalized = AiConfigStore.normalize(config)
        let messages: [JSONRecord] = [
            ["role": "system", "content": systemPrompt],
            ["role": "user", "content": prompt(action: action, context: context)]
        ]
        let body = requestBody(config: normalized, messages: messages)
        let response = try await invoke(config: normalized, body: body)
        let text = extractText(from: response)
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw AiServiceError.emptyResponse
        }
        return try normalizeActionResult(action: action, parsed: parseJSONText(text))
    }

    static func normalizeActionResult(action: AiNodeAction, parsed: Any) throws -> AiActionResult {
        if let array = parsed as? [Any] {
            return AiActionResult(children: sanitizeGeneratedNodes(array))
        }
        guard let record = parsed as? JSONRecord else {
            throw AiServiceError.invalidStructure
        }
        if action == .polish {
            let text = generatedNodeText(record)
            guard !text.isEmpty else { throw AiServiceError.missingPolishText }
            return AiActionResult(text: text)
        }
        return AiActionResult(children: sanitizeGeneratedNodes(record))
    }

    static func parseJSONText(_ value: String) throws -> Any {
        var trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        trimmed = trimmed.replacingOccurrences(of: #"^```(?:json)?\s*"#, with: "", options: [.regularExpression, .caseInsensitive])
        trimmed = trimmed.replacingOccurrences(of: #"\s*```$"#, with: "", options: [.regularExpression, .caseInsensitive])

        if let parsed = jsonObject(from: trimmed) {
            return parsed
        }
        if let slice = firstBalancedJSONSlice(trimmed), let parsed = jsonObject(from: slice) {
            return parsed
        }
        throw AiServiceError.invalidJSON
    }

    static func extractTextFromEventStream(_ value: String) -> String {
        guard value.range(of: #"(?m)^\s*(event|data):"#, options: .regularExpression) != nil else {
            return ""
        }

        var deltas: [String] = []
        var completedTexts: [String] = []
        for line in value.components(separatedBy: .newlines) {
            guard line.hasPrefix("data:") else { continue }
            let payload = String(line.dropFirst(5)).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !payload.isEmpty, payload != "[DONE]", let eventData = jsonObject(from: payload) as? JSONRecord else {
                continue
            }
            if eventData["type"] as? String == "response.output_text.delta", let delta = eventData["delta"] as? String {
                deltas.append(delta)
                continue
            }
            if eventData["type"] as? String == "response.output_text.done", let text = eventData["text"] as? String {
                completedTexts.append(text)
                continue
            }
            if let part = eventData["part"] as? JSONRecord, part["type"] as? String == "output_text", let text = part["text"] as? String, !text.isEmpty {
                completedTexts.append(text)
                continue
            }
            if let item = eventData["item"] as? JSONRecord {
                let text = extractTextFromOutputContent(item["content"])
                if !text.isEmpty {
                    completedTexts.append(text)
                    continue
                }
            }
            if let response = eventData["response"] as? JSONRecord, let output = response["output"] as? [Any] {
                let text = output.compactMap { item -> String? in
                    guard let item = item as? JSONRecord else { return nil }
                    return extractTextFromOutputContent(item["content"])
                }.joined()
                if !text.isEmpty {
                    completedTexts.append(text)
                }
            }
        }
        return deltas.joined().isEmpty ? completedTexts.joined() : deltas.joined()
    }

    private static func prompt(action: AiNodeAction, context: AiActionContext) -> String {
        let childList = context.existingChildren.isEmpty
            ? "无"
            : context.existingChildren.map { "- \($0)" }.joined(separator: "\n")
        return [
            action == .generate ? generationInstructions : polishInstructions,
            "",
            "文档标题：\(context.documentTitle.isEmpty ? Defaults.documentTitle : context.documentTitle)",
            "当前主题：\(context.topicText.isEmpty ? Defaults.nodeText : context.topicText)",
            context.note.isEmpty ? "" : "主题备注：\(context.note)",
            "已有子主题：\n\(childList)"
        ].filter { !$0.isEmpty }.joined(separator: "\n")
    }

    private static func requestBody(config: AiApiConfig, messages: [JSONRecord]) -> JSONRecord {
        if config.endpoint == .chatCompletions {
            return [
                "model": config.model,
                "messages": messages
            ]
        }

        let userPrompt = messages
            .filter { $0["role"] as? String != "system" }
            .compactMap { $0["content"] as? String }
            .joined(separator: "\n\n")
        return [
            "model": config.model,
            "instructions": systemPrompt,
            "input": [[
                "role": "user",
                "content": [[
                    "type": "input_text",
                    "text": userPrompt
                ]]
            ]]
        ]
    }

    private static func invoke(config: AiApiConfig, body: JSONRecord) async throws -> Any {
        guard let url = endpointURL(config: config) else { throw AiServiceError.invalidEndpoint }
        var request = URLRequest(url: url, timeoutInterval: 90)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(config.apiKey)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw AiServiceError.requestFailed("AI 请求失败")
        }

        let contentType = http.value(forHTTPHeaderField: "Content-Type") ?? ""
        let text = String(data: data, encoding: .utf8) ?? ""
        let payload = parseProviderPayload(text)

        if (200..<300).contains(http.statusCode), contentType.lowercased().hasPrefix("text/html") {
            throw AiServiceError.htmlEndpoint
        }
        if !(200..<300).contains(http.statusCode) {
            throw AiServiceError.requestFailed(providerErrorMessage(payload) ?? "AI 请求失败：HTTP \(http.statusCode)")
        }
        return payload ?? [:]
    }

    private static func endpointURL(config: AiApiConfig) -> URL? {
        let base = config.baseUrl.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: #"/+$"#, with: "", options: .regularExpression)
        guard base.lowercased().hasPrefix("http://") || base.lowercased().hasPrefix("https://") else {
            return nil
        }
        let lower = base.lowercased()
        if lower.hasSuffix("/chat/completions") || lower.hasSuffix("/responses") {
            return URL(string: base)
        }
        return URL(string: "\(base)/\(config.endpoint.path)")
    }

    private static func parseProviderPayload(_ value: String) -> Any? {
        guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return jsonObject(from: value) ?? ["text": value]
    }

    private static func providerErrorMessage(_ data: Any?) -> String? {
        guard let record = data as? JSONRecord else { return nil }
        if let error = record["error"] as? JSONRecord, let message = error["message"] as? String { return message }
        if let error = record["error"] as? String { return error }
        if let detail = record["detail"] as? String { return detail }
        if let details = record["detail"] as? [Any] {
            let messages = details.compactMap { item -> String? in
                if let item = item as? String { return item }
                if let item = item as? JSONRecord {
                    return item["msg"] as? String ?? item["message"] as? String
                }
                return nil
            }
            if !messages.isEmpty { return messages.joined(separator: "; ") }
        }
        return record["message"] as? String
    }

    private static func extractText(from data: Any?) -> String {
        if let text = data as? String {
            return extractTextFromEventStream(text).isEmpty ? text : extractTextFromEventStream(text)
        }
        guard let record = data as? JSONRecord else { return "" }
        for key in ["output_text", "text", "content"] {
            if let text = record[key] as? String {
                let streamText = extractTextFromEventStream(text)
                return streamText.isEmpty ? text : streamText
            }
        }

        if let choices = record["choices"] as? [Any],
           let first = choices.compactMap({ $0 as? JSONRecord }).first,
           let message = first["message"] as? JSONRecord,
           let content = message["content"] as? String {
            return content
        }

        if let output = record["output"] as? [Any] {
            return output.compactMap { item -> String? in
                guard let item = item as? JSONRecord else { return nil }
                return extractTextFromOutputContent(item["content"])
            }.joined()
        }
        return ""
    }

    private static func extractTextFromOutputContent(_ content: Any?) -> String {
        guard let items = content as? [Any] else { return "" }
        return items.compactMap { item -> String? in
            guard let item = item as? JSONRecord else { return nil }
            return item["text"] as? String ?? item["output_text"] as? String
        }.joined()
    }

    private static let textKeys = ["text", "title", "name", "label", "content", "heading", "topic"]
    private static let childKeys = ["children", "childNodes", "subtopics", "subTopics", "topics", "nodes", "items", "outline", "subnodes", "subNodes"]

    private static func generatedNodeText(_ value: Any?) -> String {
        if let text = value as? String {
            return text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        guard let record = value as? JSONRecord else { return "" }
        for key in textKeys {
            if let text = record[key] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return text.trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
        return ""
    }

    private static func generatedNodeChildren(_ value: Any?) -> Any? {
        guard let record = value as? JSONRecord else { return nil }
        for key in childKeys {
            if let children = record[key] as? [Any] {
                return children
            }
        }
        return nil
    }

    private static func sanitizeGeneratedNodes(_ value: Any?, depth: Int = 1) -> [AiGeneratedNode] {
        guard depth <= 3 else { return [] }
        let items: [Any]
        if let array = value as? [Any] {
            items = array
        } else if let children = generatedNodeChildren(value) as? [Any] {
            items = children
        } else {
            return []
        }

        var result: [AiGeneratedNode] = []
        for item in items {
            let text = generatedNodeText(item)
            if text.isEmpty {
                result.append(contentsOf: sanitizeGeneratedNodes(generatedNodeChildren(item), depth: depth))
                continue
            }
            result.append(AiGeneratedNode(
                text: String(text.prefix(120)),
                children: sanitizeGeneratedNodes(generatedNodeChildren(item), depth: depth + 1)
            ))
            if result.count >= 8 { break }
        }
        return result
    }

    private static func jsonObject(from value: String) -> Any? {
        guard let data = value.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data, options: [])
    }

    private static func firstBalancedJSONSlice(_ value: String) -> String? {
        let chars = Array(value)
        for start in chars.indices {
            let first = chars[start]
            guard first == "{" || first == "[" else { continue }
            var stack: [Character] = [first == "{" ? "}" : "]"]
            var inString = false
            var escaped = false

            var index = chars.index(after: start)
            while index < chars.endIndex {
                let char = chars[index]
                if inString {
                    if escaped {
                        escaped = false
                    } else if char == "\\" {
                        escaped = true
                    } else if char == "\"" {
                        inString = false
                    }
                    index = chars.index(after: index)
                    continue
                }

                if char == "\"" {
                    inString = true
                } else if char == "{" {
                    stack.append("}")
                } else if char == "[" {
                    stack.append("]")
                } else if char == "}" || char == "]" {
                    guard stack.last == char else { break }
                    stack.removeLast()
                    if stack.isEmpty {
                        return String(chars[start...index])
                    }
                }
                index = chars.index(after: index)
            }
        }
        return nil
    }
}
