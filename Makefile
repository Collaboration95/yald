.DEFAULT_GOAL := help

.PHONY: help install run dev test lint typecheck build smoke screenshots package check

help: ## Show common development commands
	@printf '%s\n' \
	  'make install      Install workspace dependencies' \
	  'make run          Build and run yald at http://127.0.0.1:4318' \
	  'make dev          Run the API and Vite development server' \
	  'make test         Run unit and API tests' \
	  'make lint         Run Oxlint' \
	  'make typecheck    Typecheck web and server' \
	  'make build        Build the web app' \
	  'make smoke        Render all pages with synthetic fixtures' \
	  'make screenshots  Regenerate README and social screenshots' \
	  'make package      Create the npm tarball' \
	  'make check        Run typecheck, lint, test, build, and smoke'

install: ## Install workspace dependencies
	scripts/bun install

run: ## Build and run yald
	./scripts/serve.sh

dev: ## Run the API and Vite development server
	./scripts/dev.sh

test: ## Run unit and API tests
	scripts/bun test

lint: ## Run Oxlint
	scripts/bun run lint

typecheck: ## Typecheck web and server
	scripts/bun run typecheck

build: ## Build the web app
	scripts/bun run build

smoke: ## Render all pages with synthetic fixtures
	scripts/bun run smoke -- --fixtures

screenshots: ## Regenerate screenshots (requires Chrome or Chromium)
	./scripts/screenshots.sh

package: ## Create the npm tarball
	npm pack

check: typecheck lint test build smoke ## Run the local CI verification steps
