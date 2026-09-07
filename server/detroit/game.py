"""Resumable, player-facing adapter for Joey Zhang's Detroit AI Player.

The upstream state and resolver modules are unmodified. The synchronous runner
loop is adapted here to pause for an MCP client at every decision.
"""
from __future__ import annotations

import copy
import json
import random
import secrets
import sys
from functools import lru_cache
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "vendor" / "engine"))
from state import apply_effects, initial_state, extract_cross_chapter_state
from resolver import node_condition_met, resolve_context, resolve_post_choice_result, ending_payload
from player_helpers import (
    _resolve_optional_choices, _resolve_mandatory_result, _record_choice_aliases,
    _node_track, _single_ending_id, _pick_primary_ending,
)
from player_helpers import _add_campaign_derived_state, apply_derived_exports, build_chapter_summary


@lru_cache(maxsize=64)
def chapter(language: str, number: int) -> dict:
    paths = sorted((ROOT / "vendor" / "story" / language).glob(f"ch{number:02d}_*.json"))
    if len(paths) != 1:
        raise ValueError("Chapter unavailable")
    return json.loads(paths[0].read_text(encoding="utf-8"))


def chapter_info(data: dict, number: int) -> dict:
    meta = data["chapter"]
    return {"number": number, "title": meta.get("title_zh") or meta.get("title") or meta.get("name") or f"Chapter {number}",
            "protagonist": meta.get("protagonist")}


def new_game(language: str = "zh", difficulty: str = "casual", seed: int | None = None) -> dict:
    if language not in ("zh", "en") or difficulty not in ("casual", "experienced", "hardcore"):
        raise ValueError("Unsupported language or difficulty")
    game = {"language": language, "difficulty": difficulty, "chapter": 1,
            "seed": seed if seed is not None else secrets.randbits(128),
            "cross_state": {}, "summaries": [], "history": [], "revision": 0,
            "phase": "playing", "last_action": None}
    _begin_chapter(game)
    _advance(game)
    return game


def _begin_chapter(game: dict) -> None:
    data = chapter(game["language"], game["chapter"])
    game.update(state=initial_state(data), cursor=0, endings=[], ended_tracks=[], pending=None)
    game["state"].update(copy.deepcopy(game["cross_state"]))
    game["history"].append({"kind": "chapter_start", "chapter": chapter_info(data, game["chapter"]),
                            "role": data["system_prompt"]["content"]})


def _tracks(data: dict) -> set[str]:
    names = data["chapter"].get("protagonist")
    return {str(n).lower() for n in names} if isinstance(names, list) else set()


def _resolve(game: dict, data: dict, node: dict, choice_id: str | None) -> None:
    state = game["state"]
    system = node.get("system", {})
    if choice_id is not None:
        apply_effects(state, system.get("effects", {}).get(choice_id, {}))
        _record_choice_aliases(state, node["id"], choice_id)
        # Each node has an independent private seed. Retries / restarts cannot reroll QTEs.
        rng = random.Random(f"{game['seed']}:{game['chapter']}:{node['id']}")
        rule = system.get("resolution_rule", {}).get(choice_id)
        if rule is None:
            ending_rule = system.get("ending_resolution", {}).get(choice_id, {})
            if game["difficulty"] in ending_rule:
                rule = ending_rule
        if rule is not None:
            selected_rule = rule if "result" in rule else rule[game["difficulty"]]
            if "result" not in selected_rule:
                selected_rule = selected_rule["success"] if rng.random() < selected_rule["probability_success"] else selected_rule["failure"]
            if isinstance(selected_rule, dict):
                # Some upstream chapters embed assignments in the QTE branch.
                state.update(copy.deepcopy(selected_rule.get("state_update", {})))
                result = selected_rule["result"]
            else:
                result = selected_rule
        else:
            result = resolve_post_choice_result(node, choice_id, state, game["difficulty"], rng=rng)
        if result:
            apply_effects(state, system.get("resolution_effects", {}).get(result, {}))
    else:
        apply_effects(state, system.get("effects", {}))
        result = _resolve_mandatory_result(node, state)
        if result and result.startswith("ending_"):
            apply_effects(state, system.get("ending_effects", {}).get(result, {}))
    if result:
        if result.startswith("ending_"):
            game["endings"].append(result)
            track = _node_track(node, _tracks(data))
            if _tracks(data):
                if track:
                    game["ended_tracks"].append(track)
            else:
                game["cursor"] = len(data["nodes"])
        else:
            state[f"_{node['id'].split('_', 1)[0]}_result"] = result
            state[f"_{node['id']}_result"] = result
            if node["id"] == "n011_final_choice":
                state["_n011_result"] = result


def _advance(game: dict) -> None:
    data = chapter(game["language"], game["chapter"])
    while game["cursor"] < len(data["nodes"]):
        node = data["nodes"][game["cursor"]]
        track = _node_track(node, _tracks(data))
        if (track and track in game["ended_tracks"]) or not node_condition_met(node, game["state"]):
            game["cursor"] += 1
            continue
        context = resolve_context(node, game["state"])
        choices = _resolve_optional_choices(node, game["state"])
        if choices:
            game["pending"] = {"context": context, "choices": choices}
            return
        game["history"].append({"kind": "scene", "chapter": game["chapter"], "context": context})
        game["cursor"] += 1
        _resolve(game, data, node, None)
    _finish_chapter(game, data)


def _finish_chapter(game: dict, data: dict) -> None:
    ids = game["endings"] or [_single_ending_id(data)]
    if not all(ids):
        raise RuntimeError("Chapter did not resolve an ending")
    primary = _pick_primary_ending(data, ids) if len(ids) > 1 else ids[0]
    result = {"ending": ending_payload(data, primary), "all_endings": [ending_payload(data, i) for i in ids]}
    state = game["state"]
    _add_campaign_derived_state(state, data, result)
    cfg = data.get("campaign", {})
    apply_derived_exports(state, cfg.get("derived_exports", []), result)
    game["cross_state"].update(extract_cross_chapter_state(state, cfg.get("cross_chapter_exports", [])))
    summary = build_chapter_summary(cfg.get("summary_segments", []), state)
    if summary:
        game["summaries"].append(summary)
    # Only the reached narrative is returned. Never return grades, effects, or hidden state.
    reached = [{k: e[k] for k in ("title", "narrative")} for e in result["all_endings"]]
    game["history"].append({"kind": "chapter_end", "chapter": game["chapter"], "endings": reached, "summary": summary})
    game["pending"] = None
    game["phase"] = "complete" if game["chapter"] == 32 else "chapter_complete"


def choose(game: dict, turn: int, choice: int, note: str = "") -> None:
    if turn != game["revision"]:
        raise ValueError("This turn is outdated. Call get_scene before choosing again.")
    if game["phase"] != "playing" or not game["pending"]:
        raise ValueError("No decision is pending; call continue_game after a chapter ends.")
    pending = game["pending"]
    if isinstance(choice, bool) or not isinstance(choice, int) or not 1 <= choice <= len(pending["choices"]):
        raise ValueError("Choose one of the displayed option numbers.")
    selected = pending["choices"][choice - 1]
    data = chapter(game["language"], game["chapter"])
    node = data["nodes"][game["cursor"]]
    game["history"].append({"kind": "decision", "chapter": game["chapter"], "context": pending["context"],
                            "options": [c["text"] for c in pending["choices"]],
                            "selected": choice, "action": selected["text"], "note": note})
    game["pending"] = None
    game["cursor"] += 1
    _resolve(game, data, node, selected["id"])
    game["revision"] += 1
    _advance(game)


def continue_game(game: dict, turn: int) -> None:
    if turn != game["revision"]:
        raise ValueError("This turn is outdated. Call get_scene first.")
    if game["phase"] != "chapter_complete":
        raise ValueError("The current chapter is not ready to continue.")
    game["chapter"] += 1
    game["revision"] += 1
    game["phase"] = "playing"
    _begin_chapter(game)
    _advance(game)


def view(game: dict, history_from: int | None = None) -> dict:
    data = chapter(game["language"], game["chapter"])
    result = {"status": game["phase"], "turn": game["revision"],
              "chapter": chapter_info(data, game["chapter"]), "history_count": len(game["history"])}
    if history_from is not None:
        result["events"] = copy.deepcopy(game["history"][history_from:])
    if game["pending"]:
        result["scene"] = {"context": game["pending"]["context"],
                           "choices": [{"number": i, "text": c["text"]} for i, c in enumerate(game["pending"]["choices"], 1)]}
    elif game["history"]:
        result["chapter_result"] = copy.deepcopy(game["history"][-1])
    result["next_action"] = {"playing": "choose_action", "chapter_complete": "continue_game", "complete": "Game complete"}[game["phase"]]
    return result
