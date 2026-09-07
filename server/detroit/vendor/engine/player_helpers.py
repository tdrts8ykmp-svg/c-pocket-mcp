# Extracted without behavioral changes from Detroit AI Player (Joey Zhang), MIT.
from __future__ import annotations
import copy
from typing import Any
from resolver import resolve_choices, resolve_check_rule
from state import evaluate_condition
_TIER_PRIORITY = {"worst": 0, "tragic": 1, "neutral": 2, "best": 3}


def _resolve_optional_choices(node: dict[str, Any], state: dict[str, Any]) -> list[dict[str, str]]:
    try:
        return resolve_choices(node, state)
    except ValueError:
        if node.get("type") in {"mandatory", "narrative"}:
            return []
        raise

def _resolve_mandatory_result(node: dict[str, Any], state: dict[str, Any] | None = None) -> str | None:
    system = node.get("system", {})
    if "result" in system:
        return system["result"]
    if "ending" in system:
        return system["ending"]

    ending_resolution = system.get("ending_resolution")
    if not isinstance(ending_resolution, dict):
        return None

    if "check" in ending_resolution and state is not None:
        result = resolve_check_rule(ending_resolution["check"], state)
        return result or None

    if len(ending_resolution) == 1:
        rule = next(iter(ending_resolution.values()))
        if isinstance(rule, dict):
            return rule.get("result")

    return None

def _pick_primary_ending(chapter_data: dict[str, Any], collected_endings: list[str]) -> str:
    endings_data = chapter_data.get("endings", {})
    unique = list(dict.fromkeys(collected_endings))

    def score(eid: str) -> tuple[int, int]:
        e = endings_data.get(eid, {})
        deaths = len(e.get("deaths", []))
        tier = _TIER_PRIORITY.get(e.get("tier", "neutral"), 2)
        return (-deaths, tier)

    return min(unique, key=score)

def _node_track(node: dict[str, Any], protagonist_tracks: set[str]) -> str | None:
    """Return the protagonist track a node belongs to, or None.

    Multi-protagonist chapters tag each node with a `phase` such as
    ``connor_cyberlife_tower`` or ``kara_captured``. The phase prefix is the
    protagonist's name, which lets the runner stop a track once it has reached
    an ending so mutually exclusive branches on the same track cannot also run.
    """
    phase = node.get("phase", "")
    if not phase:
        return None
    prefix = phase.split("_", 1)[0]
    return prefix if prefix in protagonist_tracks else None

def _single_ending_id(chapter_data: dict[str, Any]) -> str | None:
    endings = [ending_id for ending_id in chapter_data.get("endings", {}) if not str(ending_id).startswith("_")]
    return endings[0] if len(endings) == 1 else None

def _record_choice_aliases(state: dict[str, Any], node_id: str, choice_id: str) -> None:
    state[node_id] = choice_id
    if node_id == "n002_investigation_strategy":
        state["investigation"] = choice_id
    elif node_id == "n010_final_demand":
        state["final_demand"] = choice_id
    elif node_id == "n011_final_choice":
        state["final_choice"] = choice_id

def build_chapter_summary(segments: list[dict[str, Any]], state: dict[str, Any]) -> str:
    parts: list[str] = []
    for segment in segments:
        if "text" in segment:
            parts.append(str(segment["text"]))
            continue

        if "condition_variable" not in segment:
            continue

        variable_name = segment["condition_variable"]
        options = segment.get("options", {})

        # Multi-protagonist finales collect one ending per track. Narrate every
        # collected ending (Connor / Markus / Kara), not just the primary one.
        if variable_name == "_ending_id" and isinstance(state.get("_ending_ids"), list):
            for ending_id in state["_ending_ids"]:
                text = options.get(str(ending_id))
                if text:
                    parts.append(str(text))
            continue

        variable_value = str(state.get(variable_name, ""))
        text = options.get(variable_value)
        if text:
            parts.append(str(text))

    return "".join(parts)

def apply_derived_exports(
    state: dict[str, Any],
    derived_exports: list[dict[str, Any]],
    result: dict[str, Any],
) -> None:
    ending = result.get("ending", {})
    survivors = ending.get("survivors", [])
    deaths = ending.get("deaths", [])

    for rule in derived_exports:
        target = rule.get("target")
        if not target:
            continue

        if "source" in rule:
            source = rule["source"]
            if "derive_rule" in rule:
                state[target] = evaluate_condition(rule["derive_rule"], state)
                continue
            if source in state:
                state[target] = copy.deepcopy(state[source])
            continue

        if "from_ending_survivors" in rule:
            name = str(rule["from_ending_survivors"])
            survived = _contains_name(survivors, name)
            died = _contains_name(deaths, name)
            state[target] = survived or (bool(rule.get("default_if_not_dead")) and not died)
            continue

        if "from_ending_deaths" in rule:
            name = str(rule["from_ending_deaths"])
            value = _contains_name(deaths, name)
            state[target] = not value if rule.get("invert") else value

def _add_campaign_derived_state(
    final_state: dict[str, Any],
    chapter_data: dict[str, Any],
    result: dict[str, Any],
) -> None:
    ending = result["ending"]
    ending_id = ending["id"]
    chapter_id = chapter_data["chapter"]["id"]
    chapter_prefix = chapter_id.split("_", 1)[0]

    final_state["_ending_id"] = ending_id
    final_state["_ending_ids"] = [item["id"] for item in result.get("all_endings", [ending])]
    final_state[f"{chapter_prefix}_ending"] = ending_id
    final_state["connor_death_count"] = int(final_state.get("connor_death_count", 0))

    deaths = ending.get("deaths", [])
    if any(str(death).startswith("Connor") for death in deaths):
        final_state["connor_death_count"] = int(final_state.get("connor_death_count", 0)) + 1

def _contains_name(values: list[Any], name: str) -> bool:
    aliases = _name_aliases(name)
    return any(any(alias in str(value) for alias in aliases) for value in values)

def _name_aliases(name: str) -> list[str]:
    aliases = {
        "Connor": ["Connor", "康纳"],
        "Emma": ["Emma", "艾玛"],
        "Daniel": ["Daniel", "丹尼尔"],
        "Markus": ["Markus", "马库斯"],
    }
    return aliases.get(name, [name])
