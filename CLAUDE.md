# Project Guidelines & Assistant Rules

## General Context
- This repository contains source code and related project documentation.
- Context and reference materials reside in the `info/` directory.

## Rules for `info/` Directory
- Read and consult files inside `info/` for specifications and architecture.
- DO NOT MODIFY OR DELETE existing content in `info/`.
- Append new sections or add new files only when explicitly requested.

## Code Standards
- Maintain clean, modular, and secure code.
- Explain diffs and confirm before applying changes.

## Working Rules (agreed with the author)

### Communication
- Reply in Greek, short and concrete (tools and actions first, no long theory), in simple everyday language.
- When asked a question, give an opinion first and act only when told. Nothing is done without approval.

### Change log
- Before every change, append a dated "Step N: ... (dd/mm/yyyy HH:MM)" section to the END of `info/08-workflow.docx`,
  and its result after the change. Update `info/09-to-do.docx` and `info/10-Rules-Application.docx` where relevant.
- The `.docx` files in `info/` are plain UTF-8 text with CRLF line endings: append only, never rewrite or delete.
  Never delete or rename files in `info/`; only the author does that.

### Git
- Work on a branch and merge `--no-ff` into `main`, only when asked.
- NEVER push. The author pushes (`git -c http.sslBackend=schannel push origin main`).
- The repository is public: scan for secrets before every commit. No passwords, IPs or personal data in tracked files.
- Never commit: `info/07-*`, `info/08-workflow.docx`, `info/Thesis-Report/University-Prototypes/`.
- Commit messages end with the Co-Authored-By line of the assistant.

### Code
- Security and compliance code goes only in `compliance-engine/`, never in `manager/`.
- Present a plan and get approval before writing engine code.
- No helper or build files in the repository; use a temporary scratchpad outside it.

### Compliance rules
- For every rule: analysis, implementation and tests in `info/10-Rules-Application.docx` (as done for A.8.9),
  and a detailed explanation in `info/11-needtoknow.docx` (why it works, where the code is, likely examiner questions).

### Thesis
- Write only into `info/Thesis-Report/001-Draft.docx` (English). Do not touch other `info/` files for the thesis.
- Include every relevant detail of what was done, in depth, as a deliverable; the thesis must be self-contained
  and must not refer to internal `info/` files.
- Plain, simple style, as if written by the author; no generic, inflated "AI" wording.
- Only real, implemented and tested facts. Never invent results, statistics or references.
  Mark gaps with [TODO: ...], [SCREENSHOT: ...], [FIGURE: ...], [CITATION NEEDED: ...].
- Every new rule, test or change to the system is also added to the draft.
- Additions must read as a natural continuation of the existing text: integrate them into the right section,
  keep the flow, numbering and cross-references consistent, and avoid repeating what is already said.
