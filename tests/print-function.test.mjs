import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrintHandler } from '../supabase/functions/print/handler.mjs';

function fixture() {
  const jobs = new Map(), images = new Map();
  let failInsert = false;
  const client = {
    from() { return {
      select() { return { eq(_, id) { return { async maybeSingle() { return { data: jobs.get(id) || null }; } }; } }; },
      async upsert(job, opts) {
        if (failInsert) return { error: new Error('database unavailable') };
        assert.equal(opts.ignoreDuplicates, true);
        if (!jobs.has(job.id)) jobs.set(job.id, job);
        return {};
      },
    }; },
    storage: { from() { return { async upload(path, bytes, options) {
      assert.equal(options.upsert, false);
      if (images.has(path)) return { error: { statusCode: '409' } };
      images.set(path, bytes);
      return {};
    } }; } },
  };
  const handler = createPrintHandler({ createClient: () => client, env: { get: () => 'https://example.test' } });
  const send = body => handler(new Request('https://example.test/print', {
    method: 'POST', headers: { 'x-booth-key': 'lp1107-54db1816' }, body: JSON.stringify(body),
  }));
  return { jobs, images, send, failInsert: value => { failInsert = value; } };
}
const payload = { id: '2026-11-03_012345abcdef', image: 'data:image/png;base64,aW1hZ2U=', meta: { sessionId: '2026-11-03_112345abcdef' } };

test('concurrent retries create one image and one job', async () => {
  const f = fixture();
  const responses = await Promise.all([f.send(payload), f.send(payload)]);
  assert.deepEqual(responses.map(r => r.status), [200, 200]);
  assert.equal(f.jobs.size, 1);
  assert.equal(f.images.size, 1);
  assert.equal(f.jobs.get(payload.id).meta.sessionId, payload.meta.sessionId);
});

test('replay cannot reset a completed job or replace its image', async () => {
  const f = fixture();
  await f.send(payload);
  f.jobs.get(payload.id).status = 'done';
  const response = await f.send({ ...payload, image: 'data:image/png;base64,bmV3' });
  assert.equal((await response.json()).status, 'done');
  assert.equal(new TextDecoder().decode([...f.images.values()][0]), 'image');
});

test('upload success and database failure can be retried safely', async () => {
  const f = fixture();
  f.failInsert(true);
  assert.equal((await f.send(payload)).status, 500);
  f.failInsert(false);
  assert.equal((await f.send(payload)).status, 200);
  assert.equal(f.jobs.size, 1);
  assert.equal(f.images.size, 1);
});

test('older clients without IDs still work; bad input is rejected', async () => {
  const f = fixture();
  assert.equal((await f.send({ image: payload.image })).status, 200);
  for (const bad of [null, {}, { ...payload, id: '../bad' }, { ...payload, image: 'data:image/png;base64,%%%' }])
    assert.equal((await f.send(bad)).status, 400);
});
