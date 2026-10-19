# MiniLM cache-reset compatibility

This source mirrors the deployed `/srv/global-minilm/global_minilm_worker.py` used by the Meeting Minutes Agent at `http://127.0.0.1:8767`.

The agent's existing authenticated reset flow calls `POST /cache/reset`. The deployed worker supported only `/encode`, which made resets fail with `BASELINE_RESET_WORKER_FAILED`. This version adds the expected loopback-only reset, returns the number of cleared embeddings, and keeps the model loaded. Swapping the cache preserves results from requests already in progress without repopulating the new cache.

Verify with `python3 -m unittest discover -s tests -p test_global_minilm_cache_reset.py -v`. Deployment copies this source to the worker directory and restarts `global-minilm.service`; the Trinzo application is restarted only to clear its own process memory. Saved drafts, transcripts and stored model responses are not changed.

This service is shared infrastructure. The existing health and encoding contracts remain covered by the tests; no model, encoding settings or site page behavior is changed by the compatibility fix.
