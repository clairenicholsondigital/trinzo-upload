'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const EMPTY_STORE = Object.freeze({ version: 1, subscriptions: {}, events: [] });

function blankStore() {
  return { version: 1, subscriptions: {}, events: [] };
}

function createTranscriptStore(filePath) {
  const resolvedPath = path.resolve(filePath);
  let mutationQueue = Promise.resolve();

  async function read() {
    try {
      const parsed = JSON.parse(await fs.readFile(resolvedPath, 'utf8'));
      return {
        version: 1,
        subscriptions: parsed?.subscriptions && typeof parsed.subscriptions === 'object'
          ? parsed.subscriptions : {},
        events: Array.isArray(parsed?.events) ? parsed.events : []
      };
    } catch (error) {
      if (error.code === 'ENOENT') return blankStore();
      throw error;
    }
  }

  async function write(data) {
    const directory = path.dirname(resolvedPath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${resolvedPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporaryPath, resolvedPath);
    await fs.chmod(resolvedPath, 0o600);
  }

  function mutate(callback) {
    const operation = mutationQueue.then(async () => {
      const data = await read();
      const result = await callback(data);
      await write(data);
      return result;
    });
    mutationQueue = operation.catch(() => {});
    return operation;
  }

  async function subscriptionForUser(userId) {
    const data = await read();
    return Object.values(data.subscriptions).find((item) => item.userId === userId) || null;
  }

  async function subscriptionById(subscriptionId) {
    const data = await read();
    return data.subscriptions[subscriptionId] || null;
  }

  async function saveSubscription(subscription) {
    return mutate((data) => {
      for (const [id, item] of Object.entries(data.subscriptions)) {
        if (item.userId === subscription.userId && id !== subscription.id) delete data.subscriptions[id];
      }
      data.subscriptions[subscription.id] = subscription;
      return subscription;
    });
  }

  async function markLifecycle(subscriptionId, lifecycleEvent) {
    return mutate((data) => {
      const subscription = data.subscriptions[subscriptionId];
      if (!subscription) return false;
      subscription.lifecycleEvent = lifecycleEvent;
      subscription.lifecycleReceivedAt = new Date().toISOString();
      return true;
    });
  }

  async function addEvent(event) {
    return mutate((data) => {
      const duplicate = data.events.some((candidate) =>
        candidate.subscriptionId === event.subscriptionId
        && candidate.resource === event.resource
        && candidate.changeType === event.changeType);
      if (duplicate) return false;
      data.events.push(event);
      if (data.events.length > 1000) data.events.splice(0, data.events.length - 1000);
      return true;
    });
  }

  async function eventsForUser(userId) {
    const data = await read();
    return data.events.filter((event) => event.userId === userId).slice(-100).reverse();
  }

  return {
    filePath: resolvedPath,
    subscriptionForUser,
    subscriptionById,
    saveSubscription,
    markLifecycle,
    addEvent,
    eventsForUser
  };
}

module.exports = { EMPTY_STORE, createTranscriptStore };
