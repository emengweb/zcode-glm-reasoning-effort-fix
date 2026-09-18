.PHONY: help check test apply verify rollback

help:
	@echo "Targets: check test apply verify rollback"
	@echo "apply and rollback modify the ZCode installation file only; no process operations."

check:
	npm run check

test:
	npm test

apply:
	npm run apply

verify:
	npm run verify

rollback:
	npm run rollback
