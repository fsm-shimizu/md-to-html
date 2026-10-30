// 文書のスクリプトが動かない配信先（CSP でスクリプトを止める環境）でも、静的版が CSS と部品だけで使えることを確かめる
// Playwright の javaScriptEnabled: false の context で DOM を実測する。
// 対照として、スクリプトが動く context で設定ボタンが見えることも見る。
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_TARGETS = ['mockups/generated/fixture-long.html', 'mockups/generated/fixture-table-stack.html'];
const targets = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_TARGETS;
const TOLERANCE = 2;
const MENU = 'details.mdh-settings-menu';
const browser = await chromium.launch();
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mdh-noscript-'));
let tablesChecked = 0;

const visible = (el) => {
  if (!el) return false;
  const style = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  // 閉じた details の中身は矩形を持つが描画されないので、checkVisibility で描画の有無も見る。
  return el.checkVisibility({ visibilityProperty: true }) && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0 && rect.right > 0;
};
const measure = (page) => page.evaluate(`(() => {
  const visible = ${visible.toString()};
  const menu = document.querySelector('${MENU}');
  const p = document.querySelector('.mdh-doc');
  return {
    menu: Boolean(menu),
    open: Boolean(menu && menu.open),
    toggle: visible(document.querySelector('.mdh-settings-toggle')),
    panel: visible(document.querySelector('.mdh-settings')),
    scripted: visible(document.querySelector('.mdh-settings-scripted')),
    toc: visible(document.querySelector('.mdh-toc')),
    p: p ? Math.round(p.getBoundingClientRect().width) : 0,
    tables: [...document.querySelectorAll('.mdh-doc .mdh-table-scroll > table')].map((table) => {
      const scroll = table.parentElement;
      const rect = table.getBoundingClientRect();
      return { table: rect.width, height: rect.height, parent: scroll.clientWidth, scrolls: scroll.scrollWidth > scroll.clientWidth + 1 };
    })
  };
})()`);
const pressLabel = (page, name, value) => page.locator(`#mdhSettingsPanel label:has(input[name="${name}"]${value ? `[value="${value}"]` : ''})`).click();

// 1 つの HTML について、スクリプトなしの振る舞いを確かめ、失敗の一覧を返す。
async function checkFile(file, { label = file } = {}) {
  const failures = [];
  const check = (ok, message) => { if (!ok) failures.push(`${label}: ${message}`); };
  const url = pathToFileURL(path.resolve(file)).href;
  const fileHasTables = (await fs.readFile(file, 'utf8')).includes('mdh-table-scroll');

  // 1280px・1440px: 設定ボタン・パネル・目次・幅・表
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, javaScriptEnabled: false });
    const page = await context.newPage();
    try {
      await page.goto(url);
      let m = await measure(page);
      check(m.menu, 'no-script: settings menu (details) is missing');
      check(m.toggle, 'no-script: settings toggle should be visible');
      check(!m.open && !m.panel, 'no-script: panel should start closed');
      if (m.menu) {
        await page.locator('.mdh-settings-toggle').click();
        m = await measure(page);
        check(m.open && m.panel, 'no-script: pressing the toggle should open the panel');
        check(!m.scripted, 'no-script: heading colours and export should be hidden');
        await page.locator('.mdh-settings-toggle').click();
        check(!(await measure(page)).open, 'no-script: pressing the toggle again should close the panel');
        await page.locator('.mdh-settings-toggle').click();
        check((await measure(page)).p >= 720 - TOLERANCE, 'no-script: default body width');
        await pressLabel(page, 'mdh-toc', 'hide');
        check(!(await measure(page)).toc, '1440px no-script: hiding the toc should hide it');
        const widths = {};
        for (const w of ['normal', 'wide', 'full']) { await pressLabel(page, 'mdh-width', w); widths[w] = (await measure(page)).p; }
        check(Math.abs(widths.normal - 720) <= TOLERANCE, `1440px no-script: normal width ${widths.normal}`);
        check(Math.abs(widths.wide - 880) <= TOLERANCE, `1440px no-script: wide width ${widths.wide}`);
        check(Math.abs(widths.full - 1360) <= TOLERANCE, `1440px no-script: full width ${widths.full}`);
        await pressLabel(page, 'mdh-toc', 'show');
        await pressLabel(page, 'mdh-width', 'normal');
        check((await measure(page)).toc, '1440px no-script: showing the toc should show it');
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      m = await measure(page);
      check(m.tables.length > 0 || !fileHasTables, '1280px no-script: expected tables in the fixture');
      for (const [i, t] of m.tables.entries()) {
        // 本文ごと隠れて幅が両方 0 になったときに通らないよう、見えていることを先に確かめる。
        if (!(t.table > 0 && t.height > 0 && t.parent > 0)) {
          check(false, `1280px no-script: table ${i} is not rendered (${t.table}x${t.height}, parent ${t.parent})`);
          continue;
        }
        if (t.scrolls) continue;
        tablesChecked += 1;
        check(t.table >= t.parent - TOLERANCE, `1280px no-script: table ${i} should fill the body width (${Math.round(t.table)}/${t.parent})`);
      }
    } finally {
      await context.close();
    }
  }

  // 390px: 引き出しは閉じて始まり、スイッチで開き、パネルを閉じるとリンクを押せる。幅の選択は効かない。
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, javaScriptEnabled: false });
    const page = await context.newPage();
    try {
      await page.goto(url);
      let m = await measure(page);
      check(!m.toc, '390px no-script: table of contents should start closed');
      if (m.menu) {
        const base = m.p;
        await page.locator('.mdh-settings-toggle').click();
        for (const w of ['wide', 'full', 'normal']) {
          await pressLabel(page, 'mdh-width', w);
          const p = (await measure(page)).p;
          check(Math.abs(p - base) <= TOLERANCE, `390px no-script: width ${w} should not change the body (${p}/${base})`);
        }
        await pressLabel(page, 'mdh-toc-drawer');
        await page.waitForTimeout(250); // 引き出しの transition（.16s）を待つ
        check((await measure(page)).toc, '390px no-script: the drawer switch should open the toc');
        await page.locator('.mdh-settings-toggle').click();
        check(!(await measure(page)).panel, '390px no-script: the toggle should close the panel');
        const link = page.locator('.mdh-toc a[href^="#"]:visible').first();
        const href = await link.getAttribute('href');
        await link.click();
        check(decodeURIComponent(await page.evaluate(() => location.hash)) === decodeURIComponent(href), '390px no-script: the first toc link should be clickable after closing the panel');
        await page.locator('.mdh-settings-toggle').click();
        await pressLabel(page, 'mdh-toc-drawer');
        await page.waitForTimeout(250);
        check(!(await measure(page)).toc, '390px no-script: the drawer switch should close the toc');
      }
    } finally {
      await context.close();
    }
  }

  // 部品の初期値（書き出した HTML の埋め込み）どおりに始まる（AC5 のスクリプトなしの側）
  {
    const html = await fs.readFile(file, 'utf8');
    const preset = html
      .replace(/(<input type="radio" name="mdh-toc" value="show") checked/, '$1')
      .replace(/(<input type="radio" name="mdh-toc" value="hide")/, '$1 checked')
      .replace(/(<input type="radio" name="mdh-width" value="normal") checked/, '$1')
      .replace(/(<input type="radio" name="mdh-width" value="wide")/, '$1 checked');
    const presetFile = path.join(tmp, `preset-${path.basename(file)}`);
    await fs.writeFile(presetFile, preset);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, javaScriptEnabled: false });
    const page = await context.newPage();
    try {
      await page.goto(pathToFileURL(presetFile).href);
      const m = await measure(page);
      check(preset !== html, 'preset: the fixture has no settings inputs to preset');
      check(!m.toc && Math.abs(m.p - 880) <= TOLERANCE, `preset no-script: should start with the embedded toc and width (toc ${m.toc}, width ${m.p})`);
    } finally {
      await context.close();
    }
  }

  // 対照: スクリプトが動くと設定ボタンが見える
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    try {
      await page.goto(url);
      check((await measure(page)).toggle, '1280px with script: settings toggle should be visible');
    } finally {
      await context.close();
    }
  }
  return failures;
}

const failures = [];
try {
  for (const file of targets) {
    try {
      await fs.access(file);
    } catch {
      failures.push(`${file}: file not found`);
      continue;
    }
    failures.push(...(await checkFile(file)));
  }
  // 表を 1 つも測らずに通る空振りを防ぐ。
  if (tablesChecked === 0) failures.push('no table was measured');
  // 入口の負例: 設定の部品を取り除いた写しでは、同じ検査が落ちること。
  const negative = path.join(tmp, 'no-menu.html');
  await fs.writeFile(negative, (await fs.readFile(targets[0], 'utf8')).replace(/<details class="mdh-settings-menu">[\s\S]*?<\/details>/, ''));
  // 入口の欠落そのものを報告したときだけ負例の合格とする（別の理由の失敗を合格にしない）。
  const negativeFailures = await checkFile(negative, { label: 'negative' });
  if (!negativeFailures.includes('negative: no-script: settings menu (details) is missing')) failures.push(`negative: the missing settings menu was not reported (${negativeFailures.join(' / ')})`);
} finally {
  await browser.close();
  await fs.rm(tmp, { recursive: true, force: true });
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`no-script layout ok (${targets.length} files, ${tablesChecked} tables, negative case fails as expected)`);
