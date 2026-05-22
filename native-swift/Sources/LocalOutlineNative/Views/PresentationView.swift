import AppKit
import SwiftUI

struct PresentationView: View {
    var title: String
    var nodes: [OutlineNodeDTO]

    @StateObject private var deckState = PresentationDeckState()
    @State private var fullscreenSession: PresentationFullscreenSession?

    private var slides: [Slide] {
        [Slide(title: title, subtitle: "演示文稿", note: nil, points: [])] +
        nodes.map { Slide(title: $0.text.isEmpty ? Defaults.nodeText : $0.text, subtitle: nil, note: $0.note, points: $0.children) }
    }

    var body: some View {
        GeometryReader { proxy in
            PresentationDeckView(
                slides: slides,
                rootCount: nodes.count,
                state: deckState,
                isFullscreen: false,
                fullscreenAction: presentFullscreen
            )
            .frame(
                width: min(max(proxy.size.width - 80, 360), 1120),
                height: min(max(proxy.size.height - 120, 540), 760)
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(40)
        }
        .background(
            LinearGradient(
                colors: [Color(nsColor: .windowBackgroundColor), Color(nsColor: .controlBackgroundColor)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        )
        .focusable()
        .onKeyPress(.rightArrow) {
            deckState.next(count: slides.count)
            return .handled
        }
        .onKeyPress(.space) {
            deckState.next(count: slides.count)
            return .handled
        }
        .onKeyPress(.leftArrow) {
            deckState.previous(count: slides.count)
            return .handled
        }
        .onChange(of: slides.count) { _, count in
            deckState.clamp(count: count)
        }
        .onDisappear {
            fullscreenSession?.close()
            fullscreenSession = nil
        }
    }

    private func presentFullscreen() {
        guard fullscreenSession == nil else { return }
        let session = PresentationFullscreenSession(slides: slides, rootCount: nodes.count, state: deckState) {
            fullscreenSession = nil
        }
        fullscreenSession = session
        session.show()
    }
}

private struct Slide {
    var title: String
    var subtitle: String?
    var note: String?
    var points: [OutlineNodeDTO]
}

@MainActor
private final class PresentationDeckState: ObservableObject {
    @Published var currentSlide = 0

    func next(count: Int) {
        guard count > 0 else { return }
        currentSlide = currentSlide < count - 1 ? currentSlide + 1 : 0
    }

    func previous(count: Int) {
        guard count > 0 else { return }
        currentSlide = currentSlide > 0 ? currentSlide - 1 : count - 1
    }

    func clamp(count: Int) {
        guard count > 0 else {
            currentSlide = 0
            return
        }
        currentSlide = min(max(currentSlide, 0), count - 1)
    }
}

private struct PresentationDeckView: View {
    var slides: [Slide]
    var rootCount: Int
    @ObservedObject var state: PresentationDeckState
    var isFullscreen: Bool
    var fullscreenAction: () -> Void

    private var activeIndex: Int {
        min(max(state.currentSlide, 0), max(slides.count - 1, 0))
    }

    private var activeSlide: Slide {
        slides[activeIndex]
    }

    var body: some View {
        VStack(spacing: 0) {
            SlideStage(slide: activeSlide, index: activeIndex, rootCount: rootCount, isFullscreen: isFullscreen)
                .id(activeIndex)
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            Divider()
                .padding(.horizontal, isFullscreen ? 0 : 48)
                .foregroundStyle(isFullscreen ? Color.black.opacity(0.12) : Color.secondary.opacity(0.18))

            HStack(spacing: 16) {
                Button { state.previous(count: slides.count) } label: { Image(systemName: "chevron.left") }
                    .help("上一页")
                Text("\(activeIndex + 1) / \(slides.count)")
                    .font(.caption.weight(.semibold).monospacedDigit())
                    .padding(.horizontal, 14)
                    .padding(.vertical, 6)
                    .background(controlBackground, in: Capsule())
                Button { state.next(count: slides.count) } label: { Image(systemName: "chevron.right") }
                    .help("下一页")
                Button(action: fullscreenAction) {
                    Image(systemName: isFullscreen ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right")
                }
                .help(isFullscreen ? "退出全屏演示" : "全屏演示")
            }
            .buttonStyle(.bordered)
            .controlSize(.regular)
            .padding(.top, isFullscreen ? 22 : 22)
            .padding(.bottom, isFullscreen ? 26 : 22)
        }
        .foregroundStyle(Color.primary)
        .background(surfaceBackground)
        .clipShape(RoundedRectangle(cornerRadius: isFullscreen ? 0 : 16))
        .overlay {
            if !isFullscreen {
                RoundedRectangle(cornerRadius: 16).stroke(.quaternary)
            }
        }
        .shadow(color: isFullscreen ? .clear : .black.opacity(0.08), radius: 24, y: 12)
    }

    @ViewBuilder
    private var surfaceBackground: some View {
        if isFullscreen {
            Color.white
        } else {
            LinearGradient(
                colors: [Color(nsColor: .textBackgroundColor), Color(nsColor: .controlBackgroundColor).opacity(0.65)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        }
    }

    private var controlBackground: Color {
        Color.secondary.opacity(0.14)
    }
}

private struct SlideStage: View {
    var slide: Slide
    var index: Int
    var rootCount: Int
    var isFullscreen: Bool

    var body: some View {
        VStack(alignment: .center, spacing: 26) {
            if index == 0 {
                Spacer()
                VStack(alignment: .center, spacing: isFullscreen ? 26 : 24) {
                    Text(slide.subtitle ?? "")
                        .font(.headline.weight(.semibold))
                        .textCase(.uppercase)
                        .tracking(3)
                        .foregroundStyle(Color.accentColor)
                    Text(slide.title)
                        .font(.system(size: isFullscreen ? 64 : 56, weight: .bold))
                        .lineLimit(3)
                        .minimumScaleFactor(0.45)
                        .multilineTextAlignment(.center)
                        .foregroundStyle(titleGradient)
                    Text("\(rootCount) 个主要章节")
                        .font(.callout.weight(.medium))
                        .foregroundStyle(Color.secondary)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)
                        .background(Color.secondary.opacity(0.12), in: Capsule())
                }
                .frame(maxWidth: .infinity)
                Spacer()
            } else {
                Spacer()
                HStack {
                    Spacer(minLength: 0)
                    VStack(alignment: .leading, spacing: 24) {
                        Text(slide.title)
                            .font(.system(size: isFullscreen ? 50 : 42, weight: .bold))
                            .lineLimit(3)
                            .minimumScaleFactor(0.5)
                            .foregroundStyle(titleGradient)
                        if let note = slide.note, !note.isEmpty {
                            Text(note)
                                .font(.title3.italic())
                                .foregroundStyle(Color.secondary)
                                .padding(.horizontal, 16)
                                .padding(.vertical, 10)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Color.accentColor.opacity(0.06), in: UnevenRoundedRectangle(topLeadingRadius: 0, bottomLeadingRadius: 0, bottomTrailingRadius: 8, topTrailingRadius: 8))
                                .overlay(alignment: .leading) {
                                    Rectangle()
                                        .fill(Color.accentColor)
                                        .frame(width: 4)
                                }
                        }
                        ScrollView {
                            VStack(alignment: .leading, spacing: isFullscreen ? 20 : 16) {
                                ForEach(slide.points) { point in
                                    VStack(alignment: .leading, spacing: 9) {
                                        HStack(alignment: .firstTextBaseline, spacing: 12) {
                                            Text("•")
                                                .font(.title2.bold())
                                                .foregroundStyle(Color.accentColor)
                                            Text(point.text.isEmpty ? Defaults.nodeText : point.text)
                                                .font(.system(size: isFullscreen ? 26 : 21, weight: .semibold))
                                                .foregroundStyle(Color.primary)
                                        }
                                        if !point.children.isEmpty {
                                            VStack(alignment: .leading, spacing: 8) {
                                                ForEach(point.children) { child in
                                                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                                                        Text("-")
                                                        Text(child.text.isEmpty ? Defaults.nodeText : child.text)
                                                    }
                                                    .foregroundStyle(Color.secondary)
                                                }
                                            }
                                            .font(.system(size: isFullscreen ? 20 : 16))
                                            .padding(.leading, 34)
                                            .overlay(alignment: .leading) {
                                                DashedVerticalLine(isFullscreen: isFullscreen)
                                                    .padding(.leading, 8)
                                            }
                                        }
                                    }
                                }
                                if slide.points.isEmpty {
                                    Text("无详细内容")
                                        .italic()
                                        .foregroundStyle(Color.secondary)
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.trailing, 8)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .frame(maxWidth: isFullscreen ? 860 : 760, alignment: .leading)
                    Spacer(minLength: 0)
                }
                Spacer()
            }
        }
        .padding(.horizontal, isFullscreen ? 80 : 64)
        .padding(.vertical, isFullscreen ? 70 : 52)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
        .transition(.opacity.combined(with: .move(edge: .bottom)))
        .animation(.spring(response: 0.45, dampingFraction: 0.86), value: index)
    }

    private var titleGradient: LinearGradient {
        LinearGradient(
            colors: [Color(nsColor: .labelColor), Color.accentColor],
            startPoint: .leading,
            endPoint: .trailing
        )
    }
}

private struct DashedVerticalLine: View {
    var isFullscreen: Bool

    var body: some View {
        GeometryReader { proxy in
            Path { path in
                path.move(to: CGPoint(x: 0.5, y: 0))
                path.addLine(to: CGPoint(x: 0.5, y: proxy.size.height))
            }
            .stroke(Color.secondary.opacity(0.32), style: StrokeStyle(lineWidth: 1, dash: [4, 5]))
        }
        .frame(width: 1)
    }
}

@MainActor
private final class PresentationFullscreenSession: NSObject, NSWindowDelegate {
    private let slides: [Slide]
    private let rootCount: Int
    private let state: PresentationDeckState
    private let onClose: () -> Void
    private var window: PresentationFullscreenWindow?
    private var didClose = false

    init(slides: [Slide], rootCount: Int, state: PresentationDeckState, onClose: @escaping () -> Void) {
        self.slides = slides
        self.rootCount = rootCount
        self.state = state
        self.onClose = onClose
        super.init()
    }

    func show() {
        let screen = NSApp.keyWindow?.screen ?? NSScreen.main
        let frame = screen?.frame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let window = PresentationFullscreenWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false, screen: screen)
        self.window = window
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.backgroundColor = .white
        window.level = .screenSaver
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        let slideCount = slides.count
        window.next = { [weak state] in state?.next(count: slideCount) }
        window.previous = { [weak state] in state?.previous(count: slideCount) }
        window.closePresentation = { [weak self] in self?.close() }
        window.contentView = NSHostingView(rootView: PresentationFullscreenRoot(
            slides: slides,
            rootCount: rootCount,
            state: state,
            close: { [weak self] in self?.close() }
        ))
        window.setFrame(frame, display: true)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func close() {
        window?.close()
    }

    func windowWillClose(_ notification: Notification) {
        guard !didClose else { return }
        didClose = true
        window = nil
        onClose()
    }
}

private final class PresentationFullscreenWindow: NSWindow {
    var next: (() -> Void)?
    var previous: (() -> Void)?
    var closePresentation: (() -> Void)?

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }

    override func keyDown(with event: NSEvent) {
        switch event.keyCode {
        case 53:
            closePresentation?()
        case 49, 124, 125:
            next?()
        case 123, 126:
            previous?()
        default:
            super.keyDown(with: event)
        }
    }
}

private struct PresentationFullscreenRoot: View {
    var slides: [Slide]
    var rootCount: Int
    @ObservedObject var state: PresentationDeckState
    var close: () -> Void

    var body: some View {
        PresentationDeckView(
            slides: slides,
            rootCount: rootCount,
            state: state,
            isFullscreen: true,
            fullscreenAction: close
        )
        .ignoresSafeArea()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.white)
        .colorScheme(.light)
    }
}
