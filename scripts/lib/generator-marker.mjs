// scripts/lib/generator-marker.mjs
//
// md-to-html が生成した HTML であることを示す generator マーカー。
// 共有用途の CLI は .html 直接共有時にこのマーカーを検査し、
// 自前生成物のみ許可する（第三者由来の信頼できない HTML を弾く）。
// .md 経路は buildNotionHtmlString が renderPage 経由でマーカーを必ず付与する。
//
// 注意: これは「うっかり第三者HTMLを共有する」事故を防ぐためのアローリストであり、
// 攻撃者が意図的にマーカーを偽装したHTMLには無力。それを防ぐ目的のものではない。

export const GENERATOR_META = '<meta name="generator" content="md-to-html">';

// meta タグ単位で name=generator かつ content=md-to-html を判定（属性順・大小文字・空白・自己終了タグ不問）。
export function hasGeneratorMarker(html) {
  if (typeof html !== 'string' || !html) return false;
  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];
  return metaTags.some(
    (tag) =>
      /\bname\s*=\s*["']generator["']/i.test(tag) &&
      /\bcontent\s*=\s*["']md-to-html["']/i.test(tag)
  );
}
