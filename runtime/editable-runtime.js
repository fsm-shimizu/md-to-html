import { editableDocumentToMarkdown } from '../scripts/lib/blocks-to-markdown.mjs';
import { editableDocumentToStaticHtml } from '../scripts/lib/blocks-to-static-html.mjs';
import { moveBlock } from '../scripts/lib/editable-dnd.mjs';

const dataNode = document.getElementById('mdh-document-data');
const root = document.querySelector('[data-editor-root]');
const tocRoot = document.getElementById('mdh-editable-toc');
const shell = document.querySelector('.mdh-shell');
const tocToggle = document.querySelector('[data-action="toggle-toc"]');
const TURN_INTO_OPTIONS = [
  ['paragraph', 'Text', false],
  ['heading:1', 'Heading 1', false],
  ['heading:2', 'Heading 2', false],
  ['heading:3', 'Heading 3', false],
  ['blockquote', 'Quote', false],
  ['code', 'Code', false]
];
const BLOCK_ACTIONS = [
  ['duplicate', 'Duplicate'],
  ['delete', 'Delete'],
  ['move-up', 'Move up'],
  ['move-down', 'Move down']
];
const COMMAND_OPTIONS = [
  { value: 'paragraph', label: 'Text', description: 'Plain text block', keywords: ['text', 'paragraph'] },
  { value: 'heading:1', label: 'Heading 1', description: 'Large section heading', keywords: ['h1', 'heading', 'heading1'] },
  { value: 'heading:2', label: 'Heading 2', description: 'Medium section heading', keywords: ['h2', 'heading', 'heading2'] },
  { value: 'heading:3', label: 'Heading 3', description: 'Small section heading', keywords: ['h3', 'heading', 'heading3'] },
  { value: 'blockquote', label: 'Quote', description: 'Quote block', keywords: ['quote'] },
  { value: 'code', label: 'Code', description: 'Code block', keywords: ['code', 'pre'] },
  { value: 'todo', label: 'To-do list', description: 'Task list', keywords: ['todo', 'task'] },
  { value: 'bullet-list', label: 'Bulleted list', description: 'Bulleted list', keywords: ['bullet', 'list', 'ul'] },
  { value: 'numbered-list', label: 'Numbered list', description: 'Numbered list', keywords: ['number', 'ordered', 'ol'] }
];

let embeddedDocument = null;
let currentDocument = null;
let storageKey = null;
let uiTocStorageKey = null;
let draggingBlockId = null;
let dropCandidate = null;
let undoStack = [];
let redoStack = [];
let isApplyingHistory = false;
let activeInputHistoryKey = null;
let activeInputSnapshot = null;
let activeInputHistoryRecorded = false;
let commandMenuState = null;
const MAX_HISTORY = 100;

if (dataNode && root) {
  try {
    embeddedDocument = JSON.parse(dataNode.textContent);
    storageKey = `mdh-editable:v1:${embeddedDocument.documentId}`;
    uiTocStorageKey = `mdh-editable-ui:v1:${embeddedDocument.documentId}:tocCollapsed`;
    currentDocument = loadDocument(embeddedDocument);
    renderDocument(currentDocument);
    loadTocCollapsedState();
    setupDragAndDrop();
    window.__mdhEditable = {
      document: currentDocument,
      getDocument: () => currentDocument,
      renderDocument,
      moveBlock: moveBlockById,
      undo: undoDocument,
      redo: redoDocument
    };
  } catch (error) {
    console.error(error);
    root.textContent = 'Editable document data could not be loaded.';
  }
}

function inlineText(content = []) {
  return content.map((node) => {
    if (node.type === 'text') return node.text || '';
    if (node.type === 'inlineCode') return node.value || '';
    if (node.children) return inlineText(node.children);
    return '';
  }).join('');
}

function renderDocument(documentData) {
  root.replaceChildren();
  for (const block of documentData.blocks || []) {
    root.append(renderBlock(block));
  }
  renderEditableToc(documentData);
  if (window.__mdhEditable) window.__mdhEditable.document = currentDocument;
}

function renderBlock(block) {
  const wrapper = document.createElement('div');
  wrapper.className = `mdh-editor-block mdh-editor-block-${block.type}`;
  wrapper.dataset.blockId = block.id;
  wrapper.id = block.id;

  const controls = document.createElement('div');
  controls.className = 'mdh-block-controls';

  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.className = 'mdh-block-add';
  addButton.textContent = '+';
  addButton.dataset.action = 'add-block-below';
  addButton.setAttribute('aria-label', '下にブロックを追加');

  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'mdh-block-handle';
  handle.textContent = '::';
  handle.dataset.action = 'change-block-type';
  handle.draggable = true;
  handle.setAttribute('aria-label', 'ブロック操作');
  handle.setAttribute('aria-haspopup', 'menu');
  controls.append(addButton, handle);
  wrapper.append(controls);

  if (block.type === 'table') {
    wrapper.dataset.empty = 'false';
    wrapper.append(renderTableBlock(block));
    return wrapper;
  }

  if (block.type === 'list') {
    wrapper.dataset.empty = 'false';
    wrapper.append(renderListBlock(block));
    return wrapper;
  }

  const editable = document.createElement(block.type === 'heading' ? `h${Math.min(block.level || 1, 6)}` : 'div');
  editable.className = 'mdh-block-content';
  editable.contentEditable = block.type !== 'unsupported' && block.type !== 'table' ? 'true' : 'false';
  editable.textContent = blockVisibleText(block);
  setBlockEmptyState(wrapper, block, editable);
  wrapper.append(editable);
  return wrapper;
}

function blockVisibleText(block) {
  if (block.type === 'code') return block.value || '';
  if (block.type === 'unsupported') return `[unsupported: ${block.sourceType}]`;
  if (block.type === 'list') return (block.items || []).map((item) => inlineText(item.content)).join('\n');
  if (block.type === 'blockquote') return (block.blocks || []).map((child) => inlineText(child.content)).join('\n');
  if (block.type === 'table') {
    return [
      (block.headers || []).map(inlineText).join(' | '),
      ...(block.rows || []).map((row) => row.map(inlineText).join(' | '))
    ].join('\n');
  }
  return inlineText(block.content);
}

function findBlock(id) {
  return (currentDocument.blocks || []).find((block) => block.id === id);
}

function blockPlaceholder(block) {
  if (block.type === 'heading') return `Heading ${Math.max(1, Math.min(block.level || 1, 6))}`;
  if (block.type === 'code') return 'Code';
  if (block.type === 'blockquote') return 'Quote';
  if (block.type === 'paragraph') return "Type '/' for commands";
  return '';
}

function isBlockEmpty(block) {
  if (block.type === 'code') return (block.value || '').trim() === '';
  if (block.type === 'paragraph' || block.type === 'heading') return inlineText(block.content).trim() === '';
  if (block.type === 'blockquote') return (block.blocks || []).every(isBlockEmpty);
  return false;
}

function setBlockEmptyState(wrapper, block, editable) {
  wrapper.dataset.empty = isBlockEmpty(block) ? 'true' : 'false';
  const placeholder = blockPlaceholder(block);
  if (placeholder) editable.dataset.placeholder = placeholder;
  else delete editable.dataset.placeholder;
}

function syncBlockEmptyState(blockEl, block) {
  const editable = blockEl.querySelector('.mdh-block-content');
  if (editable) setBlockEmptyState(blockEl, block, editable);
}

root?.addEventListener('focusin', (event) => {
  const blockEl = event.target.closest('[data-block-id]');
  if (!blockEl) return;
  const tableCell = event.target.closest('[data-table-cell]');
  const listItem = event.target.closest('[data-list-item-index]');
  const key = `${blockEl.dataset.blockId}:${tableCell?.dataset.tableCell || listItem?.dataset.listItemIndex || 'content'}`;
  activeInputHistoryKey = key;
  activeInputSnapshot = cloneDocument(currentDocument);
  activeInputHistoryRecorded = false;
});

root?.addEventListener('beforeinput', (event) => {
  const key = inputHistoryKey(event.target);
  if (!key) return;
  if (commandMenuState?.blockId && key === `${commandMenuState.blockId}:content`) return;
  rememberInputHistory(key);
});

root?.addEventListener('focusout', () => {
  if (!commandMenuState) clearInputHistoryState();
});

root?.addEventListener('input', (event) => {
  const blockEl = event.target.closest('[data-block-id]');
  if (!blockEl) return;
  const block = findBlock(blockEl.dataset.blockId);
  if (!block) return;
  const tableCell = event.target.closest('[data-table-cell]');
  const listItem = event.target.closest('[data-list-item-index]');
  rememberInputHistory(`${blockEl.dataset.blockId}:${tableCell?.dataset.tableCell || listItem?.dataset.listItemIndex || 'content'}`);
  if (tableCell && block.type === 'table') {
    updateTableCell(block, tableCell.dataset.tableCell, tableCell.textContent);
    persistDocument();
    return;
  }
  if (listItem && block.type === 'list') {
    updateListItem(block, listItem.dataset.listItemIndex, event.target.textContent);
    persistDocument();
    return;
  }
  if (block.type === 'code') block.value = event.target.textContent;
  else if (block.type === 'blockquote') block.blocks = [{ id: block.blocks?.[0]?.id || nextRuntimeBlockId(), type: 'paragraph', content: [{ type: 'text', text: event.target.textContent }] }];
  else block.content = [{ type: 'text', text: event.target.textContent }];
  syncBlockEmptyState(blockEl, block);
  if (block.type === 'heading') renderEditableToc(currentDocument);
  updateCommandMenuFromInput(blockEl, block);
  persistDocument();
});

root?.addEventListener('keydown', (event) => {
  if (commandMenuState && handleCommandMenuKeydown(event)) return;

  const blockEl = event.target.closest('[data-block-id]');
  if (!blockEl) return;
  const block = findBlock(blockEl.dataset.blockId);
  if (!block) return;

  if (event.altKey && event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    event.preventDefault();
    moveBlockOneStep(block.id, event.key === 'ArrowUp' ? -1 : 1);
    return;
  }

  if (event.key === 'Escape') {
    closeFloatingMenus();
    return;
  }

  if (handleMarkdownShortcutKeydown(event, blockEl, block)) {
    return;
  }

  if (event.key === 'Enter' && !event.shiftKey) {
    const listItem = event.target.closest('[data-list-item-index]');
    if (listItem && block.type === 'list') {
      event.preventDefault();
      addListItemAfter(block.id, Number(listItem.dataset.listItemIndex));
      return;
    }
    event.preventDefault();
    addBlockBelow(block.id);
    return;
  }

  const listItem = event.target.closest('[data-list-item-index]');
  if (event.key === 'Backspace' && listItem && block.type === 'list' && event.target.textContent === '') {
    event.preventDefault();
    deleteListItem(block.id, Number(listItem.dataset.listItemIndex));
    return;
  }

  if (event.key === 'Backspace' && isEmptyTextBlock(block)) {
    const index = currentDocument.blocks.findIndex((item) => item.id === block.id);
    if (index <= 0) return;
    event.preventDefault();
    const previous = currentDocument.blocks[index - 1];
    if (previous.type === 'unsupported' || previous.type === 'table') {
      focusBlock(previous.id);
      return;
    }
    clearInputHistoryState();
    rememberHistory();
    currentDocument.blocks.splice(index, 1);
    renderDocument(currentDocument);
    persistDocument();
    focusBlock(previous.id);
  }
});

root?.addEventListener('click', (event) => {
  const addTrigger = event.target.closest('[data-action="add-block-below"]');
  if (addTrigger) {
    const blockEl = addTrigger.closest('[data-block-id]');
    if (!blockEl) return;
    closeFloatingMenus();
    addBlockBelow(blockEl.dataset.blockId);
    return;
  }

  const trigger = event.target.closest('[data-action="change-block-type"]');
  if (!trigger) return;
  const blockEl = trigger.closest('[data-block-id]');
  const block = blockEl ? findBlock(blockEl.dataset.blockId) : null;
  if (!block) return;
  closeFloatingMenus();
  blockEl.append(renderBlockOperationMenu(block));
});

root?.addEventListener('click', (event) => {
  const checkbox = event.target.closest('[data-list-checkbox]');
  if (!checkbox) return;
  const blockEl = checkbox.closest('[data-block-id]');
  const block = blockEl ? findBlock(blockEl.dataset.blockId) : null;
  if (!block || block.type !== 'list') return;
  const index = Number(checkbox.closest('[data-list-item-index]').dataset.listItemIndex);
  block.items[index].checked = checkbox.checked;
  persistDocument();
});

root?.addEventListener('pointerdown', (event) => {
  const checkbox = event.target.closest('[data-list-checkbox]');
  if (!checkbox) return;
  clearInputHistoryState();
  rememberHistory();
});

function renderBlockOperationMenu(block) {
  const menu = document.createElement('div');
  menu.className = 'mdh-block-type-menu';
  menu.role = 'menu';

  const addBelow = document.createElement('button');
  addBelow.type = 'button';
  addBelow.textContent = 'Add below';
  addBelow.dataset.blockAction = 'add-below';
  addBelow.addEventListener('click', () => {
    addBlockBelow(block.id);
    closeFloatingMenus();
  });
  menu.append(addBelow, renderMenuLabel('Turn into'));

  for (const [value, label, disabledForGoal] of TURN_INTO_OPTIONS) {
    const item = document.createElement('button');
    item.type = 'button';
    item.textContent = label;
    item.dataset.blockType = value;
    const disabled = disabledForGoal || !canTurnInto(block);
    item.disabled = disabled;
    if (!disabled) {
      item.addEventListener('click', () => {
        clearInputHistoryState();
        rememberHistory();
        changeBlockType(block, value);
        closeFloatingMenus();
        renderDocument(currentDocument);
        persistDocument();
      });
    }
    menu.append(item);
  }

  menu.append(renderMenuLabel('More'));
  for (const [action, label] of BLOCK_ACTIONS) {
    const item = document.createElement('button');
    item.type = 'button';
    item.textContent = label;
    item.dataset.blockAction = action;
    item.disabled = isBlockActionDisabled(block, action);
    if (!item.disabled) item.addEventListener('click', () => runBlockAction(block.id, action));
    menu.append(item);
  }
  return menu;
}

function renderMenuLabel(text) {
  const label = document.createElement('div');
  label.className = 'mdh-block-menu-label';
  label.textContent = text;
  return label;
}

function canTurnInto(block) {
  return block.type !== 'table' && block.type !== 'unsupported';
}

function isBlockActionDisabled(block, action) {
  const index = currentDocument.blocks.findIndex((item) => item.id === block.id);
  if (action === 'move-up') return index <= 0;
  if (action === 'move-down') return index < 0 || index >= currentDocument.blocks.length - 1;
  return false;
}

function runBlockAction(blockId, action) {
  closeFloatingMenus();
  if (action === 'duplicate') duplicateBlock(blockId);
  else if (action === 'delete') deleteBlock(blockId);
  else if (action === 'move-up') moveBlockOneStep(blockId, -1);
  else if (action === 'move-down') moveBlockOneStep(blockId, 1);
}

function updateCommandMenuFromInput(blockEl, block) {
  if (block.type !== 'paragraph') {
    closeCommandMenu();
    return;
  }
  const text = inlineText(block.content);
  if (!text.startsWith('/')) {
    if (commandMenuState?.blockId === block.id) closeCommandMenu();
    return;
  }
  const query = text.slice(1);
  if (!commandMenuState || commandMenuState.blockId !== block.id) {
    openCommandMenu(blockEl, block, query);
    return;
  }
  renderCommandMenu(blockEl, block, query, commandMenuState.selectedIndex);
}

function openCommandMenu(blockEl, block, query) {
  closeTypeMenus();
  renderCommandMenu(blockEl, block, query, 0);
}

function renderCommandMenu(blockEl, block, query, selectedIndex) {
  blockEl.querySelectorAll('.mdh-command-menu').forEach((menu) => menu.remove());
  const items = filteredCommandItems(query);
  const nextSelectedIndex = Math.max(0, Math.min(selectedIndex, Math.max(items.length - 1, 0)));
  commandMenuState = {
    blockId: block.id,
    query,
    selectedIndex: nextSelectedIndex,
    items
  };

  const menu = document.createElement('div');
  menu.className = 'mdh-command-menu';
  menu.role = 'menu';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'mdh-command-empty';
    empty.textContent = 'No commands';
    menu.append(empty);
  }
  items.forEach((command, index) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.dataset.commandValue = command.value;
    item.disabled = Boolean(command.disabled);
    item.className = index === nextSelectedIndex ? 'mdh-command-item is-active' : 'mdh-command-item';
    item.innerHTML = `<span>${command.label}</span><small>${command.description}</small>`;
    if (!command.disabled) {
      item.addEventListener('click', () => confirmCommand(command));
    }
    menu.append(item);
  });
  blockEl.append(menu);
}

function filteredCommandItems(query) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return COMMAND_OPTIONS;
  return COMMAND_OPTIONS.filter((command) => {
    return command.label.toLowerCase().includes(normalized)
      || command.keywords.some((keyword) => keyword.startsWith(normalized));
  });
}

function handleCommandMenuKeydown(event) {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    moveCommandSelection(direction);
    return true;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    const command = commandMenuState.items[commandMenuState.selectedIndex];
    if (command && !command.disabled) confirmCommand(command);
    return true;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    closeCommandMenu({ keepInputHistory: false });
    return true;
  }
  return false;
}

function moveCommandSelection(direction) {
  const state = commandMenuState;
  if (!state?.items.length) return;
  const blockEl = root.querySelector(`[data-block-id="${CSS.escape(state.blockId)}"]`);
  const block = findBlock(state.blockId);
  if (!blockEl || !block) return;
  const nextIndex = (state.selectedIndex + direction + state.items.length) % state.items.length;
  renderCommandMenu(blockEl, block, state.query, nextIndex);
}

function confirmCommand(command) {
  const state = commandMenuState;
  if (!state) return;
  const snapshot = activeInputSnapshot ? cloneDocument(activeInputSnapshot) : null;
  if (!activeInputHistoryRecorded) rememberHistory();
  else redoStack = [];
  if (snapshot) currentDocument = snapshot;
  const block = findBlock(state.blockId);
  if (!block) {
    closeCommandMenu();
    return;
  }
  changeBlockType(block, command.value);
  if (block.type === 'code') block.value = '';
  else block.content = [{ type: 'text', text: '' }];
  closeCommandMenu();
  renderDocument(currentDocument);
  persistDocument();
  focusBlock(block.id);
}

function changeBlockType(block, value) {
  const text = blockVisibleText(block);
  if (value.startsWith('heading:')) {
    block.type = 'heading';
    block.level = Number(value.split(':')[1]);
    block.content = [{ type: 'text', text }];
    delete block.value;
    delete block.blocks;
    return;
  }
  if (value === 'code') {
    block.type = 'code';
    block.lang ||= '';
    block.value = text;
    delete block.content;
    delete block.level;
    return;
  }
  if (value === 'blockquote') {
    block.type = 'blockquote';
    block.blocks = [{ id: nextRuntimeBlockId(), type: 'paragraph', content: [{ type: 'text', text }] }];
    delete block.content;
    delete block.value;
    delete block.level;
    return;
  }
  if (value === 'todo' || value === 'bullet-list' || value === 'numbered-list') {
    block.type = 'list';
    block.ordered = value === 'numbered-list';
    block.start = null;
    block.items = [{ checked: value === 'todo' ? false : null, content: [{ type: 'text', text }] }];
    delete block.content;
    delete block.value;
    delete block.blocks;
    delete block.level;
    return;
  }
  block.type = 'paragraph';
  block.content = [{ type: 'text', text }];
  delete block.value;
  delete block.blocks;
  delete block.level;
}

function handleMarkdownShortcutKeydown(event, blockEl, block) {
  if (block.type !== 'paragraph') return false;
  if (event.key !== ' ' && event.key !== 'Enter') return false;
  const text = inlineText(block.content);
  const shortcutType = markdownShortcutType(text);
  if (!shortcutType) return false;
  event.preventDefault();
  clearInputHistoryState();
  rememberHistory();
  changeBlockType(block, shortcutType);
  if (block.type === 'code') block.value = '';
  else block.content = [{ type: 'text', text: '' }];
  closeFloatingMenus();
  renderDocument(currentDocument);
  persistDocument();
  focusBlock(block.id);
  return true;
}

function markdownShortcutType(text) {
  if (text === '#') return 'heading:1';
  if (text === '##') return 'heading:2';
  if (text === '###') return 'heading:3';
  if (text === '```') return 'code';
  if (text === '>') return 'blockquote';
  if (text === '-') return 'bullet-list';
  if (text === '1.') return 'numbered-list';
  if (text === '[ ]') return 'todo';
  return null;
}

function closeTypeMenus() {
  root.querySelectorAll('.mdh-block-type-menu').forEach((menu) => menu.remove());
}

function closeCommandMenu({ keepInputHistory = false } = {}) {
  root.querySelectorAll('.mdh-command-menu').forEach((menu) => menu.remove());
  commandMenuState = null;
  if (!keepInputHistory) clearInputHistoryState();
}

function closeFloatingMenus() {
  closeTypeMenus();
  closeCommandMenu();
}

document.addEventListener('click', (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'reset-edits') {
    resetEdits();
  } else if (action === 'export-markdown') {
    downloadText(`${slugTitle()}.md`, editableDocumentToMarkdown(currentDocument), 'text/markdown;charset=utf-8');
  } else if (action === 'export-html') {
    exportStaticHtml();
  } else if (action === 'toggle-toc') {
    toggleToc();
  }
});

function loadDocument(embedded) {
  try {
    const stored = JSON.parse(localStorage.getItem(`mdh-editable:v1:${embedded.documentId}`));
    if (stored?.document?.version === 1 && stored.document.documentId === embedded.documentId) {
      return stored.document;
    }
  } catch (error) {
    console.error(error);
  }
  return cloneDocument(embedded);
}

function persistDocument() {
  try {
    localStorage.setItem(storageKey, JSON.stringify({
      savedAt: new Date().toISOString(),
      document: currentDocument
    }));
  } catch (error) {
    console.error(error);
  }
}

function resetEdits() {
  clearInputHistoryState();
  rememberHistory();
  localStorage.removeItem(storageKey);
  currentDocument = cloneDocument(embeddedDocument);
  renderDocument(currentDocument);
}

function nextRuntimeBlockId() {
  currentDocument._idCounter ||= currentDocument.blocks.reduce((value, block) => {
    return Math.max(value, maxBlockNumber(block) + 1);
  }, 1);
  const id = `b_${String(currentDocument._idCounter).padStart(3, '0')}`;
  currentDocument._idCounter += 1;
  return id;
}

function maxBlockNumber(block) {
  const match = /^b_(\d+)$/.exec(block.id || '');
  const own = match ? Number(match[1]) : 0;
  return (block.blocks || []).reduce((value, child) => Math.max(value, maxBlockNumber(child)), own);
}

function insertBlockAfter(blockId, newBlock) {
  const index = currentDocument.blocks.findIndex((block) => block.id === blockId);
  currentDocument.blocks.splice(index + 1, 0, newBlock);
}

function addBlockBelow(blockId) {
  clearInputHistoryState();
  rememberHistory();
  const newBlock = {
    id: nextRuntimeBlockId(),
    type: 'paragraph',
    content: [{ type: 'text', text: '' }]
  };
  insertBlockAfter(blockId, newBlock);
  renderDocument(currentDocument);
  persistDocument();
  focusBlock(newBlock.id);
  return newBlock;
}

function duplicateBlock(blockId) {
  const index = currentDocument.blocks.findIndex((block) => block.id === blockId);
  if (index < 0) return;
  clearInputHistoryState();
  rememberHistory();
  const duplicate = cloneBlockWithNewIds(currentDocument.blocks[index]);
  currentDocument.blocks.splice(index + 1, 0, duplicate);
  renderDocument(currentDocument);
  persistDocument();
  focusBlock(duplicate.id);
}

function cloneBlockWithNewIds(block) {
  const next = cloneDocument(block);
  assignNewBlockIds(next);
  return next;
}

function assignNewBlockIds(block) {
  block.id = nextRuntimeBlockId();
  for (const child of block.blocks || []) assignNewBlockIds(child);
}

function deleteBlock(blockId) {
  const index = currentDocument.blocks.findIndex((block) => block.id === blockId);
  if (index < 0) return;
  clearInputHistoryState();
  rememberHistory();
  if (currentDocument.blocks.length === 1) {
    currentDocument.blocks[0] = {
      id: nextRuntimeBlockId(),
      type: 'paragraph',
      content: [{ type: 'text', text: '' }]
    };
    renderDocument(currentDocument);
    persistDocument();
    focusBlock(currentDocument.blocks[0].id);
    return;
  }
  const focusTarget = currentDocument.blocks[index + 1]?.id || currentDocument.blocks[index - 1]?.id;
  currentDocument.blocks.splice(index, 1);
  renderDocument(currentDocument);
  persistDocument();
  if (focusTarget) focusBlock(focusTarget);
}

function moveBlockOneStep(blockId, direction) {
  const index = currentDocument.blocks.findIndex((block) => block.id === blockId);
  const target = currentDocument.blocks[index + direction];
  if (index < 0 || !target) return false;
  return moveBlockById(blockId, target.id, direction < 0 ? 'before' : 'after');
}

function focusBlock(blockId) {
  requestAnimationFrame(() => {
    const blockEl = root.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`);
    const target = blockEl?.querySelector('.mdh-block-content') || blockEl?.querySelector('.mdh-block-handle');
    target?.focus();
  });
}

function focusListItem(blockId, index) {
  requestAnimationFrame(() => {
    const blockEl = root.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`);
    blockEl?.querySelector(`[data-list-item-index="${index}"] .mdh-list-item-content`)?.focus();
  });
}

function isEmptyTextBlock(block) {
  return block.type === 'paragraph' && inlineText(block.content).trim() === '';
}

function cloneDocument(documentData) {
  return JSON.parse(JSON.stringify(documentData));
}

function renderTableBlock(block) {
  const table = document.createElement('table');
  table.className = 'mdh-editable-table';
  if ((block.headers || []).length >= 3) table.classList.add('mdh-stackable-table');
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  (block.headers || []).forEach((cellContent, cellIndex) => {
    const cell = document.createElement('th');
    renderTableCell(cell, cellContent, `header:${cellIndex}`);
    headerRow.append(cell);
  });
  thead.append(headerRow);
  table.append(thead);

  const tbody = document.createElement('tbody');
  (block.rows || []).forEach((row, rowIndex) => {
    const tr = document.createElement('tr');
    row.forEach((cellContent, cellIndex) => {
      const cell = document.createElement('td');
      const label = inlineText((block.headers || [])[cellIndex] || []);
      if (label) cell.dataset.label = label;
      renderTableCell(cell, cellContent, `${rowIndex}:${cellIndex}`);
      tr.append(cell);
    });
    tbody.append(tr);
  });
  table.append(tbody);
  return table;
}

function renderListBlock(block) {
  const list = document.createElement(block.ordered ? 'ol' : 'ul');
  list.className = 'mdh-editable-list';
  if (block.ordered && block.start) list.start = block.start;
  (block.items || []).forEach((item, index) => {
    const li = document.createElement('li');
    li.dataset.listItemIndex = String(index);
    li.className = typeof item.checked === 'boolean' ? 'mdh-list-item mdh-list-item-task' : 'mdh-list-item';

    if (typeof item.checked === 'boolean') {
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = item.checked;
      checkbox.dataset.listCheckbox = 'true';
      checkbox.setAttribute('aria-label', 'To-do item');
      li.append(checkbox);
    }

    const content = document.createElement('span');
    content.className = 'mdh-list-item-content';
    content.contentEditable = 'true';
    content.textContent = inlineText(item.content);
    li.append(content);
    list.append(li);
  });
  return list;
}

function updateListItem(block, indexValue, text) {
  const index = Number(indexValue);
  if (!block.items[index]) return;
  block.items[index].content = [{ type: 'text', text }];
}

function addListItemAfter(blockId, index) {
  const block = findBlock(blockId);
  if (!block || block.type !== 'list') return;
  clearInputHistoryState();
  rememberHistory();
  const current = block.items[index] || {};
  const checked = typeof current.checked === 'boolean' ? false : null;
  block.items.splice(index + 1, 0, { checked, content: [{ type: 'text', text: '' }] });
  renderDocument(currentDocument);
  persistDocument();
  focusListItem(blockId, index + 1);
}

function deleteListItem(blockId, index) {
  const block = findBlock(blockId);
  if (!block || block.type !== 'list') return;
  clearInputHistoryState();
  rememberHistory();
  if (block.items.length <= 1) {
    block.items[0] = { checked: typeof block.items[0]?.checked === 'boolean' ? false : null, content: [{ type: 'text', text: '' }] };
    renderDocument(currentDocument);
    persistDocument();
    focusListItem(blockId, 0);
    return;
  }
  block.items.splice(index, 1);
  renderDocument(currentDocument);
  persistDocument();
  focusListItem(blockId, Math.max(0, index - 1));
}

function renderTableCell(cell, cellContent, address) {
  cell.contentEditable = 'true';
  cell.dataset.tableCell = address;
  cell.textContent = inlineText(cellContent);
}

function updateTableCell(block, address, text) {
  const nextContent = [{ type: 'text', text }];
  if (address.startsWith('header:')) {
    const cellIndex = Number(address.split(':')[1]);
    block.headers[cellIndex] = nextContent;
    return;
  }
  const [rowIndex, cellIndex] = address.split(':').map(Number);
  block.rows[rowIndex][cellIndex] = nextContent;
}

async function exportStaticHtml() {
  const html = await editableDocumentToStaticHtml(currentDocument);
  downloadText(`${slugTitle()}.html`, html, 'text/html;charset=utf-8');
}

function downloadText(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function slugTitle() {
  return (currentDocument.title || 'document')
    .toLowerCase()
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/gi, '-')
    .replace(/^-+|-+$/g, '') || 'document';
}

function renderEditableToc(documentData) {
  if (!tocRoot) return;
  const headings = (documentData.blocks || [])
    .filter((block) => block.type === 'heading' && (block.level || 1) <= 3)
    .map((block) => ({
      level: Math.max(1, Math.min(block.level || 1, 3)),
      id: block.id,
      text: inlineText(block.content).trim() || 'Untitled',
      children: []
    }));
  tocRoot.replaceChildren(...renderTocNodes(buildTocTree(headings)));
}

function buildTocTree(headings) {
  const rootNodes = [];
  const stack = [];
  for (const heading of headings) {
    while (stack.length && stack[stack.length - 1].level >= heading.level) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(heading);
    else rootNodes.push(heading);
    stack.push(heading);
  }
  return rootNodes;
}

function renderTocNodes(nodes) {
  return nodes.map((node) => {
    if (node.level === 3) return renderTocLink(node, 'mdh-toc-h3');

    const wrapper = document.createElement('div');
    wrapper.className = `mdh-toc-node mdh-toc-h${node.level}`;
    const disclosure = document.createElement('details');
    disclosure.className = 'mdh-toc-disclosure';
    if (node.level === 2) disclosure.open = true;
    const summary = document.createElement('summary');
    summary.setAttribute('aria-label', `${node.text}を開閉`);
    const children = document.createElement('div');
    children.className = 'mdh-toc-children';
    children.replaceChildren(...renderTocNodes(node.children));
    disclosure.append(summary, children);
    wrapper.append(disclosure, renderTocLink(node, `mdh-toc-title mdh-toc-title-h${node.level}`));
    return wrapper;
  });
}

function renderTocLink(node, className) {
  const link = document.createElement('a');
  link.className = className;
  link.href = `#${node.id}`;
  link.textContent = node.text;
  link.addEventListener('click', () => {
    if (shell && window.matchMedia('(max-width: 860px)').matches) {
      shell.classList.add('mdh-toc-collapsed');
      persistTocCollapsedState();
      updateTocToggle();
    }
  });
  return link;
}

function toggleToc() {
  if (!shell || !tocToggle) return;
  shell.classList.toggle('mdh-toc-collapsed');
  persistTocCollapsedState();
  updateTocToggle();
}

function loadTocCollapsedState() {
  if (!shell || !uiTocStorageKey) return;
  try {
    const stored = localStorage.getItem(uiTocStorageKey);
    const collapsed = stored === null ? window.matchMedia('(max-width: 860px)').matches : stored === 'true';
    shell.classList.toggle('mdh-toc-collapsed', collapsed);
  } catch (error) {
    console.error(error);
  }
  updateTocToggle();
}

function persistTocCollapsedState() {
  if (!shell || !uiTocStorageKey) return;
  try {
    localStorage.setItem(uiTocStorageKey, String(shell.classList.contains('mdh-toc-collapsed')));
  } catch (error) {
    console.error(error);
  }
}

function updateTocToggle() {
  if (!shell || !tocToggle) return;
  const collapsed = shell.classList.contains('mdh-toc-collapsed');
  tocToggle.setAttribute('aria-expanded', String(!collapsed));
  tocToggle.textContent = collapsed ? '目次を開く' : '目次を閉じる';
}

updateTocToggle();

document.addEventListener('keydown', (event) => {
  if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return;
  event.preventDefault();
  event.stopPropagation();
  if (event.shiftKey) redoDocument();
  else undoDocument();
}, true);

function setupDragAndDrop() {
  root.addEventListener('dragstart', (event) => {
    const handle = event.target.closest('.mdh-block-handle');
    const blockEl = handle?.closest('[data-block-id]');
    if (!handle || !blockEl) return;
    closeTypeMenus();
    window.getSelection()?.removeAllRanges();
    document.activeElement?.blur?.();
    draggingBlockId = blockEl.dataset.blockId;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', draggingBlockId);
    event.dataTransfer.setDragImage(blockEl, 20, Math.min(24, blockEl.offsetHeight / 2));
    blockEl.classList.add('mdh-dragging');
  });

  root.addEventListener('dragover', (event) => {
    if (!draggingBlockId) return;
    const blockEl = event.target.closest('[data-block-id]');
    if (!blockEl || blockEl.dataset.blockId === draggingBlockId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const rect = blockEl.getBoundingClientRect();
    const position = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    setDragCandidate(blockEl, position);
  });

  root.addEventListener('dragleave', (event) => {
    if (!dropCandidate?.blockEl) return;
    if (event.relatedTarget && dropCandidate.blockEl.contains(event.relatedTarget)) return;
    dropCandidate.blockEl.classList.remove('mdh-drop-before', 'mdh-drop-after');
    dropCandidate = null;
  });

  root.addEventListener('drop', (event) => {
    if (!draggingBlockId || !dropCandidate) return;
    event.preventDefault();
    const { blockEl, position } = dropCandidate;
    const movedId = draggingBlockId;
    const changed = moveBlockById(movedId, blockEl.dataset.blockId, position);
    clearDragState();
    if (changed) focusBlock(movedId);
  });

  root.addEventListener('dragend', clearDragState);
}

function setDragCandidate(blockEl, position) {
  if (dropCandidate?.blockEl === blockEl && dropCandidate.position === position) return;
  clearDropCandidate();
  blockEl.classList.add(position === 'before' ? 'mdh-drop-before' : 'mdh-drop-after');
  dropCandidate = { blockEl, position };
}

function clearDropCandidate() {
  dropCandidate?.blockEl?.classList.remove('mdh-drop-before', 'mdh-drop-after');
  dropCandidate = null;
}

function clearDragState() {
  root.querySelectorAll('.mdh-dragging, .mdh-drop-before, .mdh-drop-after').forEach((node) => {
    node.classList.remove('mdh-dragging', 'mdh-drop-before', 'mdh-drop-after');
  });
  draggingBlockId = null;
  dropCandidate = null;
}

function moveBlockById(draggedId, targetId, position) {
  const nextBlocks = moveBlock(currentDocument.blocks || [], draggedId, targetId, position);
  if (!nextBlocks) return false;
  clearInputHistoryState();
  rememberHistory();
  currentDocument.blocks = nextBlocks;
  renderDocument(currentDocument);
  persistDocument();
  return true;
}

function rememberHistory() {
  if (isApplyingHistory) return;
  pushUndoSnapshot(cloneDocument(currentDocument));
  redoStack = [];
}

function pushUndoSnapshot(snapshot) {
  undoStack.push(snapshot);
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
}

function undoDocument() {
  if (!undoStack.length) return false;
  redoStack.push(cloneDocument(currentDocument));
  const previous = undoStack.pop();
  applyHistoryDocument(previous);
  return true;
}

function redoDocument() {
  if (!redoStack.length) return false;
  undoStack.push(cloneDocument(currentDocument));
  const next = redoStack.pop();
  applyHistoryDocument(next);
  return true;
}

function applyHistoryDocument(documentData) {
  isApplyingHistory = true;
  clearInputHistoryState();
  currentDocument = cloneDocument(documentData);
  renderDocument(currentDocument);
  persistDocument();
  isApplyingHistory = false;
}

function inputHistoryKey(target) {
  const blockEl = target.closest?.('[data-block-id]');
  if (!blockEl) return null;
  const tableCell = target.closest('[data-table-cell]');
  const listItem = target.closest('[data-list-item-index]');
  return `${blockEl.dataset.blockId}:${tableCell?.dataset.tableCell || listItem?.dataset.listItemIndex || 'content'}`;
}

function rememberInputHistory(key) {
  if (isApplyingHistory) return;
  if (activeInputHistoryKey !== key || !activeInputSnapshot) {
    activeInputHistoryKey = key;
    activeInputSnapshot = cloneDocument(currentDocument);
    activeInputHistoryRecorded = false;
  }
  if (activeInputHistoryRecorded) return;
  pushUndoSnapshot(cloneDocument(activeInputSnapshot));
  redoStack = [];
  activeInputHistoryRecorded = true;
}

function clearInputHistoryState() {
  activeInputHistoryKey = null;
  activeInputSnapshot = null;
  activeInputHistoryRecorded = false;
}
