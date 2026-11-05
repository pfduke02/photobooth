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
    const params = new URL(url).searchParams;
    return Response.json((!params.has('status') || params.get('status') === `eq.${job.status}`) &&
      (!params.has('id') || params.get('id') === `eq.${job.id}`) ? [{ ...job }] : []);
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

test('a receipt is retained when the queue row changes before acknowledgement', async t => {
  const { job, calls, options, spool } = await fixture(t);
  calls.failAck = true;
  await assert.rejects(createWorker(options).tick(), /503/);
  job.status = 'pending'; // e.g. an operator requeues after losing the acknowledgement
  calls.failAck = false;
  await assert.rejects(createWorker(options).tick(), /acknowledg|receipt|attention/i);
  assert.equal(calls.printed, 1, 'a local receipt must prohibit a second lp submission');
  assert.ok((await readdir(spool)).some(file => file.endsWith('.receipt.json')));
});

test('a locally acknowledged job cannot be printed again by resetting its row', async t => {
  const { job, calls, options } = await fixture(t);
  await createWorker(options).tick();
  job.status = 'pending';
  await assert.rejects(createWorker(options).tick(), /submission receipt/);
  assert.equal(calls.printed, 1);
});

test('a lost acknowledgement response can be reconciled when the cloud is already done', async t => {
  const { job, calls, options, spool } = await fixture(t);
  calls.failAck = true;
  await assert.rejects(createWorker(options).tick(), /503/);
  calls.failAck = false; job.status = 'done';
  await createWorker(options).tick();
  assert.ok((await readdir(spool)).some(file => file.endsWith('.submitted.json')));
  assert.equal(calls.printed, 1);
});

test('invalid payload and lp rejection become explicit job errors', async t => {
  for (const failure of ['path', 'copies', 'lp']) {
    const { job, calls, options } = await fixture(t);
    if (failure === 'path') job.image_path = null;
    if (failure === 'copies') job.copies = 0;
    if (failure === 'lp') options.print = async () => { throw new Error('printer unavailable'); };
    await assert.rejects(createWorker(options).tick());
    assert.equal(job.status, 'error');
    assert.equal(calls.printed, 0);
    assert.ok(job.error);
  }
});

test('a selected-job test cannot consume an unrelated pending job', async t => {
  const { job, calls, options } = await fixture(t);
  await createWorker({ ...options, jobId: '2026-11-03_000000000000' }).tick();
  assert.equal(calls.printed, 0);
  assert.equal(job.status, 'pending');
  await createWorker({ ...options, jobId: job.id }).tick();
  assert.equal(calls.printed, 1);
});

test('a selected-job test does not acknowledge another job\'s outstanding receipt', async t => {
  const { calls, options } = await fixture(t);
  calls.failAck = true;
  await assert.rejects(createWorker(options).tick(), /503/);
  const before = calls.patches;
  await createWorker({ ...options, jobId: '2026-11-03_000000000000' }).tick();
  assert.equal(calls.patches, before);
  assert.equal(calls.printed, 1);
});

test('a lost claim response never leads to an unconfirmed lp submission', async t => {
  const { job, calls, options } = await fixture(t);
  const fetch = options.fetch;
  options.fetch = async (url, opts) => {
    const result = await fetch(url, opts);
    if (opts.method === 'PATCH' && JSON.parse(opts.body).status === 'printing') throw new Error('connection lost after claim');
    return result;
  };
  await assert.rejects(createWorker(options).tick(), /connection lost/);
  assert.equal(job.status, 'printing');
  assert.equal(calls.printed, 0);
});

test('two workers sharing a spool can reconcile the same receipt without reprinting', async t => {
  const { job, calls, options } = await fixture(t);
  calls.failAck = true;
  await assert.rejects(createWorker(options).tick(), /503/);
  calls.failAck = false;
  await Promise.all([createWorker(options).tick(), createWorker(options).tick()]);
  assert.equal(job.status, 'done');
  assert.equal(calls.printed, 1);
});
