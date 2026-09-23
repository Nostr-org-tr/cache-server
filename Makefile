SHELL := /bin/bash
.SHELLFLAGS := -e -o pipefail -c
NVM_EXEC := if [ -s "$$HOME/.nvm/nvm.sh" ]; then . "$$HOME/.nvm/nvm.sh"; fi; \
	NVMRC_VER=$$(cat .nvmrc 2>/dev/null | tr -d 'v \r\n'); \
	ACTIVE_VER=$$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'); \
	if [ -n "$$NVMRC_VER" ] && [ "$$ACTIVE_VER" = "$$NVMRC_VER" ]; then \
		true; \
	elif command -v nvm >/dev/null 2>&1; then \
		nvm use || nvm install; \
	fi

.PHONY: all install dev build build-css build-chartjs test test-watch bench lint db-create db-migrate-local db-migrate-remote cache-prune-all cache-prune-moderated cache-prune-gc cache-prune-dry-run cache-prune-local-all cache-prune-local-moderated cache-prune-local-gc cache-prune-local-dry-run cache-prune-remote cache-prune-remote-all cache-prune-remote-moderated cache-prune-remote-gc cache-prune-remote-dry-run deploy tail verify-live gallery clean version-check version-bump version-patch version-minor version-major version-set

all: lint test build

install:
	@$(NVM_EXEC) && npm install

build-css:
	@$(NVM_EXEC) && npm run build:css

build-chartjs:
	@$(NVM_EXEC) && npm run build:chartjs

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

cache-prune-all:
	@$(NVM_EXEC) && npm run cache:prune:local:all

cache-prune-moderated:
	@$(NVM_EXEC) && npm run cache:prune:local:moderated

cache-prune-gc:
	@$(NVM_EXEC) && npm run cache:prune:local:gc

cache-prune-dry-run:
	@$(NVM_EXEC) && npm run cache:prune:local:dry

cache-prune-local-all:
	@$(NVM_EXEC) && npm run cache:prune:local:all

cache-prune-local-moderated:
	@$(NVM_EXEC) && npm run cache:prune:local:moderated

cache-prune-local-gc:
	@$(NVM_EXEC) && npm run cache:prune:local:gc

cache-prune-local-dry-run:
	@$(NVM_EXEC) && npm run cache:prune:local:dry

cache-prune-remote:
	@$(NVM_EXEC) && npm run cache:prune:remote

cache-prune-remote-all:
	@$(NVM_EXEC) && npm run cache:prune:remote:all

cache-prune-remote-moderated:
	@$(NVM_EXEC) && npm run cache:prune:remote:moderated

cache-prune-remote-gc:
	@$(NVM_EXEC) && npm run cache:prune:remote:gc

cache-prune-remote-dry-run:
	@$(NVM_EXEC) && npm run cache:prune:remote:dry

deploy:
	@$(NVM_EXEC) && npm run deploy

tail:
	@$(NVM_EXEC) && npm run tail

verify-live:
	@$(NVM_EXEC) && npm run verify:live -- $(ARGS)

gallery:
	@$(NVM_EXEC) && npm run gallery -- $(ARGS)

clean:
	rm -rf dist .wrangler .mf coverage
