.PHONY: help check test apply verify rollback snapshot-check snapshot-apply snapshot-verify snapshot-rollback test-snapshot test-snapshot-real

help:
	@echo Targets: check test apply verify rollback
	@echo Snapshot privacy targets: snapshot-check snapshot-apply snapshot-verify snapshot-rollback test-snapshot test-snapshot-real
	@echo Bun is preferred when available; otherwise npm is used.

# Keep shell-specific conditionals out of recipes: supports cmd.exe and sh.
check test apply verify rollback:
	node run-package.mjs $@

# Repo snapshot capture/upload privacy patch (see SNAPSHOT-PRIVACY.md).
snapshot-check:
	node snapshot-patch.mjs check

snapshot-verify:
	node snapshot-patch.mjs verify

test-snapshot:
	node test-snapshot.mjs

test-snapshot-real:
	node tests/test-snapshot-real-copy.mjs

snapshot-apply:
	node snapshot-patch.mjs apply "C:/Program Files/ZCode/resources/app.asar" --confirm

snapshot-rollback:
	node snapshot-patch.mjs rollback "C:/Program Files/ZCode/resources/app.asar" --confirm
