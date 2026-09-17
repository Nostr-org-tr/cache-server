SHELL := /bin/bash
.SHELLFLAGS := -e -o pipefail -c
NVM_EXEC := [ -s "$$HOME/.nvm/nvm.sh" ] && . "$$HOME/.nvm/nvm.sh" && nvm use

.PHONY: all install dev build test test-watch bench lint db-create db-migrate-local db-migrate-remote deploy tail verify-live clean version-check version-bump version-patch version-minor version-major version-set

all: lint test build

install:
	@$(NVM_EXEC) && npm install

dev:
	@$(NVM_EXEC) && npm run dev

build:
	@$(NVM_EXEC) && npm run build

test:
	@$(NVM_EXEC) && npm run test

test-watch:
	@$(NVM_EXEC) && npm run test:watch

bench:
	@$(NVM_EXEC) && npm run bench

lint:
	@$(NVM_EXEC) && npm run lint

version-check:
	@$(NVM_EXEC) && npm run version:check

version-bump:
	@$(NVM_EXEC) && npm run version:bump

version-patch:
	@$(NVM_EXEC) && npm run version:patch

version-minor:
	@$(NVM_EXEC) && npm run version:minor

version-major:
	@$(NVM_EXEC) && npm run version:major

version-set:
	@$(NVM_EXEC) && npm run version:set -- $(VERSION)

db-create:
	@$(NVM_EXEC) && npm run db:create

db-migrate-local:
	@$(NVM_EXEC) && npm run db:migrate:local

db-migrate-remote:
	@$(NVM_EXEC) && npm run db:migrate:remote

deploy:
	@$(NVM_EXEC) && npm run deploy

tail:
	@$(NVM_EXEC) && npm run tail

verify-live:
	@$(NVM_EXEC) && npm run verify:live -- $(ARGS)

clean:
	rm -rf dist .wrangler .mf coverage
