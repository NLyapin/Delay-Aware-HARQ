# Сборка HARQ Lab

## Требования

Установите Node.js 22+, npm, uv и Python 3.12. Получите исходный код проекта и выполните:

```sh
uv sync --python 3.12 --extra dev --locked
npm ci
```

Для нативного установщика используйте соответствующую ОС. Python-движок упаковывается для ОС и архитектуры сборочного окружения; установка целевой архитектуры Electron не превращает Python-библиотеки в кроссплатформенные бинарные файлы.

На macOS требуются Xcode Command Line Tools. На Windows нужны доступные в PATH Python, uv и Node.js. На Linux используйте совместимый с целевыми машинами дистрибутив: требования бинарных зависимостей, включая glibc, определяются средой сборки.

## Оболочка с внешним Python

```sh
npm run dist
```

Результат находится в `desktop/dist/`. Эта сборка содержит интерфейс и исходники, но не Python. Перед запуском укажите `HARQ_PYTHON`: абсолютный путь к интерпретатору с установленными зависимостями и проектом `harq-lab`.

Пример для macOS с ARM64, выполняемый из корня исходного проекта:

```sh
HARQ_PYTHON="$PWD/.venv/bin/python" "desktop/dist/mac-arm64/HARQ Lab.app/Contents/MacOS/HARQ Lab"
```

Для других ОС/архитектур путь к исполняемому файлу отличается. В Windows интерпретатор виртуального окружения находится в `.venv\Scripts\python.exe`.

## Автономная сборка со встроенным Python

Ниже приведён ручной процесс: он не требует локального скрипта публикации, который намеренно не включён в репозиторий. Все команды выполняются из корня проекта на целевой ОС.

### 1. Подготовка точки входа

Создайте каталог `.local/build/` и файл `.local/build/backend.py`:

```python
import multiprocessing
from harq_lab.cli import main

if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
```

### 2. Упаковка движка

Выполните команду одной строкой:

```sh
uv run --locked --with pyinstaller==6.22.3 pyinstaller --noconfirm --clean --onedir --name harq-backend --paths . --distpath .local/build/runtime --workpath .local/build/work --specpath .local/build --collect-submodules harq_lab --collect-submodules uvicorn .local/build/backend.py
```

В `.local/build/runtime/harq-backend/` появятся исполняемый файл и каталог его зависимостей. Копировать нужно всю папку, а не только исполняемый файл.

Проверьте запуск:

```sh
# macOS / Linux
.local/build/runtime/harq-backend/harq-backend --help
.local/build/runtime/harq-backend/harq-backend serve --port 8765
```

На Windows используйте `.local\build\runtime\harq-backend\harq-backend.exe`. Откройте `http://127.0.0.1:8765/api/health`, проверьте ответ `status: ok` и остановите сервер перед продолжением. Эта проверка подтверждает работу движка; интерфейс проверяется после упаковки Electron.

### 3. Конфигурация Electron

Создайте `.local/build/electron-builder.json`:

```json
{
  "appId": "research.harq.lab",
  "productName": "HARQ Lab",
  "asar": false,
  "directories": { "output": "desktop/dist/standalone" },
  "artifactName": "HARQ-Lab-${version}-${os}-${arch}.${ext}",
  "files": [
    "desktop/**/*",
    "!desktop/dist/**",
    "harq_lab/**/*",
    "pyproject.toml",
    "uv.lock",
    "package.json",
    "!**/__pycache__/**",
    "!**/*.pyc",
    "!**/.local/**"
  ],
  "extraResources": [
    { "from": ".local/build/runtime/harq-backend", "to": "backend" }
  ],
  "mac": {
    "category": "public.app-category.education",
    "icon": "desktop/assets/icon.icns",
    "target": ["dmg", "zip"]
  },
  "win": {
    "icon": "desktop/assets/icon.ico",
    "target": ["nsis", "zip"]
  },
  "linux": {
    "icon": "desktop/assets/icon.png",
    "target": ["AppImage", "tar.gz"]
  }
}
```

### 4. Сборка на целевой ОС

Выберите только команду для текущей системы и добавьте `--x64` либо `--arm64` в соответствии с архитектурой упакованного Python-движка:

```sh
# macOS
npx --no-install electron-builder --config .local/build/electron-builder.json --mac --publish never

# Windows
npx --no-install electron-builder --config .local/build/electron-builder.json --win --publish never

# Linux
npx --no-install electron-builder --config .local/build/electron-builder.json --linux --publish never
```

Результаты сохраняются в `desktop/dist/standalone/`. Electron ищет встроенный движок в `resources/backend/harq-backend` (`harq-backend.exe` на Windows). Переменная `HARQ_PYTHON` переопределяет его: для проверки автономности уберите её из окружения и запустите упакованное приложение, выполните сравнение и проверьте экспорт результатов.

Нативные библиотеки радиодрайверов не входят в этот процесс. Для PlutoSDR дополнительно нужны аппаратные зависимости и драйверы из [HARDWARE.md](HARDWARE.md). Наличие программного I/Q-режима не подтверждает работоспособность RF-тракта.

## Иконки

Готовые PNG, ICO и ICNS находятся в `desktop/assets/`. Их не требуется пересоздавать при каждой сборке. При изменении знака:

```sh
npx playwright install chromium
npm run build:icons
```

На macOS генератор получает точный знак из HTML/CSS интерфейса; на остальных ОС использует сохранённый `brandmark.png`. Для установленного браузера можно задать `PLAYWRIGHT_CHROMIUM_EXECUTABLE`. Скругляется только иконка приложения, не знак в интерфейсе.

## Публикация релизов через GitHub Actions

Workflow [release.yml](../.github/workflows/release.yml) собирает четыре нативные цели:

| Цель | Runner | Дистрибутивы |
|---|---|---|
| Windows x64 | `windows-2022` | EXE, ZIP |
| Linux x64 | `ubuntu-24.04` | AppImage, tar.gz |
| macOS ARM64 | `macos-15` | DMG, ZIP |
| macOS Intel x64 | `macos-15-intel` | DMG, ZIP |

Сначала выполняются проверки Python и интерфейса. Каждый сборочный узел упаковывает свой
Python runtime, проверяет его архитектуру, API и CPU-модем. Только после успеха всех четырёх
целей отдельное задание проверяет манифесты и SHA-256, загружает файлы в черновик и публикует
релиз. Ошибка одной цели блокирует публикацию; `fail-fast: false` сохраняет диагностику остальных.

Workflow запускается через **Actions → Release HARQ Lab → Run workflow**. Укажите полный
40-символьный `source_commit`, тег `v<версия package.json>` и уникальный `request_id`.
Версии `package.json` и `pyproject.toml` должны совпадать. `publish = true` публикует релиз
автоматически; `publish = false` оставляет черновик, `build_only = true` сохраняет только артефакты.
Исходники всегда берутся из указанного commit. Workflow должен быть доступен в основной ветке.

Локальный запуск одной командой, очистка `desktop/dist/`, наблюдение и скачивание реализованы
в `.local/release.py`; этот скрипт намеренно не включён в репозиторий. Его `ship` / `all` выполняет
полный цикл и публикует релиз по умолчанию. Конфигурация SSH больше не требуется.

При повторной публикации публичный релиз не перезаписывается: увеличьте версию и обновите
lockfiles. Черновик соответствующего commit может быть дополнен при повторном запуске.
Релизы в GitHub и исходные данные экспериментов очистка локальных сборок не удаляет.

Для распространения подписанных сборок настройте сертификаты подписи и нотариализацию
в своей сборочной среде. Упаковка и публикация сами по себе не подписывают приложение
и не подтверждают его аппаратную совместимость. RF-драйверы устанавливаются отдельно.
