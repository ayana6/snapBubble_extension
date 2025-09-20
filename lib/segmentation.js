export function groupWordRects(wordRects) {
  if (!Array.isArray(wordRects) || wordRects.length === 0) return { boxes: [], texts: [] };
  const heights = wordRects.map(b => b.height).sort((a,b) => a-b);
  const medianH = heights[Math.floor(heights.length/2)] || 16;
  const maxGap = Math.max(10, Math.floor(medianH * 0.9));
  const used = new Set();
  const isNeighbor = (a, b) => {
    const ax2 = a.left + a.width, ay2 = a.top + a.height;
    const bx2 = b.left + b.width, by2 = b.top + b.height;
    const xGap = Math.max(0, Math.max(a.left, b.left) - Math.min(ax2, bx2));
    const yGap = Math.max(0, Math.max(a.top, b.top) - Math.min(ay2, by2));
    const dist = Math.hypot(xGap, yGap);
    return dist <= maxGap;
  };
  const boxes = [];
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
    members.sort((a,b)=> a.top===b.top ? a.left-b.left : a.top-b.top);
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const m of members) {
      if (m.left < left) left = m.left;
      if (m.top < top) top = m.top;
      if (m.left + m.width > right) right = m.left + m.width;
      if (m.top + m.height > bottom) bottom = m.top + m.height;
    }
    const pad = 6;
    boxes.push({
      left: Math.max(0, left - pad),
      top: Math.max(0, top - pad),
      width: Math.max(1, (right - left) + 2*pad),
      height: Math.max(1, (bottom - top) + 2*pad),
      text: members.map(m => m.text).join(" "),
      __display: false
    });
  }
  return { boxes, texts: boxes.map(b => b.text) };
}


