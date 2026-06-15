package com.bike.android.ai

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AiParsingTest {
    @Test
    fun parsesGeneratedChildrenFromJsonArray() {
        assertEquals(
            listOf("捕捉入口", "轻量整理"),
            parseGeneratedChildren("""["捕捉入口", "轻量整理"]"""),
        )
    }

    @Test
    fun parsesGeneratedChildrenFromObjectArray() {
        assertEquals(
            listOf("分享面板", "收件箱"),
            parseGeneratedChildren(
                """
                {
                  "children": [
                    { "title": "分享面板" },
                    { "text": "收件箱" }
                  ]
                }
                """.trimIndent(),
            ),
        )
    }

    @Test
    fun parsesGeneratedNodesFromDesktopBikeShape() {
        val nodes = parseGeneratedNodes(
            """
            {
              "children": [
                {
                  "text": "移动端捕捉",
                  "children": [
                    { "topic": "分享面板" },
                    { "heading": "输入法上方工具栏" }
                  ]
                },
                { "title": "回桌面整理" }
              ]
            }
            """.trimIndent(),
        )

        assertEquals("移动端捕捉", nodes.first().text)
        assertEquals(listOf("分享面板", "输入法上方工具栏"), nodes.first().children.map { it.text })
        assertEquals("回桌面整理", nodes.last().text)
    }

    @Test
    fun parsesGeneratedChildrenFromBalancedJsonInsideText() {
        assertEquals(
            listOf("快速记录", "轻量整理"),
            parseGeneratedChildren(
                """
                好的，结果如下：
                {"children":[{"text":"快速记录"},{"text":"轻量整理"}]}
                希望有帮助。
                """.trimIndent(),
            ),
        )
    }

    @Test
    fun parsesGeneratedChildrenFromLines() {
        assertEquals(
            listOf("快速捕捉", "AI 润色"),
            parseGeneratedChildren(
                """
                1. 快速捕捉
                - AI 润色
                """.trimIndent(),
            ),
        )
    }

    @Test
    fun parsesGeneratedChildrenFromFencedJson() {
        assertEquals(
            listOf("离线收件箱", "回桌面整理"),
            parseGeneratedChildren(
                """
                ```JSON
                ["离线收件箱", "回桌面整理"]
                ```
                """.trimIndent(),
            ),
        )
    }

    @Test
    fun parsesPolishedTextFromJsonOrPlainText() {
        assertEquals(
            "移动端快速捕捉入口",
            parsePolishedText("""{ "text": "移动端快速捕捉入口" }"""),
        )
        assertEquals(
            "移动端轻量整理",
            parsePolishedText("移动端轻量整理\n\n解释：忽略这行"),
        )
    }

    @Test
    fun parsesPolishedTextFromFencedPlainText() {
        assertEquals(
            "移动端 AI 辅助整理",
            parsePolishedText(
                """
                ```
                移动端 AI 辅助整理
                ```
                """.trimIndent(),
            ),
        )
    }

    @Test
    fun parsesProviderErrorMessageFromJsonHtmlAndPlainText() {
        assertEquals(
            "model not found",
            parseProviderErrorMessage("""{ "error": { "message": "model not found" } }"""),
        )
        assertEquals(
            "服务器返回了网页错误",
            parseProviderErrorMessage("<html><title>Bad gateway</title></html>"),
        )
        assertEquals(
            "upstream unavailable",
            parseProviderErrorMessage("upstream unavailable\nretry later"),
        )
        assertNull(parseProviderErrorMessage("   "))
    }

    @Test
    fun extractsAssistantContentFromCommonResponseShapes() {
        assertEquals(
            """["捕捉", "整理"]""",
            extractAssistantContent(
                """
                {
                  "choices": [
                    { "message": { "content": "[\"捕捉\", \"整理\"]" } }
                  ]
                }
                """.trimIndent(),
            ),
        )
        assertEquals(
            "移动端草稿",
            extractAssistantContent("""{ "output_text": "移动端草稿" }"""),
        )
        assertEquals(
            "移动端草稿",
            extractAssistantContent(
                """
                {
                  "output": [
                    {
                      "type": "message",
                      "content": [
                        { "type": "output_text", "text": "移动端草稿" }
                      ]
                    }
                  ]
                }
                """.trimIndent(),
            ),
        )
        assertEquals(
            "移动端草稿",
            extractAssistantContent(
                """
                {
                  "content": [
                    { "type": "text", "text": "移动端草稿" }
                  ]
                }
                """.trimIndent(),
            ),
        )
    }

    @Test
    fun extractsAssistantContentFromResponsesEventStream() {
        assertEquals(
            """{"children":[{"text":"捕捉"}]}""",
            extractAssistantContent(
                """
                event: response.output_text.delta
                data: {"type":"response.output_text.delta","delta":"{\"children\":[{\"text\":\"捕"}
                
                event: response.output_text.delta
                data: {"type":"response.output_text.delta","delta":"捉\"}]}"}
                
                data: [DONE]
                """.trimIndent(),
            ),
        )
    }

    @Test
    fun acceptsPlainTextProviderPayloadBeforeActionNormalization() {
        assertEquals("not json here", extractAssistantContent("not json here"))
        assertTrue(
            runCatching { parseJsonText("not json here") }
                .exceptionOrNull() is AiResponseFormatException,
        )
    }

    @Test
    fun parsesProviderErrorMessageFromDesktopBikeShapes() {
        assertEquals(
            "bad key",
            parseProviderErrorMessage("""{ "error": "bad key" }"""),
        )
        assertEquals(
            "field required; invalid endpoint",
            parseProviderErrorMessage(
                """
                {
                  "detail": [
                    { "msg": "field required" },
                    { "message": "invalid endpoint" }
                  ]
                }
                """.trimIndent(),
            ),
        )
    }

    @Test
    fun buildsEndpointUrlsFromCommonBaseUrls() {
        assertEquals(
            "https://api.openai.com/v1/responses",
            aiEndpointUrl("https://api.openai.com", AiEndpoint.Responses),
        )
        assertEquals(
            "https://api.openai.com/v1/responses",
            aiEndpointUrl("https://api.openai.com/v1", AiEndpoint.Responses),
        )
        assertEquals(
            "https://api.openai.com/v1/chat/completions",
            chatCompletionsUrl("https://api.openai.com"),
        )
        assertEquals(
            "https://api.openai.com/v1/chat/completions",
            chatCompletionsUrl("https://api.openai.com/v1"),
        )
        assertEquals(
            "https://example.com/openai/chat/completions",
            chatCompletionsUrl("https://example.com/openai"),
        )
        assertEquals(
            "https://example.com/v1/chat/completions",
            chatCompletionsUrl("https://example.com/v1/chat/completions"),
        )
    }
}
