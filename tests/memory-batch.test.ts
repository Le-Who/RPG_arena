import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTableName } from 'drizzle-orm';
import { writeStateEvents } from '../src/lib/memory';
test('state event batch shares lock/config and writes embedding outbox once', async () => {
  const counts: Record<string,number> = {}; let next=0;
  const tx = {
    execute: async () => { counts.lock=(counts.lock??0)+1; },
    select: () => ({from(table: Parameters<typeof getTableName>[0]) { const name=getTableName(table); counts[name]=(counts[name]??0)+1; const rows = name==='ai_settings'?[{dims:768}]:[]; return {where:()=>Object.assign(Promise.resolve(rows),{limit:async()=>rows})}; }}),
    insert: (table: Parameters<typeof getTableName>[0]) => ({ values: (value: unknown) => { const name=getTableName(table); counts[`insert:${name}`]=(counts[`insert:${name}`]??0)+1; if(name==='memory_embeddings') assert.equal((value as unknown[]).length,3); return {returning:async()=>[{id:`node-${++next}`}],onConflictDoUpdate:async()=>{}}; }}),
  };
  const events = Array.from({length:3},(_,i)=>({layer:'episodic' as const,category:'event',title:`Event ${i}`,content:`Content ${i}`,importance:70,entityKey:`event:${i}`,mode:'upsert' as const}));
  const ids = await writeStateEvents('session',events,2,tx as never);
  assert.equal(ids.length,3); assert.equal(counts.lock,1); assert.equal(counts.ai_settings,1); assert.equal(counts['insert:memory_embeddings'],1);
});
