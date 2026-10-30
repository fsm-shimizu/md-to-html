// 本文の部品の並びと、目次の現在位置表示を実ブラウザで確かめる回帰テスト。
// (1) チェックリストの項目で、強調は文の中に並び、子リストは親の文の下に来る（横に並ばない）。
// (2) 目次の現在位置（.mdh-toc-current）が、スクロールに合わせて移り、末尾では最後の見出しになる。
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { buildNotionHtmlString } from './lib/build-notion.mjs';

const TASK_MD = '# T\n\n## チェックリスト\n\n- [ ] 親 **重要** の説明\n  - 子項目\n- [x] 2 つ目の項目\n';
// 段落を 2 つ持つ項目は li > p > input になる。
const TASK_PARA_MD = '# T\n\n## チェックリスト\n\n- [ ] 親 **重要** の説明\n\n  続きの段落\n\n- [x] 次\n';
const TOC_MD = ['# T', '', ...Array.from({ length: 6 }, (_, i) => [`## 節${i + 1}`, '', ...Array.from({ length: 12 }, () => '本文の段落です。'.repeat(8) + '\n')]).flat(), '## 最後の節', '', '短い本文です。'].join('\n');

const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined;
const browser = await chromium.launch({ executablePath });
try {
  for (const width of [1200, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    await page.setContent(await buildNotionHtmlString(TASK_MD, 'task.md'), { waitUntil: 'load' });
    const m = await page.evaluate(() => {
      const li = document.querySelector('.task-list-item');
      const box = (el) => el.getBoundingClientRect();
      return { check: box(li.querySelector('input')), strong: box(li.querySelector('strong')), child: box(li.querySelector('ul')) };
    });
    assert(m.strong.left > m.check.right, `${width}px: 強調がチェックボックスの右の文の中にない`);
    assert(Math.abs(m.strong.top - m.check.top) < 12, `${width}px: 強調がチェックボックスと同じ行にない (strong.top=${m.strong.top}, check.top=${m.check.top})`);
    assert(m.child.top >= m.strong.bottom - 1, `${width}px: 子リストが親の文の下にない (child.top=${m.child.top}, strong.bottom=${m.strong.bottom})`);
    await page.setContent(await buildNotionHtmlString(TASK_PARA_MD, 'task-para.md'), { waitUntil: 'load' });
    const p = await page.evaluate(() => [...document.querySelectorAll('.task-list-item input[type="checkbox"]')].map((input) => {
      const s = getComputedStyle(input);
      // チェックボックスの直後の文字（テキストノード）の左端と比べる。
      const range = document.createRange();
      range.selectNodeContents(input.nextSibling);
      const text = range.getBoundingClientRect();
      const b = input.getBoundingClientRect();
      return { appearance: s.appearance, position: s.position, right: b.right, textLeft: text.left };
    }));
    assert.equal(p.length, 2, `${width}px: 段落つきチェックリストのチェックボックスが 2 個ない`);
    for (const c of p) {
      assert(c.appearance === 'none' && c.position === 'absolute', `${width}px: 段落つきチェックリストにチェックボックスの装飾が当たっていない (${c.appearance}, ${c.position})`);
      assert(c.right <= c.textLeft, `${width}px: 段落つきチェックリストでチェックボックスが文に重なっている`);
    }
    await page.close();
    console.log(`${width}px: task list keeps strong inline and child list below (also with paragraphs)`);
  }

  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.setContent(await buildNotionHtmlString(TOC_MD, 'toc.md'), { waitUntil: 'load' });
  const current = () => page.evaluate(() => [...document.querySelectorAll('.mdh-toc-current')].map((a) => a.textContent));
  assert.deepEqual(await current(), ['節1'], '読み込み直後は最初の見出しが現在位置');
  await page.evaluate(() => document.getElementById('節3').scrollIntoView());
  await page.waitForTimeout(150);
  assert.deepEqual(await current(), ['節3'], '節3 へスクロールすると節3 が現在位置');
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(150);
  assert.deepEqual(await current(), ['最後の節'], '末尾までスクロールすると最後の見出しが現在位置');
  await page.close();
  console.log('TOC current section follows scrolling and reaches the last heading at the bottom');
} finally {
  await browser.close();
}
