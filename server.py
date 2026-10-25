"""Local, synthetic lending demo. Run: python server.py (Python 3.12)."""
import hashlib
import hmac
import json
import math
import os
import re
import secrets
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from scoring import (PRODUCTS, decide, mock_checks, mock_credit_report, score_application,
                     suggest_alternative, suggest_products)

ROOT = Path(__file__).resolve().parent
ORGANIZATION_TYPES = ("ИП", "ООО", "АО", "ПАО", "Самозанятый")
APPLICATION_PROFILE_FIELDS = {"company_name", "tax_id", "business_months", "organization_type",
                              "industry", "contact_name", "phone", "email", "legal_address",
                              "average_revenue_6m"}


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class ApiError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


def require(condition, message, status=400):
    if not condition:
        raise ApiError(status, message)


def password_hash(username, password):
    salt = hashlib.sha256(("yasno:" + username).encode()).digest()
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 60_000).hex()


def validate_application(raw):
    require(isinstance(raw, dict), "Ожидается JSON-объект.")
    data = {}
    for field, low, high in [("product_id", 1, 40), ("purpose", 5, 500),
                             ("clarification", 0, 2000), ("statement_filename", 0, 255),
                             ("financial_document_filename", 0, 255)]:
        value = raw.get(field, "")
        require(isinstance(value, str), f"{field}: требуется текст.")
        value = value.strip()
        require(low <= len(value) <= high, f"{field}: длина от {low} до {high} символов.")
        data[field] = value
    product = next((p for p in PRODUCTS if p["id"] == data["product_id"]), None)
    require(product, "Неизвестный продукт.")
    collateral_type = raw.get("collateral_type", "none")
    require(isinstance(collateral_type, str) and collateral_type in {
        "none", "real_estate", "equipment", "vehicle", "deposit", "purchased_asset", "msp_guarantee"
    }, "Неизвестный вид обеспечения.")
    data["collateral_type"] = collateral_type
    statement_source = raw.get("statement_source", "bank_account")
    require(isinstance(statement_source, str) and statement_source in {
        "not_provided", "uploaded", "bank_account"
    }, "Неизвестный источник банковской выписки.")
    data["statement_source"] = statement_source
    financial_document_source = raw.get("financial_document_source", "bank_report")
    require(isinstance(financial_document_source, str) and financial_document_source in {
        "not_provided", "uploaded", "bank_report"
    }, "Неизвестный источник финансового документа.")
    data["financial_document_source"] = financial_document_source
    financial_document_type = raw.get("financial_document_type", "accounting")
    require(isinstance(financial_document_type, str) and financial_document_type in {
        "accounting", "tax_declaration", "usn_declaration", "management"
    }, "Неизвестный вид финансового документа.")
    data["financial_document_type"] = financial_document_type
    limits = {"amount": (product["min_amount"], product["max_amount"]),
              "term_months": (product["min_term"], product["max_term"]),
              "revenue_monthly": (0, 10**10), "expenses_monthly": (0, 10**10),
              "existing_payment": (0, 10**10), "collateral_value": (0, 10**11),
              "finance_period_months": (6, 12), "statement_period_months": (6, 12),
              "statement_monthly_inflow": (0, 10**11),
              "statement_min_monthly_inflow": (0, 10**11),
              "statement_average_balance": (-10**10, 10**10),
              "statement_negative_days": (0, 366),
              "statement_seasonality": (0, 10),
              "statement_top_counterparty_share": (0, 1),
              "financial_document_period_months": (3, 12),
              "reported_revenue_monthly": (0, 10**11),
              "reported_net_profit_monthly": (-10**10, 10**10)}
    for field, (low, high) in limits.items():
        defaults = {"collateral_value": 0, "finance_period_months": 6,
                    "statement_period_months": 6, "statement_monthly_inflow": raw.get("revenue_monthly", 0),
                    "statement_min_monthly_inflow": raw.get("revenue_monthly", 0),
                    "statement_average_balance": 0, "statement_negative_days": 0,
                    "statement_seasonality": 0, "statement_top_counterparty_share": 0,
                    "financial_document_period_months": 12,
                    "reported_revenue_monthly": raw.get("revenue_monthly", 0),
                    "reported_net_profit_monthly": raw.get("revenue_monthly", 0) - raw.get("expenses_monthly", 0)}
        value = raw.get(field, defaults.get(field))
        require(type(value) in (float, int) and math.isfinite(value), f"{field}: требуется конечное число.")
        require(low <= value <= high, f"{field}: допустимо от {low} до {high}.")
        if field in ("term_months", "finance_period_months", "statement_period_months",
                     "statement_negative_days", "financial_document_period_months"):
            require(value == int(value), f"{field}: требуется целое число.")
            data[field] = int(value)
        else:
            data[field] = round(value, 2)
    require(data["finance_period_months"] in (6, 12), "Период финансовых показателей: 6 или 12 месяцев.")
    require(data["statement_period_months"] in (6, 12), "Период банковской выписки: 6 или 12 месяцев.")
    require(data["financial_document_period_months"] in (3, 6, 12),
            "Период финансового документа: 3, 6 или 12 месяцев.")
    if collateral_type in {"real_estate", "equipment", "vehicle", "deposit"}:
        require(data["collateral_value"] > 0, "Укажите ориентировочную рыночную стоимость залога.")
    if product.get("required_collateral_coverage"):
        require(collateral_type not in {"none", "msp_guarantee"}, "Для выбранного продукта укажите предмет залога.")
    require(type(raw.get("consent", False)) is bool, "consent: требуется true или false.")
    data["consent"] = raw.get("consent", False)
    require(type(raw.get("statement_tax_payments", True)) is bool,
            "statement_tax_payments: требуется true или false.")
    data["statement_tax_payments"] = raw.get("statement_tax_payments", True)
    require(type(raw.get("bki_consent", True)) is bool, "bki_consent: требуется true или false.")
    data["bki_consent"] = raw.get("bki_consent", True)
    require(not (set(raw) - set(data)), "В запросе есть неизвестные поля.")
    return data


def validate_profile(raw):
    require(isinstance(raw, dict), "Ожидается JSON-объект.")
    data = {}
    for field, low, high in [("company_name", 2, 120), ("tax_id", 10, 12),
                             ("organization_type", 2, 30), ("industry", 2, 120),
                             ("contact_name", 2, 120), ("phone", 5, 40),
                             ("email", 5, 120), ("legal_address", 5, 300)]:
        value = raw.get(field, "")
        require(isinstance(value, str), f"{field}: требуется текст.")
        value = value.strip()
        require(low <= len(value) <= high, f"{field}: длина от {low} до {high} символов.")
        data[field] = value
    require(re.fullmatch(r"(?:[0-9]{10}|[0-9]{12})", data["tax_id"]), "ИНН: укажите 10 или 12 цифр.")
    require(data["organization_type"] in ORGANIZATION_TYPES, "Выберите доступный вид организации.")
    require(re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", data["email"]), "Укажите корректный email.")
    for field, high, integer in [("business_months", 1200, True), ("average_revenue_6m", 10**10, False)]:
        value = raw.get(field)
        require(type(value) in (float, int) and math.isfinite(value), f"{field}: требуется конечное число.")
        require(0 <= value <= high, f"{field}: допустимо от 0 до {high}.")
        if integer:
            require(value == int(value), f"{field}: требуется целое число.")
            value = int(value)
        data[field] = value
    require(not (set(raw) - set(data)), "В запросе есть неизвестные поля.")
    return data


def assess(data, client):
    scoring_data = {**data, "tax_id": client["tax_id"], "business_months": client["business_months"]}
    checks = mock_checks(client["tax_id"])
    checks["credit_report"] = mock_credit_report(client["tax_id"]) if data.get("bki_consent", True) else None
    score = score_application(scoring_data, checks)
    decision = decide(scoring_data, checks, score)
    product = next(p for p in PRODUCTS if p["id"] == data["product_id"])
    missing_documents = []
    if not data.get("bki_consent", True):
        missing_documents.append("Согласие на получение кредитного отчёта")
    if data.get("statement_source", "bank_account") == "not_provided":
        missing_documents.append("Банковская выписка за 6–12 месяцев")
    if data.get("financial_document_source", "bank_report") == "not_provided":
        missing_documents.append("Бухгалтерская отчётность или налоговая декларация")
    if product.get("required_collateral_coverage") and data.get("collateral_type", "none") in {"none", "msp_guarantee", ""}:
        missing_documents.append("Документы на предмет залога")
    return {"checks": checks, "score": score, "decision": decision,
            "alternative": suggest_alternative(scoring_data, checks, score, decision),
            "product_alternatives": suggest_products(scoring_data, checks, decision),
            "missing_documents": missing_documents}


class Store:
    def __init__(self, path):
        self.path = str(path)
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS users (
                    username TEXT PRIMARY KEY, password_hash TEXT NOT NULL,
                    role TEXT NOT NULL CHECK(role IN ('client','bank')));
                CREATE TABLE IF NOT EXISTS clients (
                    username TEXT PRIMARY KEY REFERENCES users(username),
                    tax_id TEXT NOT NULL UNIQUE, company_name TEXT NOT NULL,
                    business_months INTEGER NOT NULL, organization_type TEXT NOT NULL,
                    industry TEXT NOT NULL, contact_name TEXT NOT NULL,
                    phone TEXT NOT NULL, email TEXT NOT NULL, legal_address TEXT NOT NULL,
                    average_revenue_6m REAL NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS applications (
                    id TEXT PRIMARY KEY, owner TEXT NOT NULL, status TEXT NOT NULL,
                    data TEXT NOT NULL, assessment TEXT,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS events (
                    id INTEGER PRIMARY KEY, application_id TEXT NOT NULL REFERENCES applications(id),
                    at TEXT NOT NULL, status TEXT NOT NULL, actor TEXT NOT NULL, note TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, expires REAL NOT NULL);
                CREATE INDEX IF NOT EXISTS events_application ON events(application_id, id);
                CREATE INDEX IF NOT EXISTS applications_owner ON applications(owner);
                CREATE INDEX IF NOT EXISTS applications_status ON applications(status, created_at);
                CREATE INDEX IF NOT EXISTS clients_company ON clients(company_name);
            """)
            self.seed(db)
            self.migrate_applications(db)

    @contextmanager
    def connection(self, write=False):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            if write:
                db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    @staticmethod
    def seed(db):
        seed = json.loads((ROOT / "data/clients.json").read_text(encoding="utf-8"))
        accounts = [{"username": "analyst", "password": "analyst-pass", "role": "bank"}]
        accounts.extend({"username": item["username"], "password": item["password"], "role": "client"}
                        for item in seed)
        for account in accounts:
            db.execute("INSERT OR IGNORE INTO users(username,password_hash,role) VALUES(?,?,?)",
                       (account["username"], password_hash(account["username"], account["password"]), account["role"]))
        stamp = now()
        columns = ("username", "tax_id", "company_name", "business_months", "organization_type",
                   "industry", "contact_name", "phone", "email", "legal_address", "average_revenue_6m")
        for item in seed:
            profile = validate_profile({key: item[key] for key in columns if key != "username"})
            values = [item["username"], *(profile[key] for key in columns if key != "username"), stamp, stamp]
            db.execute(f"INSERT OR IGNORE INTO clients({','.join(columns)},created_at,updated_at) VALUES({','.join('?' for _ in values)})", values)

    @staticmethod
    def migrate_applications(db):
        migrated_owners = set()
        rows = db.execute("SELECT id,owner,data FROM applications ORDER BY created_at DESC").fetchall()
        for row in rows:
            data = json.loads(row["data"])
            if row["owner"] not in migrated_owners and all(data.get(key) is not None for key in ("company_name", "tax_id", "business_months")):
                try:
                    db.execute("""UPDATE clients SET company_name=?,tax_id=?,business_months=?,
                        average_revenue_6m=?,updated_at=? WHERE username=?""",
                        (data["company_name"], data["tax_id"], int(data["business_months"]),
                         float(data.get("revenue_monthly", 0)), now(), row["owner"]))
                except sqlite3.IntegrityError:
                    pass
                migrated_owners.add(row["owner"])
            migrated = {key: value for key, value in data.items() if key not in APPLICATION_PROFILE_FIELDS}
            if migrated != data:
                db.execute("UPDATE applications SET data=? WHERE id=?", (json.dumps(migrated), row["id"]))

    @staticmethod
    def client(db, username):
        row = db.execute("SELECT username,tax_id,company_name,business_months,organization_type,industry,contact_name,phone,email,legal_address,average_revenue_6m,created_at,updated_at FROM clients WHERE username=?", (username,)).fetchone()
        require(row is not None, "Профиль клиента не найден.", 404)
        return dict(row)

    @staticmethod
    def application(db, app_id, user):
        row = db.execute("SELECT * FROM applications WHERE id=?", (app_id,)).fetchone()
        require(row is not None and (user["role"] == "bank" or row["owner"] == user["username"]),
                "Заявка не найдена.", 404)
        result = dict(row)
        result["data"] = json.loads(result["data"])
        result["assessment"] = json.loads(result["assessment"]) if result["assessment"] else None
        result["client"] = Store.client(db, result["owner"])
        result["events"] = [dict(e) for e in db.execute(
            "SELECT at,status,actor,note FROM events WHERE application_id=? ORDER BY id", (app_id,))]
        return result

    @staticmethod
    def event(db, app_id, status, actor, note):
        stamp = now()
        db.execute("UPDATE applications SET status=?,updated_at=? WHERE id=?", (status, stamp, app_id))
        db.execute("INSERT INTO events(application_id,at,status,actor,note) VALUES(?,?,?,?,?)",
                   (app_id, stamp, status, actor, note))


class Handler(BaseHTTPRequestHandler):
    server_version = "CreditDemo/1.0"

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def send(self, status, body, content_type="application/json; charset=utf-8", cookie=None):
        if not isinstance(body, bytes):
            body = json.dumps(body, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        require(self.headers.get("Content-Type", "").split(";")[0] == "application/json", "Требуется application/json.", 415)
        require(not self.headers.get("Transfer-Encoding"), "Потоковое тело запроса не поддерживается.")
        try:
            length = int(self.headers.get("Content-Length", 0))
            require(0 < length <= 65536, "Тело запроса должно быть от 1 до 65536 байт.", 413)
            value = json.loads(self.rfile.read(length).decode("utf-8"),
                               parse_constant=lambda x: (_ for _ in ()).throw(ValueError(x)))
        except (ValueError, UnicodeError):
            raise ApiError(400, "Некорректный JSON.")
        require(isinstance(value, dict), "Ожидается JSON-объект.")
        return value

    def token_hash(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except Exception:
            return ""
        token = cookie.get("session")
        return hashlib.sha256(token.value.encode()).hexdigest() if token else ""

    def user(self):
        with self.server.store.connection() as db:
            row = db.execute("SELECT sessions.username,users.role FROM sessions JOIN users ON users.username=sessions.username WHERE token_hash=? AND expires>?",
                             (self.token_hash(), time.time())).fetchone()
        require(row, "Войдите в аккаунт.", 401)
        return {"username": row["username"], "role": row["role"]}

    def dispatch(self):
        path = urlsplit(self.path).path
        host = self.headers.get("Host", "")
        require(urlsplit("http://" + host).hostname in self.server.allowed_hosts, "Недопустимый Host.", 403)
        if self.command != "GET":
            origin = self.headers.get("Origin")
            require(not origin or (urlsplit(origin).netloc == host and urlsplit(origin).scheme in ("http", "https")),
                    "Разрешены только запросы из этого приложения.", 403)
        if self.command == "GET":
            files = {"/": ("static/index.html", "text/html; charset=utf-8"),
                     "/app.js": ("static/app.js", "application/javascript; charset=utf-8"),
                     "/style.css": ("static/style.css", "text/css; charset=utf-8"),
                     "/openapi.json": ("docs/openapi.json", "application/json; charset=utf-8")}
            if path in files:
                name, kind = files[path]
                return self.send(200, (ROOT / name).read_bytes(), kind)
            if path == "/health":
                with self.server.store.connection() as db:
                    db.execute("SELECT 1").fetchone()
                return self.send(200, {"status": "ok", "demo": True})
        if path == "/api/login" and self.command == "POST":
            raw = self.body()
            username, password = raw.get("username"), raw.get("password")
            require(isinstance(username, str) and isinstance(password, str), "Укажите логин и пароль.")
            with self.server.store.connection() as db:
                account = db.execute("SELECT username,password_hash,role FROM users WHERE username=?", (username.strip(),)).fetchone()
            expected = password_hash(username.strip(), password) if account else password_hash("missing", password)
            require(account and hmac.compare_digest(expected, account["password_hash"]), "Неверный логин или пароль.", 401)
            token = secrets.token_urlsafe(32)
            with self.server.store.connection(write=True) as db:
                db.execute("DELETE FROM sessions WHERE expires<=? OR token_hash=?", (time.time(), self.token_hash()))
                db.execute("INSERT INTO sessions VALUES(?,?,?)", (hashlib.sha256(token.encode()).hexdigest(), account["username"], time.time()+28800))
            return self.send(200, {"user": {"username": account["username"], "role": account["role"]}},
                             cookie=f"session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800")
        user = self.user()
        if path == "/api/logout" and self.command == "POST":
            self.body()
            with self.server.store.connection(write=True) as db:
                db.execute("DELETE FROM sessions WHERE token_hash=?", (self.token_hash(),))
            return self.send(200, {"ok": True}, cookie="session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0")
        if self.command == "GET":
            if path == "/api/me":
                return self.send(200, {"user": user})
            if path == "/api/products":
                return self.send(200, {"products": PRODUCTS})
            if path == "/api/demo-profiles":
                return self.send(200, {"profiles": json.loads((ROOT / "data/demo_profiles.json").read_text(encoding="utf-8"))})
            if path == "/api/client-profile":
                require(user["role"] == "client", "Профиль доступен только клиенту.", 403)
                with self.server.store.connection() as db:
                    return self.send(200, {"client": Store.client(db, user["username"])})
            if path == "/api/clients":
                require(user["role"] == "bank", "Реестр клиентов доступен только сотруднику банка.", 403)
                with self.server.store.connection() as db:
                    rows = db.execute("""SELECT clients.*,
                        COUNT(applications.id) AS application_count,
                        SUM(CASE WHEN applications.status='manual_review' THEN 1 ELSE 0 END) AS manual_review_count,
                        MAX(applications.created_at) AS latest_application_at
                        FROM clients LEFT JOIN applications ON applications.owner=clients.username
                        GROUP BY clients.username ORDER BY clients.company_name""").fetchall()
                    clients = [dict(row) for row in rows]
                return self.send(200, {"clients": clients})
            if path == "/api/applications":
                with self.server.store.connection() as db:
                    rows = db.execute("SELECT id FROM applications WHERE owner=? OR ?='bank' ORDER BY created_at DESC",
                                      (user["username"], user["role"])).fetchall()
                    apps = [Store.application(db, r["id"], user) for r in rows]
                return self.send(200, {"applications": apps})
            client_apps = re.fullmatch(r"/api/clients/([A-Za-z0-9_.-]{1,64})/applications", path)
            if client_apps:
                require(user["role"] == "bank", "Заявки клиента доступны только сотруднику банка.", 403)
                with self.server.store.connection() as db:
                    Store.client(db, client_apps.group(1))
                    rows = db.execute("SELECT id FROM applications WHERE owner=? ORDER BY created_at DESC", (client_apps.group(1),)).fetchall()
                    apps = [Store.application(db, row["id"], user) for row in rows]
                return self.send(200, {"applications": apps})
        if path == "/api/client-profile" and self.command == "PUT":
            require(user["role"] == "client", "Профиль доступен только клиенту.", 403)
            profile = validate_profile(self.body())
            with self.server.store.connection(write=True) as db:
                duplicate = db.execute("SELECT username FROM clients WHERE tax_id=? AND username<>?", (profile["tax_id"], user["username"])).fetchone()
                require(not duplicate, "Клиент с таким ИНН уже существует.", 409)
                assignments = ",".join(f"{key}=?" for key in profile)
                db.execute(f"UPDATE clients SET {assignments},updated_at=? WHERE username=?", (*profile.values(), now(), user["username"]))
                result = Store.client(db, user["username"])
            return self.send(200, {"client": result})
        if path == "/api/preview" and self.command == "POST":
            require(user["role"] == "client", "Предварительная проверка доступна только клиенту.", 403)
            data = validate_application(self.body())
            with self.server.store.connection() as db:
                client = Store.client(db, user["username"])
            return self.send(200, assess(data, client))
        if path == "/api/applications" and self.command == "POST":
            require(user["role"] == "client", "Создавать заявки может клиент.", 403)
            data, app_id, stamp = validate_application(self.body()), secrets.token_hex(8), now()
            with self.server.store.connection(write=True) as db:
                db.execute("INSERT INTO applications VALUES(?,?,?,?,?,?,?)",
                           (app_id, user["username"], "draft", json.dumps(data), None, stamp, stamp))
                Store.event(db, app_id, "draft", user["username"], "Черновик сохранён.")
                result = Store.application(db, app_id, user)
            return self.send(201, result)
        match = re.fullmatch(r"/api/applications/([a-f0-9]{16})(?:/(submit|accept|decision))?", path)
        require(match, "Маршрут не найден.", 404)
        app_id, action = match.groups()
        if self.command == "GET" and not action:
            with self.server.store.connection() as db:
                return self.send(200, Store.application(db, app_id, user))
        require((self.command == "PUT" and not action) or (self.command == "POST" and action), "Метод не поддерживается.", 405)
        raw = self.body()
        with self.server.store.connection(write=True) as db:
            app = Store.application(db, app_id, user)
            if action == "decision":
                require(user["role"] == "bank", "Решение доступно только сотруднику банка.", 403)
                require(app["status"] == "manual_review", "Заявка не ожидает ручного решения.", 409)
                choice, note = raw.get("action"), raw.get("note", "")
                require(choice in ("approve", "reject", "request_info"), "Неизвестное действие.")
                require(isinstance(note, str) and len(note.strip()) <= 2000, "Комментарий: не более 2000 символов.")
                require(choice == "approve" and (not note.strip() or len(note.strip()) >= 10)
                        or choice != "approve" and len(note.strip()) >= 10,
                        "Для запроса уточнения и отказа нужен комментарий от 10 символов; при одобрении комментарий можно не заполнять.")
                status = {"approve": "approved", "reject": "rejected", "request_info": "needs_info"}[choice]
                assessment = app["assessment"]
                # Preserve the automatic assessment; record the human decision separately.
                assessment["bank_decision"] = {"status": status, "note": note.strip(), "actor": user["username"]}
                if status == "approved":
                    data = app["data"]
                    product = next(p for p in PRODUCTS if p["id"] == data["product_id"])
                    assessment["bank_decision"]["offer"] = {"amount": data["amount"], "term_months": data["term_months"],
                        "annual_rate": product["annual_rate"], "monthly_payment": assessment["score"]["monthly_payment"]}
                db.execute("UPDATE applications SET assessment=? WHERE id=?", (json.dumps(assessment), app_id))
                Store.event(db, app_id, status, user["username"], note.strip())
            else:
                require(user["role"] == "client", "Действие доступно только клиенту.", 403)
                if not action:
                    require(app["status"] in ("draft", "needs_info"), "Редактирование закрыто после отправки.", 409)
                    data = validate_application(raw)
                    db.execute("UPDATE applications SET data=?,assessment=NULL WHERE id=?", (json.dumps(data), app_id))
                    Store.event(db, app_id, app["status"], user["username"], "Данные заявки обновлены.")
                elif action == "submit":
                    require(app["status"] in ("draft", "needs_info"), "Заявка уже отправлена.", 409)
                    require(app["data"]["consent"], "Подтвердите согласие на обработку данных.")
                    require(app["data"].get("bki_consent", True),
                            "Подтвердите согласие на получение кредитного отчёта.")
                    if app["status"] == "needs_info":
                        require(len(app["data"]["clarification"]) >= 10, "Добавьте ответ на запрос банка (от 10 символов).")
                    assessment = assess(app["data"], app["client"])
                    # Clarification is reviewed by a person; text does not magically remove risk.
                    if app["status"] == "needs_info" and assessment["decision"]["status"] != "rejected":
                        assessment["decision"] = {"status": "manual_review", "reasons": ["Уточнение передано сотруднику банка."], "offer": None}
                    Store.event(db, app_id, "checking", "system", "Выполнены локальные проверки компании и кредитной истории.")
                    db.execute("UPDATE applications SET assessment=? WHERE id=?", (json.dumps(assessment), app_id))
                    Store.event(db, app_id, assessment["decision"]["status"], "system", " ".join(assessment["decision"]["reasons"]))
                elif action == "accept":
                    require(app["status"] == "approved", "Принять предложение можно только после одобрения.", 409)
                    Store.event(db, app_id, "signed", user["username"], "Условия предложения приняты.")
                    Store.event(db, app_id, "funded", "system", "Заявка завершена.")
            result = Store.application(db, app_id, user)
        return self.send(200, result)

    def handle_request(self):
        try:
            self.dispatch()
        except ApiError as error:
            self.send(error.status, {"error": error.message})
        except (ValueError, OverflowError):
            self.send(400, {"error": "Некорректные параметры запроса или расчёта."})
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
        except Exception:
            self.log_error("Internal error (request body omitted)")
            self.send(500, {"error": "Внутренняя ошибка. Попробуйте снова."})

    do_GET = do_POST = do_PUT = handle_request


def create_server(host="127.0.0.1", port=8000, db_path=None):
    server = ThreadingHTTPServer((host, port), Handler)
    server.store = Store(db_path or os.environ.get("DB_PATH", str(ROOT / "runtime/credit.db")))
    server.allowed_hosts = set(os.environ.get("ALLOWED_HOSTS", "localhost,127.0.0.1,::1").split(","))
    return server


if __name__ == "__main__":
    server = create_server(os.environ.get("HOST", "127.0.0.1"), int(os.environ.get("PORT", "8000")))
    print(f"Credit MVP: http://localhost:{server.server_port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
