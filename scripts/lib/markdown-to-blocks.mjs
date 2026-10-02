import { isSafeUrl } from './url-safety.mjs';

export function markdownDocumentToEditableDocument(document, sourceMarkdown) {
  return {
    version: 1,
    title: document.title,
    titleSource: document.titleSource,
    frontmatter: document.frontmatter,
    promoted: document.promoted,
    blocks: mdastToBlocks(document.tree, sourceMarkdown)
  };
}

export function mdastToBlocks(tree, sourceMarkdown) {
  return nodesToBlocks(tree.children || [], sourceMarkdown, { value: 0 });
}

export function inlineNodesToContent(nodes = []) {
  return nodes.flatMap((node) => inlineNodeToContent(node));
}

export function nextBlockId(index) {
  return `b_${String(index + 1).padStart(3, '0')}`;
}

function nodesToBlocks(nodes, sourceMarkdown, counter) {
  return nodes.map((node) => nodeToBlock(node, sourceMarkdown, counter));
}

function nodeToBlock(node, sourceMarkdown, counter) {
  const id = nextBlockId(counter.value);
  counter.value += 1;
  if (node.type === 'heading') {
    return {
      id,
      type: 'heading',
      level: node.depth,
      originalDepth: node.data?.originalDepth ?? node.depth,
      content: inlineNodesToContent(node.children)
    };
  }

  if (node.type === 'paragraph') {
    return { id, type: 'paragraph', content: inlineNodesToContent(node.children) };
  }

  if (node.type === 'blockquote') {
    return { id, type: 'blockquote', blocks: nodesToBlocks(node.children || [], sourceMarkdown, counter) };
  }

  if (node.type === 'code') {
    return { id, type: 'code', lang: node.lang || '', value: node.value || '' };
  }

  if (node.type === 'thematicBreak') {
    return { id, type: 'thematicBreak' };
  }

  if (node.type === 'list') {
    return {
      id,
      type: 'list',
      ordered: Boolean(node.ordered),
      start: node.start || null,
      items: (node.children || []).map((item) => ({
        checked: typeof item.checked === 'boolean' ? item.checked : null,
        content: listItemToContent(item)
      }))
    };
  }

  if (node.type === 'table') {
    const rows = node.children || [];
    return {
      id,
      type: 'table',
      align: node.align || [],
      headers: rows[0] ? tableRowToContent(rows[0]) : [],
      rows: rows.slice(1).map(tableRowToContent)
    };
  }

  if (node.type === 'html') {
    return {
      id,
      type: 'unsupported',
      sourceType: 'html',
      raw: sliceNodeSource(node, sourceMarkdown) || node.value || '',
      unsupportedReason: 'raw HTML is hidden in preview'
    };
  }

  return {
    id,
    type: 'unsupported',
    sourceType: node.type,
    raw: sliceNodeSource(node, sourceMarkdown),
    unsupportedReason: `${node.type} is not supported in editable preview`
  };
}

function listItemToContent(item) {
  const paragraph = (item.children || []).find((child) => child.type === 'paragraph');
  if (paragraph) return inlineNodesToContent(paragraph.children);
  return inlineNodesToContent(item.children || []);
}

function tableRowToContent(row) {
  return (row.children || []).map((cell) => inlineNodesToContent(cell.children || []));
}

function sliceNodeSource(node, sourceMarkdown) {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (typeof start !== 'number' || typeof end !== 'number') return '';
  return sourceMarkdown.slice(start, end);
}

function inlineNodeToContent(node) {
  if (!node) return [];
  if (node.type === 'text') return [{ type: 'text', text: node.value || '' }];
  if (node.type === 'inlineCode') return [{ type: 'inlineCode', value: node.value || '' }];
  if (node.type === 'break') return [{ type: 'break' }];
  if (node.type === 'strong' || node.type === 'emphasis' || node.type === 'delete') {
    return [{ type: node.type, children: inlineNodesToContent(node.children || []) }];
  }
  if (node.type === 'link') {
    const children = inlineNodesToContent(node.children || []);
    if (!isSafeUrl(node.url)) return children;
    return [{ type: 'link', url: node.url, title: node.title || null, children }];
  }
  if (node.type === 'image') {
    return [{ type: 'text', text: `[image: ${node.url || ''}]` }];
  }
  if (node.value) return [{ type: 'text', text: String(node.value) }];
  if (node.children) return inlineNodesToContent(node.children);
  return [];
}
