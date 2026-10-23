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

from scoring import PRODUCTS, decide, mock_checks, score_application, suggest_alternative

ROOT = Path(__file__).resolve().parent
USERS = {"client": "client", "client2": "client", "analyst": "bank"}


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class ApiError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


def require(condition, message, status=400):
    if not condition:
        raise ApiError(status, message)


def validate(raw):
    require(isinstance(raw, dict), "Ожидается JSON-объект.")
    data = {}
    for field, low, high in [("company_name", 2, 120), ("tax_id", 10, 12),
                             ("product_id", 1, 40), ("purpose", 5, 500),
                             ("clarification", 0, 2000)]:
        value = raw.get(field, "")
        require(isinstance(value, str), f"{field}: требуется текст.")
        value = value.strip()
        require(low <= len(value) <= high, f"{field}: длина от {low} до {high} символов.")
        data[field] = value
    require(re.fullmatch(r"(?:[0-9]{10}|[0-9]{12})", data["tax_id"]), "ИНН: 10 или 12 цифр (демоданные).")
    product = next((p for p in PRODUCTS if p["id"] == data["product_id"]), None)
    require(product, "Неизвестный продукт.")
    limits = {"amount": (product["min_amount"], product["max_amount"]),
              "term_months": (product["min_term"], product["max_term"]),
              "revenue_monthly": (0, 10**10), "expenses_monthly": (0, 10**10),
              "existing_payment": (0, 10**10), "business_months": (0, 1200)}
    for field, (low, high) in limits.items():
        value = raw.get(field)
        require(type(value) in (float, int) and math.isfinite(value), f"{field}: требуется конечное число.")
        require(low <= value <= high, f"{field}: допустимо от {low} до {high}.")
        if field in ("term_months", "business_months"):
            require(value == int(value), f"{field}: требуется целое число.")
            data[field] = int(value)
        else:
            data[field] = round(value, 2)
    require(type(raw.get("consent", False)) is bool, "consent: требуется true или false.")
    data["consent"] = raw.get("consent", False)
    require(not (set(raw) - set(data)), "В запросе есть неизвестные поля.")
    return data


def assess(data):
    checks = mock_checks(data["tax_id"])
    score = score_application(data, checks)
    decision = decide(data, checks, score)
    return {"checks": checks, "score": score, "decision": decision,
            "alternative": suggest_alternative(data, checks, score, decision)}


class Store:
    def __init__(self, path):
        self.path = str(path)
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
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
            """)

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
    def application(db, app_id, user):
        row = db.execute("SELECT * FROM applications WHERE id=?", (app_id,)).fetchone()
        require(row is not None and (user["role"] == "bank" or row["owner"] == user["username"]),
                "Заявка не найдена.", 404)
        result = dict(row)
        result["data"] = json.loads(result["data"])
        result["assessment"] = json.loads(result["assessment"]) if result["assessment"] else None
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
            row = db.execute("SELECT username FROM sessions WHERE token_hash=? AND expires>?",
                             (self.token_hash(), time.time())).fetchone()
        require(row, "Войдите в демо-аккаунт.", 401)
        return {"username": row["username"], "role": USERS[row["username"]]}

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
            require(username in USERS and hmac.compare_digest(password.encode(), self.server.password.encode()), "Неверный логин или пароль.", 401)
            token = secrets.token_urlsafe(32)
            with self.server.store.connection(write=True) as db:
                db.execute("DELETE FROM sessions WHERE expires<=? OR token_hash=?", (time.time(), self.token_hash()))
                db.execute("INSERT INTO sessions VALUES(?,?,?)", (hashlib.sha256(token.encode()).hexdigest(), username, time.time()+28800))
            return self.send(200, {"user": {"username": username, "role": USERS[username]}},
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
            if path == "/api/applications":
                with self.server.store.connection() as db:
                    rows = db.execute("SELECT id FROM applications WHERE owner=? OR ?='bank' ORDER BY created_at DESC",
                                      (user["username"], user["role"])).fetchall()
                    apps = [Store.application(db, r["id"], user) for r in rows]
                return self.send(200, {"applications": apps})
        if path == "/api/preview" and self.command == "POST":
            return self.send(200, assess(validate(self.body())))
        if path == "/api/applications" and self.command == "POST":
            require(user["role"] == "client", "Создавать заявки может клиент.", 403)
            data, app_id, stamp = validate(self.body()), secrets.token_hex(8), now()
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
                require(isinstance(note, str) and 10 <= len(note.strip()) <= 2000, "Обоснование: от 10 до 2000 символов.")
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
                    data = validate(raw)
                    db.execute("UPDATE applications SET data=?,assessment=NULL WHERE id=?", (json.dumps(data), app_id))
                    Store.event(db, app_id, app["status"], user["username"], "Данные заявки обновлены.")
                elif action == "submit":
                    require(app["status"] in ("draft", "needs_info"), "Заявка уже отправлена.", 409)
                    require(app["data"]["consent"], "Подтвердите согласие на учебную обработку данных.")
                    if app["status"] == "needs_info":
                        require(len(app["data"]["clarification"]) >= 10, "Добавьте ответ на запрос банка (от 10 символов).")
                    assessment = assess(app["data"])
                    # Clarification is reviewed by a person; text does not magically remove risk.
                    if app["status"] == "needs_info" and assessment["decision"]["status"] != "rejected":
                        assessment["decision"] = {"status": "manual_review", "reasons": ["Уточнение передано сотруднику банка."], "offer": None}
                    Store.event(db, app_id, "checking", "system", "Выполнены локальные проверки компании и кредитной истории.")
                    db.execute("UPDATE applications SET assessment=? WHERE id=?", (json.dumps(assessment), app_id))
                    Store.event(db, app_id, assessment["decision"]["status"], "system", " ".join(assessment["decision"]["reasons"]))
                elif action == "accept":
                    require(app["status"] == "approved", "Принять предложение можно только после одобрения.", 409)
                    Store.event(db, app_id, "signed", user["username"], "Подписание договора смоделировано. Юридической силы нет.")
                    Store.event(db, app_id, "funded", "system", "Выдача смоделирована. Деньги не переводились.")
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
    server.password = os.environ.get("DEMO_PASSWORD", "demo-pass-2026")
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
