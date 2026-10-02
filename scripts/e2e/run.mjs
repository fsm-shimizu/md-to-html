import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { withPage } from './helpers.mjs';

const taskArgIndex = process.argv.indexOf('--task');
const task = taskArgIndex >= 0 ? process.argv[taskArgIndex + 1] : 'smoke';
const htmlPath = 'mockups/generated/editable-basic.html';
const dogfoodHtmlPath = 'mockups/generated/fixture-long.editable.html';

async function expectBlockEmpty(page, blockId, expected) {
  assert.equal(
    await page.locator(`[data-block-id="${blockId}"]`).evaluate((node) => node.dataset.empty === 'true'),
    expected
  );
}

if (task === 'smoke' || task === '3.5') {
  await withPage(htmlPath, async (page) => {
    await page.waitForSelector('[data-editor-root]', { state: 'attached' });
    assert.equal(await page.locator('[data-action="export-markdown"]').count(), 1);
    assert.equal(await page.locator('[data-action="export-html"]').count(), 1);
    assert.equal(await page.locator('[data-action="reset-edits"]').count(), 1);
    assert.equal(await page.locator('[data-action="toggle-toc"]').count(), 1);
    await page.waitForFunction(() => document.querySelectorAll('.mdh-toc-tree a').length > 0);
    const firstHeadingText = await page.locator('.mdh-editor-block-heading .mdh-block-content').first().innerText();
    const tocTexts = await page.locator('.mdh-toc-tree a').allTextContents();
    assert(tocTexts.includes(firstHeadingText));
    await page.locator('[data-action="toggle-toc"]').click();
    assert.equal(await page.locator('.mdh-shell').evaluate((node) => node.classList.contains('mdh-toc-collapsed')), true);
  });
  console.log(`E2E smoke passed for ${htmlPath}`);
} else if (task === '4') {
  await withPage(htmlPath, async (page) => {
    await page.waitForSelector('[data-block-id]');
    assert((await page.locator('[data-block-id]').count()) > 0);
    for (const type of ['list', 'blockquote', 'table', 'code', 'unsupported']) {
      const text = await page.locator(`.mdh-editor-block-${type}`).first().innerText();
      assert(text.trim().length > 0, `${type} block should have visible text`);
    }

    const paragraph = page.locator('.mdh-editor-block-paragraph .mdh-block-content').first();
    await paragraph.fill('Edited paragraph');
    const edited = await page.evaluate(() => window.__mdhEditable.getDocument().blocks[1].content[0].text);
    assert.equal(edited, 'Edited paragraph');

    await page.locator('.mdh-editor-block-paragraph [data-action="change-block-type"]').first().click();
    assert.equal(await page.locator('.mdh-block-type-menu').count(), 1);
  });
  console.log(`E2E task 4 passed for ${htmlPath}`);
} else if (task === '5') {
  await withPage(htmlPath, async (page) => {
    await page.waitForSelector('[data-block-id]');
    const paragraph = page.locator('.mdh-editor-block-paragraph .mdh-block-content').first();
    await paragraph.fill('Persisted paragraph');
    await page.reload();
    await page.waitForSelector('[data-block-id]');
    assert.equal(await page.locator('.mdh-editor-block-paragraph .mdh-block-content').first().innerText(), 'Persisted paragraph');

    await page.locator('[data-action="reset-edits"]').click();
    assert.match(
      await page.locator('.mdh-editor-block-paragraph .mdh-block-content').first().innerText(),
      /This is strong/
    );

    const beforeEnter = await page.locator('[data-block-id]').count();
    await page.locator('.mdh-editor-block-paragraph .mdh-block-content').first().click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('[data-block-id]').count(), beforeEnter + 1);

    const emptyBlock = page.locator('.mdh-editor-block-paragraph .mdh-block-content').nth(1);
    await emptyBlock.click();
    await page.keyboard.press('/');
    assert.equal(await page.locator('.mdh-command-menu').count(), 1);
    await page.keyboard.press('Escape');

    await emptyBlock.fill('');
    await emptyBlock.click();
    await page.keyboard.press('Backspace');
    assert.equal(await page.locator('[data-block-id]').count(), beforeEnter);

    await page.evaluate(() => {
      const doc = window.__mdhEditable.getDocument();
      const tableIndex = doc.blocks.findIndex((block) => block.type === 'table');
      doc.blocks.splice(tableIndex + 1, 0, {
        id: 'b_test_empty',
        type: 'paragraph',
        content: [{ type: 'text', text: '' }]
      });
      window.__mdhEditable.renderDocument(doc);
    });
    const withGuard = await page.locator('[data-block-id]').count();
    await page.locator('[data-block-id="b_test_empty"] .mdh-block-content').click();
    await page.keyboard.press('Backspace');
    assert.equal(await page.locator('[data-block-id]').count(), withGuard);
  });
  console.log(`E2E task 5 passed for ${htmlPath}`);
} else if (task === '6') {
  await withPage(htmlPath, async (page) => {
    await page.waitForSelector('[data-block-id]');
    await page.locator('.mdh-editor-block-paragraph .mdh-block-content').first().fill('Markdown export paragraph');
    const downloadPromise = page.waitForEvent('download');
    await page.locator('[data-action="export-markdown"]').click();
    const download = await downloadPromise;
    const outputPath = 'mockups/generated/editable-basic.exported.md';
    await download.saveAs(outputPath);
    const markdown = await fs.readFile(outputPath, 'utf8');
    assert(markdown.includes('Markdown export paragraph'));
    assert(markdown.includes('title: Editable Fixture'));
    assert(markdown.includes('status: draft'));
  });
  console.log(`E2E task 6 passed for ${htmlPath}`);
} else if (task === '7') {
  await withPage(htmlPath, async (page) => {
    await page.waitForSelector('[data-block-id]');
    const cell = page.locator('[data-table-cell]').first();
    await cell.fill('Edited Name');
    const downloadPromise = page.waitForEvent('download');
    await page.locator('[data-action="export-html"]').click();
    const download = await downloadPromise;
    const outputPath = 'mockups/generated/editable-basic.exported.html';
    await download.saveAs(outputPath);
    const html = await fs.readFile(outputPath, 'utf8');
    assert(html.includes('Edited Name'));
    assert(!html.includes('raw html should not execute'));
  });
  console.log(`E2E task 7 passed for ${htmlPath}`);
} else if (task === '8') {
  await withPage(dogfoodHtmlPath, async (page) => {
    await page.waitForSelector('[data-block-id]');
    const paragraph = page.locator('.mdh-editor-block-paragraph .mdh-block-content').first();
    const originalParagraph = await paragraph.innerText();
    await paragraph.fill('Dogfood edited paragraph');
    assert.equal(await paragraph.innerText(), 'Dogfood edited paragraph');

    await page.locator('.mdh-editor-block-heading [data-action="change-block-type"]').first().click();
    await page.locator('.mdh-block-type-menu [data-block-type="heading:2"]').click();
    assert.equal(
      await page.evaluate(() => window.__mdhEditable.getDocument().blocks.find((block) => block.type === 'heading').level),
      2
    );

    const beforeEnter = await page.locator('[data-block-id]').count();
    await paragraph.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('[data-block-id]').count(), beforeEnter + 1);
    await page.locator('.mdh-editor-block-paragraph .mdh-block-content').nth(1).click();
    await page.keyboard.press('Backspace');
    assert.equal(await page.locator('[data-block-id]').count(), beforeEnter);

    await page.locator('[data-action="reset-edits"]').click();
    assert.equal(await page.locator('.mdh-editor-block-paragraph .mdh-block-content').first().innerText(), originalParagraph);

    await page.locator('.mdh-editor-block-paragraph .mdh-block-content').first().fill('Dogfood export paragraph');
    const markdownDownloadPromise = page.waitForEvent('download');
    await page.locator('[data-action="export-markdown"]').click();
    const markdownDownload = await markdownDownloadPromise;
    const markdownPath = 'mockups/generated/fixture-long.exported.md';
    await markdownDownload.saveAs(markdownPath);
    const markdown = await fs.readFile(markdownPath, 'utf8');
    assert(markdown.includes('Dogfood export paragraph'));

    const htmlDownloadPromise = page.waitForEvent('download');
    await page.locator('[data-action="export-html"]').click();
    const htmlDownload = await htmlDownloadPromise;
    const htmlPath = 'mockups/generated/fixture-long.exported.html';
    await htmlDownload.saveAs(htmlPath);
    const html = await fs.readFile(htmlPath, 'utf8');
    assert(html.includes('Dogfood export paragraph'));
  });
  console.log(`E2E task 8 passed for ${dogfoodHtmlPath}`);
} else if (task === '9') {
  await withPage(htmlPath, async (page) => {
    await page.waitForSelector('[data-block-id]');
    await page.locator('[data-action="reset-edits"]').click();
    const beforeOrder = await page.evaluate(() => window.__mdhEditable.getDocument().blocks.map((block) => block.id));
    assert(beforeOrder.includes('b_002'));
    assert(beforeOrder.includes('b_006'));

    const changed = await page.evaluate(() => window.__mdhEditable.moveBlock('b_002', 'b_006', 'after'));
    assert.equal(changed, true);

    const afterOrder = await page.evaluate(() => window.__mdhEditable.getDocument().blocks.map((block) => block.id));
    assert(afterOrder.indexOf('b_002') > afterOrder.indexOf('b_006'));
    const domOrder = await page.locator('[data-block-id]').evaluateAll((nodes) => nodes.map((node) => node.dataset.blockId));
    assert.deepEqual(domOrder, afterOrder);

    await page.reload();
    await page.waitForSelector('[data-block-id]');
    const reloadedOrder = await page.evaluate(() => window.__mdhEditable.getDocument().blocks.map((block) => block.id));
    assert.deepEqual(reloadedOrder, afterOrder);

    const downloadPromise = page.waitForEvent('download');
    await page.locator('[data-action="export-markdown"]').click();
    const download = await downloadPromise;
    const outputPath = 'mockups/generated/editable-basic.exported.md';
    await download.saveAs(outputPath);
    const markdown = await fs.readFile(outputPath, 'utf8');
    assert(markdown.indexOf('## Lists') < markdown.indexOf('This is'));
  });
  console.log(`E2E task 9 passed for ${htmlPath}`);
} else if (task === '10') {
  await withPage(htmlPath, async (page) => {
    await page.waitForSelector('[data-block-id]');
    await page.locator('[data-action="reset-edits"]').click();
    const heading = page.locator('.mdh-editor-block-heading .mdh-block-content').first();
    const originalText = await heading.innerText();
    await heading.fill('Undoable heading edit');
    assert.equal(await heading.innerText(), 'Undoable heading edit');

    await page.keyboard.press('Meta+Z');
    assert.equal(await heading.innerText(), originalText);
    assert.equal(
      await page.evaluate(() => window.__mdhEditable.getDocument().blocks[0].content[0].text),
      originalText
    );

    await page.keyboard.press('Meta+Shift+Z');
    assert.equal(await heading.innerText(), 'Undoable heading edit');
    assert.equal(
      await page.evaluate(() => window.__mdhEditable.getDocument().blocks[0].content[0].text),
      'Undoable heading edit'
    );

    await page.locator('[data-action="reset-edits"]').click();
    const beforeOrder = await page.evaluate(() => window.__mdhEditable.getDocument().blocks.map((block) => block.id));
    await page.evaluate(() => window.__mdhEditable.moveBlock('b_002', 'b_006', 'after'));
    const movedOrder = await page.evaluate(() => window.__mdhEditable.getDocument().blocks.map((block) => block.id));
    assert.notDeepEqual(movedOrder, beforeOrder);

    await page.keyboard.press('Meta+Z');
    assert.deepEqual(await page.evaluate(() => window.__mdhEditable.getDocument().blocks.map((block) => block.id)), beforeOrder);

    await page.keyboard.press('Meta+Shift+Z');
    assert.deepEqual(await page.evaluate(() => window.__mdhEditable.getDocument().blocks.map((block) => block.id)), movedOrder);
  });
  console.log(`E2E task 10 passed for ${htmlPath}`);
} else if (task === '11') {
  await withPage(htmlPath, async (page) => {
    await page.waitForSelector('[data-block-id]');
    await page.locator('[data-action="reset-edits"]').click();

    const firstParagraphBlock = page.locator('.mdh-editor-block-paragraph').first();
    const firstParagraphId = await firstParagraphBlock.getAttribute('data-block-id');
    const beforeCount = await page.locator('[data-block-id]').count();

    await firstParagraphBlock.locator('[data-action="add-block-below"]').click();
    assert.equal(await page.locator('[data-block-id]').count(), beforeCount + 1);

    const docAfterAdd = await page.evaluate(() => window.__mdhEditable.getDocument());
    const insertedIndex = docAfterAdd.blocks.findIndex((block) => block.id === firstParagraphId) + 1;
    const inserted = docAfterAdd.blocks[insertedIndex];
    assert.equal(inserted.type, 'paragraph');
    assert.equal(inserted.content[0].text, '');

    const insertedBlock = page.locator(`[data-block-id="${inserted.id}"]`);
    await expectBlockEmpty(page, inserted.id, true);
    assert.equal(await insertedBlock.locator('.mdh-block-content').getAttribute('data-placeholder'), "Type '/' for commands");

    await page.keyboard.press('Meta+Z');
    assert.equal(await page.locator('[data-block-id]').count(), beforeCount);
    await page.keyboard.press('Meta+Shift+Z');
    assert.equal(await page.locator('[data-block-id]').count(), beforeCount + 1);

    const redoInsertedId = await page.evaluate(() => {
      const doc = window.__mdhEditable.getDocument();
      const empty = doc.blocks.find((block) => block.type === 'paragraph' && block.content?.[0]?.text === '');
      return empty.id;
    });
    const redoInsertedBlock = page.locator(`[data-block-id="${redoInsertedId}"]`);

    await redoInsertedBlock.locator('[data-action="change-block-type"]').click();
    assert.equal(await page.locator('.mdh-block-type-menu').count(), 1);
    assert.equal(await page.locator('.mdh-block-type-menu [data-block-action="add-below"]').isDisabled(), false);
    assert.equal(await page.locator('.mdh-block-type-menu [data-block-type="blockquote"]').isDisabled(), false);
    assert.equal(await page.locator('.mdh-block-type-menu [data-block-action="duplicate"]').isDisabled(), false);
    await page.locator('.mdh-block-type-menu [data-block-type="heading:2"]').click();
    assert.equal(
      await page.evaluate((id) => window.__mdhEditable.getDocument().blocks.find((block) => block.id === id).level, redoInsertedId),
      2
    );
    assert.equal(await page.locator(`[data-block-id="${redoInsertedId}"] .mdh-block-content`).getAttribute('data-placeholder'), 'Heading 2');

    await page.locator(`[data-block-id="${redoInsertedId}"] [data-action="change-block-type"]`).click();
    await page.locator('.mdh-block-type-menu [data-block-type="code"]').click();
    assert.equal(
      await page.evaluate((id) => window.__mdhEditable.getDocument().blocks.find((block) => block.id === id).type, redoInsertedId),
      'code'
    );
    assert.equal(await page.locator(`[data-block-id="${redoInsertedId}"] .mdh-block-content`).getAttribute('data-placeholder'), 'Code');

    await page.locator(`[data-block-id="${redoInsertedId}"] [data-action="change-block-type"]`).click();
    await page.locator('.mdh-block-type-menu [data-block-type="paragraph"]').click();
    assert.equal(
      await page.evaluate((id) => window.__mdhEditable.getDocument().blocks.find((block) => block.id === id).type, redoInsertedId),
      'paragraph'
    );

    await page.locator(`[data-block-id="${redoInsertedId}"] .mdh-block-content`).fill('Placeholder should not export');
    await expectBlockEmpty(page, redoInsertedId, false);
    const markdownDownloadPromise = page.waitForEvent('download');
    await page.locator('[data-action="export-markdown"]').click();
    const markdownDownload = await markdownDownloadPromise;
    const outputPath = 'mockups/generated/editable-basic.exported.md';
    await markdownDownload.saveAs(outputPath);
    const markdown = await fs.readFile(outputPath, 'utf8');
    assert(markdown.includes('Placeholder should not export'));
    assert(!markdown.includes("Type '/' for commands"));
  });
  console.log(`E2E task 11 passed for ${htmlPath}`);
} else if (task === '12') {
  await withPage(htmlPath, async (page) => {
    await page.waitForSelector('[data-block-id]');
    await page.locator('[data-action="reset-edits"]').click();

    const paragraphBlock = page.locator('.mdh-editor-block-paragraph').first();
    const paragraphId = await paragraphBlock.getAttribute('data-block-id');
    const beforeCount = await page.locator('[data-block-id]').count();

    await paragraphBlock.locator('[data-action="change-block-type"]').click();
    await page.locator('.mdh-block-type-menu [data-block-action="duplicate"]').click();
    assert.equal(await page.locator('[data-block-id]').count(), beforeCount + 1);
    const duplicateId = await page.evaluate((id) => {
      const doc = window.__mdhEditable.getDocument();
      const index = doc.blocks.findIndex((block) => block.id === id);
      return doc.blocks[index + 1].id;
    }, paragraphId);
    assert.notEqual(duplicateId, paragraphId);

    await page.locator(`[data-block-id="${duplicateId}"] [data-action="change-block-type"]`).click();
    await page.locator('.mdh-block-type-menu [data-block-action="delete"]').click();
    assert.equal(await page.locator('[data-block-id]').count(), beforeCount);
    await page.keyboard.press('Meta+Z');
    assert.equal(await page.locator('[data-block-id]').count(), beforeCount + 1);
    await page.keyboard.press('Meta+Shift+Z');
    assert.equal(await page.locator('[data-block-id]').count(), beforeCount);

    await paragraphBlock.locator('[data-action="change-block-type"]').click();
    await page.locator('.mdh-block-type-menu [data-block-type="blockquote"]').click();
    assert.equal(
      await page.evaluate((id) => window.__mdhEditable.getDocument().blocks.find((block) => block.id === id).type, paragraphId),
      'blockquote'
    );
    await page.locator(`[data-block-id="${paragraphId}"] .mdh-block-content`).fill('Edited quote');
    assert.equal(
      await page.evaluate((id) => window.__mdhEditable.getDocument().blocks.find((block) => block.id === id).blocks[0].content[0].text, paragraphId),
      'Edited quote'
    );

    const beforeOrder = await page.evaluate(() => window.__mdhEditable.getDocument().blocks.map((block) => block.id));
    await page.locator(`[data-block-id="${paragraphId}"] [data-action="change-block-type"]`).click();
    await page.locator('.mdh-block-type-menu [data-block-action="move-down"]').click();
    const movedOrder = await page.evaluate(() => window.__mdhEditable.getDocument().blocks.map((block) => block.id));
    assert(movedOrder.indexOf(paragraphId) > beforeOrder.indexOf(paragraphId));
    await page.locator(`[data-block-id="${paragraphId}"] .mdh-block-content`).click();
    await page.keyboard.press('Alt+Shift+ArrowUp');
    assert.deepEqual(await page.evaluate(() => window.__mdhEditable.getDocument().blocks.map((block) => block.id)), beforeOrder);

    const tableBlock = page.locator('.mdh-editor-block-table').first();
    const tableId = await tableBlock.getAttribute('data-block-id');
    await tableBlock.locator('[data-action="change-block-type"]').click();
    assert.equal(await page.locator('.mdh-block-type-menu [data-block-action="duplicate"]').isDisabled(), false);
    assert.equal(await page.locator('.mdh-block-type-menu [data-block-type="paragraph"]').isDisabled(), true);
    await page.locator('.mdh-block-type-menu [data-block-action="duplicate"]').click();
    const tableDuplicate = await page.evaluate((id) => {
      const doc = window.__mdhEditable.getDocument();
      const index = doc.blocks.findIndex((block) => block.id === id);
      return doc.blocks[index + 1];
    }, tableId);
    assert.equal(tableDuplicate.type, 'table');
  });
  console.log(`E2E task 12 passed for ${htmlPath}`);
} else if (task === '13') {
  await withPage(htmlPath, async (page) => {
    await page.waitForSelector('[data-block-id]');
    await page.locator('[data-action="reset-edits"]').click();

    const paragraph = page.locator('.mdh-editor-block-paragraph').first();
    await paragraph.locator('[data-action="add-block-below"]').click();
    const h1Id = await page.evaluate(() => {
      const doc = window.__mdhEditable.getDocument();
      return doc.blocks.find((block) => block.type === 'paragraph' && block.content?.[0]?.text === '').id;
    });
    await page.locator(`[data-block-id="${h1Id}"] .mdh-block-content`).fill('/h1');
    await page.waitForSelector('.mdh-command-menu');
    assert.equal(await page.locator('.mdh-command-menu [data-command-value="heading:1"]').count(), 1);
    await page.keyboard.press('Enter');
    assert.equal(
      await page.evaluate((id) => window.__mdhEditable.getDocument().blocks.find((block) => block.id === id).level, h1Id),
      1
    );
    assert.equal(await page.locator(`[data-block-id="${h1Id}"] .mdh-block-content`).innerText(), '');

    await page.keyboard.press('Meta+Z');
    assert.equal(
      await page.evaluate((id) => {
        const block = window.__mdhEditable.getDocument().blocks.find((item) => item.id === id);
        return `${block.type}:${block.content?.[0]?.text}`;
      }, h1Id),
      'paragraph:'
    );
    await page.keyboard.press('Meta+Shift+Z');
    assert.equal(
      await page.evaluate((id) => window.__mdhEditable.getDocument().blocks.find((block) => block.id === id).level, h1Id),
      1
    );

    await page.locator(`[data-block-id="${h1Id}"] [data-action="add-block-below"]`).click();
    const codeId = await page.evaluate((afterId) => {
      const doc = window.__mdhEditable.getDocument();
      const index = doc.blocks.findIndex((block) => block.id === afterId);
      return doc.blocks[index + 1].id;
    }, h1Id);
    await page.locator(`[data-block-id="${codeId}"] .mdh-block-content`).fill('/code');
    await page.waitForSelector('.mdh-command-menu');
    await page.keyboard.press('Enter');
    assert.equal(
      await page.evaluate((id) => window.__mdhEditable.getDocument().blocks.find((block) => block.id === id).type, codeId),
      'code'
    );

    await page.locator(`[data-block-id="${codeId}"] [data-action="add-block-below"]`).click();
    const arrowId = await page.evaluate((afterId) => {
      const doc = window.__mdhEditable.getDocument();
      const index = doc.blocks.findIndex((block) => block.id === afterId);
      return doc.blocks[index + 1].id;
    }, codeId);
    await page.locator(`[data-block-id="${arrowId}"] .mdh-block-content`).fill('/h');
    await page.waitForSelector('.mdh-command-menu');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    assert.equal(
      await page.evaluate((id) => window.__mdhEditable.getDocument().blocks.find((block) => block.id === id).level, arrowId),
      2
    );

    await page.locator(`[data-block-id="${codeId}"] [data-action="add-block-below"]`).click();
    const todoId = await page.evaluate((afterId) => {
      const doc = window.__mdhEditable.getDocument();
      const index = doc.blocks.findIndex((block) => block.id === afterId);
      return doc.blocks[index + 1].id;
    }, codeId);
    await page.locator(`[data-block-id="${todoId}"] .mdh-block-content`).fill('/todo');
    await page.waitForSelector('.mdh-command-menu');
    assert.equal(await page.locator('.mdh-command-menu [data-command-value="todo"]').isDisabled(), false);
    await page.keyboard.press('Enter');
    assert.equal(
      await page.evaluate((id) => window.__mdhEditable.getDocument().blocks.find((block) => block.id === id).type, todoId),
      'list'
    );

    await page.locator(`[data-block-id="${todoId}"] [data-action="add-block-below"]`).click();
    const escapeId = await page.evaluate((afterId) => {
      const doc = window.__mdhEditable.getDocument();
      const index = doc.blocks.findIndex((block) => block.id === afterId);
      return doc.blocks[index + 1].id;
    }, todoId);
    await page.locator(`[data-block-id="${escapeId}"] .mdh-block-content`).fill('/h');
    await page.waitForSelector('.mdh-command-menu');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.mdh-command-menu').count(), 0);
    assert.equal(
      await page.evaluate((id) => window.__mdhEditable.getDocument().blocks.find((block) => block.id === id).content[0].text, escapeId),
      '/h'
    );

    for (const text of ['2026/05/17', 'https://example.com/a', 'ja/en']) {
      await page.locator(`[data-block-id="${escapeId}"] .mdh-block-content`).fill(text);
      assert.equal(await page.locator('.mdh-command-menu').count(), 0);
    }
  });
  console.log(`E2E task 13 passed for ${htmlPath}`);
} else if (task === '14') {
  await withPage(htmlPath, async (page) => {
    await page.waitForSelector('[data-block-id]');
    await page.locator('[data-action="reset-edits"]').click();

    const makeEmptyAfterFirstParagraph = async () => {
      const firstParagraph = page.locator('.mdh-editor-block-paragraph').first();
      await firstParagraph.locator('[data-action="add-block-below"]').click();
      return page.evaluate(() => {
        const doc = window.__mdhEditable.getDocument();
        return doc.blocks.find((block) => block.type === 'paragraph' && block.content?.[0]?.text === '').id;
      });
    };

    for (const [trigger, level] of [['#', 1], ['##', 2], ['###', 3]]) {
      const id = await makeEmptyAfterFirstParagraph();
      await page.locator(`[data-block-id="${id}"] .mdh-block-content`).fill(trigger);
      await page.keyboard.press('Space');
      assert.equal(
        await page.evaluate((blockId) => window.__mdhEditable.getDocument().blocks.find((block) => block.id === blockId).level, id),
        level
      );
      await page.keyboard.press('Meta+Z');
      assert.equal(
        await page.evaluate((blockId) => {
          const block = window.__mdhEditable.getDocument().blocks.find((item) => item.id === blockId);
          return `${block.type}:${block.content?.[0]?.text}`;
        }, id),
        `paragraph:${trigger}`
      );
    }

    const codeId = await makeEmptyAfterFirstParagraph();
    await page.locator(`[data-block-id="${codeId}"] .mdh-block-content`).fill('```');
    await page.keyboard.press('Space');
    assert.equal(
      await page.evaluate((blockId) => window.__mdhEditable.getDocument().blocks.find((block) => block.id === blockId).type, codeId),
      'code'
    );

    for (const [trigger, expected] of [['>', 'blockquote'], ['-', 'list'], ['1.', 'list'], ['[ ]', 'list']]) {
      const id = await makeEmptyAfterFirstParagraph();
      await page.locator(`[data-block-id="${id}"] .mdh-block-content`).fill(trigger);
      await page.keyboard.press('Space');
      assert.equal(
        await page.evaluate((blockId) => window.__mdhEditable.getDocument().blocks.find((item) => item.id === blockId).type, id),
        expected
      );
    }
  });
  console.log(`E2E task 14 passed for ${htmlPath}`);
} else if (task === '15') {
  await withPage(htmlPath, async (page) => {
    await page.waitForSelector('[data-block-id]');
    await page.locator('[data-action="reset-edits"]').click();

    await page.locator('[data-action="toggle-toc"]').click();
    assert.equal(await page.locator('.mdh-shell').evaluate((node) => node.classList.contains('mdh-toc-collapsed')), true);
    await page.reload();
    await page.waitForSelector('[data-block-id]');
    assert.equal(await page.locator('.mdh-shell').evaluate((node) => node.classList.contains('mdh-toc-collapsed')), true);

    await page.locator('[data-action="reset-edits"]').click();
    assert.equal(await page.locator('.mdh-shell').evaluate((node) => node.classList.contains('mdh-toc-collapsed')), true);
    assert.equal(await page.locator('[data-action="toggle-toc"]').getAttribute('aria-expanded'), 'false');

    await page.locator('[data-action="toggle-toc"]').click();
    await page.reload();
    await page.waitForSelector('[data-block-id]');
    assert.equal(await page.locator('.mdh-shell').evaluate((node) => node.classList.contains('mdh-toc-collapsed')), false);

    const paragraph = page.locator('.mdh-editor-block-paragraph .mdh-block-content').first();
    await paragraph.click();
    const focusStyles = await page.locator('.mdh-editor-block-paragraph').first().evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        borderLeftWidth: style.borderLeftWidth,
        borderLeftStyle: style.borderLeftStyle,
        borderLeftColor: style.borderLeftColor
      };
    });
    assert.equal(focusStyles.borderLeftWidth, '2px');
    assert.equal(focusStyles.borderLeftStyle, 'solid');
    assert.notEqual(focusStyles.borderLeftColor, 'rgba(0, 0, 0, 0)');

    const toolbar = page.locator('.mdh-editor-toolbar');
    assert.equal(await toolbar.locator('[data-action="export-markdown"]').count(), 1);
    assert.equal(await toolbar.locator('[data-action="export-html"]').count(), 1);
    assert.equal(await toolbar.locator('[data-action="reset-edits"]').count(), 1);
    assert.notEqual(await toolbar.evaluate((node) => getComputedStyle(node).position), 'sticky');

    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true
    );
    const toolbarWidth = await toolbar.evaluate((node) => Math.ceil(node.getBoundingClientRect().width));
    assert(toolbarWidth <= 390, `toolbar width ${toolbarWidth} should fit mobile viewport`);
  });
  console.log(`E2E task 15 passed for ${htmlPath}`);
} else if (task === '16') {
  await withPage(htmlPath, async (page) => {
    await page.waitForSelector('[data-block-id]');
    await page.locator('[data-action="reset-edits"]').click();

    const bulletBlock = page.locator('.mdh-editor-block-list').first();
    const bulletId = await bulletBlock.getAttribute('data-block-id');
    await bulletBlock.locator('[data-list-item-index="0"] .mdh-list-item-content').fill('Edited bullet');
    assert.equal(
      await page.evaluate((id) => window.__mdhEditable.getDocument().blocks.find((block) => block.id === id).items[0].content[0].text, bulletId),
      'Edited bullet'
    );

    await bulletBlock.locator('[data-list-item-index="0"] .mdh-list-item-content').click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    assert.equal(
      await page.evaluate((id) => window.__mdhEditable.getDocument().blocks.find((block) => block.id === id).items.length, bulletId),
      3
    );
    await page.locator(`[data-block-id="${bulletId}"] [data-list-item-index="1"] .mdh-list-item-content`).fill('New bullet');
    assert.equal(
      await page.evaluate((id) => window.__mdhEditable.getDocument().blocks.find((block) => block.id === id).items[1].content[0].text, bulletId),
      'New bullet'
    );

    const taskBlockId = await page.evaluate(() => window.__mdhEditable.getDocument().blocks.find((block) => block.type === 'list' && block.items.some((item) => typeof item.checked === 'boolean')).id);
    const firstCheckbox = page.locator(`[data-block-id="${taskBlockId}"] input[type="checkbox"]`).first();
    await firstCheckbox.click();
    assert.equal(
      await page.evaluate((id) => window.__mdhEditable.getDocument().blocks.find((block) => block.id === id).items[0].checked, taskBlockId),
      true
    );
    await page.keyboard.press('Meta+Z');
    assert.equal(
      await page.evaluate((id) => window.__mdhEditable.getDocument().blocks.find((block) => block.id === id).items[0].checked, taskBlockId),
      false
    );

    const downloadPromise = page.waitForEvent('download');
    await page.locator('[data-action="export-markdown"]').click();
    const download = await downloadPromise;
    const outputPath = 'mockups/generated/editable-basic.exported.md';
    await download.saveAs(outputPath);
    const markdown = await fs.readFile(outputPath, 'utf8');
    assert(markdown.includes('- Edited bullet'));
    assert(markdown.includes('- New bullet'));
    assert(markdown.includes('- [ ] Open task'));
  });
  console.log(`E2E task 16 passed for ${htmlPath}`);
} else if (task === '17') {
  await withPage(htmlPath, async (page) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.waitForSelector('[data-block-id]');
    await page.locator('[data-action="reset-edits"]').click();

    const initial = await page.evaluate(() => {
      const shell = document.querySelector('.mdh-shell');
      const toc = document.querySelector('.mdh-toc');
      const pageNode = document.querySelector('.mdh-page');
      const tocRect = toc.getBoundingClientRect();
      const pageRect = pageNode.getBoundingClientRect();
      return {
        collapsed: shell.classList.contains('mdh-toc-collapsed'),
        ariaExpanded: document.querySelector('[data-action="toggle-toc"]').getAttribute('aria-expanded'),
        tocPosition: getComputedStyle(toc).position,
        tocLeft: Math.round(tocRect.left),
        pageTop: Math.round(pageRect.top),
        scrollWidth: document.documentElement.scrollWidth,
        width: window.innerWidth
      };
    });
    assert.equal(initial.collapsed, true);
    assert.equal(initial.ariaExpanded, 'false');
    assert.equal(initial.tocPosition, 'fixed');
    assert(initial.pageTop <= 96, `page top ${initial.pageTop} should not be pushed below the drawer`);
    assert(initial.scrollWidth <= initial.width, `closed drawer overflow ${initial.scrollWidth}/${initial.width}`);

    await page.locator('[data-action="toggle-toc"]').click();
    await page.waitForFunction(() => {
      const shell = document.querySelector('.mdh-shell');
      const toc = document.querySelector('.mdh-toc');
      const rect = toc.getBoundingClientRect();
      return !shell.classList.contains('mdh-toc-collapsed') && rect.left >= 0 && rect.right <= window.innerWidth;
    });
    const open = await page.evaluate(() => {
      const shell = document.querySelector('.mdh-shell');
      const toc = document.querySelector('.mdh-toc');
      const pageNode = document.querySelector('.mdh-page');
      const tocRect = toc.getBoundingClientRect();
      const pageRect = pageNode.getBoundingClientRect();
      return {
        collapsed: shell.classList.contains('mdh-toc-collapsed'),
        ariaExpanded: document.querySelector('[data-action="toggle-toc"]').getAttribute('aria-expanded'),
        tocLeft: Math.round(tocRect.left),
        tocRight: Math.round(tocRect.right),
        pageTop: Math.round(pageRect.top),
        scrollWidth: document.documentElement.scrollWidth,
        width: window.innerWidth
      };
    });
    assert.equal(open.collapsed, false);
    assert.equal(open.ariaExpanded, 'true');
    assert(open.tocLeft >= 0, `drawer left ${open.tocLeft} should be inside viewport`);
    assert(open.tocRight <= open.width, `drawer right ${open.tocRight} should fit viewport ${open.width}`);
    assert.equal(open.pageTop, initial.pageTop);
    assert(open.scrollWidth <= open.width, `open drawer overflow ${open.scrollWidth}/${open.width}`);

    await page.locator('[data-action="toggle-toc"]').click();
    assert.equal(await page.locator('.mdh-shell').evaluate((node) => node.classList.contains('mdh-toc-collapsed')), true);
  });
  console.log(`E2E task 17 passed for ${htmlPath}`);
} else {
  throw new Error(`Unknown e2e task: ${task}`);
}
