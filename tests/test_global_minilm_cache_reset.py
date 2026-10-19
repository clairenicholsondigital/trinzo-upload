import importlib.util
import json
from pathlib import Path
import sys
import threading
import types
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen


class Vector(list):
    def tolist(self):
        return list(self)


class Model:
    def __init__(self, *_args):
        self.calls = 0

    def encode(self, texts, **_kwargs):
        self.calls += 1
        return [Vector([float(len(text)), 1.0]) for text in texts]


def load_worker():
    source = Path(__file__).resolve().parents[1] / 'ops/global-minilm/global_minilm_worker.py'
    spec = importlib.util.spec_from_file_location('cache_reset_worker', source)
    worker = importlib.util.module_from_spec(spec)
    fake = types.SimpleNamespace(SentenceTransformer=Model)
    with patch.dict(sys.modules, {'sentence_transformers': fake}):
        spec.loader.exec_module(worker)
    return worker


class CacheResetTests(unittest.TestCase):
    def setUp(self):
        self.worker = load_worker()

    def test_reset_clears_populated_cache_preserves_model_and_recomputed_results(self):
        backend = self.worker.BACKEND
        model = backend.model
        before = backend.encode_many(['Review the pack.', 'Confirm the owner.'])
        self.assertEqual(backend.model.calls, 1)
        self.assertEqual(backend.encode_many(list(before)), before)
        self.assertEqual(backend.model.calls, 1)
        self.assertEqual(backend.reset_cache(), 2)
        self.assertEqual(backend.cache, {})
        self.assertIs(backend.model, model)
        self.assertEqual(backend.encode_many(list(before)), before)
        self.assertEqual(backend.model.calls, 2)

    def test_repeated_empty_reset_is_idempotent(self):
        backend = self.worker.BACKEND
        self.assertEqual(backend.reset_cache(), 0)
        self.assertEqual(backend.reset_cache(), 0)
        self.assertTrue(backend.available)

    def test_reset_during_encoding_keeps_inflight_result_complete_and_new_cache_empty(self):
        backend = self.worker.BACKEND
        backend.encode_many(['Existing result'])
        started, proceed = threading.Event(), threading.Event()
        original = backend.model.encode

        def delayed(texts, **kwargs):
            started.set()
            if not proceed.wait(5):
                raise RuntimeError('reset did not release the in-flight probe')
            return original(texts, **kwargs)

        backend.model.encode = delayed
        result, errors = {}, []

        def run():
            try:
                result.update(backend.encode_many(['Existing result', 'New result']))
            except Exception as error:
                errors.append(error)

        task = threading.Thread(target=run)
        task.start()
        self.assertTrue(started.wait(5))
        try:
            self.assertEqual(backend.reset_cache(), 1)
        finally:
            proceed.set()
            task.join(5)
        self.assertFalse(task.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(set(result), {'Existing result', 'New result'})
        self.assertEqual(backend.cache, {})

    def test_http_encode_health_and_reset_contract(self):
        server = self.worker.ThreadingHTTPServer(('127.0.0.1', 0), self.worker.Handler)
        task = threading.Thread(target=server.serve_forever, daemon=True)
        task.start()
        base = f'http://127.0.0.1:{server.server_port}'

        def request(path, payload=None):
            data = None if payload is None else json.dumps(payload).encode()
            request = Request(base + path, data=data, method='POST' if path != '/health' else 'GET',
                              headers={'Content-Type': 'application/json'})
            with urlopen(request, timeout=5) as response:
                return response.status, json.load(response)

        try:
            status, encoded = request('/encode', {'texts': ['Review', 'Confirm']})
            self.assertEqual(status, 200)
            self.assertEqual(encoded['dimensions'], 2)
            self.assertEqual(request('/health')[1]['cacheSize'], 2)
            status, reset = request('/cache/reset')
            self.assertEqual(status, 200)
            self.assertEqual(reset, {'ok': True, 'cleared': 2})
            self.assertEqual(request('/cache/reset')[1]['cleared'], 0)
            self.assertEqual(request('/health')[1]['cacheSize'], 0)
            self.assertEqual(request('/encode', {'texts': ['Review', 'Confirm']})[1]['embeddings'], encoded['embeddings'])
            with self.assertRaises(HTTPError) as error:
                request('/unrecognised')
            self.assertEqual(error.exception.code, 404)
        finally:
            server.shutdown()
            server.server_close()
            task.join(5)

    def test_non_loopback_reset_is_rejected_without_clearing(self):
        backend = self.worker.BACKEND
        backend.encode_many(['Preserve this'])
        handler = object.__new__(self.worker.Handler)
        handler.path = '/cache/reset'
        handler.client_address = ('203.0.113.5', 1234)
        responses = []
        handler.send_json = lambda payload, status=200: responses.append((status, payload))
        handler.do_POST()
        self.assertEqual(responses, [(403, {'ok': False, 'reason': 'Loopback access only.'})])
        self.assertEqual(len(backend.cache), 1)


if __name__ == '__main__':
    unittest.main()
