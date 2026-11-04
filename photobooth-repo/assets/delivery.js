/* Durable session delivery. A requested print is queued only after its strip
   has been archived. Stable IDs make retries safe after a lost response. */
(function () {
  function newId() {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    return new Date().toISOString().slice(0, 10) + '_' +
      Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }

  function createDelivery(config, onChange, onPending) {
    const records = new Map(), running = new Map();
    let db;
    const ready = new Promise(resolve => {
      try {
        const request = indexedDB.open('photobooth-delivery', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('pending', { keyPath: 'id' });
        request.onerror = () => resolve();
        request.onsuccess = () => { db = request.result; resolve(); };
      } catch { resolve(); }
    }).then(async () => {
      if (!db) return;
      const saved = await transaction('readonly', store => store.getAll()).catch(() => []);
      saved.forEach(record => records.set(record.id, record));
    });

    function transaction(mode, operation) {
      return new Promise((resolve, reject) => {
        const tx = db.transaction('pending', mode);
        const request = operation(tx.objectStore('pending'));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = tx.onabort = () => reject(tx.error || new Error('Browser storage unavailable'));
      });
    }
    function complete(record) {
      return record.targets.every(k => record.results[k]?.ok) &&
        (!record.print || record.print.result?.ok);
    }
    function notify(record) {
      onChange(record);
      onPending?.([...records.values()].filter(r => !complete(r)).length);
    }
    async function persist(record) {
      try {
        if (!db) throw new Error('Browser storage unavailable');
        await transaction('readwrite', store => complete(record) ? store.delete(record.id) : store.put(record));
        record.durable = true;
      } catch { record.durable = false; }
      notify(record);
    }
    async function post(endpoint, body, cloud) {
      const headers = { 'Content-Type': 'application/json' };
      if (cloud) Object.assign(headers, {
        apikey: config.cloud.anonKey, Authorization: 'Bearer ' + config.cloud.anonKey,
        'x-booth-key': config.cloud.boothKey,
      });
      try {
        const response = await fetch(endpoint, {
          method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(45000),
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || 'HTTP ' + response.status);
        return { ...data, ok: true };
      } catch (error) { return { ok: false, error: String(error.message || error) }; }
    }
    async function send(record) {
      await persist(record); // Save the images before starting network work.
      record.sending = true;
      notify(record);
      await Promise.all(record.targets.filter(k => !record.results[k]?.ok).map(async kind => {
        record.results[kind] = await post(config[kind].endpoint, record.session, kind === 'cloud');
        await persist(record);
      }));
      if (record.print && !record.print.result?.ok && record.results.cloud?.ok) {
        record.print.result = await post(config.cloud.endpoint.replace(/\/[^/]+$/, '/print'), {
          id: record.print.id, image: record.print.image, copies: 1,
          meta: { sessionId: record.id },
        }, true);
      }
      record.sending = false;
      await persist(record);
      // Completed payloads need only stay in memory for the current result screen.
      for (const [id, old] of records) {
        if (records.size <= 24) break;
        if (id !== record.id && complete(old)) records.delete(id);
      }
      return record;
    }
    function flush(record) {
      if (running.has(record.id)) return running.get(record.id);
      const task = send(record).finally(() => running.delete(record.id));
      running.set(record.id, task);
      return task;
    }
    async function retryAll() {
      await ready;
      // Serial recovery keeps a long offline backlog from flooding the connection.
      for (const record of records.values()) if (!complete(record)) await flush(record);
    }
    async function save(session) {
      await ready;
      let record = records.get(session.id);
      if (!record) {
        record = { id: session.id, session, targets: config.target === 'both' ? ['local', 'cloud'] : [config.target], results: {} };
        records.set(record.id, record);
      }
      return flush(record);
    }
    async function requestPrint(session, image) {
      await ready;
      let record = records.get(session.id);
      if (!record) {
        record = { id: session.id, session, targets: ['cloud'], results: {} };
        records.set(record.id, record);
      }
      if (!record.targets.includes('cloud')) record.targets.push('cloud');
      if (!record.print) record.print = { id: newId(), image };
      await persist(record);
      // Persist the intent immediately, including while an upload is in flight.
      // If that send already passed its print step, run it once more below.
      if (running.has(session.id)) await running.get(session.id);
      if (record.print.result?.ok) return record;
      return flush(record);
    }
    window.addEventListener('online', retryAll);
    const timer = setInterval(retryAll, 30000);
    ready.then(retryAll);
    return { save, requestPrint, retryAll, ready, records, stop: () => {
      clearInterval(timer); window.removeEventListener('online', retryAll);
    } };
  }
  window.PBDelivery = { newId, create: createDelivery };
})();
