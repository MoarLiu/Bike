package com.bike.android.data

import kotlinx.serialization.Serializable

const val CURRENT_WORKSPACE_VERSION = 1

@Serializable
data class Workspace(
    val version: Int = CURRENT_WORKSPACE_VERSION,
    val activeDocumentId: String,
    val documents: List<OutlineDocument>,
)

@Serializable
data class OutlineDocument(
    val id: String,
    val title: String,
    val createdAt: String,
    val updatedAt: String,
    val markdownSource: String? = null,
    val markdownUpdatedAt: String? = null,
    val isShortcut: Boolean = false,
    val nodes: List<OutlineNode> = emptyList(),
)

@Serializable
data class OutlineNode(
    val id: String,
    val text: String,
    val note: String = "",
    val checked: Boolean = false,
    val collapsed: Boolean = false,
    val color: String = "plain",
    val headingLevel: Int? = null,
    val bold: Boolean? = null,
    val italic: Boolean? = null,
    val underline: Boolean? = null,
    val strike: Boolean? = null,
    val highlight: Boolean? = null,
    val icon: String? = null,
    val imageName: String? = null,
    val imageAlt: String? = null,
    val table: List<List<String>>? = null,
    val codeBlock: String? = null,
    val codeLanguage: String? = null,
    val isTodo: Boolean? = null,
    val children: List<OutlineNode> = emptyList(),
)
