package com.bike.android.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class WorkspaceMutationsTest {
    @Test
    fun switchesActiveDocumentOnlyWhenDocumentExists() {
        val workspace = createStarterWorkspace(Instant.parse("2026-06-13T00:00:00Z"))
            .withNewDocument(
                title = "Second",
                now = Instant.parse("2026-06-13T00:01:00Z"),
            )
        val originalActiveId = workspace.activeDocumentId
        val otherDocumentId = workspace.documents.last().id

        assertEquals(otherDocumentId, workspace.withActiveDocument(otherDocumentId).activeDocumentId)
        assertEquals(originalActiveId, workspace.withActiveDocument("missing").activeDocumentId)
    }

    @Test
    fun togglesNestedNodeCheckedStateAndUpdatesDocumentTimestamp() {
        val workspace = createStarterWorkspace(Instant.parse("2026-06-13T00:00:00Z"))
        val document = workspace.activeDocument()
        val target = document.nodes.first().children.first()

        val updated = workspace.withNodeChecked(
            documentId = document.id,
            nodeId = target.id,
            checked = true,
            now = Instant.parse("2026-06-13T00:05:00Z"),
        )

        val updatedDocument = updated.activeDocument()
        val updatedNode = updatedDocument.nodes.first().children.first()
        assertTrue(updatedNode.checked)
        assertEquals("2026-06-13T00:05:00Z", updatedDocument.updatedAt)
    }

    @Test
    fun appendsSharedContentToInboxAndMakesItActive() {
        val workspace = createStarterWorkspace(Instant.parse("2026-06-13T00:00:00Z"))

        val updated = workspace.withInboxEntry(
            content = "来自浏览器的链接\nhttps://example.com",
            now = Instant.parse("2026-06-13T00:01:00Z"),
        )

        val inbox = updated.activeDocument()
        assertEquals(INBOX_DOCUMENT_TITLE, inbox.title)
        assertEquals("来自浏览器的链接", inbox.nodes.first().text)
        assertEquals("https://example.com", inbox.nodes.first().note)
        assertEquals("2026-06-13T00:01:00Z", inbox.updatedAt)
    }

    @Test
    fun createsInboxWhenSharedContentArrivesWithoutOne() {
        val workspace = Workspace(
            activeDocumentId = "doc_other",
            documents = listOf(
                OutlineDocument(
                    id = "doc_other",
                    title = "Other",
                    createdAt = "2026-06-13T00:00:00Z",
                    updatedAt = "2026-06-13T00:00:00Z",
                    nodes = listOf(outlineNode("原主题")),
                ),
            ),
        )

        val updated = workspace.withInboxEntry(
            content = "收件箱新内容",
            now = Instant.parse("2026-06-13T00:02:00Z"),
        )

        assertEquals(INBOX_DOCUMENT_TITLE, updated.activeDocument().title)
        assertEquals("收件箱新内容", updated.activeDocument().nodes.first().text)
        assertEquals(2, updated.documents.size)
        assertTrue(updated.activeDocument().id.startsWith("doc_"))
    }

    @Test
    fun updatesNodeTextNoteAndCollapsedState() {
        val workspace = createStarterWorkspace(Instant.parse("2026-06-13T00:00:00Z"))
        val document = workspace.activeDocument()
        val target = document.nodes.first()

        val updated = workspace
            .withNodeText(
                documentId = document.id,
                nodeId = target.id,
                text = "移动收件箱",
                now = Instant.parse("2026-06-13T00:02:00Z"),
            )
            .withNodeNote(
                documentId = document.id,
                nodeId = target.id,
                note = "手机端先做轻编辑",
                now = Instant.parse("2026-06-13T00:03:00Z"),
            )
            .withNodeCollapsed(
                documentId = document.id,
                nodeId = target.id,
                collapsed = true,
                now = Instant.parse("2026-06-13T00:04:00Z"),
            )

        val updatedNode = updated.activeDocument().nodes.first()
        assertEquals("移动收件箱", updatedNode.text)
        assertEquals("手机端先做轻编辑", updatedNode.note)
        assertTrue(updatedNode.collapsed)
        assertEquals("2026-06-13T00:04:00Z", updated.activeDocument().updatedAt)
    }

    @Test
    fun updatesDocumentTitleAndTimestamp() {
        val workspace = createStarterWorkspace(Instant.parse("2026-06-13T00:00:00Z"))
        val document = workspace.activeDocument()

        val updated = workspace.withDocumentTitle(
            documentId = document.id,
            title = "移动端草稿",
            now = Instant.parse("2026-06-13T00:04:30Z"),
        )

        assertEquals("移动端草稿", updated.activeDocument().title)
        assertEquals("2026-06-13T00:04:30Z", updated.activeDocument().updatedAt)
    }

    @Test
    fun togglesDocumentShortcutAndUpdatesTimestamp() {
        val workspace = createStarterWorkspace(Instant.parse("2026-06-13T00:00:00Z"))
        val document = workspace.activeDocument()

        val updated = workspace.withDocumentShortcut(
            documentId = document.id,
            isShortcut = true,
            now = Instant.parse("2026-06-13T00:04:45Z"),
        )

        assertTrue(updated.activeDocument().isShortcut)
        assertEquals("2026-06-13T00:04:45Z", updated.activeDocument().updatedAt)
    }

    @Test
    fun duplicatesDocumentWithFreshDocumentAndNodeIds() {
        val workspace = createStarterWorkspace(Instant.parse("2026-06-13T00:00:00Z"))
        val source = workspace.activeDocument()

        val updated = workspace.withDocumentDuplicated(
            documentId = source.id,
            now = Instant.parse("2026-06-13T00:04:50Z"),
        )

        val duplicated = updated.activeDocument()
        assertEquals(2, updated.documents.size)
        assertNotEquals(source.id, duplicated.id)
        assertTrue(duplicated.id.startsWith("doc_"))
        assertEquals("${source.title} 副本", duplicated.title)
        assertEquals("2026-06-13T00:04:50Z", duplicated.createdAt)
        assertEquals(source.nodes.first().text, duplicated.nodes.first().text)
        assertNotEquals(source.nodes.first().id, duplicated.nodes.first().id)
        assertNotEquals(source.nodes.first().children.first().id, duplicated.nodes.first().children.first().id)
    }

    @Test
    fun movesDocumentToFront() {
        val workspace = createStarterWorkspace(Instant.parse("2026-06-13T00:00:00Z"))
            .withNewDocument(
                title = "Second",
                now = Instant.parse("2026-06-13T00:01:00Z"),
            )
        val firstId = workspace.documents.first().id
        val secondId = workspace.documents.last().id

        val updated = workspace.withDocumentMovedToFront(secondId)

        assertEquals(secondId, updated.documents.first().id)
        assertEquals(firstId, updated.documents.last().id)
    }

    @Test
    fun deletesDocumentsAndKeepsActiveDocumentValid() {
        val workspace = createStarterWorkspace(Instant.parse("2026-06-13T00:00:00Z"))
            .withNewDocument(
                title = "Second",
                now = Instant.parse("2026-06-13T00:01:00Z"),
            )
        val activeId = workspace.activeDocumentId

        val updated = workspace.withDocumentDeleted(
            documentId = activeId,
            now = Instant.parse("2026-06-13T00:04:55Z"),
        )

        assertEquals(1, updated.documents.size)
        assertTrue(updated.documents.any { it.id == updated.activeDocumentId })
        assertNotEquals(activeId, updated.activeDocumentId)
    }

    @Test
    fun deletingAllDocumentsCreatesReplacementDocument() {
        val workspace = createStarterWorkspace(Instant.parse("2026-06-13T00:00:00Z"))

        val updated = workspace.withDocumentsDeleted(
            documentIds = workspace.documents.map { it.id }.toSet(),
            now = Instant.parse("2026-06-13T00:04:58Z"),
        )

        assertEquals(1, updated.documents.size)
        assertEquals(updated.documents.first().id, updated.activeDocumentId)
        assertEquals("未命名文档", updated.documents.first().title)
        assertTrue(updated.documents.first().id.startsWith("doc_"))
    }

    @Test
    fun updatesNodeTextAndNoteTogether() {
        val workspace = createStarterWorkspace(Instant.parse("2026-06-13T00:00:00Z"))
        val document = workspace.activeDocument()
        val target = document.nodes.first()

        val updated = workspace.withNodeTextAndNote(
            documentId = document.id,
            nodeId = target.id,
            text = "移动收件箱",
            note = "一次保存两个字段",
            now = Instant.parse("2026-06-13T00:05:00Z"),
        )

        val updatedNode = updated.activeDocument().nodes.first()
        assertEquals("移动收件箱", updatedNode.text)
        assertEquals("一次保存两个字段", updatedNode.note)
        assertEquals("2026-06-13T00:05:00Z", updated.activeDocument().updatedAt)
    }

    @Test
    fun insertsSiblingAfterNestedNode() {
        val workspace = createStarterWorkspace(Instant.parse("2026-06-13T00:00:00Z"))
        val document = workspace.activeDocument()
        val target = document.nodes.first().children.first()

        val updated = workspace.withSiblingAfter(
            documentId = document.id,
            nodeId = target.id,
            text = "新同级",
            now = Instant.parse("2026-06-13T00:06:00Z"),
        )

        val siblings = updated.activeDocument().nodes.first().children
        assertEquals("新同级", siblings[1].text)
        assertEquals(target.id, siblings[0].id)
        assertEquals("2026-06-13T00:06:00Z", updated.activeDocument().updatedAt)
    }

    @Test
    fun appendsChildAndExpandsParent() {
        val workspace = createStarterWorkspace(Instant.parse("2026-06-13T00:00:00Z"))
        val document = workspace.activeDocument()
        val target = document.nodes.first().copy(collapsed = true)
        val collapsedWorkspace = workspace.copy(
            documents = listOf(document.copy(nodes = listOf(target) + document.nodes.drop(1))),
        )

        val updated = collapsedWorkspace.withChildNode(
            documentId = document.id,
            nodeId = target.id,
            text = "新子级",
            now = Instant.parse("2026-06-13T00:07:00Z"),
        )

        val updatedNode = updated.activeDocument().nodes.first()
        assertEquals("新子级", updatedNode.children.last().text)
        assertEquals(false, updatedNode.collapsed)
        assertEquals("2026-06-13T00:07:00Z", updated.activeDocument().updatedAt)
    }

    @Test
    fun appendsProvidedChildAndPreservesItsId() {
        val workspace = createStarterWorkspace(Instant.parse("2026-06-13T00:00:00Z"))
        val document = workspace.activeDocument()
        val target = document.nodes.first()
        val child = outlineNode("")

        val updated = workspace.withChildNode(
            documentId = document.id,
            nodeId = target.id,
            childNode = child,
            now = Instant.parse("2026-06-13T00:07:30Z"),
        )

        val updatedNode = updated.activeDocument().nodes.first()
        assertEquals(child.id, updatedNode.children.last().id)
        assertEquals("", updatedNode.children.last().text)
        assertFalse(updatedNode.collapsed)
        assertEquals("2026-06-13T00:07:30Z", updated.activeDocument().updatedAt)
    }

    @Test
    fun appendsGeneratedChildrenAndExpandsParent() {
        val workspace = createStarterWorkspace(Instant.parse("2026-06-13T00:00:00Z"))
        val document = workspace.activeDocument()
        val target = document.nodes.first()

        val updated = workspace.withGeneratedChildren(
            documentId = document.id,
            nodeId = target.id,
            texts = listOf("AI 子主题 1", " ", "AI 子主题 2"),
            now = Instant.parse("2026-06-13T00:08:00Z"),
        )

        val updatedNode = updated.activeDocument().nodes.first()
        assertEquals("AI 子主题 1", updatedNode.children.takeLast(2).first().text)
        assertEquals("AI 子主题 2", updatedNode.children.last().text)
        assertFalse(updatedNode.collapsed)
        assertEquals("2026-06-13T00:08:00Z", updated.activeDocument().updatedAt)
    }

    @Test
    fun movesNestedNodeToParentLevel() {
        val workspace = createStarterWorkspace(Instant.parse("2026-06-13T00:00:00Z"))
        val document = workspace.activeDocument()
        val parent = document.nodes.first()
        val target = parent.children.first()

        val updated = workspace.withNodeMovedToParentLevel(
            documentId = document.id,
            nodeId = target.id,
            now = Instant.parse("2026-06-13T00:08:15Z"),
        )

        val nodes = updated.activeDocument().nodes
        assertEquals(parent.id, nodes.first().id)
        assertFalse(nodes.first().children.any { it.id == target.id })
        assertEquals(target.id, nodes[1].id)
        assertEquals("2026-06-13T00:08:15Z", updated.activeDocument().updatedAt)
    }

    @Test
    fun appendsRootNodeToDocument() {
        val workspace = createStarterWorkspace(Instant.parse("2026-06-13T00:00:00Z"))
        val document = workspace.activeDocument()

        val updated = workspace.withRootNode(
            documentId = document.id,
            text = "新的根主题",
            now = Instant.parse("2026-06-13T00:08:30Z"),
        )

        assertEquals(document.nodes.size + 1, updated.activeDocument().nodes.size)
        assertEquals("新的根主题", updated.activeDocument().nodes.last().text)
        assertEquals("2026-06-13T00:08:30Z", updated.activeDocument().updatedAt)
    }

    @Test
    fun appendsProvidedRootNodeAndPreservesItsId() {
        val workspace = createStarterWorkspace(Instant.parse("2026-06-13T00:00:00Z"))
        val document = workspace.activeDocument()
        val root = outlineNode("")

        val updated = workspace.withRootNode(
            documentId = document.id,
            newNode = root,
            now = Instant.parse("2026-06-13T00:08:45Z"),
        )

        assertEquals(root.id, updated.activeDocument().nodes.last().id)
        assertEquals("", updated.activeDocument().nodes.last().text)
        assertEquals("2026-06-13T00:08:45Z", updated.activeDocument().updatedAt)
    }

    @Test
    fun deletesNestedNodeAndKeepsDocumentNonEmpty() {
        val workspace = createStarterWorkspace(Instant.parse("2026-06-13T00:00:00Z"))
        val document = workspace.activeDocument()
        val target = document.nodes.first().children.first()

        val updated = workspace.withNodeDeleted(
            documentId = document.id,
            nodeId = target.id,
            now = Instant.parse("2026-06-13T00:09:00Z"),
        )

        val remainingChildren = updated.activeDocument().nodes.first().children
        assertFalse(remainingChildren.any { it.id == target.id })
        assertTrue(updated.activeDocument().nodes.isNotEmpty())
        assertEquals("2026-06-13T00:09:00Z", updated.activeDocument().updatedAt)
    }

    @Test
    fun createsNewDocumentAsActiveDocument() {
        val workspace = createStarterWorkspace(Instant.parse("2026-06-13T00:00:00Z"))
        val updated = workspace.withNewDocument(
            title = "Inbox",
            now = Instant.parse("2026-06-13T00:10:00Z"),
        )

        assertEquals(2, updated.documents.size)
        assertNotEquals(workspace.activeDocumentId, updated.activeDocumentId)
        assertEquals("Inbox", updated.activeDocument().title)
        assertEquals("2026-06-13T00:10:00Z", updated.activeDocument().createdAt)
        assertTrue(updated.activeDocument().id.startsWith("doc_"))
    }
}
