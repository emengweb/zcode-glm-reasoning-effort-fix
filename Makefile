.PHONY: help check test apply verify rollback

# Test for Bun inside each recipe. This avoids environment variables overriding
# a Make variable and accidentally leaving GNU Make with only "run <script>".
help:
	@echo "Package runner: Bun when available, otherwise npm"
	@echo "Targets: check test apply verify rollback"
	@echo "apply and rollback modify the ZCode installation file only; no process operations."

check:
	@if command -v bun >/dev/null 2>&1; then bun run check; else npm run check; fi

test:
	@if command -v bun >/dev/null 2>&1; then bun run test; else npm test; fi

apply:
	@if command -v bun >/dev/null 2>&1; then bun run apply; else npm run apply; fi

verify:
	@if command -v bun >/dev/null 2>&1; then bun run verify; else npm run verify; fi

rollback:
	@if command -v bun >/dev/null 2>&1; then bun run rollback; else npm run rollback; fi
