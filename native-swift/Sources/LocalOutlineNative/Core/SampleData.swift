import Foundation

enum SampleData {
    static func starterWorkspace() -> WorkspaceV1DTO {
        let documentId = UUID().uuidString
        return WorkspaceV1DTO(
            activeDocumentId: documentId,
            documents: [
                OutlineDocumentDTO(
                    id: documentId,
                    title: "本地化大纲产品蓝图",
                    nodes: [
                        node("核心原则 #localfirst", [
                            node("所有文档先保存在本机 SwiftData"),
                            node("iCloud Drive 只作为备份和跨设备迁移文件夹"),
                            node("导出格式保持开放：Markdown、OPML、FreeMind、JSON")
                        ]),
                        node("编辑逻辑", [
                            node("Enter 新建同级主题"),
                            node("Tab / Shift+Tab 调整层级"),
                            node("折叠、聚焦、任务勾选、节点备注")
                        ]),
                        node("视图", [
                            node("大纲视图是主编辑器"),
                            node("思维导图由同一棵树即时生成"),
                            node("演示视图按层级展开，适合复盘或会议")
                        ]),
                        node("知识连接", [
                            node("用 #标签 聚合主题"),
                            node("用 [[本地化大纲产品蓝图]] 建立文档链接")
                        ])
                    ]
                )
            ]
        )
    }

    private static func node(_ text: String, _ children: [OutlineNodeDTO] = []) -> OutlineNodeDTO {
        OutlineNodeDTO(text: text, children: children)
    }
}
