# Legacy econometrics regression oracle

These frozen TypeScript method implementations were moved from commit `ffcd4e09` into test-only fixtures. Existing regression and cross-check tests compare current behavior with this historical implementation. Production code does not import this directory.

Relative imports to current Core runtime helpers were adjusted only to preserve module resolution from this fixture location. The old OLS Python runner is kept under `python/ols/` for backend regression tests.
