const RETRY_DELAYS = [5000, 30000, 120000];

const MESSAGES = {
  "external-change": "iCloud 文件有外部修改，已暂停自动备份。请先查看外部变更。",
  "stale-source": "已有更新的备份任务，已忽略这次旧请求。",
  unavailable: "备份目录暂时不可用。",
  permission: "没有写入备份目录的权限。",
  "write-failed": "写入备份失败。",
  paused: "自动备份已暂停。",
  disabled: "自动备份未开启。",
};

const defaultSettings = () => ({
  version: 1,
  auto: false,
  baselineHash: null,
  lastContentHash: null,
  lastSemanticHash: null,
  lastSuccessAt: null,
  lastTicket: 0,
  lastSourceRevision: 0,
  lastSourceHash: null,
  lastStampAt: 0,
  paused: null,
  retryCount: 0,
  lastError: null,
});

const codeFor = (error) => {
  const code = error?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return "unavailable";
  if (code === "EACCES" || code === "EPERM") return "permission";
  return "write-failed";
};

const createBackupService = ({
  fs,
  path,
  getDirectory,
  workspaceFilename,
  stampedPrefix,
  maxStamped = 20,
  lock,
  writeAtomic,
  hash,
  now = () => Date.now(),
  readSettings,
  writeSettings,
  migrate,
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (timer) => clearTimeout(timer),
  verifySavedSource,
  requireSavedSources = false,
  readPending = async () => null,
  writePending = async () => {},
  prepareAssets = async () => {},
}) => {
  let settings = defaultSettings();
  let pending = null;
  let writing = null;
  let pumpPromise = null;
  let retryTimer = null;
  let retryEpoch = 0;
  let lastResult = null;
  let loaded = false;
  let issuedTicket = 0;
  let enqueueChain = Promise.resolve();
  let newestSourceRevision = 0;
  let newestSourceHash = null;
  let resolutionEpoch = 0;
  let unfinishedReceipt = null;
  let settingsWrites = Promise.resolve();

  const persist = () => {
    const content = JSON.stringify(settings, null, 2);
    const run = settingsWrites.then(() => writeSettings(content), () => writeSettings(content));
    settingsWrites = run.catch(() => {});
    return run;
  };

  const status = () => ({
    auto: settings.auto === true,
    paused: settings.paused,
    baselineHash: settings.baselineHash,
    lastSuccessAt: settings.lastSuccessAt,
    lastSemanticHash: settings.lastSemanticHash,
    lastError: settings.lastError,
    lastTicket: settings.lastTicket || 0,
    writing: Boolean(writing),
    pending: Boolean(pending),
    lastResult,
    unfinishedReceipt,
  });

  const load = async () => {
    if (loaded) return settings;
    loaded = true;
    try {
      const raw = await readSettings();
      if (raw) settings = { ...defaultSettings(), ...JSON.parse(raw) };
    } catch {
      settings = defaultSettings();
    }
    try {
      const previous = await readPending();
      if (previous && Number.isSafeInteger(previous.sourceRevision) && typeof previous.sourceHash === "string") {
        unfinishedReceipt = { sourceRevision: previous.sourceRevision, sourceHash: previous.sourceHash, ticket: previous.ticket };
      }
    } catch (error) { settings.lastError = { code: "write-failed", message: `未完成备份凭据读取失败：${error.message}` }; }
    return settings;
  };

  const finish = async (result) => {
    lastResult = { ...result, error: result.ok ? undefined : result.error ?? MESSAGES[result.code] };
    return lastResult;
  };

  const prune = async (directory) => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const backups = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.startsWith(stampedPrefix) && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const filePath = path.join(directory, entry.name);
          const stats = await fs.stat(filePath);
          return { filePath, modifiedAt: stats.mtimeMs };
        }),
    );
    await Promise.all(
      backups
        .sort((left, right) => right.modifiedAt - left.modifiedAt)
        .slice(maxStamped)
        .map((backup) => fs.rm(backup.filePath, { force: true })),
    );
  };

  const floorTicket = () => Math.max(
    settings.lastTicket || 0,
    writing?.ticket || 0,
    pending?.ticket || 0,
    issuedTicket,
  );

  const cancelRetry = () => {
    if (!retryTimer) return;
    clearTimer(retryTimer);
    retryTimer = null;
  };

  const invalidateRetries = () => {
    retryEpoch += 1;
    cancelRetry();
  };

  const scheduleRetry = (delay, job, epoch) => {
    cancelRetry();
    const timer = setTimer(() => {
      if (retryTimer !== timer || epoch !== retryEpoch) return;
      retryTimer = null;
      enqueue({ ...job, retry: true, wait: false });
    }, delay);
    retryTimer = timer;
  };

  const fail = async (job, error) => {
    const code = codeFor(error);
    settings.lastError = { code, message: error instanceof Error ? error.message : String(error) };
    const canRetry = !job.manual
      && settings.auto
      && settings.retryCount < RETRY_DELAYS.length
      && code !== "external-change"
      && job.ticket >= floorTicket()
      && job.retryEpoch === retryEpoch;
    if (canRetry) {
      const delay = RETRY_DELAYS[settings.retryCount];
      settings.retryCount += 1;
      await persist();
      scheduleRetry(delay, job, job.retryEpoch);
    } else if (job.retryEpoch === retryEpoch) {
      settings.paused = code;
      await persist();
    }
    return finish({ ok: false, code, error: settings.lastError.message, ticket: job.ticket });
  };

  const perform = async (job) => {
    let directory;
    try {
      directory = await getDirectory();
      await fs.mkdir(directory, { recursive: true });
    } catch (error) {
      return fail(job, error);
    }
    const latestPath = path.join(directory, workspaceFilename);
    let content;
    let nextHash;
    try {
      const workspace = await migrate(job.workspace);
      content = `${JSON.stringify(workspace, null, 2)}\n`;
      nextHash = hash(content);
    } catch (error) {
      return fail(job, error);
    }
    try {
      return await lock(latestPath, async () => {
        if (job.resolutionEpoch !== resolutionEpoch) return finish({ ok: false, code: "stale-source", ticket: job.ticket });
        let existing = null;
        try {
          existing = await fs.readFile(latestPath, "utf8");
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
        const existingHash = existing == null ? null : hash(existing);
        const conflicts = existingHash && existingHash !== nextHash && existingHash !== settings.baselineHash;
        if (conflicts) {
          settings.paused = "external-change";
          settings.lastError = { code: "external-change", message: MESSAGES["external-change"] };
          await persist();
          return finish({ ok: false, code: "external-change", revision: existingHash, ticket: job.ticket });
        }
        await prepareAssets(job.workspace, directory, nextHash);
        if (existingHash === nextHash) {
          if (job.resolutionEpoch !== resolutionEpoch) return finish({ ok: false, code: "stale-source", ticket: job.ticket });
          settings.baselineHash = nextHash;
          settings.lastContentHash = nextHash;
          if (job.semanticHash) settings.lastSemanticHash = job.semanticHash;
          settings.lastTicket = Math.max(settings.lastTicket || 0, job.ticket || 0);
          if (job.sourceRevision != null) { settings.lastSourceRevision = job.sourceRevision; settings.lastSourceHash = job.sourceHash; }
          issuedTicket = Math.max(issuedTicket, settings.lastTicket);
          settings.lastError = null;
          settings.retryCount = 0;
          invalidateRetries();
          settings.paused = null;
          await persist();
          return finish({ ok: true, code: "unchanged", path: latestPath, revision: nextHash, ticket: job.ticket });
        }
        const currentNow = now();
        const stampDue = job.manual || !settings.lastStampAt || currentNow - settings.lastStampAt >= 10 * 60 * 1000;
        if (stampDue) {
          const stamp = new Date(currentNow).toISOString().replace(/[:.]/g, "-");
          await writeAtomic(path.join(directory, `${stampedPrefix}${stamp}.json`), content);
          settings.lastStampAt = currentNow;
          await prune(directory);
        }
        if (job.resolutionEpoch !== resolutionEpoch) return finish({ ok: false, code: "stale-source", ticket: job.ticket });
        await writeAtomic(latestPath, content);
        if (job.resolutionEpoch !== resolutionEpoch) return finish({ ok: false, code: "stale-source", ticket: job.ticket });
        settings.baselineHash = nextHash;
        settings.lastContentHash = nextHash;
        if (job.semanticHash) settings.lastSemanticHash = job.semanticHash;
        settings.lastSuccessAt = new Date(currentNow).toISOString();
        settings.lastTicket = Math.max(settings.lastTicket || 0, job.ticket || 0);
        if (job.sourceRevision != null) { settings.lastSourceRevision = job.sourceRevision; settings.lastSourceHash = job.sourceHash; }
        issuedTicket = Math.max(issuedTicket, settings.lastTicket);
        invalidateRetries();
        settings.paused = null;
        settings.retryCount = 0;
        settings.lastError = null;
        await persist();
        return finish({ ok: true, code: "ok", path: latestPath, revision: nextHash, ticket: job.ticket });
      });
    } catch (error) {
      return fail(job, error);
    }
  };

  const pump = () => {
    if (pumpPromise) return pumpPromise;
    pumpPromise = (async () => {
      try {
        while (pending) {
          const job = pending;
          pending = null;
          writing = job;
          try {
            job.result = await perform(job);
            if (job.result?.ok && !pending) {
              try { await writePending(null); unfinishedReceipt = null; }
              catch (error) { settings.lastError = { code: "write-failed", message: `备份已写入，但未完成凭据清理失败：${error.message}` }; await persist(); }
            }
          } finally {
            if (writing === job) writing = null;
          }
        }
      } finally {
        writing = null;
        pumpPromise = null;
      }
    })();
    return pumpPromise;
  };

  const enqueueUnlocked = async (job) => {
    await load();
    if (requireSavedSources && !job.retry && (!verifySavedSource || !(await verifySavedSource(job)))) return finish({ ok: false, code: "stale-source", ticket: job.ticket });
    newestSourceRevision = Math.max(newestSourceRevision, settings.lastSourceRevision || 0);
    if (newestSourceHash == null) newestSourceHash = settings.lastSourceHash;
    const sourceRevision = Number.isSafeInteger(job.sourceRevision) && job.sourceRevision > 0 ? job.sourceRevision : null;
    const sourceHash = hash(`${JSON.stringify(await migrate(job.workspace), null, 2)}\n`);
    if (sourceRevision != null && (sourceRevision < newestSourceRevision || (sourceRevision === newestSourceRevision && sourceHash !== newestSourceHash))) {
      return finish({ ok: false, code: "stale-source", ticket: job.ticket });
    }
    if (sourceRevision == null && newestSourceRevision > 0) return finish({ ok: false, code: "stale-source", ticket: job.ticket });
    issuedTicket = Math.max(issuedTicket, settings.lastTicket || 0);
    let ticket = Number.isInteger(job.ticket) ? job.ticket : null;
    const floor = floorTicket();
    if (ticket == null || (job.allocateNext === true && ticket <= floor) || (sourceRevision > newestSourceRevision && ticket <= floor)) ticket = floor + 1;
    if (!job.manual && settings.auto !== true) return finish({ ok: false, code: "disabled", ticket });
    if (settings.paused === "local-source" && job.resumeSource === true && sourceRevision != null) {
      settings.paused = null;
      settings.lastError = null;
      await persist();
    }
    if (!job.manual && settings.paused) return finish({ ok: false, code: "paused", reason: settings.paused, ticket });
    const ownRetry = job.retry === true && job.retryEpoch === retryEpoch && ticket === floor && ticket > settings.lastTicket && !writing && !pending;
    if (ticket <= floor && !ownRetry) {
      return finish({ ok: false, code: "stale-source", ticket });
    }
    try {
      await writePending({ workspace: job.workspace, sourceRevision, sourceHash, ticket, semanticHash: job.semanticHash });
      unfinishedReceipt = { sourceRevision, sourceHash, ticket };
    } catch (error) { return finish({ ok: false, code: codeFor(error), ticket, error: `备份凭据保存失败：${error.message}` }); }
    if (!job.retry) invalidateRetries();
    issuedTicket = Math.max(issuedTicket, ticket);
    if (sourceRevision != null) { newestSourceRevision = sourceRevision; newestSourceHash = sourceHash; }
    const queuedJob = { ...job, ticket, sourceRevision, sourceHash, retryEpoch, resolutionEpoch, result: null };
    pending = queuedJob;
    const queued = pump();
    if (job.wait) {
      await queued;
      return queuedJob.result;
    }
    return { ok: true, code: "queued", ticket };
  };

  const enqueue = (job) => {
    const run = enqueueChain.then(() => enqueueUnlocked(job), () => enqueueUnlocked(job));
    enqueueChain = run.then(() => {}, () => {});
    return run;
  };

  const setAuto = async (enabled) => {
    await load();
    settings.auto = enabled === true;
    if (!settings.auto) {
      settings.paused = null;
      settings.retryCount = 0;
      pending = null;
      invalidateRetries();
    }
    await persist();
    return status();
  };
  const pauseSource = async () => {
    await load();
    resolutionEpoch += 1;
    pending = null;
    invalidateRetries();
    if (settings.paused !== "external-change") settings.paused = "local-source";
    settings.retryCount = 0;
    await persist();
    return status();
  };

  const inspect = async () => {
    await load();
    try {
      const directory = await getDirectory();
      const latestPath = path.join(directory, workspaceFilename);
      const existing = await fs.readFile(latestPath, "utf8");
      return {
        ok: true,
        exists: true,
        path: latestPath,
        fileHash: hash(existing),
        baselineHash: settings.baselineHash,
        paused: settings.paused,
      };
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { ok: true, exists: false, fileHash: null, baselineHash: settings.baselineHash, paused: settings.paused };
      }
      return { ok: false, code: codeFor(error), error: error instanceof Error ? error.message : String(error) };
    }
  };

  const replaceWithLocal = async ({ workspace, expectedFileHash, sourceRevision, semanticHash, ticket, ownerId }) => {
    await load();
    if (requireSavedSources && (!verifySavedSource || !(await verifySavedSource({ workspace, sourceRevision, ticket, ownerId })))) return finish({ ok: false, code: "stale-source" });
    const directory = await getDirectory();
    await fs.mkdir(directory, { recursive: true });
    const latestPath = path.join(directory, workspaceFilename);
    const migrated = await migrate(workspace);
    const content = `${JSON.stringify(migrated, null, 2)}\n`;
    const nextHash = hash(content);
    return lock(latestPath, async () => {
      const sourceFloor = Math.max(newestSourceRevision, settings.lastSourceRevision || 0);
      if (sourceFloor > 0 && (!Number.isSafeInteger(sourceRevision) || sourceRevision < sourceFloor)) return finish({ ok: false, code: "stale-source", ticket });
      if (sourceRevision === sourceFloor && nextHash !== (newestSourceHash ?? settings.lastSourceHash)) return finish({ ok: false, code: "stale-source", ticket });
      ticket = Math.max(ticket || 0, floorTicket() + 1);
      let existing = null;
      try {
        existing = await fs.readFile(latestPath, "utf8");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const existingHash = existing == null ? null : hash(existing);
      if (existingHash !== expectedFileHash) {
        settings.paused = "external-change";
        await persist();
        return finish({ ok: false, code: "external-change", revision: existingHash, ticket });
      }
      await prepareAssets(migrated, directory, nextHash);
      if (existing != null) {
        const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
        await writeAtomic(path.join(directory, `${stampedPrefix}external-${stamp}.json`), existing);
        await prune(directory);
      }
      await writeAtomic(latestPath, content);
      resolutionEpoch += 1;
      pending = null;
      invalidateRetries();
      settings.baselineHash = nextHash;
      settings.lastContentHash = nextHash;
      settings.lastSemanticHash = semanticHash ?? null;
      settings.lastSuccessAt = new Date(now()).toISOString();
      settings.lastTicket = Math.max(settings.lastTicket || 0, ticket);
      issuedTicket = settings.lastTicket;
      if (Number.isSafeInteger(sourceRevision)) {
        newestSourceRevision = sourceRevision;
        newestSourceHash = nextHash;
        settings.lastSourceRevision = sourceRevision;
        settings.lastSourceHash = nextHash;
      }
      settings.paused = null;
      settings.lastError = null;
      await persist();
      return finish({ ok: true, code: "ok", path: latestPath, revision: nextHash, ticket });
    });
  };

  const acceptBaseline = async (hashValue, { sourceRevision, workspace, semanticHash, ticket, ownerId } = {}) => {
    await load();
    if (workspace === undefined || !verifySavedSource || !Number.isSafeInteger(ticket) || ticket <= 0 ||
      !(await verifySavedSource({ sourceRevision, workspace, ticket, ownerId }))) return finish({ ok: false, code: "stale-source" });
    // Only the main process allocates the accepted ticket. Renderer counters
    // cannot raise the scheduling floor, even with an extreme supplied value.
    ticket = floorTicket() + 1;
    const latestPath = path.join(await getDirectory(), workspaceFilename);
    return lock(latestPath, async () => {
      let existing = null;
      try { existing = await fs.readFile(latestPath, "utf8"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
      const actualHash = existing == null ? null : hash(existing);
      if (actualHash !== hashValue) {
        settings.paused = "external-change";
        await persist();
        return finish({ ok: false, code: "external-change", revision: actualHash });
      }
      if (workspace !== undefined) {
        const savedHash = hash(`${JSON.stringify(await migrate(workspace), null, 2)}\n`);
        const externalHash = hash(`${JSON.stringify(await migrate(JSON.parse(existing)), null, 2)}\n`);
        const sourceFloor = Math.max(newestSourceRevision, settings.lastSourceRevision);
        const sourceHash = newestSourceHash ?? settings.lastSourceHash;
        if (!Number.isSafeInteger(sourceRevision) || sourceRevision <= 0 || sourceRevision < sourceFloor || (sourceRevision === sourceFloor && sourceHash !== savedHash) || savedHash !== externalHash) {
          return finish({ ok: false, code: "stale-source" });
        }
        newestSourceRevision = sourceRevision;
        newestSourceHash = savedHash;
        settings.lastSourceRevision = sourceRevision;
        settings.lastSourceHash = savedHash;
      } else if (settings.baselineHash && settings.baselineHash !== hashValue) {
        return finish({ ok: false, code: "stale-source" });
      }
      resolutionEpoch += 1;
      pending = null;
      invalidateRetries();
      settings.baselineHash = hashValue;
      settings.lastContentHash = hashValue;
      settings.lastSemanticHash = semanticHash ?? null;
      settings.paused = null;
      settings.lastError = null;
      settings.retryCount = 0;
      if (Number.isSafeInteger(ticket)) settings.lastTicket = Math.max(settings.lastTicket, ticket);
      unfinishedReceipt = null;
      await writePending(null);
      await persist();
      return { ok: true, ...status() };
    });
  };

  const recordCloseTimeout = async () => {
    await load();
    settings.lastError = { code: "close-timeout", message: "上次关闭时备份刷新超过 3 秒；本机内容和未完成备份凭据已保留，请查看备份状态后重试" };
    await persist();
    return status();
  };

  return {
    recordCloseTimeout,
    load,
    status,
    enqueue,
    setAuto,
    pauseSource,
    inspect,
    replaceWithLocal,
    acceptBaseline,
    _settings: () => settings,
  };
};

module.exports = { createBackupService, MESSAGES };
