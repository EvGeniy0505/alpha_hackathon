# Публикация демонстрации

Основная версия для сдачи запускается через Docker Compose и сохраняет SQLite
в именованном томе. Публикация по внешней ссылке является дополнительной.

## Render: бесплатная демонстрация через Docker

В корне лежит render.yaml. Он использует существующий Dockerfile, бесплатный
web service, проверку /health и Secure-cookie для внешнего HTTPS.

1. Войдите в свой аккаунт Render.
2. Создайте Blueprint из https://github.com/EvGeniy0505/alpha_hackathon.
3. Выберите ветку main и проверьте, что план Free, без платных дисков и сервисов.
4. Запустите создание. После успешной сборки Render выдаст адрес вида
   https://имя-сервиса.onrender.com. Откройте /health, затем /login.
5. Войдите как client / client-pass; для сотрудника — analyst / analyst-pass.
6. При необходимости добавьте полученный адрес в форму сдачи. До создания
   сервиса внешнего адреса нет; render.yaml сам по себе сайт не публикует.

Ссылка для создания Blueprint:
https://render.com/deploy?repo=https://github.com/EvGeniy0505/alpha_hackathon

Важное ограничение Free: SQLite в /tmp является временной. Заявки и сессии
сбрасываются при перезапуске, новом деплое или остановке по неактивности.
После 15 минут без трафика сервис может засыпать; первый запрос будит его.
Поэтому бесплатный облачный адрес подходит для дополнительного показа,
а воспроизводимая версия с сохранением данных — Docker Compose на обычном ПК.
Для постоянного размещения нужна отдельная долговечная БД или диск;
такая переделка не входит в эту демонстрационную конфигурацию.

Render автоматически передаёт RENDER_EXTERNAL_HOSTNAME. Сервер добавляет
только этот hostname к разрешённым localhost/127.0.0.1, без wildcard.
Для собственного домена добавьте его в ALLOWED_HOSTS, сохранив localhost,127.0.0.1.
HOST=0.0.0.0 и PORT=10000 задаются в Blueprint. Ключи API не нужны.

Официальные ограничения и описание конфигурации:
- https://render.com/docs/free
- https://render.com/docs/blueprint-spec
- https://render.com/docs/environment-variables

## Docker Compose на своём компьютере или сервере

```bash
git clone https://github.com/EvGeniy0505/alpha_hackathon.git
cd alpha_hackathon
docker compose up --build --detach --wait
```

По умолчанию приложение доступно только на http://localhost:8000.
Все параметры можно записать в .env на основе .env.example.
Если 8000 занят, задайте APP_PORT=18080 и откройте http://localhost:18080.
На Linux/macOS можно выполнить APP_PORT=18080 docker compose up --build --detach --wait.
В PowerShell сначала выполните $env:APP_PORT='18080'.

Для сервера за HTTPS reverse proxy оставьте привязку к 127.0.0.1,
задайте ALLOWED_HOSTS=localhost,127.0.0.1,ваш-домен и COOKIE_SECURE=1.
Прокси должен сохранять исходный Host. Настройка домена и сертификата
зависит от выбранного сервера; в бесплатном Render HTTPS предоставляет платформа.

Для открытого HTTP-показа на IP задайте APP_BIND=0.0.0.0 и включите этот IP
в ALLOWED_HOSTS. COOKIE_SECURE при HTTP остаётся 0.
Не используйте реальные данные: учётные записи и кредитные операции демонстрационные.

База остаётся в credit-data при docker compose restart app и docker compose down.
Не выполняйте docker compose down -v, если хотите сохранить заявки.
