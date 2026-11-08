// Browser storage doubles (localStorage, BroadcastChannel) plus an installer
// that puts them and the fake IndexedDB on globalThis for one test.
import { createFakeIndexedDB, createTaskQueue, domError } from "./fake-indexeddb.mjs";

export function createFakeLocalStorage() {
  const data = new Map();
  const setFailures = [];
  const storage = {
    getItem: (key) => data.get(String(key)) ?? null,
    setItem: (key, value) => {
      const name = String(key);
      const failure = setFailures.find((item) => item.times > 0 && item.match(name));
      if (failure) {
        failure.times -= 1;
        throw failure.error();
      }
      data.set(name, String(value));
    },
    removeItem: (key) => {
      data.delete(String(key));
    },
    clear: () => data.clear(),
    key: (index) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };
  return {
    storage,
    data,
    // Makes setItem throw (QuotaExceededError by default), for one key or all.
    failSetItem(key, { times = Infinity } = {}, error = () => domError("QuotaExceededError", `Injected quota failure for ${key}`)) {
      setFailures.push({ match: (name) => key === undefined || name === key, error, times });
    },
    resetFailures() {
      setFailures.length = 0;
    },
  };
}

// Channels with the same name deliver posted data to the other open channels,
// asynchronously and never to the posting channel itself.
export function createFakeBroadcastChannels(tasks = createTaskQueue()) {
  const open = new Set();
  const messages = [];
  const listenerErrors = [];

  class FakeBroadcastChannel {
    constructor(name) {
      this.name = String(name);
      this.onmessage = null;
      this._listeners = new Set();
      this._closed = false;
      open.add(this);
    }

    postMessage(data) {
      if (this._closed) throw domError("InvalidStateError", "The channel is closed.");
      const payload = structuredClone(data);
      messages.push({ name: this.name, data: payload });
      for (const target of open) {
        if (target !== this && target.name === this.name) tasks.tick(() => target._dispatch(payload));
      }
    }

    addEventListener(type, listener) {
      if (type === "message") this._listeners.add(listener);
    }

    removeEventListener(type, listener) {
      if (type === "message") this._listeners.delete(listener);
    }

    close() {
      this._closed = true;
      open.delete(this);
    }

    _dispatch(payload) {
      if (this._closed) return;
      const event = { type: "message", data: structuredClone(payload), target: this, currentTarget: this };
      for (const listener of [this.onmessage, ...this._listeners]) {
        if (typeof listener !== "function") continue;
        try {
          listener.call(this, event);
        } catch (error) {
          listenerErrors.push(error);
        }
      }
    }
  }

  return {
    BroadcastChannel: FakeBroadcastChannel,
    messages,
    listenerErrors,
    closeAll() {
      [...open].forEach((channel) => channel.close());
    },
  };
}

const GLOBALS = ["indexedDB", "localStorage", "BroadcastChannel"];

// Original globals, captured by the outermost install of the current test(s).
let originals = null;
let installs = 0;

// Installs fresh fakes on globalThis and restores the originals after the test.
// Pass { indexedDB: false } to simulate a browser without IndexedDB. Nested
// installs (several simulated browsers in one test) restore the real globals
// once the last one is torn down, whatever order the after hooks run in.
export function installFakeBrowserStorage(t, { indexedDB = true } = {}) {
  const tasks = createTaskQueue();
  const idb = createFakeIndexedDB(tasks);
  const local = createFakeLocalStorage();
  const channels = createFakeBroadcastChannels(tasks);
  // Read descriptors, not values: Node's own localStorage getter warns.
  if (installs === 0) originals = GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  installs += 1;
  const define = (name, value) => Object.defineProperty(globalThis, name, {
    value, configurable: true, enumerable: true, writable: true,
  });
  define("indexedDB", indexedDB ? idb.indexedDB : undefined);
  define("localStorage", local.storage);
  define("BroadcastChannel", channels.BroadcastChannel);
  t.after(() => {
    channels.closeAll();
    installs -= 1;
    if (installs > 0) return;
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    originals = null;
  });
  return { idb, localStorage: local, channels, settle: () => tasks.idle() };
}
