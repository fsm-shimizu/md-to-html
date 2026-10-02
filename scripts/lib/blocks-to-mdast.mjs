export function editableDocumentToMdast(document) {
  return { type: 'root', children: blocksToMdast(document.blocks || []) };
}

export function blocksToMdast(blocks) {
  return blocks.flatMap((block) => blockToMdast(block));
}

export function contentToInlineNodes(content = []) {
  return content.flatMap((item) => contentItemToInlineNode(item));
}

function blockToMdast(block) {
  if (block.type === 'heading') {
    return [{ type: 'heading', depth: block.level, children: contentToInlineNodes(block.content) }];
  }

  if (block.type === 'paragraph') {
    return [{ type: 'paragraph', children: contentToInlineNodes(block.content) }];
  }

  if (block.type === 'blockquote') {
    return [{ type: 'blockquote', children: blocksToMdast(block.blocks || []) }];
  }

  if (block.type === 'code') {
    return [{ type: 'code', lang: block.lang || null, value: block.value || '' }];
  }

  if (block.type === 'thematicBreak') {
    return [{ type: 'thematicBreak' }];
  }

  if (block.type === 'list') {
    return [{
      type: 'list',
      ordered: Boolean(block.ordered),
      start: block.start || null,
      spread: false,
      children: (block.items || []).map((item) => ({
        type: 'listItem',
        spread: false,
        checked: typeof item.checked === 'boolean' ? item.checked : null,
        children: [{ type: 'paragraph', children: contentToInlineNodes(item.content) }]
      }))
    }];
  }

  if (block.type === 'table') {
    return [{
      type: 'table',
      align: block.align || [],
      children: [
        tableRowToMdast(block.headers || []),
        ...(block.rows || []).map(tableRowToMdast)
      ]
    }];
  }

  if (block.type === 'unsupported' && block.sourceType === 'html') {
    return [{ type: 'html', value: block.raw || '' }];
  }

  if (block.type === 'unsupported') {
    return [{
      type: 'paragraph',
      children: [{ type: 'text', value: `[unsupported: ${block.sourceType}]` }]
    }];
  }

  return [];
}

function tableRowToMdast(cells) {
  return {
    type: 'tableRow',
    children: cells.map((cell) => ({
      type: 'tableCell',
      children: contentToInlineNodes(cell)
    }))
  };
}

function contentItemToInlineNode(item) {
  if (!item) return [];
  if (item.type === 'text') return [{ type: 'text', value: item.text || '' }];
  if (item.type === 'inlineCode') return [{ type: 'inlineCode', value: item.value || '' }];
  if (item.type === 'break') return [{ type: 'break' }];
  if (item.type === 'strong' || item.type === 'emphasis' || item.type === 'delete') {
    return [{ type: item.type, children: contentToInlineNodes(item.children || []) }];
  }
  if (item.type === 'link') {
    return [{
      type: 'link',
      url: item.url || '',
      title: item.title || null,
      children: contentToInlineNodes(item.children || [])
    }];
  }
  return [{ type: 'text', value: item.text || item.value || '' }];
}
