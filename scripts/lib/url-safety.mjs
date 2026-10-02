import { visit } from 'unist-util-visit';

export function rehypeSanitizeUrls() {
  return (tree) => {
    visit(tree, 'element', (node) => {
      if (!node.properties) return;

      for (const property of ['href', 'src']) {
        if (property in node.properties && !isSafeUrl(node.properties[property])) {
          delete node.properties[property];
        }
      }
    });
  };
}

export function isSafeUrl(value) {
  if (Array.isArray(value)) return value.every(isSafeUrl);
  if (typeof value !== 'string') return false;

  const normalized = value.trim().replace(/[\u0000-\u001f\u007f\s]+/g, '').toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith('#')) return true;
  if (normalized.startsWith('./') || normalized.startsWith('../')) return true;
  if (normalized.startsWith('//')) return false;           // プロトコル相対は拒否
  if (normalized.startsWith('/')) return true;             // root-relative

  // コロンがあり、かつ最初の '/' より前にある場合のみスキームとして扱う
  // （'dir/a:b.png' のようにパス後方のコロンはスキームではなく相対参照）
  const colon = normalized.indexOf(':');
  if (colon !== -1) {
    const slash = normalized.indexOf('/');
    const isScheme = slash === -1 || colon < slash;
    if (isScheme) {
      const scheme = normalized.slice(0, colon);
      return ['http', 'https', 'mailto', 'tel'].includes(scheme);
    }
  }

  // スキームを持たない相対参照（'sample.png' / 'images/x.png' 等）は許可
  return true;
}
