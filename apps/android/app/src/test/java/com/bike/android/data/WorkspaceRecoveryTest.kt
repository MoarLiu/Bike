package com.bike.android.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

class WorkspaceRecoveryTest {
    @Test
    fun movesCorruptedWorkspaceToBackupFile() {
        val directory = Files.createTempDirectory("bike-workspace-recovery").toFile()
        try {
            val workspaceFile = File(directory, "bike-workspace.json")
            workspaceFile.writeText("{ broken json", Charsets.UTF_8)

            val backupFile = backupCorruptedWorkspaceFile(workspaceFile)

            assertFalse(workspaceFile.exists())
            assertTrue(backupFile.exists())
            assertTrue(backupFile.name.startsWith("bike-workspace.json.corrupted-"))
            assertEquals("{ broken json", backupFile.readText(Charsets.UTF_8))
        } finally {
            directory.deleteRecursively()
        }
    }
}
