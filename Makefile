.DEFAULT_GOAL := help

.PHONY: help install hooks run dev test test-fast lint typecheck build smoke screenshots package check check-fast

help: ## Show common development commands
	@printf '%s\n' \
	  'make install      Install workspace dependencies and Git hooks' \
	  'make hooks        Install Git hooks in an existing checkout' \
	  'make run          Build and run yald at http://127.0.0.1:4318' \
	  'make dev          Run the API and Vite development server' \
	  'make test         Run unit and API tests' \
	  'make test-fast    Run quick unit and API tests, stopping on failure' \
	  'make lint         Run Oxlint' \
	  'make typecheck    Typecheck web and server' \
	  'make build        Build the web app' \
	  'make smoke        Render all pages with synthetic fixtures' \
	  'make screenshots  Regenerate README and social screenshots' \
	  'make package      Create the npm tarball' \
	  'make check        Run typecheck, lint, test, build, and smoke' \
	  'make check-fast   Run the pre-commit lint and quick test checks'

install: ## Install workspace dependencies
	scripts/bun install
	bash scripts/install-hooks.sh

hooks: ## Install Git hooks in an existing checkout
	bash scripts/install-hooks.sh

run: ## Build and run yald
	./scripts/serve.sh

dev: ## Run the API and Vite development server
	./scripts/dev.sh

test: ## Run unit and API tests
	scripts/bun test

test-fast: ## Run quick unit and API tests
	scripts/bun run test:fast

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

check-fast: ## Run the pre-commit lint and quick test checks
	scripts/bun run check:fast
