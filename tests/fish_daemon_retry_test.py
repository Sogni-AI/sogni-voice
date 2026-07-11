"""Deterministic test of the Fish daemon's runaway-retry logic.

Run with the Fish venv (it imports mlx + the vendored local_mlx):
  PYTHONPATH=vendor/fish-s2-mlx .venv-fish-tts/bin/python tests/fish_daemon_retry_test.py

Verifies that _synthesize_with_reference retries with tighter sampling when a
generation hits the token cap (runaway), returns immediately on a natural stop,
and falls back safely when every attempt runs away.
"""
import importlib.util
import numpy as np
import mlx.core as mx

spec = importlib.util.spec_from_file_location("fishd", "scripts/fish_tts_daemon.py")
fishd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fishd)


class Seg:
    def __init__(self, n, samples=4410):
        self.token_count = n
        self.audio = mx.zeros((samples,))


class StubModel:
    def __init__(self, natural_after):
        self.calls = 0
        self.natural_after = natural_after
        self.seen = []

    def generate(self, text, **kw):
        self.calls += 1
        self.seen.append(kw)
        cap = kw["max_tokens"]
        n = (cap - 5) if self.calls > self.natural_after else cap
        yield Seg(n)


class StubServer:
    def _effective_max_tokens(self, model, text, requested):
        return 216


def make(natural_after):
    d = fishd.FishTTSDaemon()
    d._mx = mx
    d._np = np
    d.server = StubServer()
    d.model = StubModel(natural_after)
    return d


def main():
    d = make(natural_after=1)
    d._synthesize_with_reference("hi", mx.zeros((100,)), "ref", None, None)
    assert d.model.calls == 2, "should retry exactly once on runaway->clean"
    assert d.model.seen[1].get("top_p") == 0.6, "retry must use tighter sampling"

    d = make(natural_after=0)
    d._synthesize_with_reference("hi", mx.zeros((100,)), "ref", None, None)
    assert d.model.calls == 1, "clean output must not retry (no extra cost)"

    d = make(natural_after=99)
    out = d._synthesize_with_reference("hi", mx.zeros((100,)), "ref", None, None)
    assert d.model.calls == 3, "should exhaust the 3-attempt ladder"
    assert out is not None, "must return a bounded fallback, not crash"

    print("Fish daemon retry-mechanism: ALL ASSERTIONS PASSED")


if __name__ == "__main__":
    main()
