import assert from 'node:assert/strict';
import { moveBlock } from './lib/editable-dnd.mjs';

const ids = (blocks) => blocks.map((block) => block.id);
const blocks = ['a', 'b', 'c', 'd'].map((id) => ({ id }));

assert.deepEqual(ids(moveBlock(blocks, 'b', 'd', 'after')), ['a', 'c', 'd', 'b']);
assert.deepEqual(ids(moveBlock(blocks, 'd', 'b', 'before')), ['a', 'd', 'b', 'c']);
assert.deepEqual(ids(moveBlock(blocks, 'a', 'd', 'after')), ['b', 'c', 'd', 'a']);
assert.deepEqual(ids(moveBlock(blocks, 'd', 'a', 'before')), ['d', 'a', 'b', 'c']);
assert.equal(moveBlock(blocks, 'b', 'b', 'before'), null);
assert.equal(moveBlock(blocks, 'b', 'c', 'before'), null);
assert.equal(moveBlock(blocks, 'c', 'b', 'after'), null);
assert.equal(moveBlock(blocks, 'x', 'b', 'before'), null);
assert.equal(moveBlock(blocks, 'b', 'x', 'before'), null);
assert.deepEqual(ids(blocks), ['a', 'b', 'c', 'd']);

console.log('Drag order tests passed');
