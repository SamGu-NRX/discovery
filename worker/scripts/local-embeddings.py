"""OpenAI-compatible POST /v1/embeddings for local lens runs (LENS_EMBED_URL).

Serves BAAI/bge-base-en-v1.5 through fastembed's ONNX build, the same model
Workers AI serves as @cf/baai/bge-base-en-v1.5, so tastes and thresholds from
a local run are close to production's. They are not identical: fastembed runs
its own ONNX export, and nothing here measures the difference.

Setup: python3 -m venv venv && ./venv/bin/pip install fastembed
Usage: ./venv/bin/python scripts/local-embeddings.py [port]   (default 8899)
"""

import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from fastembed import TextEmbedding

MODEL = TextEmbedding("BAAI/bge-base-en-v1.5")


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/v1/embeddings":
            return self.reply(404, {"error": f"no route {self.path}"})
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
        texts = body.get("input")
        if isinstance(texts, str):
            texts = [texts]
        if not isinstance(texts, list) or not all(isinstance(t, str) for t in texts):
            return self.reply(400, {"error": "input must be a string or an array of strings"})
        vectors = [v.tolist() for v in MODEL.embed(texts)]
        self.reply(200, {"object": "list", "model": "BAAI/bge-base-en-v1.5", "data": [{"index": i, "embedding": v} for i, v in enumerate(vectors)]})

    def reply(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
