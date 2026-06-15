package com.bike.android.data

import java.io.File

data class WorkspaceRecovery(
    val backupPath: String,
) {
    val backupFileName: String = File(backupPath).name
}

internal fun backupCorruptedWorkspaceFile(workspaceFile: File): File {
    val parent = workspaceFile.parentFile ?: error("工作区文件没有父目录")
    parent.mkdirs()

    val backupFile = nextCorruptedBackupFile(parent, workspaceFile.name)
    if (workspaceFile.renameTo(backupFile)) {
        return backupFile
    }

    workspaceFile.copyTo(backupFile, overwrite = false)
    if (!workspaceFile.delete()) {
        backupFile.delete()
        error("无法移动损坏的工作区文件")
    }
    return backupFile
}

private fun nextCorruptedBackupFile(parent: File, workspaceFileName: String): File {
    val timestamp = System.currentTimeMillis()
    var index = 0
    while (true) {
        val suffix = if (index == 0) "" else "-$index"
        val candidate = File(parent, "$workspaceFileName.corrupted-$timestamp$suffix")
        if (!candidate.exists()) return candidate
        index += 1
    }
}
