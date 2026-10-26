'use strict';

// API for the Settings page: the People list (internal vs client, other
// spellings) and the Glossary (terms, meanings, wrong spellings to correct).
// Any signed-in user can read the lists; only admins can change them.

const express = require('express');
const { requireAuth } = require('./auth');
const settingsDb = require('../utils/settingsDb');
const settingsStore = require('../utils/settingsStore');

const router = express.Router();

function isAdmin(req) {
  return req.authUser?.role === 'admin';
}

function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  return res.status(403).json({ success: false, error: 'Only admins can change settings.' });
}

function requireDatabase(req, res, next) {
  if (settingsDb.isAvailable()) return next();
  return res.status(503).json({ success: false, error: 'Settings cannot be saved because the database is not configured.' });
}

function sendError(res, error, fallback) {
  const status = Number(error?.status) || 500;
  if (status >= 500) console.error('[settings]', error);
  return res.status(status).json({ success: false, error: status >= 500 ? fallback : error.message });
}

function publicPerson(person) {
  return { id: person.id ?? null, name: person.name, side: person.side, spellings: [...(person.spellings || [])] };
}

function publicTerm(term) {
  return { id: term.id ?? null, term: term.term, meaning: term.meaning || '', heardAs: [...(term.heardAs || [])] };
}

router.get('/', requireAuth, async (req, res) => {
  try {
    await settingsStore.refresh();
    return res.json({
      success: true,
      canEdit: isAdmin(req) && settingsDb.isAvailable(),
      source: settingsStore.source(),
      people: settingsStore.getPeople().map(publicPerson),
      terms: settingsStore.getTerms().map(publicTerm)
    });
  } catch (error) {
    return sendError(res, error, 'Settings could not be loaded.');
  }
});

router.get('/history', requireAuth, requireAdmin, requireDatabase, async (req, res) => {
  try {
    return res.json({ success: true, changes: await settingsDb.listChanges(req.query.limit) });
  } catch (error) {
    return sendError(res, error, 'The change history could not be loaded.');
  }
});

function saveHandler(save, shape) {
  return async (req, res) => {
    try {
      const item = await save({
        id: req.params.id == null ? null : Number(req.params.id),
        input: req.body || {},
        userEmail: req.authUser?.email || ''
      });
      await settingsStore.refresh();
      return res.json({ success: true, item: shape(item) });
    } catch (error) {
      return sendError(res, error, 'The change could not be saved.');
    }
  };
}

function deleteHandler(remove, shape) {
  return async (req, res) => {
    try {
      const item = await remove({ id: Number(req.params.id), userEmail: req.authUser?.email || '' });
      await settingsStore.refresh();
      return res.json({ success: true, item: shape(item) });
    } catch (error) {
      return sendError(res, error, 'The item could not be deleted.');
    }
  };
}

const guard = [requireAuth, requireAdmin, requireDatabase];
router.post('/people', ...guard, saveHandler(settingsDb.savePerson, publicPerson));
router.put('/people/:id', ...guard, saveHandler(settingsDb.savePerson, publicPerson));
router.delete('/people/:id', ...guard, deleteHandler(settingsDb.deletePerson, publicPerson));
router.post('/terms', ...guard, saveHandler(settingsDb.saveTerm, publicTerm));
router.put('/terms/:id', ...guard, saveHandler(settingsDb.saveTerm, publicTerm));
router.delete('/terms/:id', ...guard, deleteHandler(settingsDb.deleteTerm, publicTerm));

module.exports = router;
