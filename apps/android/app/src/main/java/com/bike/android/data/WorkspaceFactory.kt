package com.bike.android.data

import java.time.Instant
import java.util.UUID

const val INBOX_DOCUMENT_TITLE = "Bike Android 收件箱"

fun createStarterWorkspace(now: Instant = Instant.now()): Workspace {
    val timestamp = now.toString()
    val documentId = newBikeId("doc")

    return Workspace(
        activeDocumentId = documentId,
        documents = listOf(
            OutlineDocument(
                id = documentId,
                title = INBOX_DOCUMENT_TITLE,
                createdAt = timestamp,
                updatedAt = timestamp,
                nodes = listOf(
                    outlineNode(
                        text = "快速捕捉",
                        children = listOf(
                            outlineNode("从 Android 分享面板收集文字和链接"),
                            outlineNode("离线保存到本机工作区"),
                            outlineNode("回到桌面端继续深度整理"),
                        ),
                    ),
                    outlineNode(
                        text = "轻量整理",
                        children = listOf(
                            outlineNode("新增同级和子级主题"),
                            outlineNode("折叠、勾选、备注"),
                            outlineNode("保持 Workspace v1 JSON 兼容"),
                        ),
                    ),
                ),
            ),
        ),
    )
}

fun outlineNode(
    text: String,
    children: List<OutlineNode> = emptyList(),
): OutlineNode =
    OutlineNode(
        id = newBikeId("node"),
        text = text,
        children = children,
    )

fun outlineNode(
    text: String,
    note: String,
    children: List<OutlineNode> = emptyList(),
): OutlineNode =
    outlineNode(text = text, children = children).copy(note = note)

fun Workspace.activeDocument(): OutlineDocument =
    documents.firstOrNull { it.id == activeDocumentId }
        ?: documents.firstOrNull()
        ?: error("工作区没有可用文档")

fun OutlineDocument.nodeCount(): Int =
    nodes.sumOf { it.nodeCount() }

fun OutlineNode.nodeCount(): Int =
    1 + children.sumOf { it.nodeCount() }

internal fun newBikeId(prefix: String): String =
    "${prefix}_${UUID.randomUUID()}"
