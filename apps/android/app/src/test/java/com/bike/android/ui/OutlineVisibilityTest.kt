package com.bike.android.ui

import com.bike.android.data.outlineNode
import org.junit.Assert.assertEquals
import org.junit.Test

class OutlineVisibilityTest {
    @Test
    fun hidesChildrenOfCollapsedNodes() {
        val collapsedParent = outlineNode(
            text = "折叠主题",
            children = listOf(outlineNode("不可见子主题")),
        ).copy(collapsed = true)
        val visibleParent = outlineNode(
            text = "展开主题",
            children = listOf(outlineNode("可见子主题")),
        )

        val rows = flattenVisibleNodes(listOf(collapsedParent, visibleParent))

        assertEquals(
            listOf(
                "折叠主题" to 0,
                "展开主题" to 0,
                "可见子主题" to 1,
            ),
            rows.map { it.node.text to it.depth },
        )
    }

    @Test
    fun searchFindsNestedNodesEvenWhenParentIsCollapsed() {
        val collapsedParent = outlineNode(
            text = "折叠主题",
            children = listOf(
                outlineNode(
                    text = "移动端 AI 生成",
                    note = "核心能力",
                ),
            ),
        ).copy(collapsed = true)

        val rows = flattenSearchNodes(listOf(collapsedParent), "核心")

        assertEquals(
            listOf("移动端 AI 生成" to 1),
            rows.map { it.node.text to it.depth },
        )
    }

    @Test
    fun childrenInheritCheckedAppearanceWithoutChangingTheirOwnState() {
        val parent = outlineNode(
            text = "弃用方向",
            children = listOf(outlineNode("保留真实状态")),
        ).copy(checked = true)

        val rows = flattenVisibleNodes(listOf(parent))

        assertEquals(false, rows[0].inheritedChecked)
        assertEquals(true, rows[0].node.checked)
        assertEquals(true, rows[1].inheritedChecked)
        assertEquals(false, rows[1].node.checked)
    }
}
