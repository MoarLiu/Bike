package com.bike.android.data

import java.time.Instant

fun Workspace.withActiveDocument(documentId: String): Workspace =
    if (documents.any { it.id == documentId }) copy(activeDocumentId = documentId) else this

fun Workspace.withDocumentTitle(
    documentId: String,
    title: String,
    now: Instant = Instant.now(),
): Workspace {
    val normalizedTitle = title.take(120)
    return updateDocument(documentId) { document ->
        document.copy(
            title = normalizedTitle,
            updatedAt = now.toString(),
        )
    }
}

fun Workspace.withDocumentShortcut(
    documentId: String,
    isShortcut: Boolean,
    now: Instant = Instant.now(),
): Workspace =
    updateDocument(documentId) { document ->
        document.copy(
            isShortcut = isShortcut,
            updatedAt = now.toString(),
        )
    }

fun Workspace.withDocumentMovedToFront(
    documentId: String,
): Workspace {
    val index = documents.indexOfFirst { it.id == documentId }
    if (index <= 0) return this

    val document = documents[index]
    return copy(
        documents = listOf(document) + documents.filterNot { it.id == documentId },
    )
}

fun Workspace.withDocumentDuplicated(
    documentId: String,
    now: Instant = Instant.now(),
): Workspace {
    val source = documents.firstOrNull { it.id == documentId } ?: return this
    val duplicatedDocument = source.duplicated(now)
    val sourceIndex = documents.indexOfFirst { it.id == documentId }
    val nextDocuments = documents.toMutableList().apply {
        add(sourceIndex + 1, duplicatedDocument)
    }
    return copy(
        activeDocumentId = duplicatedDocument.id,
        documents = nextDocuments,
    )
}

fun Workspace.withDocumentsDuplicated(
    documentIds: Set<String>,
    now: Instant = Instant.now(),
): Workspace {
    if (documentIds.isEmpty()) return this
    var lastCopiedId: String? = null
    val nextDocuments = documents.flatMap { document ->
        if (document.id in documentIds) {
            val copy = document.duplicated(now)
            lastCopiedId = copy.id
            listOf(document, copy)
        } else {
            listOf(document)
        }
    }
    return copy(
        activeDocumentId = lastCopiedId ?: activeDocumentId,
        documents = nextDocuments,
    )
}

fun Workspace.withDocumentDeleted(
    documentId: String,
    now: Instant = Instant.now(),
): Workspace =
    withDocumentsDeleted(setOf(documentId), now)

fun Workspace.withDocumentsDeleted(
    documentIds: Set<String>,
    now: Instant = Instant.now(),
): Workspace {
    if (documentIds.isEmpty()) return this

    val remaining = documents.filterNot { it.id in documentIds }
    if (remaining.isNotEmpty()) {
        val nextActiveId = if (activeDocumentId in documentIds) {
            remaining.first().id
        } else {
            activeDocumentId
        }
        return copy(
            activeDocumentId = nextActiveId,
            documents = remaining,
        )
    }

    val timestamp = now.toString()
    val document = OutlineDocument(
        id = newBikeId("doc"),
        title = "未命名文档",
        createdAt = timestamp,
        updatedAt = timestamp,
        nodes = listOf(outlineNode("新主题")),
    )
    return copy(
        activeDocumentId = document.id,
        documents = listOf(document),
    )
}

fun Workspace.withNodeChecked(
    documentId: String,
    nodeId: String,
    checked: Boolean,
    now: Instant = Instant.now(),
): Workspace =
    updateDocument(documentId) { document ->
        val updatedNodes = document.nodes.updateNode(nodeId) { node ->
            node.copy(checked = checked)
        }
        document.copy(nodes = updatedNodes, updatedAt = now.toString())
    }

fun Workspace.withInboxEntry(
    content: String,
    now: Instant = Instant.now(),
): Workspace {
    val trimmed = content.trim()
    if (trimmed.isBlank()) return this

    val timestamp = now.toString()
    val lines = trimmed.lines().map { it.trim() }.filter { it.isNotBlank() }
    val title = lines.firstOrNull()?.take(120) ?: "分享内容"
    val note = lines.drop(1).joinToString("\n")
    val node = outlineNode(text = title, note = note)
    val inbox = documents.firstOrNull { it.title == INBOX_DOCUMENT_TITLE }

    if (inbox == null) {
        val document = OutlineDocument(
            id = newBikeId("doc"),
            title = INBOX_DOCUMENT_TITLE,
            createdAt = timestamp,
            updatedAt = timestamp,
            nodes = listOf(node),
        )
        return copy(
            activeDocumentId = document.id,
            documents = listOf(document) + documents,
        )
    }

    return copy(
        activeDocumentId = inbox.id,
        documents = documents.map { document ->
            if (document.id == inbox.id) {
                document.copy(
                    updatedAt = timestamp,
                    nodes = listOf(node) + document.nodes,
                )
            } else {
                document
            }
        },
    )
}

fun Workspace.withNodeText(
    documentId: String,
    nodeId: String,
    text: String,
    now: Instant = Instant.now(),
): Workspace =
    updateDocument(documentId) { document ->
        document.copy(
            nodes = document.nodes.updateNode(nodeId) { node ->
                node.copy(text = text)
            },
            updatedAt = now.toString(),
        )
    }

fun Workspace.withNodeNote(
    documentId: String,
    nodeId: String,
    note: String,
    now: Instant = Instant.now(),
): Workspace =
    updateDocument(documentId) { document ->
        document.copy(
            nodes = document.nodes.updateNode(nodeId) { node ->
                node.copy(note = note)
            },
            updatedAt = now.toString(),
        )
    }

fun Workspace.withNodeTextAndNote(
    documentId: String,
    nodeId: String,
    text: String,
    note: String,
    now: Instant = Instant.now(),
): Workspace =
    updateDocument(documentId) { document ->
        document.copy(
            nodes = document.nodes.updateNode(nodeId) { node ->
                node.copy(text = text, note = note)
            },
            updatedAt = now.toString(),
        )
    }

fun Workspace.withNodeCollapsed(
    documentId: String,
    nodeId: String,
    collapsed: Boolean,
    now: Instant = Instant.now(),
): Workspace =
    updateDocument(documentId) { document ->
        document.copy(
            nodes = document.nodes.updateNode(nodeId) { node ->
                node.copy(collapsed = collapsed)
            },
            updatedAt = now.toString(),
        )
    }

fun Workspace.withSiblingAfter(
    documentId: String,
    nodeId: String,
    text: String = "新主题",
    now: Instant = Instant.now(),
): Workspace =
    withSiblingAfter(
        documentId = documentId,
        nodeId = nodeId,
        newNode = outlineNode(text),
        now = now,
    )

fun Workspace.withSiblingAfter(
    documentId: String,
    nodeId: String,
    newNode: OutlineNode,
    now: Instant = Instant.now(),
): Workspace =
    updateDocument(documentId) { document ->
        document.copy(
            nodes = document.nodes.insertSiblingAfter(nodeId, newNode),
            updatedAt = now.toString(),
        )
    }

fun Workspace.withChildNode(
    documentId: String,
    nodeId: String,
    text: String = "新子主题",
    now: Instant = Instant.now(),
): Workspace =
    withChildNode(
        documentId = documentId,
        nodeId = nodeId,
        childNode = outlineNode(text),
        now = now,
    )

fun Workspace.withChildNode(
    documentId: String,
    nodeId: String,
    childNode: OutlineNode,
    now: Instant = Instant.now(),
): Workspace =
    updateDocument(documentId) { document ->
        document.copy(
            nodes = document.nodes.updateNode(nodeId) { node ->
                node.copy(
                    collapsed = false,
                    children = node.children + childNode,
                )
            },
            updatedAt = now.toString(),
        )
    }

fun Workspace.withGeneratedChildren(
    documentId: String,
    nodeId: String,
    texts: List<String>,
    now: Instant = Instant.now(),
): Workspace {
    val children = texts
        .map { it.trim() }
        .filter { it.isNotBlank() }
        .map { outlineNode(it) }
    if (children.isEmpty()) return this

    return updateDocument(documentId) { document ->
        document.copy(
            nodes = document.nodes.updateNode(nodeId) { node ->
                node.copy(
                    collapsed = false,
                    children = node.children + children,
                )
            },
            updatedAt = now.toString(),
        )
    }
}

fun Workspace.withGeneratedOutlineChildren(
    documentId: String,
    nodeId: String,
    children: List<OutlineNode>,
    now: Instant = Instant.now(),
): Workspace {
    val validChildren = children.filter { it.text.isNotBlank() }
    if (validChildren.isEmpty()) return this

    return updateDocument(documentId) { document ->
        document.copy(
            nodes = document.nodes.updateNode(nodeId) { node ->
                node.copy(
                    collapsed = false,
                    children = node.children + validChildren,
                )
            },
            updatedAt = now.toString(),
        )
    }
}

fun Workspace.withNodeMovedToParentLevel(
    documentId: String,
    nodeId: String,
    now: Instant = Instant.now(),
): Workspace =
    updateDocument(documentId) { document ->
        document.copy(
            nodes = document.nodes.outdentNode(nodeId),
            updatedAt = now.toString(),
        )
    }

fun Workspace.withRootNode(
    documentId: String,
    text: String = "新主题",
    now: Instant = Instant.now(),
): Workspace =
    withRootNode(
        documentId = documentId,
        newNode = outlineNode(text),
        now = now,
    )

fun Workspace.withRootNode(
    documentId: String,
    newNode: OutlineNode,
    now: Instant = Instant.now(),
): Workspace =
    updateDocument(documentId) { document ->
        document.copy(
            nodes = document.nodes + newNode,
            updatedAt = now.toString(),
        )
    }

fun Workspace.withNodeDeleted(
    documentId: String,
    nodeId: String,
    now: Instant = Instant.now(),
): Workspace =
    updateDocument(documentId) { document ->
        val nextNodes = document.nodes.deleteNode(nodeId)
        document.copy(
            nodes = nextNodes.ifEmpty { listOf(outlineNode("新主题")) },
            updatedAt = now.toString(),
        )
    }

fun Workspace.withNewDocument(
    title: String = "未命名文档",
    now: Instant = Instant.now(),
): Workspace {
    val timestamp = now.toString()
    val document = OutlineDocument(
        id = newBikeId("doc"),
        title = title,
        createdAt = timestamp,
        updatedAt = timestamp,
        nodes = listOf(outlineNode("新主题")),
    )

    return copy(
        activeDocumentId = document.id,
        documents = listOf(document) + documents,
    )
}

private fun OutlineDocument.duplicated(now: Instant): OutlineDocument {
    val timestamp = now.toString()
    return copy(
        id = newBikeId("doc"),
        title = title.copyTitle(),
        createdAt = timestamp,
        updatedAt = timestamp,
        nodes = nodes.map { it.duplicated() },
    )
}

private fun OutlineNode.duplicated(): OutlineNode =
    copy(
        id = newBikeId("node"),
        children = children.map { it.duplicated() },
    )

private fun String.copyTitle(): String =
    if (isBlank()) {
        "副本"
    } else {
        "$this 副本".take(120)
    }

private fun Workspace.updateDocument(
    documentId: String,
    update: (OutlineDocument) -> OutlineDocument,
): Workspace =
    copy(
        documents = documents.map { document ->
            if (document.id == documentId) update(document) else document
        },
    )

private fun List<OutlineNode>.updateNode(
    nodeId: String,
    update: (OutlineNode) -> OutlineNode,
): List<OutlineNode> =
    map { node ->
        when {
            node.id == nodeId -> update(node)
            node.children.isNotEmpty() -> node.copy(children = node.children.updateNode(nodeId, update))
            else -> node
        }
    }

private fun List<OutlineNode>.insertSiblingAfter(
    nodeId: String,
    newNode: OutlineNode,
): List<OutlineNode> {
    val directIndex = indexOfFirst { it.id == nodeId }
    if (directIndex >= 0) {
        return toMutableList().apply {
            add(directIndex + 1, newNode)
        }
    }

    return map { node ->
        if (node.children.isEmpty()) {
            node
        } else {
            node.copy(children = node.children.insertSiblingAfter(nodeId, newNode))
        }
    }
}

private fun List<OutlineNode>.deleteNode(nodeId: String): List<OutlineNode> =
    mapNotNull { node ->
        when {
            node.id == nodeId -> null
            node.children.isNotEmpty() -> node.copy(children = node.children.deleteNode(nodeId))
            else -> node
        }
    }

private fun List<OutlineNode>.outdentNode(nodeId: String): List<OutlineNode> {
    forEachIndexed { index, node ->
        val childIndex = node.children.indexOfFirst { it.id == nodeId }
        if (childIndex >= 0) {
            val target = node.children[childIndex]
            val nextParent = node.copy(
                children = node.children.toMutableList().apply {
                    removeAt(childIndex)
                },
            )
            return toMutableList().apply {
                set(index, nextParent)
                add(index + 1, target)
            }
        }
    }

    forEachIndexed { index, node ->
        if (node.children.isNotEmpty()) {
            val nextChildren = node.children.outdentNode(nodeId)
            if (nextChildren !== node.children) {
                return toMutableList().apply {
                    set(index, node.copy(children = nextChildren))
                }
            }
        }
    }

    return this
}
