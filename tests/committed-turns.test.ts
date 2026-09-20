import { test } from 'node:test';
import assert from 'node:assert/strict';
test('preview is retired only after the committed feed has been published', async () => {
  const { publishCommittedTurn } = await import('../src/lib/committed-turns');
  const events: string[] = [];
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const done = publishCommittedTurn({ turnNumber: 4 } as never, async () => {
    await ready;
    events.push('published');
  }, () => { events.push('cleared'); });
  assert.deepEqual(events, []);
  release();
  await done;
  assert.deepEqual(events, ['published', 'cleared']);
});

test('a failed feed publication preserves the visible preview', async () => {
  const { publishCommittedTurn } = await import('../src/lib/committed-turns');
  let cleared = false;
  await assert.rejects(publishCommittedTurn({ turnNumber: 4 } as never, async () => {
    throw new Error('publication failed');
  }, () => { cleared = true; }), /publication failed/);
  assert.equal(cleared, false);
});
test('committed response is visible without waiting for snapshot and deduplicates after reload',async()=>{
  const { withCommittedTurn }=await import('../src/lib/committed-turns');
  const result={ok:true,requestId:'req',turnNumber:4,narration:'Готовый рассказ',playerAction:'Использовать «Набор»',choices:['Далее'],dice:null,modelUsed:'gemini-lite',taskType:'resolution'};
  const turns=withCommittedTurn([],result as never,'session');
  assert.deepEqual(turns.map(t=>t.content),['Использовать «Набор»','Готовый рассказ']);
  assert.equal(withCommittedTurn(turns,result as never,'session').length,2);
});
test('confirmed state advances version and choices while bulk panels load in background',async()=>{
  const { applyCommittedSnapshot }=await import('../src/lib/committed-turns');
  const before={session:{id:'session',turnCount:3,character:{hp:10},worldState:{currentLocation:'Гавань'}},turns:[],inventory:[{name:'Карта'}]};
  const result={ok:true,requestId:'req',turnNumber:4,narration:'Башня',choices:['Войти'],state:{character:{hp:8},worldState:{currentLocation:'Башня'}}};
  const updated=applyCommittedSnapshot(before as never,result as never)!;
  assert.equal(updated.session.turnCount,4);assert.equal(updated.session.character.hp,8);assert.equal(updated.session.worldState.currentLocation,'Башня');
  assert.deepEqual(updated.turns.at(-1)?.choices,['Войти']);assert.equal(updated.inventory,before.inventory);
  assert.equal(applyCommittedSnapshot(updated,{...result,turnNumber:3} as never),updated);
});
