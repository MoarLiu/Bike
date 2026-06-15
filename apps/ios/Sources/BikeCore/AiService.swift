import Foundation

public enum AiEndpoint: String, Codable, CaseIterable, Identifiable, Sendable {
    case responses
    case chatCompletions = "chat_completions"

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .responses: "Responses"
        case .chatCompletions: "Chat/completions"
        }
    }

    public var path: String {
        switch self {
        case .responses: "responses"
        case .chatCompletions: "chat/completions"
        }
    }
}

public struct AiSettings: Codable, Equatable, Sendable {
    public var endpoint: AiEndpoint
    public var baseUrl: String
    public var apiKey: String
    public var model: String

    public init(
        endpoint: AiEndpoint = .responses,
        baseUrl: String = "https://api.openai.com/v1",
        apiKey: String = "",
        model: String = "gpt-4.1-mini"
    ) {
        self.endpoint = endpoint
        self.baseUrl = baseUrl
        self.apiKey = apiKey
        self.model = model
    }

    public var isConfigured: Bool {
        !baseUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            !apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            !model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public func normalized() -> AiSettings {
        AiSettings(
            endpoint: endpoint,
            baseUrl: baseUrl
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .replacingOccurrences(of: #"/+$"#, with: "", options: .regularExpression),
            apiKey: apiKey.trimmingCharacters(in: .whitespacesAndNewlines),
            model: model.trimmingCharacters(in: .whitespacesAndNewlines)
        )
    }
}

public enum AiAction: Sendable {
    case generate
    case polish
}

public struct AiActionContext: Sendable {
    public var documentTitle: String
    public var topicText: String
    public var note: String
    public var existingChildren: [String]

    public init(documentTitle: String, topicText: String, note: String, existingChildren: [String]) {
        self.documentTitle = documentTitle
        self.topicText = topicText
        self.note = note
        self.existingChildren = existingChildren
    }
}

public struct AiGeneratedNode: Equatable, Sendable {
    public var text: String
    public var children: [AiGeneratedNode]

    public init(text: String, children: [AiGeneratedNode] = []) {
        self.text = text
        self.children = children
    }
}

public struct AiActionResult: Equatable, Sendable {
    public var text: String?
    public var children: [AiGeneratedNode]?
}

public enum AiServiceError: LocalizedError, Equatable {
    case invalidConfig(String)
    case invalidEndpoint
    case emptyResponse
    case invalidJSON
    case invalidStructure
    case missingPolishText
    case htmlEndpoint
    case requestFailed(String)

    public var errorDescription: String? {
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

public enum AiService {
    private typealias JSONRecord = [String: Any]

    public static func generatedNodesToOutlineNodes(_ nodes: [AiGeneratedNode], depth: Int = 1) -> [OutlineNode] {
        guard !nodes.isEmpty, depth <= 3 else { return [] }
        return nodes.compactMap { item in
            let text = item.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            return outlineNode(text, children: generatedNodesToOutlineNodes(item.children, depth: depth + 1))
        }
    }

    public static func run(
        settings: AiSettings,
        action: AiAction,
        context: AiActionContext
    ) async throws -> AiActionResult {
        let normalized = settings.normalized()
        if !normalized.isConfigured {
            throw AiServiceError.invalidConfig("请先配置 AI base URL、API key 和模型")
        }

        let messages: [JSONRecord] = [
            ["role": "system", "content": systemPrompt],
            ["role": "user", "content": prompt(action: action, context: context)]
        ]
        let body = requestBody(settings: normalized, messages: messages)
        let payload = try await invoke(settings: normalized, body: body)
        let text = extractText(from: payload)
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw AiServiceError.emptyResponse
        }
        return try normalizeActionResult(action: action, parsed: parseJSONText(text))
    }

    public static func normalizeActionResult(action: AiAction, parsed: Any) throws -> AiActionResult {
        if let array = parsed as? [Any] {
            return AiActionResult(children: sanitizeGeneratedNodes(array))
        }
        guard let record = parsed as? JSONRecord else {
            throw AiServiceError.invalidStructure
        }
        if action == .polish {
            let text = generatedNodeText(record)
            guard !text.isEmpty else { throw AiServiceError.missingPolishText }
            return AiActionResult(text: text, children: nil)
        }
        return AiActionResult(text: nil, children: sanitizeGeneratedNodes(record))
    }

    public static func parseJSONText(_ value: String) throws -> Any {
        var trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        trimmed = trimmed.replacingOccurrences(
            of: #"^```(?:json)?\s*"#,
            with: "",
            options: [.regularExpression, .caseInsensitive]
        )
        trimmed = trimmed.replacingOccurrences(
            of: #"\s*```$"#,
            with: "",
            options: [.regularExpression, .caseInsensitive]
        )

        if let parsed = jsonObject(from: trimmed) {
            return parsed
        }
        if let slice = firstBalancedJSONSlice(trimmed), let parsed = jsonObject(from: slice) {
            return parsed
        }
        throw AiServiceError.invalidJSON
    }

    public static func extractText(from data: Any?) -> String {
        if let text = data as? String {
            let streamText = extractTextFromEventStream(text)
            return streamText.isEmpty ? text : streamText
        }
        guard let record = data as? JSONRecord else { return "" }

        for key in ["output_text", "text", "content"] {
            if let text = record[key] as? String {
                let streamText = extractTextFromEventStream(text)
                return streamText.isEmpty ? text : streamText
            }
            let contentText = extractTextFromOutputContent(record[key])
            if key == "content", !contentText.isEmpty {
                return contentText
            }
        }

        if let choices = record["choices"] as? [Any],
           let first = choices.compactMap({ $0 as? JSONRecord }).first {
            if let message = first["message"] as? JSONRecord {
                let content = extractTextFromOutputContent(message["content"], allowString: true)
                if !content.isEmpty {
                    return content
                }
            }
            if let delta = first["delta"] as? JSONRecord {
                let content = extractTextFromOutputContent(delta["content"], allowString: true)
                if !content.isEmpty {
                    return content
                }
            }
            if let text = first["text"] as? String {
                return text
            }
        }

        if let output = record["output"] as? [Any] {
            return output.compactMap { item -> String? in
                guard let item = item as? JSONRecord else { return nil }
                return extractTextFromOutputContent(item["content"])
            }.joined()
        }
        return ""
    }

    public static func extractTextFromEventStream(_ value: String) -> String {
        guard value.range(of: #"(?m)^\s*(event|data):"#, options: .regularExpression) != nil else {
            return ""
        }

        var deltas: [String] = []
        var completedTexts: [String] = []
        for rawLine in value.components(separatedBy: .newlines) {
            let line = rawLine.trimmingCharacters(in: CharacterSet(charactersIn: " \t"))
            guard line.hasPrefix("data:") else { continue }
            let payload = String(line.dropFirst(5)).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !payload.isEmpty,
                  payload != "[DONE]",
                  let eventData = jsonObject(from: payload) as? JSONRecord else {
                continue
            }
            if eventData["type"] as? String == "response.output_text.delta",
               let delta = eventData["delta"] as? String {
                deltas.append(delta)
                continue
            }
            if eventData["type"] as? String == "response.output_text.done",
               let text = eventData["text"] as? String {
                completedTexts.append(text)
                continue
            }
            if let part = eventData["part"] as? JSONRecord,
               part["type"] as? String == "output_text",
               let text = part["text"] as? String,
               !text.isEmpty {
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
            if let response = eventData["response"] as? JSONRecord,
               let output = response["output"] as? [Any] {
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

    public static func endpointURL(settings: AiSettings) -> URL? {
        let normalized = settings.baseUrl
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: #"/+$"#, with: "", options: .regularExpression)
        guard normalized.lowercased().hasPrefix("http://") || normalized.lowercased().hasPrefix("https://") else {
            return nil
        }

        let lower = normalized.lowercased()
        if lower.hasSuffix("/chat/completions") || lower.hasSuffix("/responses") {
            return URL(string: normalized)
        }
        if let url = URL(string: normalized),
           url.host?.lowercased() == "api.openai.com",
           url.path == "" {
            return URL(string: "\(normalized)/v1/\(settings.endpoint.path)")
        }
        return URL(string: "\(normalized)/\(settings.endpoint.path)")
    }

    private static func invoke(settings: AiSettings, body: JSONRecord) async throws -> Any {
        guard let url = endpointURL(settings: settings) else { throw AiServiceError.invalidEndpoint }
        var request = URLRequest(url: url, timeoutInterval: 60)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(settings.apiKey)", forHTTPHeaderField: "Authorization")
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

    private static func requestBody(settings: AiSettings, messages: [JSONRecord]) -> JSONRecord {
        if settings.endpoint == .chatCompletions {
            return [
                "model": settings.model,
                "temperature": 0.55,
                "messages": messages
            ]
        }

        let userPrompt = messages
            .filter { $0["role"] as? String != "system" }
            .compactMap { $0["content"] as? String }
            .joined(separator: "\n\n")
        return [
            "model": settings.model,
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

    private static func prompt(action: AiAction, context: AiActionContext) -> String {
        let childList = context.existingChildren.isEmpty
            ? "无"
            : context.existingChildren.map { "- \($0)" }.joined(separator: "\n")
        return [
            action == .generate ? generationInstructions : polishInstructions,
            "",
            "文档标题：\(context.documentTitle.isEmpty ? "未命名文档" : context.documentTitle)",
            "当前主题：\(context.topicText.isEmpty ? "未命名主题" : context.topicText)",
            context.note.isEmpty ? "" : "主题备注：\(context.note)",
            "已有子主题：\n\(childList)"
        ].filter { !$0.isEmpty }.joined(separator: "\n")
    }

    private static func parseProviderPayload(_ value: String) -> Any? {
        guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return jsonObject(from: value) ?? ["text": value]
    }

    private static func providerErrorMessage(_ data: Any?) -> String? {
        guard let record = data as? JSONRecord else { return nil }
        if let error = record["error"] as? JSONRecord, let message = error["message"] as? String {
            return message
        }
        if let error = record["error"] as? String {
            return error
        }
        if let detail = record["detail"] as? String {
            return detail
        }
        if let details = record["detail"] as? [Any] {
            let messages = details.compactMap { item -> String? in
                if let item = item as? String {
                    return item
                }
                if let item = item as? JSONRecord {
                    return item["msg"] as? String ?? item["message"] as? String
                }
                return nil
            }
            if !messages.isEmpty {
                return messages.joined(separator: "; ")
            }
        }
        return record["message"] as? String
    }

    private static func extractTextFromOutputContent(_ content: Any?, allowString: Bool = false) -> String {
        if allowString, let text = content as? String {
            return text
        }
        guard let items = content as? [Any] else { return "" }
        return items.compactMap { item -> String? in
            if let text = item as? String {
                return text
            }
            guard let item = item as? JSONRecord else { return nil }
            return item["text"] as? String ?? item["output_text"] as? String
        }.joined()
    }

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

    private static func firstBalancedJSONSlice(_ value: String) -> String? {
        let chars = Array(value)
        for start in chars.indices {
            let first = chars[start]
            guard first == "{" || first == "[" else { continue }
            var stack: [Character] = [first == "{" ? "}" : "]"]
            var inString = false
            var escaped = false
            var index = start + 1
            while index < chars.count {
                let char = chars[index]
                if inString {
                    if escaped {
                        escaped = false
                    } else if char == "\\" {
                        escaped = true
                    } else if char == "\"" {
                        inString = false
                    }
                    index += 1
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
                index += 1
            }
        }
        return nil
    }

    private static func jsonObject(from value: String) -> Any? {
        guard let data = value.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data, options: [])
    }

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

    private static let textKeys = ["text", "title", "name", "label", "content", "heading", "topic"]
    private static let childKeys = [
        "children",
        "childNodes",
        "subtopics",
        "subTopics",
        "topics",
        "nodes",
        "items",
        "outline",
        "subnodes",
        "subNodes"
    ]
}
