"""Real HTTP requests against a temporary SQLite database; no extra packages."""
import copy
import http.client
import json
import sqlite3
import tempfile
import threading
import unittest
from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from server import ROOT, Store, create_server


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "test.db"
        self.server = create_server(port=0, db_path=self.path)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.cookies = {}
        self.profiles = json.loads((ROOT / "data/demo_profiles.json").read_text(encoding="utf-8"))
        self.login("client")

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def call(self, method, path, data=None, user="client", headers=None):
        request_headers = {"Content-Type": "application/json"}
        if user in self.cookies:
            request_headers["Cookie"] = self.cookies[user]
        request_headers.update(headers or {})
        body = json.dumps(data).encode() if data is not None else None
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            conn.request(method, path, body, request_headers)
            response = conn.getresponse()
            raw = response.read()
            result = json.loads(raw) if "application/json" in response.getheader("Content-Type", "") else raw
            return response.status, result, response.getheader("Set-Cookie")
        finally:
            conn.close()

    def login(self, user):
        password = {"client": "client-pass", "analyst": "analyst-pass"}.get(user, f"{user}-pass")
        status, result, cookie = self.call("POST", "/api/login", {"username": user, "password": password}, user=user)
        self.assertEqual(status, 200, result)
        self.cookies[user] = cookie.split(";")[0]

    def create(self, index=0, **updates):
        data = {**copy.deepcopy(self.profiles[index]["application"]), **updates}
        status, result, _ = self.call("POST", "/api/applications", data)
        self.assertEqual(status, 201, result)
        return result

    def action(self, app, action, data=None, user="client", expected=200):
        status, result, _ = self.call("POST", f"/api/applications/{app['id']}/{action}", data or {}, user)
        self.assertEqual(status, expected, result)
        return result

    def test_full_approval_persists_and_duplicate_accept_is_rejected(self):
        app = self.create()
        self.assertNotIn("company_name", app["data"])
        self.assertEqual(app["client"]["company_name"], "ООО Городской Пекарь")
        app = self.action(app, "submit")
        self.assertEqual(app["status"], "approved")
        app = self.action(app, "accept")
        self.assertEqual(app["status"], "funded")
        self.action(app, "accept", expected=409)
        # Reopening the database independently must recover data and the entire audit trail.
        reopened = Store(self.path)
        with reopened.connection() as db:
            saved = Store.application(db, app["id"], {"username": "client", "role": "client"})
        self.assertEqual([e["status"] for e in saved["events"]], ["draft", "checking", "approved", "signed", "funded"])
        self.assertEqual(saved["data"], app["data"])

    def test_clarification_same_application_then_human_approval(self):
        app = self.action(self.create(1), "submit")
        self.assertEqual(app["status"], "manual_review")
        self.login("analyst")
        app = self.action(app, "decision", {"action": "request_info", "note": "Поясните причину просрочки."}, "analyst")
        self.assertEqual(app["status"], "needs_info")
        self.action(app, "submit", expected=400)
        data = {**app["data"], "clarification": "Учебная просрочка возникла из-за задержки оплаты."}
        status, updated, _ = self.call("PUT", f"/api/applications/{app['id']}", data)
        self.assertEqual(status, 200)
        self.assertEqual(updated["id"], app["id"])
        app = self.action(updated, "submit")
        self.assertEqual(app["status"], "manual_review")
        app = self.action(app, "decision", {"action": "approve"}, "analyst")
        self.assertEqual(app["status"], "approved")
        self.assertEqual(app["assessment"]["bank_decision"]["note"], "")
        self.assertEqual(app["assessment"]["bank_decision"]["offer"]["amount"], data["amount"])
        self.assertEqual(app["assessment"]["decision"]["status"], "manual_review")
        self.assertEqual(self.action(app, "accept")["status"], "funded")

    def test_rejection_is_terminal_and_bank_cannot_override_hard_stop(self):
        app = self.action(self.create(2), "submit")
        self.assertEqual(app["status"], "rejected")
        self.action(app, "accept", expected=409)
        self.login("analyst")
        self.action(app, "decision", {"action": "approve", "note": "Попытка обхода ограничений."}, "analyst", 409)
        status, _, _ = self.call("PUT", f"/api/applications/{app['id']}", app["data"])
        self.assertEqual(status, 409)

    def test_roles_and_ownership_are_enforced_on_server(self):
        app = self.action(self.create(1), "submit")
        self.action(app, "decision", {"action": "approve", "note": "Клиент не должен одобрить себя."}, expected=403)
        self.login("client2")
        self.assertEqual(self.call("GET", f"/api/applications/{app['id']}", user="client2")[0], 404)
        self.assertEqual(self.call("GET", "/api/applications", user="client2")[1]["applications"], [])
        self.action(app, "submit", user="client2", expected=404)
        self.login("analyst")
        self.assertEqual(self.call("POST", "/api/applications", app["data"], "analyst")[0], 403)
        self.assertEqual(self.call("GET", "/api/applications", user="analyst")[1]["applications"][0]["id"], app["id"])

    def test_concurrent_submit_records_one_decision(self):
        app = self.create()
        path = f"/api/applications/{app['id']}/submit"
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.call("POST", path, {}), range(2)))
        self.assertEqual(sorted(r[0] for r in results), [200, 409])
        saved = self.call("GET", f"/api/applications/{app['id']}")[1]
        self.assertEqual(len(saved["events"]), 3)

    def test_preview_and_stress_do_not_save_or_mutate_application(self):
        # По БКИ у клиента есть 50 000 ₽ ежемесячных платежей; после них остаётся 50 000 ₽.
        app = self.create(revenue_monthly=110000, expenses_monthly=10000, existing_payment=0)
        data = app["data"]
        status, preview, _ = self.call("POST", "/api/preview", data)
        self.assertEqual(status, 200)
        self.assertEqual(preview["decision"]["status"], "rejected")
        self.assertIsNotNone(preview["alternative"])
        alternative = preview["alternative"]
        changed = {**data, "amount": alternative["amount"], "term_months": alternative["term_months"]}
        self.assertEqual(self.call("POST", "/api/preview", changed)[1]["decision"]["status"], alternative["status"])
        stress = {**data, "revenue_monthly": data["revenue_monthly"] * 0.8}
        stressed = self.call("POST", "/api/preview", stress)[1]
        self.assertLess(stressed["score"]["features"]["free_cash_flow"], preview["score"]["features"]["free_cash_flow"])
        saved = self.call("GET", f"/api/applications/{app['id']}")[1]
        self.assertEqual(saved, app)

    def test_validation_consent_and_unknown_checks(self):
        app = self.create(consent=False)
        self.action(app, "submit", expected=400)
        for updates in [{"amount": float("nan")}, {"term_months": 0}, {"amount": True}, {"tax_id": "abc"}, {"product_id": "other"}]:
            self.assertEqual(self.call("POST", "/api/preview", {**app["data"], **updates})[0], 400)
        profile = self.call("GET", "/api/client-profile")[1]["client"]
        update = {key: profile[key] for key in ("company_name", "tax_id", "business_months", "organization_type", "industry", "contact_name", "phone", "email", "legal_address", "average_revenue_6m")}
        update["tax_id"] = "9999999999"
        self.assertEqual(self.call("PUT", "/api/client-profile", update)[0], 200)
        unknown = self.call("POST", "/api/preview", app["data"])[1]
        self.assertEqual(unknown["decision"]["status"], "manual_review")
        self.assertIsNone(unknown["alternative"])

    def test_documents_bki_and_required_collateral(self):
        app = self.create(bki_consent=False, statement_source="not_provided",
                          financial_document_source="not_provided")
        preview = self.call("POST", "/api/preview", app["data"])[1]
        self.assertEqual(preview["decision"]["status"], "manual_review")
        self.assertEqual(set(preview["missing_documents"]), {
            "Согласие на получение кредитного отчёта",
            "Банковская выписка за 6–12 месяцев",
            "Бухгалтерская отчётность или налоговая декларация",
        })
        self.action(app, "submit", expected=400)
        mortgage = {**copy.deepcopy(self.profiles[0]["application"]),
                    "product_id": "commercial_mortgage", "amount": 2_000_000,
                    "term_months": 60, "collateral_type": "none"}
        self.assertEqual(self.call("POST", "/api/applications", mortgage)[0], 400)

    def test_client_profiles_registry_and_individual_application_lists(self):
        profile = self.call("GET", "/api/client-profile")[1]["client"]
        self.assertEqual(profile["average_revenue_6m"], 1500000)
        update = {key: profile[key] for key in ("company_name", "tax_id", "business_months", "organization_type", "industry", "contact_name", "phone", "email", "legal_address", "average_revenue_6m")}
        update["average_revenue_6m"] = 1750000
        self.assertEqual(self.call("PUT", "/api/client-profile", update)[1]["client"]["average_revenue_6m"], 1750000)
        app = self.create()
        self.assertEqual(self.call("GET", "/api/clients")[0], 403)
        self.login("analyst")
        clients = self.call("GET", "/api/clients", user="analyst")[1]["clients"]
        self.assertEqual(len(clients), 10)
        selected = next(item for item in clients if item["username"] == "client")
        self.assertEqual(selected["application_count"], 1)
        result = self.call("GET", "/api/clients/client/applications", user="analyst")[1]
        self.assertEqual([item["id"] for item in result["applications"]], [app["id"]])

    def test_each_account_has_its_own_password(self):
        self.assertEqual(self.call("POST", "/api/login", {"username": "client2", "password": "client-pass"}, user="wrong")[0], 401)
        self.login("client10")
        self.assertEqual(self.call("GET", "/api/client-profile", user="client10")[1]["client"]["username"], "client10")

    def test_legacy_application_fields_are_migrated_to_client_profile(self):
        path = Path(self.temp.name) / "legacy.db"
        legacy = {**copy.deepcopy(self.profiles[0]["application"]), "company_name": "ООО Старая Компания",
                  "tax_id": "7800000000", "business_months": 52}
        with closing(sqlite3.connect(path)) as db, db:
            db.execute("""CREATE TABLE applications (id TEXT PRIMARY KEY, owner TEXT NOT NULL,
                status TEXT NOT NULL, data TEXT NOT NULL, assessment TEXT,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL)""")
            db.execute("INSERT INTO applications VALUES(?,?,?,?,?,?,?)",
                       ("a" * 16, "client", "draft", json.dumps(legacy), None, "2026-01-01", "2026-01-01"))
        store = Store(path)
        with store.connection() as db:
            app = Store.application(db, "a" * 16, {"username": "client", "role": "client"})
        self.assertEqual(app["client"]["company_name"], "ООО Старая Компания")
        self.assertEqual(app["client"]["tax_id"], "7800000000")
        self.assertEqual(app["client"]["average_revenue_6m"], legacy["revenue_monthly"])
        self.assertFalse({"company_name", "tax_id", "business_months"} & set(app["data"]))

    def test_session_origin_host_and_static_assets(self):
        self.assertEqual(self.call("GET", "/api/me", user="anonymous")[0], 401)
        self.assertEqual(self.call("POST", "/api/preview", {}, headers={"Origin": "https://evil.invalid"})[0], 403)
        self.assertEqual(self.call("GET", "/health", headers={"Host": "evil.invalid"})[0], 403)
        for path in ["/", "/login", "/cabinet", "/landing.css", "/landing.js", "/app.js", "/advisor.js", "/advisor.css", "/push.png", "/style.css", "/health", "/openapi.json"]:
            self.assertEqual(self.call("GET", path)[0], 200, path)
        landing = self.call("GET", "/", user="anonymous")[1].decode("utf-8")
        self.assertIn('href="/login"', landing)
        self.assertNotIn('id="login-form"', landing)
        self.assertIn('id="login-form"', self.call("GET", "/login", user="anonymous")[1].decode("utf-8"))
        self.assertEqual(self.call("POST", "/api/logout", {})[0], 200)
        self.assertEqual(self.call("GET", "/api/me")[0], 401)


if __name__ == "__main__":
    unittest.main()
