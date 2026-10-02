export function moveBlock(blocks, draggedId, targetId, position) {
  const fromIndex = blocks.findIndex((block) => block.id === draggedId);
  const targetIndex = blocks.findIndex((block) => block.id === targetId);
  if (fromIndex < 0 || targetIndex < 0 || draggedId === targetId) return null;
  if (position === 'before' && fromIndex === targetIndex - 1) return null;
  if (position === 'after' && fromIndex === targetIndex + 1) return null;

  const nextBlocks = blocks.slice();
  const [moved] = nextBlocks.splice(fromIndex, 1);
  const rawInsertIndex = position === 'after' ? targetIndex + 1 : targetIndex;
  const insertIndex = fromIndex < rawInsertIndex ? rawInsertIndex - 1 : rawInsertIndex;
  nextBlocks.splice(insertIndex, 0, moved);
  return nextBlocks;
}
