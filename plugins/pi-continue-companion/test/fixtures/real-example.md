## Task
Review all recent AMS code in the printer-dashboard repo, write a spec of suggested changes, implement them on a new branch, and push.

## Done When
Spec doc written, all 7 identified bugs fixed on the `fix/ams-code-review-fixes` branch, full test suite passes, and branch is pushed to remote.

## Established
- Frontend `amsHtml()` returns inner content only; `renderCard` wraps it in `.ams-section`; `updateCard` conditionally creates section and toggles display. — evidence: internal/server/onboarding.go:1600-1690; basis: observed; reopen: if onboarding.go frontend functions are edited again
- Frontend `remain` displays meters via `(tray.remain / 1000).toFixed(1) + 'm'`; stray `>` in swatch ternary removed. — evidence: internal/server/onboarding.go:1665; basis: observed; reopen: if onboarding.go color/remain logic is edited
- Go binary available at `/tmp/godist/go` with GOPATH `$HOME/go` in PATH. — evidence: cmd:export GOROOT=/tmp/godist/go; basis: observed; reopen: if Go environment changes or PATH is reset
- Delta-merge fix described in `docs/fix-p1s-ams-loading-spec.md` already committed at HEAD `9d9a97d`. — evidence: cmd:git log --oneline -1; basis: observed; reopen: if HEAD moves backward or spec reverts
- Spec doc `docs/ams-code-review-fixes-spec.md` authored covering 7 remaining issues. — evidence: modified:docs/ams-code-review-fixes-spec.md; basis: doc; reopen: if scope of fixes changes
- Git branch `fix/ams-code-review-fixes` created from main. — evidence: cmd:git branch -a; basis: output; reopen: if branch is deleted or reset
- Dead `isErrorState` function and its test removed from `parser.go` and `parser_test.go`. — evidence: edit:internal/printers/bambu/parser.go; basis: output; reopen: if parser.go is rewritten
- Defensive copies added to `mergeAMSData` and `mergeTrays` in `client.go` when `len(new) == 0`. — evidence: edit:internal/printers/bambu/client.go; basis: output; reopen: if merge logic changes
- Garbled humidity comment in `ams_delta_test.go` corrected to distinguish Unit 0 and Unit 1. — evidence: edit:internal/printers/bambu/ams_delta_test.go:451; basis: output; reopen: if ams_delta_test.go is edited
- Index ordering assertions added to `TestMergeTrays_MatchingUpdated_NonMatchingRetained` and `TestMergeTrays_NewNotInCached_Added`. — evidence: edit:internal/printers/bambu/merge_test.go; basis: output; reopen: if merge tests are rewritten
- `TestParseAMSData` unit test suite inserted into `parser_test.go` with 7 cases. — evidence: edit:internal/printers/bambu/parser_test.go; basis: output; reopen: if parser_test.go is edited

## Learned
- Go multi-line composite literals require exact brace matching; inline short forms like `{{Index: 0}}` compress 4 braces into 2, making it easy to miscount when expanding to multi-line format. — source: session experience: parser_test.go:431 brace mismatch during P1S test case expansion
- When rewriting `updateCard` DOM logic, checking `amsEl.style.display !== 'none'` before setting `innerHTML` prevents redundant injections but doesn't solve the initial `display:none` from server render; conditionally creating the element is safer. — source: session experience: updateCard refactoring in onboarding.go
- Defensive slicing `append([]T(nil), src...)` is the idiomatic Go way to copy a slice and prevent caller alias-mutation of cache slices in merge functions. — source: session experience: client.go mergeAMSData/mergeTrays

## Open
- Syntax error at `parser_test.go:431`: extra closing braces in the final 'P1S style' test case of `TestParseAMSData` cause `expected declaration, found 'for'`. — verifies: Count braces after `Trays: []printers.FilamentSlot{`; replace the excessive `}}}}}` with `}}},` to close Trays slice, AMSUnit struct, and want slice; ensure subsequent `},` and `}` match test case and slice closures.

## Next
- Fix brace mismatch in `parser_test.go` P1S test case (line ~427) and verify syntax. → No compile errors when running `go vet` or `go test` on `parser_test.go`.
- Run `go vet ./internal/printers/bambu/ ./internal/server/` and `go test ./internal/printers/bambu/ -count=1`. → Full test suite passes and vet reports no issues.
- Commit all backend changes on branch `fix/ams-code-review-fixes`. → Git history includes committed fix/ams-code-review-fixes branch.
- Push `fix/ams-code-review-fixes` to remote. → Branch is available on remote for review/CI.
