import { CSS as STATIC_CSS, FONT_LINKS, escapeHtml, renderMeta } from './static-renderer.mjs';
import { GENERATOR_META } from './generator-marker.mjs';

export function escapeJsonForHtml(value) {
  return JSON.stringify(value)
    .replaceAll('&', '\\u0026')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

export function renderEditablePage({ title, data, editableDocument, runtimeJs, editableCss }) {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${GENERATOR_META}
  <title>${escapeHtml(title)}</title>
  ${FONT_LINKS.google}
  <style>${STATIC_CSS}\n${editableCss}</style>
</head>
<body>
  <div class="mdh-shell mdh-editable-shell" data-editable="true">
    <button class="mdh-toc-toggle" type="button" data-action="toggle-toc" aria-expanded="true">目次を閉じる</button>
    <aside class="mdh-toc" aria-label="table of contents">
      <strong>目次</strong>
      <div class="mdh-toc-tree" id="mdh-editable-toc"></div>
    </aside>
    <main class="mdh-page">
      <header class="mdh-title">
        <div class="mdh-editor-toolbar" aria-label="editor toolbar">
          <button type="button" data-action="export-markdown">Export Markdown</button>
          <button type="button" data-action="export-html">Export HTML</button>
          <button type="button" data-action="reset-edits">Reset edits</button>
        </div>
        <p class="mdh-editor-help">To continue edits after rebuilding, export Markdown and rebuild from that file.</p>
        ${renderMeta(data)}
        <h1 data-field="title">${escapeHtml(title)}</h1>
      </header>
      <article class="mdh-doc mdh-editor" data-editor-root></article>
    </main>
  </div>
  <script type="application/json" id="mdh-document-data">${escapeJsonForHtml(editableDocument)}</script>
  <script>${runtimeJs}</script>
</body>
</html>`;
}
