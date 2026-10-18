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
