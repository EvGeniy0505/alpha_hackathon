FROM python:3.12.10-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOST=0.0.0.0 PORT=8000 DB_PATH=/app/runtime/credit.db
WORKDIR /app
RUN groupadd -g 10001 app && useradd -u 10001 -g app app && mkdir /app/runtime && chown app:app /app/runtime
COPY --chown=app:app server.py scoring.py ./
COPY --chown=app:app static ./static
COPY --chown=app:app data ./data
COPY --chown=app:app docs ./docs
USER app
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2)"
CMD ["python", "server.py"]
