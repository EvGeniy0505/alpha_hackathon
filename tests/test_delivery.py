"""Delivery checks: documentation and real dispatch/SQLite without a network socket."""
import io
import json
import re
import tempfile
import unittest
from email.message import Message
from pathlib import Path
from types import SimpleNamespace

from scoring import PRODUCTS
from server import Handler, ROOT, Store, validate_application, validate_profile


class DeliveryTests(unittest.TestCase):
    def test_openapi_matches_current_fields_profiles_and_product_limits(self):
        spec = json.loads((ROOT / "docs/openapi.json").read_text())
        schemas = spec["components"]["schemas"]
        seed = json.loads((ROOT / "data/clients.json").read_text())
        demo = json.loads((ROOT / "data/demo_profiles.json").read_text())[0]["application"]
        data = validate_application(demo)
        self.assertEqual(set(data), set(schemas["ApplicationInput"]["properties"]))
        self.assertEqual(set(validate_profile({k: seed[0][k] for k in schemas["ClientProfileInput"]["properties"]})),
                         set(schemas["ClientProfileInput"]["properties"]))
        self.assertEqual({p["id"] for p in PRODUCTS},
                         set(schemas["ApplicationInput"]["properties"]["product_id"]["enum"]))
        self.assertEqual(schemas["ApplicationInput"]["properties"]["amount"]["maximum"],
                         max(p["max_amount"] for p in PRODUCTS))
        self.assertEqual(schemas["ApplicationInput"]["properties"]["term_months"]["maximum"],
                         max(p["max_term"] for p in PRODUCTS))
        self.assertNotIn("company_name", schemas["ApplicationInput"]["required"])
        for route in ("/api/client-profile", "/api/clients", "/api/clients/{username}/applications"):
            self.assertIn(route, spec["paths"])

    def test_all_openapi_references_resolve(self):
        spec = json.loads((ROOT / "docs/openapi.json").read_text())

        def walk(value):
            if isinstance(value, dict):
                if "$ref" in value:
                    target = spec
                    self.assertTrue(value["$ref"].startswith("#/"))
                    for part in value["$ref"][2:].split("/"):
                        target = target[part]
                for nested in value.values():
                    walk(nested)
            elif isinstance(value, list):
                for nested in value:
                    walk(nested)
        walk(spec)

    def test_http_collection_executes_approval_and_clarification(self):
        """Execute published examples against actual routes, auth and storage."""
        collection = (ROOT / "docs/requests.http").read_text()
        with tempfile.TemporaryDirectory() as directory:
            server = SimpleNamespace(store=Store(Path(directory) / "delivery.db"),
                                     allowed_hosts={"localhost"})
            cookie, named, checked = "", {}, []
            for block in collection.split("###")[1:]:
                request = re.search(r"^(GET|POST|PUT) \{\{base\}\}(\S+)$", block, re.M)
                if not request:
                    continue
                method, path = request.groups()
                path = re.sub(r"\{\{(\w+)\.response\.body\.\$\.id\}\}",
                              lambda m: named[m[1]]["id"], path)
                following = block[request.end():]
                body = following.split("\n\n", 1)[1].strip() if "\n\n" in following else ""
                payload = json.loads(body) if body else None
                raw = json.dumps(payload).encode() if payload is not None else b""
                handler = object.__new__(Handler)
                handler.server, handler.command, handler.path = server, method, path
                handler.headers = Message()
                handler.headers["Host"] = "localhost:8000"
                handler.headers["Content-Type"] = "application/json"
                handler.headers["Content-Length"] = str(len(raw))
                if cookie:
                    handler.headers["Cookie"] = cookie
                handler.rfile = io.BytesIO(raw)
                captured = {}
                def send(status, data, content_type=None, cookie=None):
                    captured.update(status=status, data=data, cookie=cookie)
                handler.send = send
                handler.log_error = lambda *args: None
                handler.handle_request()
                expected = 409 if "Повторное принятие" in block else (
                    201 if method == "POST" and path == "/api/applications" else 200)
                self.assertEqual(captured["status"], expected, (method, path, captured))
                if captured["cookie"]:
                    cookie = captured["cookie"].split(";")[0]
                name = re.search(r"^# @name (\w+)$", block, re.M)
                if name:
                    named[name[1]] = captured["data"]
                if path.endswith("/accept") and expected == 200:
                    self.assertEqual(captured["data"]["status"], "funded")
                if "/decision" in path and payload["action"] == "request_info":
                    self.assertEqual(captured["data"]["status"], "needs_info")
                checked.append((method, path))
            self.assertGreaterEqual(len(checked), 20)
            with server.store.connection() as db:
                approved = Store.application(db, named["approved"]["id"],
                                            {"username": "client", "role": "client"})
                reviewed = Store.application(db, named["review"]["id"],
                                            {"username": "client", "role": "client"})
            self.assertEqual(approved["status"], "funded")
            self.assertEqual(reviewed["status"], "approved")
            self.assertIn("needs_info", [event["status"] for event in reviewed["events"]])

    def test_data_model_lists_actual_tables(self):
        architecture = (ROOT / "docs/ARCHITECTURE.md").read_text()
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory) / "schema.db")
            with store.connection() as db:
                names = {row["name"] for row in db.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'")}
            for name in names:
                self.assertIn(chr(96) + name + chr(96), architecture)


if __name__ == "__main__":
    unittest.main()
