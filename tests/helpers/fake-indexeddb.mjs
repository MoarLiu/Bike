// In-memory IndexedDB double for running src/storage.ts in Node.
//
// - Events are dispatched asynchronously (one task each), so promise reactions
//   queued by a handler run before the next event, as in browsers.
// - Transactions run one at a time in creation (FIFO) order across all
//   connections and databases. A transaction executes its requests in order,
//   including requests placed from another request's callbacks, then applies
//   its changes atomically and fires `complete`. `abort()` (or a failed
//   request) discards its changes and fires `abort`.
// - Values are structured-cloned on put and on get.
// - Failure injection, a scheduler hold, a commit gate and `orphan(tx)` (the
//   page that owns the transaction is gone: the browser still finishes it, but
//   no more events reach the page) let tests interleave operations exactly.

export const domError = (name, message = name) => new DOMException(message, name);

export function createTaskQueue() {
  let pending = 0;
  return {
    tick(fn) {
      pending += 1;
      setImmediate(() => {
        pending -= 1;
        fn();
      });
    },
    get pending() {
      return pending;
    },
    // Resolves once no fake event is scheduled any more.
    async idle() {
      for (let quiet = 0; quiet < 2;) {
        await new Promise((resolve) => setImmediate(resolve));
        quiet = pending === 0 ? quiet + 1 : 0;
      }
    },
  };
}

const stringList = (names) => ({
  length: names.length,
  item: (index) => names[index] ?? null,
  contains: (name) => names.includes(name),
  [Symbol.iterator]: () => names[Symbol.iterator](),
});

const stagedKey = (storeName, key) => JSON.stringify([storeName, key]);

export function createFakeIndexedDB(tasks = createTaskQueue()) {
  const databases = new Map();
  const queue = [];
  const queueWaiters = [];
  const failures = { open: new Map(), get: new Map(), put: [], commit: [] };
  const log = { opens: [], commits: [], aborts: [] };
  const handlerErrors = [];
  let running = null;
  let holds = 0;
  let commitGate = null;
  let openConnections = 0;

  const makeEvent = (type, target, extra = {}) => ({
    type,
    target,
    currentTarget: target,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    ...extra,
  });

  // Runs an event handler; returns true if it threw (like a browser, the
  // exception is reported, here to handlerErrors, and the transaction aborts).
  const deliver = (tx, handler, target, event) => {
    if (tx?._orphaned || typeof handler !== "function") return false;
    try {
      handler.call(target, event);
      return false;
    } catch (error) {
      handlerErrors.push(error);
      return true;
    }
  };

  const takeFailure = (list, info) => {
    const entry = list.find((item) => item.times > 0 && item.match(info));
    if (!entry) return null;
    entry.times -= 1;
    return entry.error();
  };

  const pump = () => {
    if (running || holds > 0 || !queue.length) return;
    const tx = queue.shift();
    running = tx;
    tasks.tick(() => tx._start());
  };

  const finish = (tx) => {
    if (running === tx) running = null;
    pump();
  };

  const notifyQueued = () => {
    for (const waiter of [...queueWaiters]) {
      if (queue.length < waiter.count) continue;
      queueWaiters.splice(queueWaiters.indexOf(waiter), 1);
      waiter.resolve([...queue]);
    }
  };

  class FakeRequest {
    constructor(source, transaction) {
      this.source = source;
      this.transaction = transaction;
      this.readyState = "pending";
      this.onsuccess = null;
      this.onerror = null;
      this._result = undefined;
      this._error = null;
    }

    get result() {
      if (this.readyState !== "done") throw domError("InvalidStateError", "The request has not finished.");
      return this._result;
    }

    get error() {
      if (this.readyState !== "done") throw domError("InvalidStateError", "The request has not finished.");
      return this._error;
    }
  }

  class FakeObjectStore {
    constructor(transaction, name) {
      this.transaction = transaction;
      this.name = name;
    }

    get(key) {
      const tx = this.transaction;
      return tx._request(this, () => {
        const failure = failures.get.get(tx.db.name);
        if (failure) throw failure();
        return tx._read(this.name, key);
      });
    }

    openCursor() {
      const tx = this.transaction, name = this.name;
      let keys, root;
      const next = index => tx._request(this, () => {
        keys ??= [...new Set([
          ...tx.db._data.stores.get(name).keys(),
          ...[...tx._staged.values()].filter(item => item.storeName === name).map(item => item.key),
        ])].sort();
        const key = keys[index];
        if (key === undefined) return null;
        return { key, value: tx._read(name, key), continue() {
          const step = next(index + 1);
          step.onsuccess = event => { root._result = step.result; root.onsuccess?.(event); };
        } };
      });
      root = next(0);
      return root;
    }

    put(value, key) {
      const tx = this.transaction;
      tx._assertActive();
      if (tx.mode === "readonly") throw domError("ReadOnlyError", "The transaction is read-only.");
      const injected = takeFailure(failures.put, { db: tx.db.name, store: this.name, key, value });
      if (injected) throw injected;
      const clone = structuredClone(value);
      return tx._request(this, () => {
        tx._staged.set(stagedKey(this.name, key), { storeName: this.name, key, value: clone });
        return key;
      });
    }
  }

  class FakeTransaction {
    constructor(connection, storeNames, mode) {
      this.db = connection;
      this.mode = mode;
      this.error = null;
      this.oncomplete = null;
      this.onerror = null;
      this.onabort = null;
      this._storeNames = storeNames;
      this._state = "queued";
      this._requests = [];
      this._staged = new Map();
      this._orphaned = false;
    }

    get objectStoreNames() {
      return stringList([...this._storeNames]);
    }

    objectStore(name) {
      if (this._state === "finished") throw domError("InvalidStateError", "The transaction has finished.");
      if (!this._storeNames.includes(name)) throw domError("NotFoundError", `No object store named ${name}.`);
      return new FakeObjectStore(this, name);
    }

    abort() {
      if (this._state !== "queued" && this._state !== "running") {
        throw domError("InvalidStateError", "The transaction has already committed or aborted.");
      }
      this._abort(null);
    }

    _assertActive() {
      if (this._state !== "queued" && this._state !== "running") {
        throw domError("TransactionInactiveError", "The transaction is not active.");
      }
    }

    _request(source, operation) {
      this._assertActive();
      const request = new FakeRequest(source, this);
      this._requests.push({ request, operation });
      return request;
    }

    _read(storeName, key) {
      const staged = this._staged.get(stagedKey(storeName, key));
      const value = staged ? staged.value : this.db._data.stores.get(storeName).get(key);
      return value === undefined ? undefined : structuredClone(value);
    }

    _start() {
      if (this._state !== "queued") return;
      this._state = "running";
      this._step();
    }

    _step() {
      if (this._state !== "running") return;
      const entry = this._requests.shift();
      if (!entry) {
        this._commit();
        return;
      }
      const { request, operation } = entry;
      let failure = null;
      let result;
      try {
        result = operation();
      } catch (error) {
        failure = error;
      }
      request.readyState = "done";
      if (failure) {
        request._error = failure;
        const event = makeEvent("error", request);
        let threw = deliver(this, request.onerror, request, event);
        event.currentTarget = this;
        threw = deliver(this, this.onerror, this, event) || threw;
        if (this._state !== "running") return;
        if (threw) this._abort(domError("AbortError", "An error handler threw."));
        else if (!event.defaultPrevented) this._abort(failure);
        if (this._state !== "running") return;
      } else {
        request._result = result;
        const threw = deliver(this, request.onsuccess, request, makeEvent("success", request));
        if (this._state !== "running") return;
        if (threw) {
          this._abort(domError("AbortError", "A success handler threw."));
          return;
        }
      }
      tasks.tick(() => this._step());
    }

    _commit() {
      const failure = takeFailure(failures.commit, this);
      if (failure) {
        this._abort(failure);
        return;
      }
      if (commitGate && this.mode === "readwrite") {
        this._state = "waiting";
        commitGate.waiting.push(this);
        commitGate.reachedWaiters.splice(0).forEach((resolve) => resolve(this));
        return;
      }
      this._commitNow();
    }

    _commitNow() {
      this._state = "committing";
      const data = this.db._data;
      const keys = [];
      for (const { storeName, key, value } of this._staged.values()) {
        data.stores.get(storeName).set(key, value);
        keys.push(key);
      }
      this._staged.clear();
      if (keys.length) log.commits.push({ db: data.name, keys });
      tasks.tick(() => {
        this._state = "finished";
        deliver(this, this.oncomplete, this, makeEvent("complete", this));
        finish(this);
      });
    }

    _abort(error) {
      this._state = "aborting";
      this.error = error;
      this._staged.clear();
      const pendingRequests = this._requests.splice(0);
      const index = queue.indexOf(this);
      if (index >= 0) queue.splice(index, 1);
      log.aborts.push({ db: this.db._data.name, mode: this.mode, error });
      tasks.tick(() => {
        for (const { request } of pendingRequests) {
          request.readyState = "done";
          request._error = domError("AbortError", "The transaction was aborted.");
          const event = makeEvent("error", request);
          deliver(this, request.onerror, request, event);
          event.currentTarget = this;
          deliver(this, this.onerror, this, event);
        }
        this._state = "finished";
        deliver(this, this.onabort, this, makeEvent("abort", this));
        finish(this);
      });
    }
  }

  class FakeConnection {
    constructor(data) {
      this._data = data;
      this._closed = false;
      this._upgrading = false;
      this.name = data.name;
      this.version = data.version;
      this.onversionchange = null;
      openConnections += 1;
    }

    get objectStoreNames() {
      return stringList([...this._data.stores.keys()]);
    }

    createObjectStore(name) {
      if (!this._upgrading) throw domError("InvalidStateError", "Not in a version change transaction.");
      if (this._data.stores.has(name)) throw domError("ConstraintError", `Object store ${name} already exists.`);
      this._data.stores.set(name, new Map());
      return { name };
    }

    transaction(storeNames, mode = "readonly") {
      if (this._closed) throw domError("InvalidStateError", "The connection is closed.");
      if (this._upgrading) throw domError("InvalidStateError", "A version change transaction is running.");
      if (mode !== "readonly" && mode !== "readwrite") throw new TypeError(`Invalid transaction mode: ${mode}`);
      const names = Array.isArray(storeNames) ? [...storeNames] : [storeNames];
      for (const name of names) {
        if (!this._data.stores.has(name)) throw domError("NotFoundError", `No object store named ${name}.`);
      }
      const tx = new FakeTransaction(this, names, mode);
      queue.push(tx);
      notifyQueued();
      pump();
      return tx;
    }

    close() {
      if (this._closed) return;
      this._closed = true;
      openConnections -= 1;
    }
  }

  const indexedDB = {
    open(name, version = 1) {
      const request = new FakeRequest(null, null);
      request.onupgradeneeded = null;
      request.onblocked = null;
      log.opens.push(name);
      tasks.tick(() => {
        request.readyState = "done";
        const failure = failures.open.get(name);
        let data = databases.get(name);
        if (!failure && data && version < data.version) {
          request._error = domError("VersionError", `Database ${name} has a newer version.`);
        } else if (failure) {
          request._error = failure();
        }
        if (request._error) {
          deliver(null, request.onerror, request, makeEvent("error", request));
          return;
        }
        if (!data) {
          data = { name, version: 0, stores: new Map() };
          databases.set(name, data);
        }
        const connection = new FakeConnection(data);
        request._result = connection;
        if (version > data.version) {
          const oldVersion = data.version;
          data.version = version;
          connection.version = version;
          connection._upgrading = true;
          deliver(null, request.onupgradeneeded, request,
            makeEvent("upgradeneeded", request, { oldVersion, newVersion: version }));
          connection._upgrading = false;
        }
        deliver(null, request.onsuccess, request, makeEvent("success", request));
      });
      return request;
    },
  };

  return {
    indexedDB,
    tasks,
    log,
    handlerErrors,
    get openConnections() {
      return openConnections;
    },
    // Creates (or replaces) a version-1 database holding the given entries.
    seed(name, entries, storeName = "workspace-store") {
      const store = new Map(Object.entries(entries).map(([key, value]) => [key, structuredClone(value)]));
      databases.set(name, { name, version: 1, stores: new Map([[storeName, store]]) });
    },
    // Committed value, as another page would read it.
    read(name, key, storeName = "workspace-store") {
      const value = databases.get(name)?.stores.get(storeName)?.get(key);
      return value === undefined ? undefined : structuredClone(value);
    },
    failOpen(name, error = () => domError("UnknownError", `Injected open failure for ${name}`)) {
      failures.open.set(name, error);
    },
    failGet(name, error = () => domError("UnknownError", `Injected read failure for ${name}`)) {
      failures.get.set(name, error);
    },
    // Makes store.put() throw synchronously, like a DataCloneError.
    failPut({ db, key, times = Infinity } = {}, error = () => domError("DataCloneError", "Injected put failure")) {
      failures.put.push({
        match: (info) => (db === undefined || info.db === db) && (key === undefined || info.key === key),
        error,
        times,
      });
    },
    // Makes readwrite transactions abort when they try to commit.
    failCommit({ db, times = Infinity } = {}, error = () => domError("QuotaExceededError", "Injected quota failure")) {
      failures.commit.push({
        match: (tx) => tx.mode === "readwrite" && (db === undefined || tx.db.name === db),
        error,
        times,
      });
    },
    resetFailures() {
      failures.open.clear();
      failures.get.clear();
      failures.put.length = 0;
      failures.commit.length = 0;
    },
    // While held, created transactions wait in the queue instead of starting.
    hold() {
      holds += 1;
    },
    release() {
      holds = Math.max(0, holds - 1);
      pump();
    },
    // Resolves with the queued transactions once at least `count` are waiting.
    whenQueued(count) {
      if (queue.length >= count) return Promise.resolve([...queue]);
      return new Promise((resolve) => queueWaiters.push({ count, resolve }));
    },
    // Readwrite transactions that finish their requests wait before committing
    // until the returned gate is released.
    holdCommits() {
      const gate = { waiting: [], reachedWaiters: [] };
      commitGate = gate;
      return {
        reached: () => gate.waiting.length
          ? Promise.resolve(gate.waiting[0])
          : new Promise((resolve) => gate.reachedWaiters.push(resolve)),
        release: () => {
          if (commitGate === gate) commitGate = null;
          gate.waiting.splice(0).forEach((tx) => tx._commitNow());
        },
      };
    },
    // The page that created `tx` is gone: the transaction still completes, but
    // none of its remaining events are delivered.
    orphan(tx) {
      tx._orphaned = true;
    },
  };
}
