"""Учебные правила: синтетические проверки, скоринг и отдельная кредитная политика.

Это не обученная модель, score не является вероятностью дефолта.
Ставки и пороги придуманы для демонстрации и не подходят для реального кредитования.
"""

import math


VERSION = "demo-rules-1.0"
PRODUCTS = [
    {
        "id": "overdraft", "name": "Овердрафт", "category": "Оборотный капитал",
        "description": "Кратковременное покрытие кассовых разрывов по расчётному счёту.",
        "min_amount": 100_000, "max_amount": 5_000_000, "min_term": 1, "max_term": 12,
        "annual_rate": 21.5, "approval_coverage": 1.3, "min_business_months": 12,
    },
    {
        "id": "working_capital", "name": "Разовый оборотный кредит", "category": "Оборотный капитал",
        "description": "Одна сумма на закупку товара, сырья или текущие обязательства.",
        "min_amount": 100_000, "max_amount": 10_000_000, "min_term": 3, "max_term": 36,
        "annual_rate": 19.5, "approval_coverage": 1.5, "min_business_months": 6,
    },
    {
        "id": "credit_line_revolving", "name": "Возобновляемая кредитная линия", "category": "Оборотный капитал",
        "description": "Повторные транши в пределах лимита; погашенная часть снова доступна.",
        "min_amount": 500_000, "max_amount": 30_000_000, "min_term": 6, "max_term": 36,
        "annual_rate": 18.5, "approval_coverage": 1.6, "min_business_months": 12,
    },
    {
        "id": "credit_line_nonrevolving", "name": "Невозобновляемая кредитная линия", "category": "Оборотный капитал",
        "description": "Несколько траншей на проект без восстановления использованного лимита.",
        "min_amount": 500_000, "max_amount": 50_000_000, "min_term": 6, "max_term": 48,
        "annual_rate": 18.0, "approval_coverage": 1.6, "min_business_months": 12,
    },
    {
        "id": "equipment", "name": "Инвестиционный кредит", "category": "Долгосрочное финансирование",
        "description": "Расширение производства, реконструкция и покупка оборудования.",
        "min_amount": 500_000, "max_amount": 100_000_000, "min_term": 24, "max_term": 120,
        "annual_rate": 16.5, "approval_coverage": 1.5, "min_business_months": 24,
    },
    {
        "id": "commercial_mortgage", "name": "Коммерческая ипотека", "category": "Долгосрочное финансирование",
        "description": "Покупка офиса, склада, помещения или участка под залог объекта.",
        "min_amount": 1_000_000, "max_amount": 200_000_000, "min_term": 36, "max_term": 180,
        "annual_rate": 15.5, "approval_coverage": 1.4, "min_business_months": 24,
        "required_collateral_coverage": 0.7, "manual_review": True,
    },
    {
        "id": "project_finance", "name": "Проектное финансирование", "category": "Долгосрочное финансирование",
        "description": "Новое направление или стройка с погашением из будущих доходов проекта.",
        "min_amount": 5_000_000, "max_amount": 500_000_000, "min_term": 36, "max_term": 144,
        "annual_rate": 18.0, "approval_coverage": 2.0, "min_business_months": 36,
        "required_collateral_coverage": 0.4, "manual_review": True,
    },
    {
        "id": "subsidized", "name": "Льготный кредит с господдержкой", "category": "Специализированные инструменты",
        "description": "Финансирование по программе поддержки при соответствии её требованиям.",
        "min_amount": 500_000, "max_amount": 500_000_000, "min_term": 6, "max_term": 60,
        "annual_rate": 17.0, "approval_coverage": 1.3, "min_business_months": 12, "manual_review": True,
    },
    {
        "id": "leasing", "name": "Лизинг", "category": "Специализированные инструменты",
        "description": "Техника, транспорт или оборудование в аренду с последующим выкупом.",
        "min_amount": 300_000, "max_amount": 100_000_000, "min_term": 12, "max_term": 84,
        "annual_rate": 17.5, "approval_coverage": 1.4, "min_business_months": 12,
    },
    {
        "id": "factoring", "name": "Факторинг", "category": "Специализированные инструменты",
        "description": "Финансирование под уступку дебиторской задолженности.",
        "min_amount": 100_000, "max_amount": 50_000_000, "min_term": 1, "max_term": 24,
        "annual_rate": 20.0, "approval_coverage": 1.2, "min_business_months": 6, "manual_review": True,
    },
    {
        "id": "bank_guarantee", "name": "Банковская гарантия или тендерный кредит", "category": "Специализированные инструменты",
        "description": "Обеспечение заявки или исполнения контракта по 44-ФЗ и 223-ФЗ.",
        "min_amount": 100_000, "max_amount": 100_000_000, "min_term": 1, "max_term": 36,
        "annual_rate": 18.5, "approval_coverage": 1.3, "min_business_months": 12, "manual_review": True,
    },
]

COLLATERAL_HAIRCUTS = {
    "none": 0.0,
    "real_estate": 0.70,
    "equipment": 0.50,
    "vehicle": 0.55,
    "deposit": 0.95,
    "purchased_asset": 0.70,
}


def collateral_terms(data, amount):
    """Консервативно учитываем ликвидную стоимость обеспечения, не заменяя ей доход."""
    collateral_type = data.get("collateral_type", "none")
    raw_value = _number(data.get("collateral_value", 0), "collateral_value")
    if collateral_type == "msp_guarantee":
        eligible_value = amount * 0.5
        discount = 0.5
    else:
        if collateral_type not in COLLATERAL_HAIRCUTS:
            raise ValueError("Неизвестный вид обеспечения")
        base_value = amount if collateral_type == "purchased_asset" else raw_value
        eligible_value = base_value * COLLATERAL_HAIRCUTS[collateral_type]
        coverage = eligible_value / amount
        discount = 1.5 if coverage >= 0.7 else 0.75 if coverage >= 0.4 else 0.0
    coverage = eligible_value / amount
    return {
        "type": collateral_type,
        "eligible_value": round(eligible_value, 2),
        "coverage": round(coverage, 4),
        "rate_discount": discount,
    }


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
        "7700000004": ("active", 0),
        "7700000005": ("active", 0),
        "7700000006": ("active", 12),
        "7700000007": ("active", 0),
        "7700000008": ("active", 0),
        "7700000009": ("active", 0),
        "7700000010": ("active", 2),
    }
    status, overdue = examples.get(str(tax_id), ("unknown", None))
    return {
        "registry_status": status,
        "overdue_days": overdue,
        "source": "local_synthetic",
    }


def mock_credit_report(tax_id):
    """Синтетический отчёт БКИ: обязательства совпадают с тестовыми клиентами."""
    reports = {
        "7700000001": (1, 1_200_000, 50_000, 0),
        "7700000002": (2, 780_000, 42_000, 7),
        "7700000003": (3, 2_400_000, 110_000, 60),
        "7700000004": (0, 0, 0, 0),
        "7700000005": (1, 460_000, 24_000, 0),
        "7700000006": (2, 1_100_000, 58_000, 12),
        "7700000007": (1, 320_000, 18_000, 0),
        "7700000008": (0, 0, 0, 0),
        "7700000009": (2, 1_650_000, 76_000, 0),
        "7700000010": (1, 510_000, 29_000, 2),
    }
    active_loans, total_debt, monthly_payment_total, max_overdue_days = reports.get(
        str(tax_id), (0, 0, 0, 0)
    )
    return {
        "active_loans": active_loans,
        "total_debt": total_debt,
        "monthly_payment_total": monthly_payment_total,
        "max_overdue_days": max_overdue_days,
        "source": "local_synthetic_bki",
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
    finance_period = _number(data.get("finance_period_months", 6), "finance_period_months", minimum=1, integer=True)
    if finance_period not in (6, 12):
        raise ValueError("Период финансовых показателей должен быть 6 или 12 месяцев")
    collateral = collateral_terms(data, amount)
    statement_source = data.get("statement_source", "bank_account")
    if statement_source not in {"not_provided", "uploaded", "bank_account"}:
        raise ValueError("Неизвестный источник банковской выписки")
    statement_inflow = _number(data.get("statement_monthly_inflow", revenue), "statement_monthly_inflow")
    statement_min_inflow = _number(data.get("statement_min_monthly_inflow", statement_inflow), "statement_min_monthly_inflow")
    statement_average_balance = _number(data.get("statement_average_balance", 0), "statement_average_balance", minimum=-10**10)
    statement_negative_days = _number(data.get("statement_negative_days", 0), "statement_negative_days", integer=True)
    statement_tax_payments = data.get("statement_tax_payments", True)
    if not isinstance(statement_tax_payments, bool):
        raise ValueError("statement_tax_payments: требуется true или false")
    statement_seasonality = _number(data.get("statement_seasonality", 0), "statement_seasonality")
    statement_top_counterparty_share = _number(
        data.get("statement_top_counterparty_share", 0), "statement_top_counterparty_share"
    )
    if statement_top_counterparty_share > 1:
        raise ValueError("Доля крупнейшего контрагента должна быть от 0 до 1")
    bki_consent = data.get("bki_consent", True)
    if not isinstance(bki_consent, bool):
        raise ValueError("bki_consent: требуется true или false")
    credit_report = checks.get("credit_report") if bki_consent else None
    bki_monthly_payment = _number(
        credit_report.get("monthly_payment_total", 0) if credit_report else 0,
        "bki_monthly_payment",
    )
    effective_existing_payment = max(existing, bki_monthly_payment)
    financial_document_source = data.get("financial_document_source", "bank_report")
    if financial_document_source not in {"not_provided", "uploaded", "bank_report"}:
        raise ValueError("Неизвестный источник финансового документа")
    reported_revenue = _number(
        data.get("reported_revenue_monthly", revenue), "reported_revenue_monthly"
    )
    reported_net_profit = _number(
        data.get("reported_net_profit_monthly", revenue - expenses),
        "reported_net_profit_monthly", minimum=-10**10,
    )
    effective_rate = max(0, product["annual_rate"] - collateral["rate_discount"])
    payment = monthly_payment(amount, effective_rate, term)
    free_cash = revenue - expenses - effective_existing_payment
    coverage = free_cash / payment
    required_coverage = product.get("approval_coverage", 1.5)
    min_business_months = product.get("min_business_months", 12)
    required_collateral = product.get("required_collateral_coverage", 0)
    # Ограничения входных величин проверяет API; защищаем и прямой вызов модуля.
    if not math.isfinite(free_cash) or not math.isfinite(coverage):
        raise ValueError("Финансовые показатели слишком велики")

    points, reasons = 100, []
    if coverage < 1:
        points -= 55
        reasons.append("После указанных расходов денег недостаточно для нового ежемесячного платежа.")
    elif coverage < required_coverage:
        points -= 30
        reasons.append(f"Для выбранного вида финансирования нужен запас не менее {required_coverage:g} ежемесячного платежа.")
    elif coverage < required_coverage + 0.5:
        points -= 10
        reasons.append("Доходов достаточно для платежа, но финансовый запас близок к минимальному.")
    else:
        reasons.append("Доходов достаточно для нового платежа с требуемым финансовым запасом.")
    if age < max(3, min_business_months // 2):
        points -= 30
        reasons.append(f"Для выбранного вида финансирования обычно требуется не менее {min_business_months} месяцев работы.")
    elif age < min_business_months:
        points -= 15
        reasons.append(f"Компания работает меньше рекомендуемых {min_business_months} месяцев, поэтому заявку должен проверить специалист.")
    if required_collateral and collateral["coverage"] < required_collateral:
        points -= 15
        reasons.append(
            f"Для выбранного вида финансирования обычно нужно обеспечение не менее "
            f"{required_collateral * 100:.0f}% суммы после банковской оценки."
        )
    elif collateral["coverage"] >= 0.4:
        reasons.append("Указанное обеспечение снижает риск сделки и ориентировочную ставку.")
    statement_revenue_ratio = statement_inflow / revenue if revenue > 0 else 1
    statement_stability = statement_min_inflow / statement_inflow if statement_inflow > 0 else 0
    reported_revenue_ratio = reported_revenue / revenue if revenue > 0 else 1
    if statement_source == "not_provided":
        points -= 10
        reasons.append("Для подтверждения оборотов нужна банковская выписка за выбранный период.")
    else:
        if statement_revenue_ratio < 0.6:
            points -= 30
            reasons.append("Поступления по выписке заметно ниже выручки, указанной в заявке.")
        elif statement_revenue_ratio < 0.8:
            points -= 15
            reasons.append("Поступления по выписке ниже выручки, указанной в заявке; специалисту нужно сверить источники дохода.")
        else:
            reasons.append("Поступления по выписке подтверждают основную часть указанной выручки.")
        if statement_stability < 0.35:
            points -= 15
            reasons.append("Поступления по месяцам сильно меняются; важно пояснить сезонность или крупные разовые оплаты.")
        if statement_negative_days > 15:
            points -= 15
            reasons.append("По выписке счёт часто уходил в минус или использовался овердрафт.")
        elif statement_negative_days > 5:
            points -= 5
            reasons.append("По выписке были отдельные дни с отрицательным остатком.")
        if not statement_tax_payments:
            points -= 5
            reasons.append("В выписке не найдены регулярные налоговые платежи; специалисту потребуется подтверждение из другого счёта.")
        if statement_seasonality > 0.5:
            points -= 15
            reasons.append("Обороты по выписке сильно зависят от сезона; платёж нужно проверить на слабых месяцах.")
        elif statement_seasonality > 0.3:
            points -= 5
            reasons.append("По выписке заметна сезонность поступлений.")
        if statement_top_counterparty_share > 0.6:
            points -= 15
            reasons.append("Больше 60% поступлений зависит от одного контрагента.")
        elif statement_top_counterparty_share > 0.4:
            points -= 5
            reasons.append("Значительная часть поступлений зависит от одного контрагента.")
    if not bki_consent:
        points -= 10
        reasons.append("Для проверки действующих обязательств нужно согласие на получение кредитного отчёта.")
    elif credit_report:
        if bki_monthly_payment > existing * 1.1 + 1:
            points -= 10
            reasons.append("В кредитном отчёте ежемесячные платежи выше суммы, указанной в заявке.")
        else:
            reasons.append("Действующие кредитные обязательства сверены с кредитным отчётом.")
    if financial_document_source == "not_provided":
        points -= 10
        reasons.append("Для подтверждения выручки нужна бухгалтерская отчётность или налоговая декларация.")
    else:
        if reported_revenue_ratio < 0.6:
            points -= 30
            reasons.append("Выручка в финансовом документе заметно ниже суммы, указанной в заявке.")
        elif reported_revenue_ratio < 0.8:
            points -= 15
            reasons.append("Выручка в финансовом документе ниже суммы, указанной в заявке.")
        else:
            reasons.append("Финансовый документ подтверждает основную часть заявленной выручки.")
        if reported_net_profit < 0:
            points -= 20
            reasons.append("В предоставленном финансовом документе отражён убыток.")

    registry = checks.get("registry_status", "unknown")
    overdue = checks.get("overdue_days")
    if registry == "inactive":
        points -= 55
        reasons.append("По указанным данным компания сейчас не ведёт деятельность.")
    elif registry != "active":
        points -= 20
        reasons.append("Не удалось подтвердить текущий статус компании.")
    if overdue is None:
        points -= 15
        reasons.append("Не удалось получить сведения о действующих просрочках.")
    else:
        overdue = _number(overdue, "overdue_days", integer=True)
        if overdue >= 30:
            points -= 50
            reasons.append("Есть просрочка по действующим обязательствам от 30 дней.")
        elif overdue > 0:
            points -= 20
            reasons.append("Есть действующая просрочка по обязательствам.")

    points = max(0, min(100, points))
    return {
        "score": points,
        "risk": "low" if points >= 75 else "medium" if points >= 45 else "high",
        "reasons": reasons,
        "features": {
            "free_cash_flow": round(free_cash, 2),
            "payment_coverage": round(coverage, 4),
            "dscr": round(coverage, 4),
            "declared_existing_payment": existing,
            "effective_existing_payment": effective_existing_payment,
            "business_months": age,
            # Отдельный флаг сохраняет точность у границ кредитной политики.
            "covers_payment": coverage >= 1,
            "has_approval_buffer": coverage >= required_coverage,
            "required_coverage": required_coverage,
            "meets_business_age": age >= min_business_months,
            "finance_period_months": finance_period,
            "collateral_type": collateral["type"],
            "collateral_eligible_value": collateral["eligible_value"],
            "collateral_coverage": collateral["coverage"],
            "required_collateral_coverage": required_collateral,
            "has_required_collateral": collateral["coverage"] >= required_collateral,
            "base_annual_rate": product["annual_rate"],
            "effective_annual_rate": effective_rate,
            "rate_discount": collateral["rate_discount"],
            "statement_source": statement_source,
            "statement_monthly_inflow": statement_inflow,
            "statement_min_monthly_inflow": statement_min_inflow,
            "statement_average_balance": statement_average_balance,
            "statement_negative_days": statement_negative_days,
            "statement_tax_payments": statement_tax_payments,
            "statement_revenue_ratio": round(statement_revenue_ratio, 4),
            "statement_stability": round(statement_stability, 4),
            "statement_seasonality": round(statement_seasonality, 4),
            "statement_top_counterparty_share": round(statement_top_counterparty_share, 4),
            "bki_consent": bki_consent,
            "credit_report": credit_report,
            "financial_document_source": financial_document_source,
            "reported_revenue_monthly": reported_revenue,
            "reported_net_profit_monthly": reported_net_profit,
            "reported_revenue_ratio": round(reported_revenue_ratio, 4),
        },
        "monthly_payment": payment,
        "version": VERSION,
    }


def decide(data, checks, score):
    """Детерминированная политика поверх результата score_application."""
    features = score["features"]
    product = next(p for p in PRODUCTS if p["id"] == data["product_id"])
    reject_reasons = []
    if checks.get("registry_status") == "inactive":
        reject_reasons.append("По указанным данным компания сейчас не ведёт деятельность.")
    if checks.get("overdue_days") is not None and checks["overdue_days"] >= 30:
        reject_reasons.append("Есть просрочка по действующим обязательствам от 30 дней.")
    if not features["covers_payment"]:
        reject_reasons.append("После указанных расходов денег недостаточно для нового ежемесячного платежа.")
    if score["score"] < 45:
        reject_reasons.append("Совокупность указанных данных не позволяет одобрить заявку.")
    if reject_reasons:
        return {"status": "rejected", "reasons": reject_reasons, "offer": None}

    review_reasons = []
    if checks.get("registry_status") != "active":
        review_reasons.append("Нужно подтвердить статус компании.")
    if checks.get("overdue_days") is None:
        review_reasons.append("Нужно получить сведения о просрочке.")
    elif checks["overdue_days"] > 0:
        review_reasons.append("Специалисту нужно уточнить обстоятельства просрочки.")
    if not features["meets_business_age"]:
        review_reasons.append(f"Для продукта «{product['name']}» требуется более длительная история бизнеса.")
    if not features["has_approval_buffer"]:
        review_reasons.append(f"Для продукта «{product['name']}» нужен больший запас средств после расходов.")
    if not features["has_required_collateral"]:
        review_reasons.append(f"Для продукта «{product['name']}» нужно подтвердить достаточное обеспечение.")
    if product.get("manual_review"):
        review_reasons.append(f"Условия продукта «{product['name']}» проверяются специалистом банка.")
    if features["statement_source"] == "not_provided":
        review_reasons.append("Нужно получить банковскую выписку для подтверждения оборотов.")
    elif features["statement_revenue_ratio"] < 0.8:
        review_reasons.append("Нужно сверить выручку в заявке с поступлениями по банковской выписке.")
    if features["statement_stability"] < 0.35 and features["statement_source"] != "not_provided":
        review_reasons.append("Нужно проверить сезонность и стабильность поступлений по счёту.")
    if features["statement_negative_days"] > 15:
        review_reasons.append("Нужно выяснить причины частого отрицательного остатка по счёту.")
    if features["statement_seasonality"] > 0.5:
        review_reasons.append("Нужно проверить способность обслуживать долг в месяцы сезонного снижения оборотов.")
    if features["statement_top_counterparty_share"] > 0.6:
        review_reasons.append("Нужно оценить зависимость бизнеса от крупнейшего плательщика.")
    if not features["bki_consent"]:
        review_reasons.append("Нужно получить согласие на запрос кредитного отчёта.")
    elif features["credit_report"] and features["effective_existing_payment"] > features["declared_existing_payment"] * 1.1 + 1:
        review_reasons.append("Нужно уточнить платежи по обязательствам, найденным в кредитном отчёте.")
    if features["financial_document_source"] == "not_provided":
        review_reasons.append("Нужно получить бухгалтерскую отчётность или налоговую декларацию.")
    elif features["reported_revenue_ratio"] < 0.8:
        review_reasons.append("Нужно сверить заявленную выручку с финансовой отчётностью.")
    if features["reported_net_profit_monthly"] < 0:
        review_reasons.append("Нужно понять причины убытка и источник погашения кредита.")
    if score["score"] < 75:
        review_reasons.append("Совокупность указанных данных требует дополнительной проверки специалистом.")
    if review_reasons:
        return {"status": "manual_review", "reasons": review_reasons, "offer": None}

    return {
        "status": "approved",
        "reasons": ["Финансовые показатели соответствуют условиям автоматического одобрения."],
        "offer": {
            "amount": float(data["amount"]), "term_months": int(data["term_months"]),
            "annual_rate": features["effective_annual_rate"],
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
    rate = score["features"]["effective_annual_rate"] / 1200
    candidates = []
    for term in range(int(data["term_months"]), product["max_term"] + 1):
        factor = rate / -math.expm1(-term * math.log1p(rate)) if rate else 1 / term
        # Второй запас позволяет преодолеть следующий порог индекса правил.
        required_coverage = product.get("approval_coverage", 1.5)
        for coverage in (required_coverage, required_coverage + 0.5):
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
                        "При этих параметрах после расходов остаётся достаточный запас для платежа. "
                        "Исходная заявка не изменена."
                    ),
                })
    # Сначала лучший статус, затем наибольшая сумма и самый короткий срок.
    return max(candidates, key=lambda c: (c["status"] == "approved", c["amount"], -c["term_months"]), default=None)


def suggest_products(data, checks, decision, limit=3):
    """Ищет другие продукты для тех же финансов без обещания банковского одобрения."""
    if decision["status"] not in {"rejected", "manual_review"} or checks.get("registry_status") != "active":
        return []
    overdue = checks.get("overdue_days")
    if overdue is None or overdue >= 30:
        return []
    suggestions = []
    for product in PRODUCTS:
        if product["id"] == data.get("product_id"):
            continue
        candidate = {
            **data,
            "product_id": product["id"],
            "amount": min(product["max_amount"], max(product["min_amount"], float(data["amount"]))),
            "term_months": min(product["max_term"], max(product["min_term"], int(data["term_months"]))),
        }
        try:
            score = score_application(candidate, checks)
            candidate_decision = decide(candidate, checks, score)
        except ValueError:
            continue
        if candidate_decision["status"] == "rejected":
            continue
        if decision["status"] == "manual_review" and candidate_decision["status"] != "approved":
            continue
        suggestions.append({
            "product_id": product["id"],
            "name": product["name"],
            "description": product["description"],
            "status": candidate_decision["status"],
            "amount": candidate["amount"],
            "term_months": candidate["term_months"],
            "annual_rate": score["features"]["effective_annual_rate"],
            "monthly_payment": score["monthly_payment"],
        })
    suggestions.sort(key=lambda item: (item["status"] != "approved", item["monthly_payment"], item["annual_rate"]))
    return suggestions[:limit]
