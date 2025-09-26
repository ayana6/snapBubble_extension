export function groupWordRects(wordRects) {
  if (!Array.isArray(wordRects) || wordRects.length === 0) return { boxes: [], texts: [] };
  const heights = wordRects.map(b => Math.max(1, b.height)).sort((a,b) => a-b);
  const medianH = heights[Math.floor(heights.length/2)] || 16;
  const maxGapX = Math.max(8, Math.floor(medianH * 1.0));
  const maxGapY = Math.max(8, Math.floor(medianH * 1.2));

  const used = new Set();
  const isNeighbor = (a, b) => {
    const ax2 = a.left + a.width, ay2 = a.top + a.height;
    const bx2 = b.left + b.width, by2 = b.top + b.height;
    const xGap = Math.max(0, Math.max(a.left, b.left) - Math.min(ax2, bx2));
    const yGap = Math.max(0, Math.max(a.top, b.top) - Math.min(ay2, by2));
    const xLimit = Math.min(maxGapX, Math.max(a.width, b.width) * 0.6);
    const yLimit = Math.min(maxGapY, Math.max(a.height, b.height) * 0.5);
    const aCy = a.top + a.height / 2, bCy = b.top + b.height / 2;
    const aCx = a.left + a.width / 2, bCx = b.left + b.width / 2;
    const sameRow = Math.abs(aCy - bCy) <= Math.max(a.height, b.height) * 0.8;
    const sameCol = Math.abs(aCx - bCx) <= Math.max(a.width, b.width) * 0.8;
    return (xGap <= xLimit && yGap <= yLimit && (sameRow || sameCol));
  };

  const clusters = [];
  for (let i = 0; i < wordRects.length; i++) {
    if (used.has(i)) continue;
    const q = [i];
    used.add(i);
    const members = [wordRects[i]];
    while (q.length) {
      const idx = q.pop();
      const a = wordRects[idx];
      for (let j = 0; j < wordRects.length; j++) {
        if (used.has(j)) continue;
        if (isNeighbor(a, wordRects[j])) {
          used.add(j);
          q.push(j);
          members.push(wordRects[j]);
        }
      }
    }
    clusters.push(members);
  }

  const rectOf = (list) => {
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const m of list) {
      left = Math.min(left, m.left);
      top = Math.min(top, m.top);
      right = Math.max(right, m.left + m.width);
      bottom = Math.max(bottom, m.top + m.height);
    }
    return { left, top, right, bottom };
  };
  const merged = clusters.map(c => ({ rect: rectOf(c), words: c }));

  const boxes = [];
  const texts = [];
  for (const c of merged) {
    const { left, top, right, bottom } = c.rect;
    const pad = 6;
    boxes.push({
      left: Math.max(0, left - pad),
      top: Math.max(0, top - pad),
      width: Math.max(1, (right - left) + 2*pad),
      height: Math.max(1, (bottom - top) + 2*pad),
      text: c.words.sort((a,b)=> a.top===b.top ? a.left-b.left : a.top-b.top).map(m => m.text).join(' '),
      __display: false
    });
    texts.push(boxes[boxes.length - 1].text);
  }

  return { boxes, texts };
}
