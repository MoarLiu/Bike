package com.bike.android.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class WorkspaceFactoryTest {
    @Test
    fun createsStarterWorkspaceWithActiveDocumentAndNodes() {
        val workspace = createStarterWorkspace(Instant.parse("2026-06-13T00:00:00Z"))

        assertEquals(1, workspace.version)
        assertEquals(1, workspace.documents.size)
        assertEquals(workspace.documents.first().id, workspace.activeDocumentId)
        assertEquals("2026-06-13T00:00:00Z", workspace.activeDocument().createdAt)
        assertTrue(workspace.activeDocument().nodeCount() >= 4)
    }

    @Test
    fun activeDocumentFailsWithClearMessageWhenWorkspaceHasNoDocuments() {
        val workspace = Workspace(
            activeDocumentId = "missing",
            documents = emptyList(),
        )

        val error = runCatching { workspace.activeDocument() }.exceptionOrNull()

        assertTrue(error is IllegalStateException)
        assertEquals("工作区没有可用文档", error?.message)
    }
}
