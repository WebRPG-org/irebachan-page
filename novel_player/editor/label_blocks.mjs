/** 脚本パーサーの予約行と同じ判定。これ以外の @ 行がラベル定義 */
export function isLabelDefLine(raw) {
    const line = String(raw).trim();
    if (!line.startsWith("@")) return false;
    if (line.startsWith("@goto") || line.startsWith("@call")) return false;
    if (
        line === "@return" ||
        line === "@end" ||
        line === "@meta" ||
        line === "@endmeta"
    ) {
        return false;
    }
    if (/^@set(?:\s|$)/.test(line)) return false;
    if (line === "@else" || line === "@endif") return false;
    if (/^@else if(?:\s|$)/.test(line)) return false;
    if (/^@elseif(?:\s|$)/.test(line)) return false;
    if (/^@if(?:\s|$)/.test(line)) return false;
    return true;
}

/** @ラベル 行から次の @ラベル 行の手前まで。先頭の導入文は含めない */
export function listLabelBlocks(doc) {
    const starts = [];
    for (let n = 1; n <= doc.lines; n++) {
        const line = doc.line(n);
        if (isLabelDefLine(line.text)) starts.push(line);
    }
    return starts.map((line, i) => {
        const next = starts[i + 1];
        return {
            name: line.text.trim().slice(1),
            from: line.from,
            headerTo: line.to,
            to: next ? next.from : doc.length,
        };
    });
}

/** カーソル位置のラベル。導入文の中なら index は -1 */
export function labelBlockAt(doc, pos) {
    const blocks = listLabelBlocks(doc);
    for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i];
        if (pos >= block.from && (pos < block.to || i === blocks.length - 1)) {
            return { index: i, blocks };
        }
    }
    return { index: -1, blocks };
}

/**
 * ラベルブロックを並べ替える。toIndex は移動前の並びに対する挿入位置（末尾は blocks.length）。
 * 同じ場所なら null。導入文は動かさない。
 */
export function moveLabelBlock(doc, fromIndex, toIndex) {
    const blocks = listLabelBlocks(doc);
    if (fromIndex < 0 || fromIndex >= blocks.length) return null;
    if (toIndex < 0 || toIndex > blocks.length) return null;
    if (toIndex === fromIndex || toIndex === fromIndex + 1) return null;

    const ended = doc.length > 0 && doc.sliceString(doc.length - 1, doc.length) === "\n";
    const chunks = blocks.map((block) => {
        const chunk = doc.sliceString(block.from, block.to);
        return chunk.endsWith("\n") ? chunk.slice(0, -1) : chunk;
    });
    const moving = chunks.splice(fromIndex, 1)[0];
    let insertAt = toIndex;
    if (fromIndex < toIndex) insertAt -= 1;
    chunks.splice(insertAt, 0, moving);

    let cursor = blocks[0].from;
    for (let i = 0; i < insertAt; i++) cursor += chunks[i].length + 1;
    const insert = chunks.join("\n") + (ended ? "\n" : "");
    return {
        from: blocks[0].from,
        to: doc.length,
        insert,
        cursor,
    };
}
