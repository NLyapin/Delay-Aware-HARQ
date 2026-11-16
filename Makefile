.PHONY: setup start serve test study
setup:
	uv sync --python 3.12 --extra dev
	npm ci
start:
	npm start
serve:
	uv run harq-lab serve
test:
	uv run pytest -q
	uv run ruff check harq_lab tests
	npm run check
	npm run test:ui
study:
	sh scripts/run-study.sh
