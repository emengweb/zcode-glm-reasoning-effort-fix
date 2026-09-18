.PHONY: help check test apply verify rollback

help:
	@echo Targets: check test apply verify rollback
	@echo Bun is preferred when available; otherwise npm is used.

# Keep shell-specific conditionals out of recipes: supports cmd.exe and sh.
check test apply verify rollback:
	node run-package.mjs $@
