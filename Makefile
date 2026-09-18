.PHONY: help check test apply verify rollback

# Prefer Bun when it is available; otherwise use npm.
PACKAGE_RUNNER := $(shell if command -v bun >/dev/null 2>&1; then echo bun; else echo npm; fi)
RUN = $(PACKAGE_RUNNER) run

help:
	@echo "Package runner: $(PACKAGE_RUNNER)"
	@echo "Targets: check test apply verify rollback"
	@echo "apply and rollback modify the ZCode installation file only; no process operations."

check:
	$(RUN) check

test:
	$(RUN) test

apply:
	$(RUN) apply

verify:
	$(RUN) verify

rollback:
	$(RUN) rollback
