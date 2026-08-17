# zaraa friend package — Windows validation mirror

Minimal public mirror holding the sanitized zaraa friend-package artifact and
its validation tooling, so the Windows clean-install validation can run on
free public-repo Actions runners. No application source code lives here.

- `dist/friend-package/` — the built, sanitizer-gated share artifact (RC bytes + platform reports)
- `scripts/` — the clean-install validators + package verifier (validation tooling only)
- `.github/workflows/windows-validation.yml` — Windows-only validation job

After a green run:

```
gh run download <run-id> -n validation-Windows -D dist/friend-package
node scripts/friend-package-verify.mjs
```

back in the main repo flips `safeToShare` once all three platform reports match
the package's `generatedAt`.
