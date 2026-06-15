package com.bike.android.ai

import com.bike.android.data.OutlineNode
import com.bike.android.data.outlineNode
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import java.net.HttpURLConnection
import java.net.URL

class AiService(
    private val json: Json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
    },
) {
    suspend fun generateChildren(
        settings: AiSettings,
        node: OutlineNode,
        documentTitle: String = "",
    ): List<AiGeneratedNode> {
        ensureConfigured(settings)
        val result = runNodeAction(
            settings = settings,
            action = AiNodeAction.Generate,
            context = AiActionContext(
                documentTitle = documentTitle,
                topicText = node.text,
                note = node.note,
                existingChildren = node.children.map { it.text },
            ),
        )
        return result.children.orEmpty()
    }

    suspend fun polishNodeText(
        settings: AiSettings,
        node: OutlineNode,
        documentTitle: String = "",
    ): String {
        ensureConfigured(settings)
        val result = runNodeAction(
            settings = settings,
            action = AiNodeAction.Polish,
            context = AiActionContext(
                documentTitle = documentTitle,
                topicText = node.text,
                note = node.note,
                existingChildren = node.children.map { it.text },
            ),
        )
        return result.text.orEmpty()
    }

    private suspend fun runNodeAction(
        settings: AiSettings,
        action: AiNodeAction,
        context: AiActionContext,
    ): AiActionResult =
        withContext(Dispatchers.IO) {
            val messages = listOf(
                AiMessage(role = "system", content = SYSTEM_PROMPT),
                AiMessage(role = "user", content = buildPrompt(action, context)),
            )
            val payload = invokeProvider(
                settings = settings,
                body = requestBodyFor(settings, messages),
            )
            val text = extractTextFromResponse(payload, json)
            if (text.isBlank()) throw IllegalStateException("AI 返回内容为空")
            normalizeActionResult(action, parseJsonText(text, json))
        }

    private fun ensureConfigured(settings: AiSettings) {
        if (!settings.isConfigured) {
            throw IllegalStateException("请先配置 AI base URL、API key 和模型")
        }
    }

    private fun requestBodyFor(
        settings: AiSettings,
        messages: List<AiMessage>,
    ): JsonObject =
        if (settings.endpoint == AiEndpoint.ChatCompletions) {
            buildJsonObject {
                put("model", settings.model)
                put("temperature", 0.55)
                put(
                    "messages",
                    buildJsonArray {
                        messages.forEach { message ->
                            add(
                                buildJsonObject {
                                    put("role", message.role)
                                    put("content", message.content)
                                },
                            )
                        }
                    },
                )
            }
        } else {
            val userPrompt = messages
                .filterNot { it.role == "system" }
                .joinToString("\n\n") { it.content }
            buildJsonObject {
                put("model", settings.model)
                put("instructions", messages.firstOrNull { it.role == "system" }?.content.orEmpty())
                put(
                    "input",
                    buildJsonArray {
                        add(
                            buildJsonObject {
                                put("role", "user")
                                put(
                                    "content",
                                    buildJsonArray {
                                        add(
                                            buildJsonObject {
                                                put("type", "input_text")
                                                put("text", userPrompt)
                                            },
                                        )
                                    },
                                )
                            },
                        )
                    },
                )
            }
        }

    private fun invokeProvider(
        settings: AiSettings,
        body: JsonObject,
    ): JsonElement? =
        run {
            var connection: HttpURLConnection? = null
            try {
                connection = (URL(aiEndpointUrl(settings.baseUrl, settings.endpoint)).openConnection() as HttpURLConnection)
                connection.requestMethod = "POST"
                connection.connectTimeout = AI_CONNECT_TIMEOUT_MS
                connection.readTimeout = AI_READ_TIMEOUT_MS
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.setRequestProperty("Authorization", "Bearer ${settings.apiKey}")

                connection.outputStream.use { output ->
                    output.write(body.toString().toByteArray(Charsets.UTF_8))
                }

                val status = connection.responseCode
                val response = if (status in 200..299) {
                    connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
                } else {
                    connection.errorStream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
                }
                val payload = parseProviderPayload(response, json)
                val contentType = connection.contentType.orEmpty()

                if (status in 200..299 && contentType.startsWith("text/html", ignoreCase = true)) {
                    throw AiResponseFormatException(
                        preview = responsePreview(response),
                        message = "AI 端点返回了 HTML 页面，请检查 API baseurl 和协议端点是否匹配",
                    )
                }
                if (status !in 200..299) {
                    throw AiHttpException(
                        statusCode = status,
                        providerMessage = providerErrorMessage(payload)
                            ?: parseProviderErrorMessage(response, json),
                    )
                }

                payload ?: JsonObject(emptyMap())
            } finally {
                connection?.disconnect()
            }
        }

    private companion object {
        const val AI_CONNECT_TIMEOUT_MS = 30_000
        const val AI_READ_TIMEOUT_MS = 60_000
    }
}

private val SYSTEM_PROMPT = listOf(
    "你是 Bike 的大纲写作助手。",
    "必须只输出 JSON，不要输出 Markdown 代码块、解释或多余文字。",
    "内容使用中文，短句优先，适合作为大纲主题。",
).joinToString("\n")

private val GENERATION_INSTRUCTIONS = listOf(
    "任务：基于当前主题生成子主题。",
    "输出 JSON 结构：{\"children\":[{\"text\":\"子主题\",\"children\":[{\"text\":\"更细子主题\"}]}]}。",
    "最多生成 3 层子节点。每个节点 text 不超过 36 个中文字符。",
    "避免重复已有子主题，不要生成空节点。",
).joinToString("\n")

private val POLISH_INSTRUCTIONS = listOf(
    "任务：润色并重写当前主题文字。",
    "输出 JSON 结构：{\"text\":\"润色后的主题\"}。",
    "保留原意，让表达更清晰、准确、简洁。只返回一个主题文本。",
).joinToString("\n")

internal enum class AiNodeAction {
    Generate,
    Polish,
}

internal data class AiActionContext(
    val documentTitle: String,
    val topicText: String,
    val note: String,
    val existingChildren: List<String>,
)

internal data class AiMessage(
    val role: String,
    val content: String,
)

data class AiGeneratedNode(
    val text: String,
    val children: List<AiGeneratedNode> = emptyList(),
)

internal data class AiActionResult(
    val text: String? = null,
    val children: List<AiGeneratedNode>? = null,
)

private fun buildPrompt(
    action: AiNodeAction,
    context: AiActionContext,
): String {
    val childList = context.existingChildren
        .filter { it.isNotBlank() }
        .takeIf { it.isNotEmpty() }
        ?.joinToString("\n") { "- $it" }
        ?: "无"

    return listOf(
        if (action == AiNodeAction.Generate) {
            GENERATION_INSTRUCTIONS
        } else {
            POLISH_INSTRUCTIONS
        },
        "",
        "文档标题：${context.documentTitle.ifBlank { "未命名文档" }}",
        "当前主题：${context.topicText.ifBlank { "未命名主题" }}",
        context.note.takeIf { it.isNotBlank() }?.let { "主题备注：$it" }.orEmpty(),
        "已有子主题：\n$childList",
    ).filter { it.isNotBlank() }.joinToString("\n")
}

internal fun aiEndpointUrl(
    baseUrl: String,
    endpoint: AiEndpoint,
): String {
    val normalized = baseUrl.trim().trimEnd('/')
    require(normalized.startsWith("http://") || normalized.startsWith("https://")) {
        "API baseurl 需要以 http:// 或 https:// 开头"
    }

    if (normalized.endsWith("/chat/completions", ignoreCase = true) ||
        normalized.endsWith("/responses", ignoreCase = true)
    ) {
        return normalized
    }

    val url = URL(normalized)
    val path = url.path.trim('/')
    return if (url.host.equals("api.openai.com", ignoreCase = true) && path.isBlank()) {
        "$normalized/v1/${endpoint.path}"
    } else {
        "$normalized/${endpoint.path}"
    }
}

internal fun chatCompletionsUrl(baseUrl: String): String =
    aiEndpointUrl(baseUrl, AiEndpoint.ChatCompletions)

class AiHttpException(
    val statusCode: Int,
    val providerMessage: String?,
) : IllegalStateException(
    providerMessage?.takeIf { it.isNotBlank() }?.let { "AI 请求失败：HTTP $statusCode，$it" }
        ?: "AI 请求失败：HTTP $statusCode",
)

class AiResponseFormatException(
    val preview: String,
    message: String = if (preview.isBlank()) {
        "AI 返回内容格式不正确"
    } else {
        "AI 返回内容格式不正确：$preview"
    },
) : IllegalStateException(message)

internal fun parseProviderPayload(
    response: String,
    json: Json = Json { ignoreUnknownKeys = true },
): JsonElement? {
    val trimmed = response.trim()
    if (trimmed.isBlank()) return null
    return runCatching { json.parseToJsonElement(trimmed) }
        .getOrElse {
            buildJsonObject { put("text", response) }
        }
}

internal fun providerErrorMessage(data: JsonElement?): String? {
    val record = data as? JsonObject ?: return null
    val error = record["error"]
    if (error is JsonObject) {
        error.stringValue("message")?.let { return it }
    }
    if (error is JsonPrimitive) {
        error.contentOrNull?.trim()?.takeIf { it.isNotBlank() }?.let { return it }
    }
    record.stringValue("detail")?.let { return it }

    val detail = record["detail"]
    if (detail is JsonArray) {
        val details = detail.mapNotNull { item ->
            when (item) {
                is JsonPrimitive -> item.contentOrNull
                is JsonObject -> item.stringValue("msg") ?: item.stringValue("message")
                else -> null
            }?.trim()?.takeIf { it.isNotBlank() }
        }
        if (details.isNotEmpty()) return details.joinToString("; ")
    }

    return record.stringValue("message")
}

internal fun parseProviderErrorMessage(
    response: String,
    json: Json = Json { ignoreUnknownKeys = true },
): String? {
    val trimmed = response.trim()
    if (trimmed.isBlank()) return null

    providerErrorMessage(parseProviderPayload(trimmed, json))?.let { return it }

    return if (trimmed.startsWith("<")) {
        "服务器返回了网页错误"
    } else {
        trimmed.lineSequence()
            .firstOrNull { it.isNotBlank() }
            ?.take(PROVIDER_ERROR_MESSAGE_LIMIT)
    }
}

internal fun extractAssistantContent(
    response: String,
    json: Json = Json { ignoreUnknownKeys = true },
): String =
    extractTextFromResponse(parseProviderPayload(response, json), json)
        .trim()
        .takeIf { it.isNotBlank() }
        ?: throw AiResponseFormatException(responsePreview(response))

internal fun extractTextFromResponse(
    data: JsonElement?,
    json: Json = Json { ignoreUnknownKeys = true },
): String {
    if (data == null || data is JsonNull) return ""
    if (data is JsonPrimitive) {
        val text = data.contentOrNull.orEmpty()
        return extractTextFromEventStream(text, json).ifBlank { text }
    }
    val record = data as? JsonObject ?: return ""

    listOf("output_text", "text", "content").forEach { key ->
        val directText = if (key == "content") {
            record[key]?.contentTextOrNull()
        } else {
            record[key]?.stringContentOrNull()
        }
        if (!directText.isNullOrBlank()) {
            return extractTextFromEventStream(directText, json).ifBlank { directText }
        }
    }

    val choices = record["choices"] as? JsonArray
    val firstChoice = choices?.firstOrNull { it is JsonObject } as? JsonObject
    if (firstChoice != null) {
        val message = firstChoice["message"] as? JsonObject
        message?.get("content")?.contentTextOrNull()?.let { return it }

        val delta = firstChoice["delta"] as? JsonObject
        delta?.get("content")?.contentTextOrNull()?.let { return it }

        firstChoice["text"]?.stringContentOrNull()?.let { return it }
    }

    val output = record["output"] as? JsonArray
    if (output != null) {
        val outputText = output.joinToString("") { item ->
            val outputItem = item as? JsonObject
            extractTextFromOutputContent(outputItem?.get("content"))
        }
        if (outputText.isNotBlank()) return outputText
    }

    return ""
}

internal fun extractTextFromEventStream(
    value: String,
    json: Json = Json { ignoreUnknownKeys = true },
): String {
    if (!Regex("^\\s*(event|data):", RegexOption.MULTILINE).containsMatchIn(value)) return ""

    val deltas = mutableListOf<String>()
    val completedTexts = mutableListOf<String>()

    value.lineSequence().forEach { rawLine ->
        val line = rawLine.trimStart()
        if (!line.startsWith("data:")) return@forEach
        val payload = line.removePrefix("data:").trim()
        if (payload.isBlank() || payload == "[DONE]") return@forEach

        val eventData = runCatching { json.parseToJsonElement(payload) as? JsonObject }
            .getOrNull()
            ?: return@forEach

        if (eventData.stringValue("type") == "response.output_text.delta") {
            eventData.stringValue("delta")?.let { deltas += it }
            return@forEach
        }

        if (eventData.stringValue("type") == "response.output_text.done") {
            eventData.stringValue("text")?.let { completedTexts += it }
            return@forEach
        }

        val part = eventData["part"] as? JsonObject
        if (part?.stringValue("type") == "output_text") {
            part.stringValue("text")?.takeIf { it.isNotBlank() }?.let { completedTexts += it }
            return@forEach
        }

        val item = eventData["item"] as? JsonObject
        val itemText = extractTextFromOutputContent(item?.get("content"))
        if (itemText.isNotBlank()) {
            completedTexts += itemText
            return@forEach
        }

        val response = eventData["response"] as? JsonObject
        val responseOutput = response?.get("output") as? JsonArray
        val responseText = responseOutput?.joinToString("") { outputItem ->
            val outputRecord = outputItem as? JsonObject
            extractTextFromOutputContent(outputRecord?.get("content"))
        }.orEmpty()
        if (responseText.isNotBlank()) completedTexts += responseText
    }

    return deltas.joinToString("").ifBlank { completedTexts.joinToString("") }
}

private fun extractTextFromOutputContent(content: JsonElement?): String {
    val items = content as? JsonArray ?: return ""
    return items.joinToString("") { item ->
        val record = item as? JsonObject ?: return@joinToString ""
        record.stringValue("text") ?: record.stringValue("output_text") ?: ""
    }
}

internal fun parseJsonText(
    value: String,
    json: Json = Json { ignoreUnknownKeys = true },
): JsonElement {
    val trimmed = value.trim()
        .replace(Regex("^```(?:json)?\\s*", RegexOption.IGNORE_CASE), "")
        .replace(Regex("\\s*```$", RegexOption.IGNORE_CASE), "")
    return runCatching { json.parseToJsonElement(trimmed) }
        .getOrElse {
            val slice = firstBalancedJsonSlice(trimmed)
            if (slice != null) {
                return runCatching { json.parseToJsonElement(slice) }
                    .getOrElse { throw AiResponseFormatException(responsePreview(trimmed), "AI 返回内容不是有效 JSON") }
            }
            throw AiResponseFormatException(responsePreview(trimmed), "AI 返回内容不是有效 JSON")
        }
}

internal fun firstBalancedJsonSlice(value: String): String? {
    for (start in value.indices) {
        val firstChar = value[start]
        if (firstChar != '{' && firstChar != '[') continue

        val stack = ArrayDeque<Char>()
        stack.addLast(if (firstChar == '{') '}' else ']')
        var inString = false
        var escaped = false

        for (index in start + 1 until value.length) {
            val char = value[index]

            if (inString) {
                when {
                    escaped -> escaped = false
                    char == '\\' -> escaped = true
                    char == '"' -> inString = false
                }
                continue
            }

            when (char) {
                '"' -> inString = true
                '{' -> stack.addLast('}')
                '[' -> stack.addLast(']')
                '}', ']' -> {
                    if (stack.lastOrNull() != char) break
                    stack.removeLast()
                    if (stack.isEmpty()) return value.slice(start..index)
                }
            }
        }
    }
    return null
}

internal fun parseGeneratedChildren(content: String): List<String> =
    parseGeneratedNodes(content).map { it.text }.distinct()

internal fun parseGeneratedNodes(content: String): List<AiGeneratedNode> {
    val trimmed = content.stripCodeFence()
    val parsed = runCatching { parseJsonText(trimmed) }.getOrNull()
    if (parsed != null) {
        return normalizeActionResult(AiNodeAction.Generate, parsed).children.orEmpty()
    }
    return parseLinesAsChildren(trimmed).map { AiGeneratedNode(text = it) }
}

internal fun parsePolishedText(content: String): String {
    val trimmed = content.stripCodeFence()
    val parsed = runCatching { parseJsonText(trimmed) }.getOrNull()
    val fromJson = parsed?.let { generatedNodeText(it) }
    return (fromJson ?: trimmed)
        .lineSequence()
        .firstOrNull { it.isNotBlank() }
        ?.trim()
        .orEmpty()
}

internal fun normalizeActionResult(
    action: AiNodeAction,
    parsed: JsonElement,
): AiActionResult {
    if (parsed is JsonArray) {
        return AiActionResult(children = sanitizeGeneratedNodes(parsed))
    }
    val record = parsed as? JsonObject
        ?: throw IllegalStateException("AI 返回 JSON 结构不正确")

    if (action == AiNodeAction.Polish) {
        val text = generatedNodeText(record)
        if (text.isBlank()) throw IllegalStateException("AI 没有返回润色文本")
        return AiActionResult(text = text)
    }

    return AiActionResult(children = sanitizeGeneratedNodes(record))
}

internal fun generatedNodesToOutlineNodes(
    nodes: List<AiGeneratedNode>,
    depth: Int = 1,
): List<OutlineNode> {
    if (nodes.isEmpty() || depth > GENERATED_NODE_MAX_DEPTH) return emptyList()
    return nodes.mapNotNull { item ->
        val text = item.text.trim()
        if (text.isBlank()) {
            null
        } else {
            outlineNode(
                text = text,
                children = generatedNodesToOutlineNodes(item.children, depth + 1),
            )
        }
    }
}

private fun sanitizeGeneratedNodes(
    value: JsonElement?,
    depth: Int = 1,
): List<AiGeneratedNode> {
    if (depth > GENERATED_NODE_MAX_DEPTH) return emptyList()

    val items = when (value) {
        is JsonArray -> value
        is JsonObject -> generatedNodeChildren(value)
        else -> null
    } ?: return emptyList()

    return items.flatMap { item ->
        val text = generatedNodeText(item)
        if (text.isBlank()) {
            sanitizeGeneratedNodes(generatedNodeChildren(item), depth)
        } else {
            listOf(
                AiGeneratedNode(
                    text = text.take(GENERATED_NODE_TEXT_LIMIT),
                    children = sanitizeGeneratedNodes(generatedNodeChildren(item), depth + 1),
                ),
            )
        }
    }.take(GENERATED_NODE_LIMIT)
}

private fun generatedNodeText(value: JsonElement?): String =
    when (value) {
        is JsonPrimitive -> value.contentOrNull.orEmpty().trim()
        is JsonObject -> GENERATED_TEXT_KEYS
            .firstNotNullOfOrNull { key -> value.stringValue(key) }
            .orEmpty()
            .trim()
        else -> ""
    }

private fun generatedNodeChildren(value: JsonElement?): JsonArray? {
    val record = value as? JsonObject ?: return null
    return GENERATED_CHILDREN_KEYS.firstNotNullOfOrNull { key ->
        record[key] as? JsonArray
    }
}

private fun JsonObject.stringValue(key: String): String? =
    (this[key] as? JsonPrimitive)
        ?.contentOrNull
        ?.trim()
        ?.takeIf { it.isNotBlank() }

private fun JsonElement.stringContentOrNull(): String? =
    (this as? JsonPrimitive)
        ?.contentOrNull
        ?.trim()
        ?.takeIf { it.isNotBlank() }

private fun JsonElement.contentTextOrNull(): String? =
    when (this) {
        is JsonPrimitive -> contentOrNull?.trim()?.takeIf { it.isNotBlank() }
        is JsonArray -> mapNotNull { element ->
            when (element) {
                is JsonPrimitive -> element.contentOrNull
                is JsonObject -> element.stringValue("text") ?: element.stringValue("output_text")
                else -> null
            }?.trim()?.takeIf { it.isNotBlank() }
        }.joinToString("\n").takeIf { it.isNotBlank() }
        else -> null
    }

private fun responsePreview(response: String): String =
    response
        .lineSequence()
        .joinToString(" ") { it.trim() }
        .replace(Regex("\\s+"), " ")
        .take(120)

private fun parseLinesAsChildren(content: String): List<String> =
    content.lineSequence()
        .map { line ->
            line.trim()
                .removePrefix("-")
                .removePrefix("*")
                .replace(Regex("^\\d+[.)]\\s*"), "")
                .trim()
        }
        .filter { it.isNotBlank() }
        .toList()

private fun String.stripCodeFence(): String {
    val trimmed = trim()
    if (!trimmed.startsWith("```")) return trimmed

    val lines = trimmed.lines()
    val firstLine = lines.firstOrNull()?.trim().orEmpty()
    val lastLine = lines.lastOrNull()?.trim().orEmpty()
    return if (firstLine.startsWith("```") && lastLine == "```" && lines.size >= 2) {
        lines.drop(1).dropLast(1).joinToString("\n").trim()
    } else {
        trimmed
    }
}

private const val PROVIDER_ERROR_MESSAGE_LIMIT = 100
private const val GENERATED_NODE_LIMIT = 8
private const val GENERATED_NODE_TEXT_LIMIT = 120
private const val GENERATED_NODE_MAX_DEPTH = 3

private val GENERATED_TEXT_KEYS = listOf(
    "text",
    "title",
    "name",
    "label",
    "content",
    "heading",
    "topic",
)

private val GENERATED_CHILDREN_KEYS = listOf(
    "children",
    "childNodes",
    "subtopics",
    "subTopics",
    "topics",
    "nodes",
    "items",
    "outline",
    "subnodes",
    "subNodes",
)
