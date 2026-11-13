"""Exercise the running token endpoint using synthetic credentials only."""
import base64
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


class TransportAccessTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        cls.base = "http://127.0.0.1:" + str(port)
        cls.origin = "https://camera.example.test"
        cls.link_expiry = int(time.time()) + 120
        config = {
            "api_key": "synthetic-test-key",
            "api_secret": "synthetic-secret-only-for-isolated-tests",
            "origin": cls.origin, "url": "wss://camera.example.test/media",
            "room": "synthetic-private-room",
            "publisher_code_hash": digest("original-publisher-test"),
            "viewer_code_hash": digest("original-viewer-test"),
            "access_expires_at": int(time.time()) + 3600,
            "publisher_links": [
                {"code_hash": digest("temporary-publisher-test"), "expires_at": cls.link_expiry},
                {"code_hash": digest("expired-publisher-test"), "expires_at": int(time.time()) - 5},
            ],
        }
        config_path = Path(cls.temp.name) / "transport.json"
        config_path.write_text(json.dumps(config))
        env = {**os.environ, "BOOSTERA_TRANSPORT_CONFIG": str(config_path)}
        cls.process = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "server:create_app", "--factory",
             "--host", "127.0.0.1", "--port", str(port), "--no-access-log", "--log-level", "error"],
            cwd=Path(__file__).parent, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            try:
                with urllib.request.urlopen(cls.base + "/api/transport/health", timeout=1) as response:
                    if response.status == 200:
                        return
            except (OSError, urllib.error.URLError):
                if cls.process.poll() is not None:
                    raise RuntimeError("Isolated token gateway did not start")
                time.sleep(0.05)
        cls.process.terminate()
        raise RuntimeError("Isolated token gateway startup timed out")

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate()
        cls.process.wait(timeout=10)
        cls.temp.cleanup()

    def request_token(self, role, code, origin=None):
        request = urllib.request.Request(self.base + "/api/transport/token",
            data=json.dumps({"role": role, "code": code}).encode(), method="POST",
            headers={"Content-Type": "application/json", "Origin": origin or self.origin})
        try:
            response = urllib.request.urlopen(request, timeout=3)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def claims(self, body):
        encoded = body["token"].split(".")[1]
        return json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))

    def test_original_codes_keep_their_roles(self):
        status, body = self.request_token("publisher", "original-publisher-test")
        self.assertEqual(status, 200)
        self.assertTrue(self.claims(body)["video"]["canPublish"])
        status, body = self.request_token("viewer", "original-viewer-test")
        self.assertEqual(status, 200)
        self.assertFalse(self.claims(body)["video"]["canPublish"])

    def test_temporary_link_is_publisher_only_and_cannot_extend_expiry(self):
        status, body = self.request_token("publisher", "temporary-publisher-test")
        self.assertEqual(status, 200)
        claims = self.claims(body)
        self.assertTrue(claims["video"]["canPublish"])
        self.assertFalse(claims["video"]["canSubscribe"])
        self.assertEqual(claims["video"]["room"], "synthetic-private-room")
        self.assertLessEqual(body["expiresAt"], self.link_expiry)
        self.assertLessEqual(claims["exp"], self.link_expiry + 1)
        self.assertEqual(self.request_token("viewer", "temporary-publisher-test")[0], 401)

    def test_expired_unknown_and_cross_origin_requests_fail(self):
        self.assertEqual(self.request_token("publisher", "expired-publisher-test")[0], 403)
        self.assertEqual(self.request_token("publisher", "unknown-publisher-test")[0], 401)
        self.assertEqual(self.request_token("publisher", "temporary-publisher-test", "https://untrusted.example")[0], 403)


if __name__ == "__main__":
    unittest.main()
