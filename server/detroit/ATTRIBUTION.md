# Attribution and license scope

Based on **Joey Zhang / Detroit AI Player**:
https://github.com/Baba88611/detroit-ai-player

Upstream archive downloaded on 2026-09-07. `vendor/engine/state.py` and `resolver.py`
retain the original engine files without modification. `player_helpers.py` contains
the runner and campaign helper functions extracted without behavioral changes
(MIT, see `licenses/upstream-MIT.txt`).
`vendor/story/` retains all 32 Chinese and 32 English decision-tree files without
modification (CC BY-NC 4.0, see `licenses/CC-BY-NC-4.0.txt`).

This adaptation adds resumable MCP tools, private access, SQLite saves, retry
handling and deployment packaging. The adapter also handles QTE branches with
nested result objects and state_update assignments, which the upstream runner
does not fully handle. Decisions are made by the connected assistant
in the user's current conversation. No model API backend is invoked. This is a
personal play adaptation, not the upstream isolated research experiment.

Story data is for non-commercial use. This project contains no official game
executable, media or assets. Original game rights remain with their respective
owners. The upstream disclaimer is preserved in `licenses/DISCLAIMER.md`.
