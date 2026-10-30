// タブ・印刷・コメントモードの検査。
// 見本 mockups/fixtures/components-extra/tabs-print.md を今の renderer で変換し、Chromium で DOM と計算後のスタイルを測る。
// 使い方: npm run layout:print（失敗が 1 件でもあれば終了コード 1）
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildNotionHtmlString } from './lib/build-notion.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const samplePath = path.join(root, 'mockups/fixtures/components-extra/tabs-print.md');
const diagramsPath = path.join(root, 'mockups/fixtures/components-extra/diagrams.md');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mdh-print-'));
const htmlPath = path.join(tmp, 'tabs-print.html');
await fs.writeFile(htmlPath, await buildNotionHtmlString(await fs.readFile(samplePath, 'utf8'), samplePath));
const url = pathToFileURL(htmlPath).href;
const diagramsHtml = path.join(tmp, 'diagrams.html');
await fs.writeFile(diagramsHtml, await buildNotionHtmlString(await fs.readFile(diagramsPath, 'utf8'), diagramsPath));
const diagramsUrl = pathToFileURL(diagramsHtml).href;
// 表紙の見本。type を外した版と hubLink を付けた版も作る
const typesPath = path.join(root, 'mockups/fixtures/components-extra/types-cover.md');
const types3Path = path.join(root, 'mockups/fixtures/components-extra/types-cover-3lines.md');
const typesRaw = await fs.readFile(typesPath, 'utf8');
const writeHtml = async (name, raw, src, options) => {
  const file = path.join(tmp, name);
  await fs.writeFile(file, await buildNotionHtmlString(raw, src, options));
  return pathToFileURL(file).href;
};
const typesUrl = await writeHtml('types-cover.html', typesRaw, typesPath);
const notypeUrl = await writeHtml('types-cover-notype.html', typesRaw.replace(/^type: proposal\n/m, ''), typesPath);
const hubUrl = await writeHtml('types-cover-hub.html', typesRaw, typesPath, { hubLink: { href: 'index.html' } });
const types3Url = await writeHtml('types-cover-3lines.html', await fs.readFile(types3Path, 'utf8'), types3Path);

// A4（210mm＝794px）から左右 10mm（約 38px ずつ）を引いた本文の幅
const PRINT_WIDTH = 718;
const failures = [];
const passed = [];
const check = (name, ok, detail = '') => (ok ? passed : failures).push(detail ? `${name}: ${detail}` : name);

const browser = await chromium.launch();
const open = async ({ width = 1280, height = 900, javaScriptEnabled = true, media = 'screen', target = url } = {}) => {
  const context = await browser.newContext({ viewport: { width, height }, javaScriptEnabled });
  const page = await context.newPage();
  await page.goto(target, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  if (media === 'print') await page.emulateMedia({ media: 'print' });
  await page.waitForTimeout(150);
  return page;
};
const shown = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(s)].map((el) => el.checkVisibility({ visibilityProperty: true })), sel);
const firstTabs = '.mdh-doc > .mdh-tabs';

try {
  // AC4 画面: 最初のタブだけが見え、ラベルの押下と矢印キーで切り替わる。スクリプトを止めても同じ
  for (const javaScriptEnabled of [true, false]) {
    const label = javaScriptEnabled ? 'AC4' : 'AC4（スクリプトなし）';
    const page = await open({ javaScriptEnabled });
    check(`${label} 最初のタブだけが見える`, JSON.stringify(await shown(page, `${firstTabs} > .mdh-tab-panel`)) === '[true,false,false]', JSON.stringify(await shown(page, `${firstTabs} > .mdh-tab-panel`)));
    check(`${label} タブの見出しは画面では見えない幅`, await page.evaluate((s) => [...document.querySelectorAll(`${s} .mdh-tab-heading`)].every((h) => h.getBoundingClientRect().width <= 1), firstTabs));
    await page.click(`${firstTabs} label[for="mdh-tabs-1-2"]`);
    check(`${label} 2 枚目のラベルで 2 枚目だけ`, JSON.stringify(await shown(page, `${firstTabs} > .mdh-tab-panel`)) === '[false,true,false]');
    await page.focus('#mdh-tabs-1-2');
    await page.keyboard.press('ArrowRight');
    check(`${label} 矢印キーで 3 枚目`, JSON.stringify(await shown(page, `${firstTabs} > .mdh-tab-panel`)) === '[false,false,true]');
    check(`${label} 選んだラベルのフォーカスの枠`, await page.evaluate(() => getComputedStyle(document.querySelector('#mdh-tabs-1-3 + label')).outlineStyle !== 'none'));
    await page.context().close();
  }

  // AC8 コメントモード: 縦に並び、ラベルが見えない。通常表示では切り替え
  {
    const page = await open();
    await page.evaluate(() => document.body.classList.add('cmt-mode-comment'));
    check('AC8 コメントモードで全部のタブが見える', (await shown(page, '.mdh-tab-panel')).every(Boolean));
    check('AC8 コメントモードでラベルが見えない', (await shown(page, '.mdh-tab-list')).every((v) => !v));
    check('AC8 コメントモードで見出しが見える', await page.evaluate(() => [...document.querySelectorAll('.mdh-tab-heading')].every((h) => h.getBoundingClientRect().width > 1)));
    await page.evaluate(() => { document.body.classList.remove('cmt-mode-comment'); document.body.classList.add('cmt-mode-normal'); });
    check('AC8 通常表示では切り替え', JSON.stringify(await shown(page, `${firstTabs} > .mdh-tab-panel`)) === '[true,false,false]');
    await page.context().close();
  }

  // AC5・AC6 印刷。本文の幅は A4（794px）からブラウザの印刷の既定の余白（左右 10mm）を引いた 718px。列幅をドラッグで広げた後も同じ
  for (const dragged of [false, true]) {
    const label = dragged ? 'AC5（列幅を広げた後）' : 'AC5';
    const page = await open({ width: 1280 });
    if (dragged) {
      const handle = page.locator('.mdh-doc table .mdh-col-resizer').first();
      const box = await handle.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + 300, box.y + box.height / 2, { steps: 5 });
        await page.mouse.up();
      }
      check(`${label} 列幅のドラッグが効いた`, await page.evaluate(() => Boolean(document.querySelector('.mdh-doc table.mdh-table-resized'))));
    }
    await page.setViewportSize({ width: PRINT_WIDTH, height: 1123 });
    await page.emulateMedia({ media: 'print' });
    await page.waitForTimeout(200);
    const r = await page.evaluate(() => {
      const vis = (s) => [...document.querySelectorAll(s)].filter((el) => el.checkVisibility({ visibilityProperty: true })).length;
      const doc = document.querySelector('.mdh-doc').getBoundingClientRect();
      const tables = [...document.querySelectorAll('.mdh-doc table')];
      const cs = (el) => getComputedStyle(el);
      const stack = document.querySelector('.mdh-doc table.mdh-stackable-table');
      return {
        outsideControls: [...document.querySelectorAll('label, summary, button, input')].filter((el) => !el.closest('.mdh-doc') && el.checkVisibility({ visibilityProperty: true })).map((el) => el.outerHTML.slice(0, 60)),
        hidden: ['.mdh-settings-menu', '.mdh-settings-toggle', '.mdh-settings', '.mdh-toc', '.mdh-toc-toggle', '.mdh-view-toggle', '.mdh-tab-list', 'input[name="mdh-toc"]', 'input[name="mdh-width"]', 'input[name="mdh-toc-drawer"]'].filter((s) => vis(s) > 0),
        panels: [...document.querySelectorAll('.mdh-tab-panel')].map((el) => el.checkVisibility({ visibilityProperty: true })),
        headings: [...document.querySelectorAll('.mdh-tab-heading')].map((h) => h.getBoundingClientRect().width > 1),
        toggleBody: [...document.querySelectorAll('.mdh-toggle-body')].map((el) => el.checkVisibility({ visibilityProperty: true })),
        stack: stack ? { table: cs(stack).display, thead: cs(stack.querySelector('thead')).display, td: cs(stack.querySelector('td')).display, before: getComputedStyle(stack.querySelector('td'), '::before').content } : null,
        // 紙の幅を超える要素があると Chromium は紙全体を縮めて印字する（行末の全角の閉じかっこのぶら下がりを含む）
        pageWidth: document.documentElement.scrollWidth,
        tablesRight: tables.map((t) => Math.round(t.getBoundingClientRect().right - doc.right)),
        cellOverflow: tables.flatMap((t) => [...t.querySelectorAll('td, th')]).filter((c) => c.scrollWidth > c.clientWidth + 1).length,
        // 文字のセルが 4 文字ぶん（56px）より細くならない（1 文字ずつ縦に並ぶのを防ぐ）
        narrowText: tables.flatMap((t) => [...t.querySelectorAll('td:not(.mdh-num), th:not(.mdh-num)')]).filter((c) => c.textContent.trim().length > 4 && c.clientWidth < 56).map((c) => c.textContent.trim().slice(0, 10)),
        // 数値のセル（td.mdh-num）は 1 行のまま（数字の途中で折り返さない）。数値の列の見出しは折り返してよい
        numWrapped: [...document.querySelectorAll('.mdh-doc td.mdh-num')].filter((c) => { const r = document.createRange(); r.selectNodeContents(c); const tops = new Set([...r.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top))); return tops.size > 1; }).map((c) => c.textContent.trim()),
        colorAdjust: ['.mdh-callout', '.mdh-heat', '.mdh-doc pre'].map((s) => document.querySelector(s)).map((el) => (el ? cs(el).printColorAdjust : 'missing')),
        breakAfter: [...document.querySelectorAll('.mdh-doc h1, .mdh-doc h2, .mdh-doc h3')].map((h) => cs(h).breakAfter),
        breakInside: ['.mdh-doc tr', '.mdh-callout', '.mdh-toggle', '.mdh-card'].map((s) => document.querySelector(s)).filter(Boolean).map((el) => cs(el).breakInside)
      };
    });
    check(`${label} 画面用の部品を出さない`, r.hidden.length === 0, r.hidden.join(','));
    check(`${label} 本文の外に見える操作の部品が無い`, r.outsideControls.length === 0, JSON.stringify(r.outsideControls));
    check(`${label} 全部のタブの中身と見出しが出る`, r.panels.every(Boolean) && r.headings.every(Boolean), JSON.stringify([r.panels, r.headings]));
    check(`${label} 閉じたトグルの中身が出る`, r.toggleBody.length > 0 && r.toggleBody.every(Boolean), JSON.stringify(r.toggleBody));
    check(`${label} 3 列以上の表が表の形`, r.stack && r.stack.table === 'table' && r.stack.thead === 'table-header-group' && r.stack.td === 'table-cell' && r.stack.before === 'none', JSON.stringify(r.stack));
    check(`${label} 紙の幅を超えない（紙全体が縮まない）`, r.pageWidth <= PRINT_WIDTH, String(r.pageWidth));
    check(`${label} 表の右端が本文を超えない`, r.tablesRight.every((d) => d <= 1), JSON.stringify(r.tablesRight));
    check(`${label} セルの中身がはみ出さない`, r.cellOverflow === 0, String(r.cellOverflow));
    check(`${label} 文字のセルが極端に細くならない`, r.narrowText.length === 0, JSON.stringify(r.narrowText.slice(0, 5)));
    check(`${label} 数値のセルが数字の途中で折り返さない`, r.numWrapped.length === 0, JSON.stringify(r.numWrapped.slice(0, 5)));
    check(`${label} 背景の色を印刷に出す（P10。コールアウト・ヒートマップ・コード）`, r.colorAdjust.length === 3 && r.colorAdjust.every((v) => v === 'exact'), JSON.stringify(r.colorAdjust));
    if (!dragged) {
      check('AC6 見出しの直後で改ページしない', r.breakAfter.length > 0 && r.breakAfter.every((v) => v === 'avoid'), JSON.stringify(r.breakAfter));
      check('AC6 行・コールアウト・トグル・カードの途中で改ページしない', r.breakInside.length === 4 && r.breakInside.every((v) => v === 'avoid'), JSON.stringify(r.breakInside));
    }
    await page.context().close();
  }

  // AC7 A4 の PDF の文字
  {
    const page = await open({ width: PRINT_WIDTH, height: 1123, media: 'print' });
    const pdfPath = path.join(tmp, 'tabs-print.pdf');
    await page.pdf({ path: pdfPath, format: 'A4', printBackground: true, margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' } });
    const pages = Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [pdfPath], { encoding: 'utf8' }))[1]);
    const text = execFileSync('pdftotext', [pdfPath, '-'], { encoding: 'utf8' });
    for (const t of ['担当者が休むと止まる', '委託の契約の見直し', '40 時間かかる', '2025 年 4 月 17 日から数えます', '情報システム', '確定しています']) check(`AC7 PDF に「${t}」がある`, text.includes(t));
    check('AC7 PDF に設定パネルの文字が無い', !text.includes('表示の設定'));
    const headings = await page.evaluate(() => [...document.querySelectorAll('.mdh-doc h1, .mdh-doc h2, .mdh-doc h3')].map((h) => h.textContent.trim()));
    const lastLines = [];
    for (let n = 1; n <= pages; n++) {
      const t = execFileSync('pdftotext', ['-f', String(n), '-l', String(n), pdfPath, '-'], { encoding: 'utf8' }).split('\n').map((l) => l.trim()).filter(Boolean);
      lastLines.push(t[t.length - 1] || '');
    }
    check('AC7 どのページも最後の行が見出しでない', lastLines.slice(0, -1).every((l) => !headings.includes(l)), JSON.stringify(lastLines));
    await page.context().close();
  }
  // AC5 図の画面: 縮めた後の最小の文字が 10px 以上、ページは横にはみ出さず、幅の広い図は枠の中で横にスクロールできる。図の箱が黒くない
  for (const width of [1280, 390]) {
    const page = await open({ width, target: diagramsUrl });
    const r = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      vw: innerWidth,
      figs: [...document.querySelectorAll('figure.mdh-diagram')].map((f) => {
        const svg = f.querySelector('svg');
        const scale = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
        const sizes = [...svg.querySelectorAll('[font-size]')].map((e) => Number(e.getAttribute('font-size')) * scale);
        const rect = [...svg.querySelectorAll('rect')].find((x) => !x.classList.contains('xychart-grid'));
        return { k: f.dataset.mdhDiagram, min: sizes.length ? Math.min(...sizes) : 99, black: rect ? getComputedStyle(rect).fill === 'rgb(0, 0, 0)' : false, scrolls: f.scrollWidth > f.clientWidth, overflowX: getComputedStyle(f).overflowX };
      })
    }));
    check(`AC5 ${width}px 図が 8 つ`, r.figs.length === 8, String(r.figs.length));
    check(`AC5 ${width}px 最小の文字が 10px 以上`, r.figs.every((f) => f.min >= 9.95), JSON.stringify(r.figs.map((f) => [f.k, +f.min.toFixed(1)])));
    check(`AC5 ${width}px ページが横にはみ出さない`, r.sw <= r.vw, `${r.sw}/${r.vw}`);
    check(`AC5 ${width}px 図の箱が黒く塗られていない`, r.figs.every((f) => !f.black), JSON.stringify(r.figs.filter((f) => f.black).map((f) => f.k)));
    check(`AC5 ${width}px 図の枠は横にスクロールできる`, r.figs.every((f) => f.overflowX === 'auto'));
    if (width === 390) check('AC5 390px 幅の広い図は枠の中でスクロールする', r.figs.some((f) => f.scrolls));
    await page.context().close();
  }

  // AC6 図の印刷: 紙の幅に収まり、途中で改ページしない
  {
    const page = await open({ width: PRINT_WIDTH, height: 1123, media: 'print', target: diagramsUrl });
    const r = await page.evaluate(() => {
      const doc = document.querySelector('.mdh-doc').getBoundingClientRect();
      return [...document.querySelectorAll('figure.mdh-diagram')].map((f) => ({ right: Math.round(f.querySelector('svg').getBoundingClientRect().right - doc.right), bi: getComputedStyle(f).breakInside }));
    });
    check('AC6 印刷で図が紙の幅に収まる', r.length === 8 && r.every((f) => f.right <= 1), JSON.stringify(r.map((f) => f.right)));
    check('AC6 印刷で図の途中で改ページしない', r.every((f) => f.bi === 'avoid'));
    await page.context().close();
  }
  // AC5 画面: 表紙と印刷の目次は見えず、本文の見出しの位置は type を外した同じ原稿と同じ
  for (const [width, mode] of [[1280, ''], [390, ''], [1280, 'cmt-mode-comment']]) {
    const label = `AC5 ${width}px${mode ? ' コメントモード' : ''}`;
    const measure = async (target) => {
      const page = await open({ width, target });
      if (mode) await page.evaluate((m) => document.body.classList.add(m), mode);
      await page.waitForTimeout(100);
      const r = await page.evaluate(() => ({
        front: [...document.querySelectorAll('.mdh-print-front')].map((e) => getComputedStyle(e).display),
        heads: [...document.querySelectorAll('.mdh-doc :is(h1, h2, h3)')].map((h) => { const b = h.getBoundingClientRect(); return [Math.round(b.top + scrollY), Math.round(b.left), Math.round(b.width)]; })
      }));
      await page.context().close();
      return r;
    };
    const withType = await measure(typesUrl);
    const without = await measure(notypeUrl);
    check(`${label} 表紙は display: none`, withType.front.length === 1 && withType.front[0] === 'none', JSON.stringify(withType.front));
    check(`${label} 見出しの数が同じで 1 以上`, withType.heads.length > 0 && withType.heads.length === without.heads.length, `${withType.heads.length}/${without.heads.length}`);
    check(`${label} 見出しの位置が type を外した原稿と同じ`, withType.heads.every((h, i) => h.every((v, k) => Math.abs(v - without.heads[i][k]) <= 1)), JSON.stringify([withType.heads[0], without.heads[0]]));
  }

  // AC6 印刷: 1 頁目が表紙、2 頁目が目次、3 頁目から本文。本文の頭の題と索引のリンクは出ない
  const pdfPages = (file) => {
    const pages = Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [file], { encoding: 'utf8' }))[1]);
    return Array.from({ length: pages }, (_, n) => execFileSync('pdftotext', ['-f', String(n + 1), '-l', String(n + 1), file, '-'], { encoding: 'utf8' }).split('\n').map((l) => l.trim()).filter(Boolean));
  };
  {
    const page = await open({ width: PRINT_WIDTH, height: 1123, media: 'print', target: typesUrl });
    const r = await page.evaluate(() => {
      const cs = (s) => { const e = document.querySelector(s); return e ? getComputedStyle(e) : null; };
      return {
        front: cs('.mdh-print-front')?.display, title: cs('header.mdh-title')?.display,
        l1: { pad: parseFloat(cs('.mdh-print-toc-l1').paddingLeft), size: parseFloat(cs('.mdh-print-toc-l1').fontSize) },
        l2: { pad: parseFloat(cs('.mdh-print-toc-l2').paddingLeft), size: parseFloat(cs('.mdh-print-toc-l2').fontSize) }
      };
    });
    check('AC6 印刷で表紙が出て、本文の頭の題は出ない', r.front === 'block' && r.title === 'none', JSON.stringify([r.front, r.title]));
    check('AC6 印刷の目次の 2 階層目は字下げし、1 階層目の文字が大きい', r.l2.pad > r.l1.pad && r.l1.size > r.l2.size, JSON.stringify([r.l1, r.l2]));
    const pdf = path.join(tmp, 'types-cover.pdf');
    await page.pdf({ path: pdf, format: 'A4', printBackground: true, margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' } });
    const pages = pdfPages(pdf);
    // pdftotext は全角の空白を半角にするので、比べる前にそろえる
    const p1 = pages[0].join(' ').replaceAll('\u3000', ' ');
    check('AC6 1 頁目に種類の名前・題・宛先・作成者・日付', ['提案書', 'サイト改善｜調査と提案', '株式会社サンプル　山田様', '株式会社フルスタックマーケティング', '2026年9月15日'].every((t) => p1.includes(t.replaceAll('\u3000', ' '))), p1);
    check('AC6 1 頁目に本文・status・tags が無い', !['本文の段落の目印です。', '与件', 'draft', 'sample'].some((t) => p1.includes(t)), p1);
    check('AC6 2 頁目の最初は「目次」で章の名前がある', pages[1]?.[0] === '目次' && pages[1].includes('今の状態'), JSON.stringify(pages[1]?.slice(0, 3)));
    check('AC6 3 頁目から本文', pages[2]?.[0] === 'サマリ', JSON.stringify(pages[2]?.slice(0, 2)));
    await page.context().close();
  }
  {
    const page = await open({ width: PRINT_WIDTH, height: 1123, media: 'print', target: hubUrl });
    const nav = await page.evaluate(() => [...document.querySelectorAll('nav.mdh-hub-nav')].map((e) => getComputedStyle(e).display));
    check('AC6 hubLink の版で、印刷に索引のリンクが出ない', nav.length === 1 && nav[0] === 'none', JSON.stringify(nav));
    const pdf = path.join(tmp, 'types-cover-hub.pdf');
    await page.pdf({ path: pdf, format: 'A4', printBackground: true, margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' } });
    check('AC6 hubLink の版の 1 頁目の最初は種類の名前', pdfPages(pdf)[0][0] === '提案書', JSON.stringify(pdfPages(pdf)[0].slice(0, 2)));
    await page.context().close();
  }

  // 印刷では、コメント配信先の包み（#cmt-imported-document）の中でも文字のセルの最低幅は 4 文字ぶん（画面の 8em を持ち込まない）
  for (const wrapped of [false, true]) {
    const page = await open({ width: PRINT_WIDTH, height: 1123, media: 'print' });
    if (wrapped) await page.evaluate(() => { const w = document.createElement('div'); w.id = 'cmt-imported-document'; w.append(...document.body.childNodes); document.body.append(w); });
    await page.waitForTimeout(100);
    const r = await page.evaluate(() => { const c = document.querySelector('.mdh-doc td:not(.mdh-num)'); const s = getComputedStyle(c); return { min: parseFloat(s.minWidth), font: parseFloat(s.fontSize), inWrap: Boolean(c.closest('#cmt-imported-document')) }; });
    check(`印刷で文字のセルの最低幅が 4 文字ぶん${wrapped ? '（コメント配信先の包みの中）' : ''}`, r.inWrap === wrapped && Math.abs(r.min - 4 * r.font) <= 1, JSON.stringify(r));
    await page.context().close();
  }

  // AC7 題が 3 行でも、A4 と Letter（余白 15mm）で表紙が 1 頁に収まる
  {
    const page = await open({ width: PRINT_WIDTH, height: 1123, media: 'print', target: types3Url });
    const lines = await page.evaluate(() => {
      const t = document.querySelector('.mdh-cover-title');
      const range = document.createRange(); range.selectNodeContents(t);
      return { br: t.querySelectorAll('br').length, tops: new Set([...range.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top))).size };
    });
    check('AC7 表紙の題が 3 行で出る', lines.br === 2 && lines.tops === 3, JSON.stringify(lines));
    for (const format of ['A4', 'Letter']) {
      const pdf = path.join(tmp, `types-cover-3lines-${format}.pdf`);
      await page.pdf({ path: pdf, format, printBackground: true, margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' } });
      const pages = pdfPages(pdf);
      check(`AC7 ${format} で 2 頁目の最初が「目次」`, pages[1]?.[0] === '目次', JSON.stringify(pages[1]?.slice(0, 2)));
    }
    await page.context().close();
  }
} finally {
  await browser.close();
}

for (const p of passed) console.log(`ok ${p}`);
for (const f of failures) console.error(`NG ${f}`);
console.log(`layout:print ${passed.length} 件 ok・${failures.length} 件 NG`);
process.exit(failures.length ? 1 : 0);
