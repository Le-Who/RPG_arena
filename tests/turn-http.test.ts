import { test } from 'node:test';
import assert from 'node:assert/strict';
test('turn transport emits draft before commit, and background runs after work', async () => {
  const { turnHttpResponse } = await import('../src/lib/turn-http');
  let commit!:()=>void; const gate = new Promise<void>(r=>commit=r); let background = false;
  let afterJob!:()=>Promise<void>;
  const response = await turnHttpResponse(true, async runtime => {
    runtime.schedule?.(async()=>{background=true;});
    runtime.onEvent?.({type:'narration',text:'Первые слова'});
    await gate; return {ok:true,narration:'Сохранено',turnNumber:2,timings:{generationMs:20}} as never;
  }, job=>{afterJob=job;});
  const reader=response.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value),/Первые слова/);
  assert.equal(background,false); commit();
  assert.match(new TextDecoder().decode((await reader.read()).value),/committed/);
  await afterJob(); assert.equal(background,true);
});
test('JSON compatibility carries phase timing and structured failures',async()=>{
  const { turnHttpResponse } = await import('../src/lib/turn-http');
  const response=await turnHttpResponse(false,async()=>({ok:true,timings:{generationMs:32,serverMs:50}} as never),()=>{});
  assert.match(response.headers.get('server-timing')!,/generation;dur=32/);
  assert.equal((await response.json()).ok,true);
  const failed=await turnHttpResponse(false,async()=>({ok:false,code:'AI_FAILED',message:'retry'}),()=>{});
  assert.equal(failed.status,503);
});
test('JSON turn response distinguishes local quota outage and admission timeout', async () => {
  const { turnHttpResponse } = await import('../src/lib/turn-http');
  for (const [code, status] of [['QUOTA_UNAVAILABLE', 503], ['QUOTA_ADMISSION_TIMEOUT', 504]] as const) {
    const response = await turnHttpResponse(false, async () => ({ ok: false, code, message: 'No turn committed' }), () => {});
    assert.equal(response.status, status);
    assert.equal((await response.json()).code, code);
  }
});
