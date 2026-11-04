import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { createWorker } = createRequire(import.meta.url)('../printserver.js');

async function fixture(t) {
  const spool = await mkdtemp(path.join(os.tmpdir(), 'pb-print-test-'));
  t.after(() => rm(spool, { recursive: true, force: true }));
  const job = { id: '2026-11-03_abcdef123456', status: 'pending', copies: 1, image_path: 'prints/test.png' };
  const calls = { printed: 0, patches: 0, failClaim: false, failAck: false, failDownload: false };
  const fetch = async (url, options) => {
    if (url.includes('/storage/')) return new Response('image', { status: calls.failDownload ? 503 : 200 });
    if (options.method === 'PATCH') {
      calls.patches++;
      const fields = JSON.parse(options.body);
      if ((fields.status === 'printing' && calls.failClaim) || (fields.status === 'done' && calls.failAck))
        return new Response('unavailable', { status: 503 });
      const expected = new URL(url).searchParams.get('status').slice(3);
      if (job.status !== expected) return Response.json([]);
      Object.assign(job, fields);
      return Response.json([job]);
    }
    return Response.json(job.status === 'pending' ? [{ ...job }] : []);
  };
  const options = { url: 'https://example.test', spool, fetch, log: () => {}, print: async () => { calls.printed++; return 'request id is Canon-42'; } };
  return { job, calls, options, spool };
}

test('two workers atomically claim one job and submit one sheet', async t => {
  const { job, calls, options } = await fixture(t);
  // Different Macs have separate local spool directories.
  const secondSpool = await mkdtemp(path.join(os.tmpdir(), 'pb-second-worker-'));
  t.after(() => rm(secondSpool, { recursive: true, force: true }));
  await Promise.all([createWorker(options).tick(), createWorker({ ...options, spool: secondSpool }).tick()]);
  assert.equal(calls.printed, 1);
  assert.equal(job.status, 'done');
});

test('failed claim never sends anything to lp', async t => {
  const { calls, options } = await fixture(t);
  calls.failClaim = true;
  await assert.rejects(createWorker(options).tick(), /503/);
  assert.equal(calls.printed, 0);
});

test('a failed acknowledgement recovers after restart without reprinting', async t => {
  const { job, calls, options, spool } = await fixture(t);
  calls.failAck = true;
  await assert.rejects(createWorker(options).tick(), /503/);
  assert.equal(job.status, 'printing');
  assert.equal(calls.printed, 1);
  assert.ok((await readdir(spool)).some(file => file.endsWith('.receipt.json')));
  calls.failAck = false;
  await createWorker(options).tick();
  assert.equal(job.status, 'done');
  assert.equal(calls.printed, 1);
});

test('dry-run leaves the real job pending and never invokes lp', async t => {
  const { job, calls, options } = await fixture(t);
  await createWorker({ ...options, dryRun: true }).tick();
  assert.equal(job.status, 'pending');
  assert.equal(calls.patches, 0);
  assert.equal(calls.printed, 0);
});

test('download failure becomes an actionable printer error', async t => {
  const { job, calls, options } = await fixture(t);
  calls.failDownload = true;
  await assert.rejects(createWorker(options).tick(), /503/);
  assert.equal(job.status, 'error');
  assert.equal(calls.printed, 0);
});
