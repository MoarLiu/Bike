package com.bike.android.data

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkspaceJsonTest {
    @Test
    fun decodesDesktopWorkspaceV1WithRichNodeFields() {
        val payload = WorkspaceJson.decode(sampleWorkspaceJson)

        assertEquals(1, payload.workspace.version)
        assertEquals("doc_product", payload.workspace.activeDocumentId)
        assertEquals(1, payload.workspace.documents.size)

        val document = payload.workspace.documents.first()
        assertEquals("Bike Android MVP", document.title)
        assertTrue(document.markdownSource!!.contains("# Bike Android"))

        val node = document.nodes.first()
        assertEquals("移动端定位", node.text)
        assertEquals(2, node.headingLevel)
        assertEquals(true, node.bold)
        assertEquals("kotlin", node.codeLanguage)
        assertEquals(listOf("场景", "价值"), node.table!!.first())
        assertEquals("快速捕捉", node.children.first().text)
    }

    @Test
    fun preservesUnknownDesktopFieldsDuringRoundTrip() {
        val payload = WorkspaceJson.decode(sampleWorkspaceJson)
        val encoded = WorkspaceJson.encode(payload)
        val reparsed = WorkspaceJson.json.parseToJsonElement(encoded).jsonObject

        assertEquals(
            "top-level",
            reparsed.getObject("androidUnknown").getString("scope"),
        )

        val document = reparsed.getArray("documents").first().jsonObject
        assertEquals("desktop-only", document.getString("futureDocumentField"))

        val node = document.getArray("nodes").first().jsonObject
        assertEquals("keep-me", node.getString("futureNodeField"))
        assertEquals(true, node.getBoolean("bold"))

        val child = node.getArray("children").first().jsonObject
        assertEquals(7, child.getInt("futureChildField"))
    }

    @Test
    fun preservesUnknownFieldsWhenLightEditingKnownFields() {
        val payload = WorkspaceJson.decode(sampleWorkspaceJson)
        val document = payload.workspace.documents.first()
        val root = document.nodes.first()

        val edited = payload.copy(
            workspace = payload.workspace.copy(
                documents = listOf(
                    document.copy(
                        title = "Bike Android Companion",
                        nodes = listOf(
                            root.copy(
                                text = "移动端定位调整",
                                checked = true,
                            ),
                        ),
                    ),
                ),
            ),
        )

        val encoded = WorkspaceJson.encode(edited)
        val reparsed = WorkspaceJson.json.parseToJsonElement(encoded).jsonObject
        val documentJson = reparsed.getArray("documents").first().jsonObject
        val nodeJson = documentJson.getArray("nodes").first().jsonObject

        assertEquals("Bike Android Companion", documentJson.getString("title"))
        assertEquals("desktop-only", documentJson.getString("futureDocumentField"))
        assertEquals("移动端定位调整", nodeJson.getString("text"))
        assertTrue(nodeJson.getBoolean("checked"))
        assertEquals("keep-me", nodeJson.getString("futureNodeField"))

        val child = nodeJson.getArray("children").first().jsonObject
        assertEquals("快速捕捉", child.getString("text"))
        assertEquals(7, child.getInt("futureChildField"))
    }

    @Test
    fun removesKnownNullableFieldsWhenAndroidClearsThem() {
        val payload = WorkspaceJson.decode(sampleWorkspaceJson)
        val document = payload.workspace.documents.first()
        val root = document.nodes.first()

        val cleared = payload.copy(
            workspace = payload.workspace.copy(
                documents = listOf(
                    document.copy(
                        markdownSource = null,
                        markdownUpdatedAt = null,
                        nodes = listOf(
                            root.copy(
                                bold = null,
                                icon = null,
                                imageName = null,
                                imageAlt = null,
                                table = null,
                                codeBlock = null,
                                codeLanguage = null,
                            ),
                        ),
                    ),
                ),
            ),
        )

        val encoded = WorkspaceJson.encode(cleared)
        val reparsed = WorkspaceJson.json.parseToJsonElement(encoded).jsonObject
        val documentJson = reparsed.getArray("documents").first().jsonObject
        val nodeJson = documentJson.getArray("nodes").first().jsonObject

        assertFalse("markdownSource" in documentJson)
        assertFalse("markdownUpdatedAt" in documentJson)
        assertFalse("bold" in nodeJson)
        assertFalse("icon" in nodeJson)
        assertFalse("imageName" in nodeJson)
        assertFalse("imageAlt" in nodeJson)
        assertFalse("table" in nodeJson)
        assertFalse("codeBlock" in nodeJson)
        assertFalse("codeLanguage" in nodeJson)
        assertEquals("keep-me", nodeJson.getString("futureNodeField"))
    }

    @Test
    fun freshEncodeOmitsNullOptionalFieldsAndKeepsRequiredDefaults() {
        val workspace = Workspace(
            activeDocumentId = "doc_1",
            documents = listOf(
                OutlineDocument(
                    id = "doc_1",
                    title = "Inbox",
                    createdAt = "2026-06-13T00:00:00.000Z",
                    updatedAt = "2026-06-13T00:00:00.000Z",
                    nodes = listOf(
                        OutlineNode(
                            id = "node_1",
                            text = "Captured thought",
                        ),
                    ),
                ),
            ),
        )

        val encoded = WorkspaceJson.encode(workspace)
        val reparsed = WorkspaceJson.json.parseToJsonElement(encoded).jsonObject
        val node = reparsed
            .getArray("documents")
            .first()
            .jsonObject
            .getArray("nodes")
            .first()
            .jsonObject

        assertEquals("plain", node.getString("color"))
        assertFalse("headingLevel" in node)
        assertFalse("markdownSource" in reparsed.getArray("documents").first().jsonObject)
    }

    @Test
    fun rejectsWorkspaceWithoutDocuments() {
        val error = assertThrows(IllegalArgumentException::class.java) {
            WorkspaceJson.decode(
                """
                {
                  "version": 1,
                  "activeDocumentId": "missing",
                  "documents": []
                }
                """.trimIndent(),
            )
        }

        assertEquals("工作区至少需要一篇文档", error.message)
    }

    @Test
    fun normalizesMissingActiveDocumentToFirstDocument() {
        val payload = WorkspaceJson.decode(
            """
            {
              "version": 1,
              "activeDocumentId": "missing",
              "documents": [
                {
                  "id": "doc_first",
                  "title": "First",
                  "createdAt": "2026-06-13T00:00:00Z",
                  "updatedAt": "2026-06-13T00:00:00Z",
                  "nodes": []
                }
              ]
            }
            """.trimIndent(),
        )

        assertEquals("doc_first", payload.workspace.activeDocumentId)
    }

    private fun JsonObject.getObject(key: String): JsonObject =
        getValue(key).jsonObject

    private fun JsonObject.getArray(key: String) =
        getValue(key).jsonArray

    private fun JsonObject.getString(key: String): String =
        getValue(key).jsonPrimitive.content

    private fun JsonObject.getInt(key: String): Int =
        getValue(key).jsonPrimitive.int

    private fun JsonObject.getBoolean(key: String): Boolean =
        getValue(key).jsonPrimitive.boolean
}

private val sampleWorkspaceJson = """
    {
      "version": 1,
      "activeDocumentId": "doc_product",
      "androidUnknown": { "scope": "top-level" },
      "documents": [
        {
          "id": "doc_product",
          "title": "Bike Android MVP",
          "createdAt": "2026-06-13T00:00:00.000Z",
          "updatedAt": "2026-06-13T01:00:00.000Z",
          "markdownSource": "# Bike Android\n\n- 移动端定位",
          "markdownUpdatedAt": "2026-06-13T01:00:00.000Z",
          "futureDocumentField": "desktop-only",
          "nodes": [
            {
              "id": "node_positioning",
              "text": "移动端定位",
              "note": "Mobile companion, not desktop parity.",
              "checked": false,
              "collapsed": false,
              "color": "blue",
              "headingLevel": 2,
              "bold": true,
              "italic": false,
              "underline": false,
              "strike": false,
              "highlight": true,
              "icon": "spark",
              "imageName": "capture.png",
              "imageAlt": "Capture flow",
              "table": [["场景", "价值"], ["分享入口", "快速收集"]],
              "codeBlock": "val scope = \"MVP\"",
              "codeLanguage": "kotlin",
              "isTodo": true,
              "futureNodeField": "keep-me",
              "children": [
                {
                  "id": "node_capture",
                  "text": "快速捕捉",
                  "note": "",
                  "checked": true,
                  "collapsed": false,
                  "color": "plain",
                  "futureChildField": 7,
                  "children": []
                }
              ]
            }
          ]
        }
      ]
    }
""".trimIndent()
