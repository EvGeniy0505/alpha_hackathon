"""Учебные правила: синтетические проверки, скоринг и отдельная кредитная политика.

Это не обученная модель, score не является вероятностью дефолта.
Ставки и пороги придуманы для демонстрации и не подходят для реального кредитования.
"""

import math


VERSION = "demo-rules-1.0"
PRODUCTS = [
    {
        "id": "working_capital", "name": "Оборотный кредит",
        "description": "Учебный продукт на закупки и текущие расходы бизнеса.",
        "min_amount": 100_000, "max_amount": 3_000_000,
        "min_term": 6, "max_term": 24, "annual_rate": 24.0,
    },
    {
        "id": "equipment", "name": "Кредит на оборудование",
        "description": "Учебный продукт на покупку оборудования.",
        "min_amount": 300_000, "max_amount": 10_000_000,
        "min_term": 12, "max_term": 60, "annual_rate": 20.0,
    },
]


def _number(value, name, *, minimum=0, integer=False):
    """Не допускаем bool, NaN, Infinity и нецелые сроки."""
    if isinstance(value, bool):
        raise ValueError(f"{name}: требуется число")
    try:
        number = float(value)
    except (ValueError, TypeError, OverflowError) as exc:
        raise ValueError(f"{name}: требуется число") from exc
    if not math.isfinite(number) or number < minimum:
        raise ValueError(f"{name}: требуется конечное число не меньше {minimum}")
    if integer and not number.is_integer():
        raise ValueError(f"{name}: требуется целое число")
    return int(number) if integer else number


def monthly_payment(amount, annual_rate, term_months):
    """Аннуитет; ставка в процентах годовых, сумма и результат в рублях."""
    amount = _number(amount, "amount", minimum=0.01)
    rate = _number(annual_rate, "annual_rate") / 1200
    months = _number(term_months, "term_months", minimum=1, integer=True)
    if rate == 0:
        return round(amount / months, 2)
    # log1p/expm1 устойчивы даже при почти нулевой положительной ставке.
    denominator = -math.expm1(-months * math.log1p(rate))
    payment = amount * rate / denominator
    if not math.isfinite(payment):
        raise ValueError("Параметры дают слишком большой платеж")
    return round(payment, 2)


def mock_checks(tax_id):
    """Никаких запросов в ФНС/БКИ: записи ниже выдуманы целиком."""
    examples = {
        "7700000001": ("active", 0),
        "7700000002": ("active", 7),
        "7700000003": ("inactive", 60),
    }
    status, overdue = examples.get(str(tax_id), ("unknown", None))
    return {
        "registry_status": status,
        "overdue_days": overdue,
        "source": "local_synthetic",
    }


def score_application(data, checks):
    """Возвращает объяснимый индекс правил; не принимает кредитное решение."""
    product = next((p for p in PRODUCTS if p["id"] == data.get("product_id")), None)
    if product is None:
        raise ValueError("Неизвестный кредитный продукт")
    amount = _number(data.get("amount"), "amount", minimum=0.01)
    term = _number(data.get("term_months"), "term_months", minimum=1, integer=True)
    if not product["min_amount"] <= amount <= product["max_amount"]:
        raise ValueError("Сумма выходит за границы продукта")
    if not product["min_term"] <= term <= product["max_term"]:
        raise ValueError("Срок выходит за границы продукта")
    revenue = _number(data.get("revenue_monthly"), "revenue_monthly")
    expenses = _number(data.get("expenses_monthly"), "expenses_monthly")
    existing = _number(data.get("existing_payment"), "existing_payment")
    age = _number(data.get("business_months"), "business_months", integer=True)
    payment = monthly_payment(amount, product["annual_rate"], term)
    free_cash = revenue - expenses - existing
    coverage = free_cash / payment
    # Ограничения входных величин проверяет API; защищаем и прямой вызов модуля.
    if not math.isfinite(free_cash) or not math.isfinite(coverage):
        raise ValueError("Финансовые показатели слишком велики")

    points, reasons = 100, []
    if coverage < 1:
        points -= 55
        reasons.append("Свободного денежного потока не хватает на новый платеж.")
    elif coverage < 1.5:
        points -= 30
        reasons.append("Запас свободного потока меньше 1,5 нового платежа.")
    elif coverage < 2:
        points -= 10
        reasons.append("Свободный поток покрывает менее двух новых платежей.")
    else:
        reasons.append("Свободный поток покрывает не менее двух новых платежей.")
    if age < 6:
        points -= 30
        reasons.append("Бизнес работает меньше 6 месяцев.")
    elif age < 12:
        points -= 15
        reasons.append("Бизнес работает меньше 12 месяцев.")

    registry = checks.get("registry_status", "unknown")
    overdue = checks.get("overdue_days")
    if registry == "inactive":
        points -= 55
        reasons.append("В синтетическом реестре компания неактивна.")
    elif registry != "active":
        points -= 20
        reasons.append("Статус компании не подтвержден учебной проверкой.")
    if overdue is None:
        points -= 15
        reasons.append("Нет учебных данных о просрочке.")
    else:
        overdue = _number(overdue, "overdue_days", integer=True)
        if overdue >= 30:
            points -= 50
            reasons.append("Синтетическая просрочка составляет 30 дней или больше.")
        elif overdue > 0:
            points -= 20
            reasons.append("Обнаружена небольшая синтетическая просрочка.")

    points = max(0, min(100, points))
    return {
        "score": points,
        "risk": "low" if points >= 75 else "medium" if points >= 45 else "high",
        "reasons": reasons,
        "features": {
            "free_cash_flow": round(free_cash, 2),
            "payment_coverage": round(coverage, 4),
            "business_months": age,
            # Отдельный флаг сохраняет точность у границ кредитной политики.
            "covers_payment": coverage >= 1,
            "has_approval_buffer": coverage >= 1.5,
        },
        "monthly_payment": payment,
        "version": VERSION,
    }


def decide(data, checks, score):
    """Детерминированная политика поверх результата score_application."""
    features = score["features"]
    reject_reasons = []
    if checks.get("registry_status") == "inactive":
        reject_reasons.append("Компания неактивна в синтетическом реестре.")
    if checks.get("overdue_days") is not None and checks["overdue_days"] >= 30:
        reject_reasons.append("Учебная политика не допускает просрочку от 30 дней.")
    if not features["covers_payment"]:
        reject_reasons.append("Денежного потока недостаточно для нового платежа.")
    if score["score"] < 45:
        reject_reasons.append("Индекс правил ниже учебного порога 45.")
    if reject_reasons:
        return {"status": "rejected", "reasons": reject_reasons, "offer": None}

    review_reasons = []
    if checks.get("registry_status") != "active":
        review_reasons.append("Нужно подтвердить статус компании.")
    if checks.get("overdue_days") is None:
        review_reasons.append("Нужно получить сведения о просрочке.")
    elif checks["overdue_days"] > 0:
        review_reasons.append("Нужно выяснить обстоятельства учебной просрочки.")
    if features["business_months"] < 12:
        review_reasons.append("Историю бизнеса короче 12 месяцев проверяет специалист.")
    if not features["has_approval_buffer"]:
        review_reasons.append("Нужно уточнить небольшой запас денежного потока.")
    if score["score"] < 75:
        review_reasons.append("Индекс правил ниже порога автоматического одобрения 75.")
    if review_reasons:
        return {"status": "manual_review", "reasons": review_reasons, "offer": None}

    product = next(p for p in PRODUCTS if p["id"] == data["product_id"])
    return {
        "status": "approved",
        "reasons": ["Выполнены условия автоматического одобрения учебной политики."],
        "offer": {
            "amount": float(data["amount"]), "term_months": int(data["term_months"]),
            "annual_rate": product["annual_rate"],
            "monthly_payment": score["monthly_payment"],
        },
    }


def suggest_alternative(data, checks, score, decision):
    """Подбирает учебный вариант без изменения заявки; решение перепроверяется."""
    overdue = checks.get("overdue_days")
    if (decision["status"] == "approved" or checks.get("registry_status") != "active"
            or overdue is None or overdue >= 30):
        return None
    free_cash = score["features"]["free_cash_flow"]
    if free_cash <= 0:
        return None
    product = next(p for p in PRODUCTS if p["id"] == data["product_id"])
    rate = product["annual_rate"] / 1200
    candidates = []
    for term in range(int(data["term_months"]), product["max_term"] + 1):
        factor = rate / -math.expm1(-term * math.log1p(rate)) if rate else 1 / term
        # Второй запас позволяет преодолеть следующий порог индекса правил.
        for coverage in (1.5, 2):
            ceiling = math.floor((free_cash / coverage - 0.01) / factor)
            amount = min(float(data["amount"]), product["max_amount"], ceiling)
            if amount < product["min_amount"]:
                continue
            candidate = {**data, "amount": amount, "term_months": term}
            recalculated = score_application(candidate, checks)
            if not recalculated["features"]["has_approval_buffer"]:
                continue
            status = decide(candidate, checks, recalculated)["status"]
            if status == "approved" or (status == "manual_review" and decision["status"] == "rejected"):
                candidates.append({
                    "amount": amount, "term_months": term,
                    "monthly_payment": recalculated["monthly_payment"], "status": status,
                    "explanation": (
                        "Учебный расчет: при этих параметрах запас потока не меньше 1,5 платежа. "
                        "Это сценарий по синтетическим правилам, а не обещание выдачи кредита. "
                        "Исходная заявка не изменена."
                    ),
                })
    # Сначала лучший статус, затем наибольшая сумма и самый короткий срок.
    return max(candidates, key=lambda c: (c["status"] == "approved", c["amount"], -c["term_months"]), default=None)
