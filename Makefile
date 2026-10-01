# Stitchbook monorepo tasks. Run `make setup` once, then the others.
-include .env
export

PYTHON   ?= python3
VENV     := .venv
BIN      := $(VENV)/bin
# Empty in .env counts as not set.
API_PORT := $(or $(API_PORT),8000)
WEB_PORT := $(or $(WEB_PORT),8080)

.PHONY: setup test api worker web

setup: ## Create the virtualenv, install the Python packages and web tooling
	$(PYTHON) -m venv $(VENV)
	$(BIN)/pip install --upgrade pip
	$(BIN)/pip install -e ./digitizer -e ./api -e ./worker pytest httpx
	npm --prefix web install

test: ## Python tests + web colour-token lint (an empty Python suite counts as a pass)
	@$(BIN)/pytest; status=$$?; \
	if [ $$status -eq 5 ]; then echo "pytest: no tests collected yet (empty suite)"; \
	elif [ $$status -ne 0 ]; then exit $$status; fi
	npm --prefix web run -s check:tokens

api: ## FastAPI dev server with reload
	$(BIN)/uvicorn stitchbook_api.main:app --reload --port $(API_PORT)

worker: ## RQ worker on $$RQ_QUEUE (needs Redis running at $$REDIS_URL)
	$(BIN)/python -m stitchbook_worker.main

web: ## Vite dev server for the React front end
	npm --prefix web run dev -- --port $(WEB_PORT)
