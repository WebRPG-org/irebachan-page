import { Compartment, EditorState } from "@codemirror/state";
import {
    EditorView,
    ViewPlugin,
    keymap,
    lineNumbers,
    highlightActiveLineGutter,
    highlightSpecialChars,
    drawSelection,
    dropCursor,
    rectangularSelection,
    crosshairCursor,
    highlightActiveLine,
    Decoration,
} from "@codemirror/view";
import {
    foldGutter,
    foldService,
    indentOnInput,
    syntaxHighlighting,
    defaultHighlightStyle,
    bracketMatching,
    foldKeymap,
} from "@codemirror/language";
import { history, defaultKeymap, historyKeymap } from "@codemirror/commands";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import {
    closeBrackets,
    autocompletion,
    closeBracketsKeymap,
    completionKeymap,
} from "@codemirror/autocomplete";
import { lintKeymap } from "@codemirror/lint";
import { novelLanguage } from "./novel_syntax.mjs";
import { buildColorThemeExtensions } from "./novel_theme.mjs";
import { getStoredThemeId } from "./novel_editor_colors.mjs";
import { isLabelDefLine, labelBlockAt, listLabelBlocks, moveLabelBlock } from "./label_blocks.mjs";

function clearDomTextSelection() {
    const sel = window.getSelection?.();
    if (sel?.rangeCount) sel.removeAllRanges();
}

function isCoarsePointer() {
    return (
        typeof window !== "undefined" &&
        window.matchMedia("(pointer: coarse)").matches
    );
}

function symbolBarCover(scrollerRect) {
    const bar = document.getElementById("symbolBar");
    if (!bar || bar.hidden || !scrollerRect) return 0;
    const barRect = bar.getBoundingClientRect();
    const overlap = Math.min(barRect.bottom, scrollerRect.bottom) - Math.max(barRect.top, scrollerRect.top);
    return overlap > 0 ? overlap : 0;
}

/** カーソルとキーボード上端・画面上端の間に空ける余白(px) */
const KEYBOARD_SCROLL_PADDING = 12;

/**
 * エディタのスクロール領域のうち、実際の画面（visualViewport）の外にはみ出している上下の幅。
 * iOS などキーボードがレイアウトを縮めず上に被さる環境で、被さった分を「見えない」と扱う。
 */
function getHiddenScrollerInsets(view) {
    const vv = window.visualViewport;
    if (!vv) return null;
    const rect = view.scrollDOM.getBoundingClientRect();
    const visibleTop = vv.offsetTop;
    const visibleBottom = vv.offsetTop + vv.height;
    return {
        top: Math.max(0, visibleTop - rect.top),
        bottom: Math.max(0, rect.bottom - visibleBottom) + symbolBarCover(rect),
    };
}

/**
 * baseScrollTop のままでカーソルが見えていればそれを、見えなければ見える位置まで最小限ずらした scrollTop を返す
 */
function scrollTopKeepingCursorVisible(view, baseScrollTop) {
    const scroller = view.scrollDOM;
    const head = view.state.selection.main.head;
    const rect = scroller.getBoundingClientRect();
    const coords = view.coordsAtPos(head);
    let lineTop;
    let lineBottom;
    if (coords) {
        lineTop = coords.top - rect.top + scroller.scrollTop;
        lineBottom = coords.bottom - rect.top + scroller.scrollTop;
    } else {
        const block = view.lineBlockAt(head);
        const docTop = view.documentTop - rect.top + scroller.scrollTop;
        lineTop = docTop + block.top;
        lineBottom = docTop + block.bottom;
    }
    const hidden = getHiddenScrollerInsets(view) ?? { top: 0, bottom: 0 };
    const viewTop = hidden.top + KEYBOARD_SCROLL_PADDING;
    const viewBottom = scroller.clientHeight - hidden.bottom - KEYBOARD_SCROLL_PADDING;
    let target = baseScrollTop;
    if (lineBottom - target > viewBottom) target = lineBottom - viewBottom;
    if (lineTop - target < viewTop) target = lineTop - viewTop;
    const maxScroll = scroller.scrollHeight - scroller.clientHeight;
    return Math.max(0, Math.min(target, maxScroll));
}

/** タップ後、ブラウザ等による自動スクロールを打ち消す時間(ms) */
const TAP_SCROLL_GUARD_MS = 800;
/** これ以上指が動いたらタップではなくスクロール操作とみなす(px) */
const TAP_MOVE_TOLERANCE = 10;

function buildMobileTouchScrollExtensions() {
    if (!isCoarsePointer()) return [];

    const scrollMargins = EditorView.scrollMargins.of((view) => {
        if (!view.hasFocus) return null;
        const hidden = getHiddenScrollerInsets(view);
        if (!hidden) return null;
        return {
            top: hidden.top + KEYBOARD_SCROLL_PADDING,
            bottom: hidden.bottom + KEYBOARD_SCROLL_PADDING,
        };
    });

    /**
     * Android Chrome はキーボード表示中に入力欄をタップするたび「入力欄をカーソルが見える位置へ」
     * 独自にスクロールし、大きな入力欄だと本文が大きく飛ぶ。タップ直後のスクロールは打ち消し、
     * タップした行が隠れる場合だけ見える端まで最小限動かす。
     */
    const viewportPlugin = ViewPlugin.fromClass(
        class MobileKeyboardScroll {
            constructor(view) {
                this.view = view;
                this.padBottom = 0;
                this.attrs = null;
                this._touch = null;
                this._base = 0;
                this._guardUntil = 0;
                this._raf = 0;
                this._timer = 0;
                const scroller = view.scrollDOM;

                this._onTouchStart = (e) => {
                    this._guardUntil = 0;
                    const t = e.touches.length === 1 ? e.touches[0] : null;
                    this._touch = t ? { x: t.clientX, y: t.clientY, moved: false } : null;
                };
                this._onTouchMove = (e) => {
                    const t = e.touches[0];
                    if (!this._touch || !t) return;
                    if (
                        Math.abs(t.clientX - this._touch.x) > TAP_MOVE_TOLERANCE ||
                        Math.abs(t.clientY - this._touch.y) > TAP_MOVE_TOLERANCE
                    ) {
                        this._touch.moved = true;
                    }
                };
                this._onTouchEnd = () => {
                    const touch = this._touch;
                    this._touch = null;
                    if (!touch || touch.moved) return;
                    this._base = scroller.scrollTop;
                    this._guardUntil = Date.now() + TAP_SCROLL_GUARD_MS;
                };
                this._onScroll = () => {
                    if (this._touch || Date.now() > this._guardUntil) return;
                    this.enforce(this._base);
                };
                this._vvHeight = window.visualViewport?.height ?? 0;
                this._onViewportChange = () => {
                    const height = window.visualViewport?.height ?? 0;
                    const shrank = height < this._vvHeight - 1;
                    this._vvHeight = height;
                    const guarding = Date.now() <= this._guardUntil;
                    if (guarding) {
                        this._guardUntil = Date.now() + TAP_SCROLL_GUARD_MS;
                    } else if (!shrank) {
                        return;
                    }
                    cancelAnimationFrame(this._raf);
                    clearTimeout(this._timer);
                    const run = () => {
                        if (!view.hasFocus || this._touch) return;
                        this.enforce(guarding ? this._base : scroller.scrollTop);
                    };
                    this._raf = requestAnimationFrame(run);
                    this._timer = setTimeout(run, 300);
                };

                scroller.addEventListener("touchstart", this._onTouchStart, { passive: true });
                scroller.addEventListener("touchmove", this._onTouchMove, { passive: true });
                scroller.addEventListener("touchend", this._onTouchEnd, { passive: true });
                scroller.addEventListener("touchcancel", this._onTouchStart, { passive: true });
                scroller.addEventListener("scroll", this._onScroll, { passive: true });
                window.visualViewport?.addEventListener("resize", this._onViewportChange);
            }

            enforce(base) {
                const scroller = this.view.scrollDOM;
                const target = scrollTopKeepingCursorVisible(this.view, base);
                this._base = target;
                if (Math.abs(scroller.scrollTop - target) >= 1) scroller.scrollTop = target;
            }

            /** 文末でもカーソル行をキーボードの上まで持ち上げられるよう、隠れた分だけ下に余白を足す */
            update(update) {
                const hidden = update.view.hasFocus
                    ? getHiddenScrollerInsets(update.view)
                    : null;
                const pad = hidden?.bottom
                    ? Math.round(hidden.bottom + KEYBOARD_SCROLL_PADDING * 2)
                    : 0;
                if (pad === this.padBottom) return;
                this.padBottom = pad;
                this.attrs = pad > 0 ? { style: `padding-bottom: ${pad}px` } : null;
            }

            destroy() {
                cancelAnimationFrame(this._raf);
                clearTimeout(this._timer);
                const scroller = this.view.scrollDOM;
                scroller.removeEventListener("touchstart", this._onTouchStart);
                scroller.removeEventListener("touchmove", this._onTouchMove);
                scroller.removeEventListener("touchend", this._onTouchEnd);
                scroller.removeEventListener("touchcancel", this._onTouchStart);
                scroller.removeEventListener("scroll", this._onScroll);
                window.visualViewport?.removeEventListener("resize", this._onViewportChange);
            }
        },
        {
            provide: (plugin) =>
                EditorView.contentAttributes.of(
                    (view) => view.plugin(plugin)?.attrs ?? null
                ),
        }
    );

    return [scrollMargins, viewportPlugin];
}

const colorThemeCompartment = new Compartment();

/** ラベル行の末尾から、次のラベルとの区切り改行の手前までを折りたためるようにする */
function labelBodyFoldRange(doc, block) {
    if (!block) return null;
    let to = block.to;
    if (to < doc.length) to -= 1;
    if (block.headerTo >= to) return null;
    return { from: block.headerTo, to };
}

const labelHeadMark = Decoration.line({ class: "cm-labelHead" });

/** 三角が被らないよう、ラベル行だけ文字を右へずらす */
const labelHeadPlugin = ViewPlugin.fromClass(class {
    constructor(view) {
        this.decorations = this.build(view);
    }
    update(update) {
        if (update.docChanged || update.viewportChanged) {
            this.decorations = this.build(update.view);
        }
    }
    build(view) {
        const marks = [];
        for (const { from, to } of view.visibleRanges) {
            let pos = from;
            while (pos <= to) {
                const line = view.state.doc.lineAt(pos);
                if (isLabelDefLine(line.text)) marks.push(labelHeadMark.range(line.from));
                if (line.to >= view.state.doc.length) break;
                pos = line.to + 1;
            }
        }
        return Decoration.set(marks);
    }
}, {
    decorations: (plugin) => plugin.decorations,
});

const labelFoldService = foldService.of((state, lineStart) => {
    const line = state.doc.lineAt(lineStart);
    const { index, blocks } = labelBlockAt(state.doc, line.from);
    if (index < 0 || blocks[index].from !== line.from) return null;
    return labelBodyFoldRange(state.doc, blocks[index]);
});

/** 開いているラベルは下向き、たたんだラベルは右向き。長押しでブロックを移動 */
function foldMarkerDOM(open) {
    const span = document.createElement("span");
    span.className = open ? "cm-foldMarker is-open" : "cm-foldMarker is-folded";
    return span;
}

const LABEL_DRAG_HOLD_MS = 280;

function bindLabelBlockDrag(view) {
    const indicator = document.createElement("div");
    indicator.className = "label-drag-indicator";
    indicator.hidden = true;
    document.body.appendChild(indicator);

    let drag = null;
    let suppressClick = false;

    const blockIndexAt = (clientY) => {
        const rect = view.contentDOM.getBoundingClientRect();
        const pos = view.posAtCoords({ x: rect.left + 16, y: clientY });
        if (pos == null) return -1;
        const found = labelBlockAt(view.state.doc, pos);
        if (found.index >= 0) return found.index;
        const blocks = found.blocks;
        if (!blocks.length) return -1;
        const first = view.coordsAtPos(blocks[0].from);
        return first && clientY < first.top ? 0 : -1;
    };

    const dropIndexAt = (clientY) => {
        const blocks = listLabelBlocks(view.state.doc);
        if (!blocks.length) return 0;
        for (let i = 0; i < blocks.length; i++) {
            const top = view.coordsAtPos(blocks[i].from)?.top;
            if (top == null) continue;
            const nextTop = i + 1 < blocks.length
                ? view.coordsAtPos(blocks[i + 1].from)?.top
                : view.contentDOM.getBoundingClientRect().bottom;
            const mid = nextTop == null ? top : (top + nextTop) / 2;
            if (clientY < mid) return i;
        }
        return blocks.length;
    };

    const placeIndicator = (index) => {
        const blocks = listLabelBlocks(view.state.doc);
        if (!blocks.length || !drag) return;
        const rect = view.contentDOM.getBoundingClientRect();
        let y;
        if (index <= 0) y = view.coordsAtPos(blocks[0].from)?.top;
        else if (index >= blocks.length) {
            const tail = Math.max(0, view.state.doc.length - 1);
            y = view.coordsAtPos(tail)?.bottom;
        } else y = view.coordsAtPos(blocks[index].from)?.top;
        if (y == null) {
            indicator.hidden = true;
            return;
        }
        const same = index === drag.index || index === drag.index + 1;
        indicator.hidden = false;
        indicator.classList.toggle("is-same", same);
        indicator.style.left = `${rect.left}px`;
        indicator.style.width = `${rect.width}px`;
        indicator.style.top = `${y}px`;
    };

    const clearDrag = () => {
        if (!drag) return;
        clearTimeout(drag.timer);
        drag.marker?.classList.remove("is-holding");
        view.dom.classList.remove("is-label-dragging");
        indicator.hidden = true;
        drag = null;
    };

    view.dom.addEventListener("pointerdown", (event) => {
        const marker = event.target.closest?.(".cm-foldMarker");
        if (!marker || !view.dom.contains(marker)) return;
        if (event.button != null && event.button !== 0) return;
        const index = blockIndexAt(event.clientY);
        if (index < 0) return;
        drag = {
            pointerId: event.pointerId,
            index,
            drop: index,
            startX: event.clientX,
            startY: event.clientY,
            armed: false,
            moved: false,
            marker,
            timer: 0,
        };
        try {
            marker.setPointerCapture?.(event.pointerId);
        } catch {
            /* 合成イベントや未対応ブラウザではキャプチャしない */
        }
        drag.timer = window.setTimeout(() => {
            if (!drag || drag.pointerId !== event.pointerId) return;
            drag.armed = true;
            drag.marker.classList.add("is-holding");
            view.dom.classList.add("is-label-dragging");
            drag.drop = dropIndexAt(event.clientY);
            placeIndicator(drag.drop);
        }, LABEL_DRAG_HOLD_MS);
    });

    view.dom.addEventListener("pointermove", (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (!drag.armed) {
            if (dx * dx + dy * dy > 64) {
                suppressClick = true;
                clearDrag();
            }
            return;
        }
        event.preventDefault();
        drag.drop = dropIndexAt(event.clientY);
        placeIndicator(drag.drop);
    });

    const finish = (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const armed = drag.armed;
        const fromIndex = drag.index;
        const toIndex = drag.drop;
        if (armed || drag.moved) {
            suppressClick = true;
            window.setTimeout(() => { suppressClick = false; }, 400);
        }
        clearDrag();
        if (!armed) return;
        const change = moveLabelBlock(view.state.doc, fromIndex, toIndex);
        if (!change) return;
        view.dispatch({
            changes: { from: change.from, to: change.to, insert: change.insert },
            selection: { anchor: change.cursor },
            scrollIntoView: true,
        });
        view.focus();
    };

    view.dom.addEventListener("pointerup", finish);
    view.dom.addEventListener("pointercancel", (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        if (drag.armed || drag.moved) {
            suppressClick = true;
            window.setTimeout(() => { suppressClick = false; }, 400);
        }
        clearDrag();
    });
    view.dom.addEventListener("click", (event) => {
        if (!suppressClick) return;
        suppressClick = false;
        event.preventDefault();
        event.stopPropagation();
    }, true);
}

/** basicSetup と同じ構成。折りたたみ印だけ三角にする */
const editorSetup = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter({ markerDOM: foldMarkerDOM }),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        ...lintKeymap,
    ]),
];

export function createScenarioEditor(parent, options = {}) {
    const { onChange, onPreviewShortcut, onSyncEditorShortcut, onCursorChange, onFocusChange } = options;
    const initialTheme = getStoredThemeId();
    let backgroundPaused = false;

    const previewKeymap = keymap.of([
        {
            key: "Mod-Enter",
            run: () => {
                onPreviewShortcut?.();
                return true;
            },
        },
        {
            key: "Mod-Shift-Enter",
            run: () => {
                onSyncEditorShortcut?.();
                return true;
            },
        },
    ]);

    const view = new EditorView({
        parent,
        doc: "",
        extensions: [
            editorSetup,
            novelLanguage,
            labelFoldService,
            labelHeadPlugin,
            colorThemeCompartment.of(buildColorThemeExtensions(initialTheme)),
            EditorView.lineWrapping,
            previewKeymap,
            ...buildMobileTouchScrollExtensions(),
            EditorView.updateListener.of((update) => {
                if (update.docChanged) {
                    onChange?.();
                }
                if (backgroundPaused) return;
                if (update.selectionSet || update.docChanged) {
                    onCursorChange?.();
                }
            }),
        ],
    });

    parent.classList.add("script-editor-host--ready");
    bindLabelBlockDrag(view);

    view.dom.addEventListener("focusin", () => onFocusChange?.(true));
    view.dom.addEventListener("focusout", (event) => {
        if (view.dom.contains(event.relatedTarget)) return;
        onFocusChange?.(false);
    });

    return {
        getValue() {
            return view.state.doc.toString();
        },

        setValue(text) {
            const next = text ?? "";
            const cur = view.state.doc.toString();
            if (cur === next) return;
            view.dispatch({
                changes: { from: 0, to: view.state.doc.length, insert: next },
            });
        },

        getCursorLine() {
            return view.state.doc.lineAt(view.state.selection.main.head).number - 1;
        },

        goToLine(lineNum, options = {}) {
            if (lineNum < 0) return;
            const lineCount = view.state.doc.lines;
            if (lineCount === 0) return;
            const line = view.state.doc.line(Math.min(lineNum + 1, lineCount));
            const scrollY = options.scrollY ?? "center";
            const yMargin =
                options.yMargin ?? (scrollY === "start" ? 96 : 5);
            view.dispatch({
                selection: { anchor: line.from, head: line.from },
                effects: EditorView.scrollIntoView(line.from, {
                    y: scrollY,
                    yMargin,
                }),
            });
            if (options.focus !== false) {
                view.focus();
                if (options.clearNativeSelection) {
                    clearDomTextSelection();
                    requestAnimationFrame(clearDomTextSelection);
                }
            }
        },

        isFocused() {
            return view.hasFocus;
        },

        focus() {
            view.focus();
        },

        clearNativeSelection() {
            clearDomTextSelection();
        },

        selectAll() {
            view.dispatch({
                selection: { anchor: 0, head: view.state.doc.length },
            });
        },

        getView() {
            return view;
        },

        getAppTheme() {
            return getStoredThemeId();
        },

        setAppTheme(themeId) {
            view.dispatch({
                effects: colorThemeCompartment.reconfigure(
                    buildColorThemeExtensions(themeId)
                ),
            });
        },

        setBackgroundPaused(paused) {
            backgroundPaused = Boolean(paused);
        },

        insertAtCursor(text) {
            const sel = view.state.selection.main;
            let insert = text;
            if (insert.startsWith(" ") && sel.from > 0) {
                const prev = view.state.doc.sliceString(sel.from - 1, sel.from);
                if (/\s/.test(prev)) insert = insert.replace(/^\s+/, "");
            }
            const at = sel.from + insert.length;
            view.dispatch({
                changes: { from: sel.from, to: sel.to, insert },
                selection: { anchor: at },
                effects: EditorView.scrollIntoView(at, { y: "nearest" }),
            });
            view.focus();
        },
    };
}

/* global __EDITOR_BUILD__ */
const EDITOR_BUILD = typeof __EDITOR_BUILD__ === "string" ? __EDITOR_BUILD__ : "dev";

if (typeof window !== "undefined") {
    window.ScenarioEditor = { create: createScenarioEditor, build: EDITOR_BUILD };
    const showBuild = () => {
        const el = document.getElementById("editorBuildStamp");
        if (el) el.textContent = EDITOR_BUILD;
    };
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", showBuild);
    } else {
        showBuild();
    }
}
