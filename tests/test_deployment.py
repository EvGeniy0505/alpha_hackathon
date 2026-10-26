"""Deployment configuration without weakening Host or cookie protection."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from server import create_server


class DeploymentTests(unittest.TestCase):
    def test_render_hostname_is_allowed_alongside_local_healthcheck(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "RENDER_EXTERNAL_HOSTNAME": "example.onrender.com", "COOKIE_SECURE": "1",
            "ALLOWED_HOSTS": "localhost,127.0.0.1"
        }):
            server = create_server(port=0, db_path=Path(directory) / "render.db")
            try:
                self.assertEqual(server.allowed_hosts, {"example.onrender.com", "localhost", "127.0.0.1"})
                self.assertTrue(server.secure_cookies)
                self.assertNotIn("attacker.example", server.allowed_hosts)
            finally:
                server.server_close()

    def test_local_http_keeps_secure_cookie_opt_in(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "RENDER_EXTERNAL_HOSTNAME": "", "COOKIE_SECURE": "0"
        }):
            server = create_server(port=0, db_path=Path(directory) / "local.db")
            try:
                self.assertFalse(server.secure_cookies)
            finally:
                server.server_close()
