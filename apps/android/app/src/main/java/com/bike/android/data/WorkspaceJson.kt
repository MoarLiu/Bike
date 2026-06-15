package com.bike.android.data

import kotlinx.serialization.encodeToString
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject

data class WorkspacePayload(
    val workspace: Workspace,
    val raw: JsonObject,
    val recovery: WorkspaceRecovery? = null,
)

object WorkspaceJson {
    @OptIn(ExperimentalSerializationApi::class)
    val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = true
        prettyPrint = true
    }

    fun decode(source: String): WorkspacePayload {
        val raw = json.parseToJsonElement(source).jsonObject
        val workspace = json.decodeFromJsonElement<Workspace>(raw).normalized()
        return WorkspacePayload(
            workspace = workspace,
            raw = raw,
        )
    }

    fun encode(workspace: Workspace): String =
        json.encodeToString(workspace)

    fun encode(payload: WorkspacePayload): String {
        val encoded = json.encodeToJsonElement(payload.workspace).jsonObject
        val merged = mergeWorkspace(payload.raw, encoded)
        return json.encodeToString(JsonObject.serializer(), merged)
    }

    private fun mergeWorkspace(raw: JsonObject, encoded: JsonObject): JsonObject =
        JsonObject(
            raw.toMutableMap().apply {
                this["version"] = encoded.getValue("version")
                this["activeDocumentId"] = encoded.getValue("activeDocumentId")
                this["documents"] = mergeDocuments(
                    raw["documents"]?.jsonArrayOrNull(),
                    encoded.getValue("documents").jsonArray,
                )
            },
        )

    private fun mergeDocuments(raw: JsonArray?, encoded: JsonArray): JsonArray {
        val rawById = raw.orEmpty()
            .mapNotNull { it.jsonObjectOrNull() }
            .associateBy { it.stringValue("id") }

        return JsonArray(
            encoded.map { document ->
                val encodedDocument = document.jsonObject
                mergeDocument(rawById[encodedDocument.stringValue("id")], encodedDocument)
            },
        )
    }

    private fun mergeDocument(raw: JsonObject?, encoded: JsonObject): JsonObject =
        JsonObject(
            (raw?.toMutableMap() ?: mutableMapOf()).apply {
                putKnown(encoded, DOCUMENT_KEYS)
                this["nodes"] = mergeNodes(
                    raw?.get("nodes")?.jsonArrayOrNull(),
                    encoded.getValue("nodes").jsonArray,
                )
            },
        )

    private fun mergeNodes(raw: JsonArray?, encoded: JsonArray): JsonArray {
        val rawById = raw.orEmpty()
            .mapNotNull { it.jsonObjectOrNull() }
            .associateBy { it.stringValue("id") }

        return JsonArray(
            encoded.map { node ->
                val encodedNode = node.jsonObject
                mergeNode(rawById[encodedNode.stringValue("id")], encodedNode)
            },
        )
    }

    private fun mergeNode(raw: JsonObject?, encoded: JsonObject): JsonObject =
        JsonObject(
            (raw?.toMutableMap() ?: mutableMapOf()).apply {
                putKnown(encoded, NODE_KEYS)
                this["children"] = mergeNodes(
                    raw?.get("children")?.jsonArrayOrNull(),
                    encoded.getValue("children").jsonArray,
                )
            },
        )

    private fun MutableMap<String, JsonElement>.putKnown(
        encoded: JsonObject,
        keys: Set<String>,
    ) {
        keys.forEach { key ->
            if (encoded.containsKey(key)) {
                this[key] = encoded.getValue(key)
            } else {
                remove(key)
            }
        }
    }

    private fun JsonElement.jsonObjectOrNull(): JsonObject? =
        this as? JsonObject

    private fun JsonElement.jsonArrayOrNull(): JsonArray? =
        this as? JsonArray

    private fun JsonObject.stringValue(key: String): String =
        (this[key] as? JsonPrimitive)?.content.orEmpty()

    private fun Workspace.normalized(): Workspace {
        require(documents.isNotEmpty()) { "工作区至少需要一篇文档" }
        return if (documents.any { it.id == activeDocumentId }) {
            this
        } else {
            copy(activeDocumentId = documents.first().id)
        }
    }

    private val DOCUMENT_KEYS = setOf(
        "id",
        "title",
        "createdAt",
        "updatedAt",
        "markdownSource",
        "markdownUpdatedAt",
        "isShortcut",
    )

    private val NODE_KEYS = setOf(
        "id",
        "text",
        "note",
        "checked",
        "collapsed",
        "color",
        "headingLevel",
        "bold",
        "italic",
        "underline",
        "strike",
        "highlight",
        "icon",
        "imageName",
        "imageAlt",
        "table",
        "codeBlock",
        "codeLanguage",
        "isTodo",
    )
}
