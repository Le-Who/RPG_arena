import { test } from 'node:test';
import assert from 'node:assert/strict';
import { turnInputHash, normalizeTurnInput } from '../src/lib/turn-admission';
const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
test('hidden item identity is normalized and bound to retry identity', () => {
  const input = { sessionId: a, action: 'Использовать «Набор»', isFree: true, expectedTurn: 1 };
  assert.notEqual(turnInputHash({...input,itemIds:[a]}), turnInputHash({...input,itemIds:[b]}));
  assert.deepEqual(normalizeTurnInput({...input,itemIds:[a,a]}).itemIds,[a]);
  assert.throws(() => normalizeTurnInput({...input,itemIds:['#123456']}));
});
test('selected item pins exact duplicate-name item and invalid owned refs fail closed', async () => {
  const { actionWithItemBindings, retainedItemBindings } = await import('../src/lib/item-bindings');
  const items = [{id:a,name:'Набор',quantity:1},{id:b,name:'Набор',quantity:0}];
  assert.match(actionWithItemBindings('Использовать «Набор»',[a],items),new RegExp(a));
  assert.throws(()=>actionWithItemBindings('Использовать «Набор»',[b],items));
  assert.throws(()=>actionWithItemBindings('Набор',[b],items.slice(0,1)));
  assert.deepEqual(retainedItemBindings('Осмотреться',[{id:a,name:'Набор'}]),[]);
});
