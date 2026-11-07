/* Durable session delivery. A requested print is queued only after its strip
   has been archived. Stable IDs make retries safe after a lost response. */
(function () {
  function newId() {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    return new Date().toISOString().slice(0, 10) + '_' +
      Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }

  function createDelivery(config, onChange, onPending) {
    const records = new Map(), running = new Map(), printing = new Map();
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
      saved.filter(record => !complete(record)).forEach(record => records.set(record.id, record));
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
        // Read/merge/write in ONE transaction: another tab's successful delivery
        // or print intent must never be overwritten by this tab's stale copy.
        await new Promise((resolve, reject) => {
          const tx = db.transaction('pending', 'readwrite');
          const store = tx.objectStore('pending');
          const get = store.get(record.id);
          get.onsuccess = () => {
            const saved = get.result;
            if (saved) {
              record.targets = [...new Set([...saved.targets, ...record.targets])];
              for (const [kind, result] of Object.entries(saved.results)) {
                if (result.ok || !record.results[kind]?.ok) record.results[kind] = result;
              }
              if (saved.print) {
                if (record.print?.id !== saved.print.id) record.print = saved.print;
                else if (saved.print.result?.ok || !record.print.result?.ok)
                  record.print.result = saved.print.result || record.print.result;
              }
            }
            // Keep a small completion receipt so a stale tab cannot recreate a
            // completed print under a fresh ID. Drop all image data on success.
            const value = complete(record) ? {
              id: record.id, targets: record.targets, results: record.results,
              ...(record.print ? { print: { id: record.print.id, result: record.print.result } } : {}),
            } : { ...record, sending: false };
            store.put(value);
          };
          tx.oncomplete = resolve;
          tx.onerror = tx.onabort = () => reject(tx.error || new Error('Browser storage unavailable'));
        });
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
      const targets = record.targets.filter(k => !record.results[k]?.ok);
      await Promise.all(targets.map(async kind => {
        record.results[kind] = await post(config[kind].endpoint, record.session, kind === 'cloud');
        await persist(record);
        if (kind === 'cloud') await sendPrint(record);
      }));
      if (!targets.includes('cloud')) await sendPrint(record);
      record.sending = false;
      await persist(record);
      // Completed payloads need only stay in memory for the current result screen.
      for (const [id, old] of records) {
        if (records.size <= 24) break;
        if (id !== record.id && complete(old)) records.delete(id);
      }
      return record;
    }
    function sendPrint(record) {
      if (printing.has(record.id)) return printing.get(record.id);
      if (!record.print || record.print.result?.ok || !record.results.cloud?.ok) return Promise.resolve();
      const task = (async () => {
        await persist(record); // Reconcile another tab's job ID / completed receipt.
        if (record.print.result?.ok) return;
        record.print.result = await post(config.cloud.endpoint.replace(/\/[^/]+$/, '/print'), {
          id: record.print.id, image: record.print.image, copies: 1,
          meta: { sessionId: record.id },
        }, true);
        await persist(record);
      })().finally(() => printing.delete(record.id));
      printing.set(record.id, task);
      return task;
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
      // A slow local destination must not delay an already archived cloud print.
      if (record.results.cloud?.ok) { await sendPrint(record); return record; }
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
