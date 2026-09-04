"""Category-relative scoring for persisted GitHub repository metrics."""

from __future__ import annotations

import datetime as dt
import math
from typing import Any, Iterable


_REQUIRED_ENRICHMENT = ("readme_bytes", "has_code", "contributors")


def _number(value: Any, default: float = 0.0) -> float:
    if value is None:
        return default
    try:
        return max(0.0, float(value))
    except (TypeError, ValueError):
        return default


def _datetime(value: Any) -> dt.datetime | None:
    if not value:
        return None
    if isinstance(value, dt.datetime):
        parsed = value
    else:
        try:
            parsed = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


def _days_since(value: Any, now: dt.datetime, default: float = 365.0) -> float:
    parsed = _datetime(value)
    if parsed is None:
        return default
    return max(0.0, (now - parsed).total_seconds() / 86_400)


def _normalize(values: list[float]) -> list[float]:
    """Min-max normalize a category to 0..100, using a neutral singleton score."""
    if not values:
        return []
    low, high = min(values), max(values)
    if math.isclose(low, high):
        return [50.0] * len(values)
    return [100.0 * (value - low) / (high - low) for value in values]


def _normalize_eligible(values: list[float], excluded: list[bool]) -> list[float]:
    eligible_values = [value for value, is_excluded in zip(values, excluded) if not is_excluded]
    normalized = iter(_normalize(eligible_values))
    return [0.0 if is_excluded else next(normalized) for is_excluded in excluded]


def _ratio(numerator: Any, denominator: Any, default: float = 0.5) -> float:
    if numerator is None or denominator is None:
        return default
    denominator_value = _number(denominator)
    if denominator_value <= 0:
        return default
    return min(1.0, _number(numerator) / denominator_value)


def _quality_score(project: dict[str, Any]) -> float:
    components = [
        100.0 if project.get("license_spdx") else 50.0,
        100.0 if _number(project.get("releases_30d")) > 0 else 40.0,
        min(100.0, math.log1p(_number(project.get("readme_bytes"), 1_000)) / math.log1p(8_000) * 100),
        100.0 if project.get("readme_has_ci") else 50.0,
        100.0 if project.get("readme_has_demo") else 50.0,
    ]
    return sum(components) / len(components)


def score_category(
    projects: Iterable[dict[str, Any]],
    category: str,
    *,
    now: dt.datetime | None = None,
    gravity: float = 1.5,
) -> list[dict[str, Any]]:
    """Calculate both ranking models for repositories within one category.

    Inputs are expected to come from the metrics database. All relative dimensions
    are normalized only against the projects supplied in this call.
    """
    rows = list(projects)
    if not rows:
        return []
    now = now or dt.datetime.now(dt.timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=dt.timezone.utc)

    raw_momentum: list[float] = []
    raw_activity: list[float] = []
    raw_engagement: list[float] = []
    raw_freshness: list[float] = []
    raw_hot: list[float] = []
    excluded_from_ranking = [
        (project.get("readme_bytes") is not None and _number(project.get("readme_bytes")) < 200)
        or (project.get("has_code") is not None and not bool(project.get("has_code")))
        for project in rows
    ]

    for project in rows:
        star_delta = _number(project.get("star_delta_7d"))
        fork_delta = _number(project.get("fork_delta_7d"))
        commits = _number(project.get("commits_30d"))
        age_days = _days_since(project.get("created_at"), now)
        push_days = _days_since(project.get("pushed_at"), now)

        relative_growth = star_delta / (_number(project.get("stars")) + 100.0)
        raw_momentum.append(
            0.55 * math.log1p(star_delta)
            + 0.25 * math.log1p(fork_delta)
            + 0.20 * math.log1p(relative_growth * 100)
        )
        issue_close_hours = _number(project.get("avg_issue_close_hours"), 48)
        raw_activity.append(
            0.45 * math.log1p(commits)
            + 0.20 / math.log(push_days + 2)
            + 0.20 * math.log1p(_number(project.get("contributors"), 3))
            + 0.15 / math.log(issue_close_hours + 2)
        )

        total_issues = _number(project.get("open_issues")) + _number(project.get("closed_issues"))
        issue_close_ratio = _ratio(project.get("closed_issues"), total_issues)
        total_prs = _number(project.get("open_prs")) + _number(project.get("merged_prs"))
        pr_merge_ratio = _ratio(project.get("merged_prs"), total_prs)
        raw_engagement.append(
            0.45 * math.log1p(_number(project.get("forks")))
            + 0.30 * issue_close_ratio
            + 0.15 * pr_merge_ratio
            + 0.10 * math.log1p(_number(project.get("releases_30d")))
        )
        raw_freshness.append(1.0 / math.log(age_days + 2))
        raw_hot.append((star_delta + 2 * fork_delta + commits) / ((age_days + 2) ** gravity))

    momentum_scores = _normalize_eligible(raw_momentum, excluded_from_ranking)
    activity_scores = _normalize_eligible(raw_activity, excluded_from_ranking)
    engagement_scores = _normalize_eligible(raw_engagement, excluded_from_ranking)
    freshness_scores = _normalize_eligible(raw_freshness, excluded_from_ranking)
    hot_scores = _normalize_eligible(raw_hot, excluded_from_ranking)

    scored: list[dict[str, Any]] = []
    for index, project in enumerate(rows):
        penalties: list[str] = []
        excluded = False

        if project.get("readme_bytes") is not None and _number(project.get("readme_bytes")) < 200:
            penalties.append("README_TOO_SHORT")
            excluded = True
        has_code = project.get("has_code")
        if has_code is not None and not bool(has_code):
            penalties.append("NO_CODE")
            excluded = True
        if any(project.get(field) is None for field in _REQUIRED_ENRICHMENT):
            penalties.append("INCOMPLETE_DATA")

        quality_multiplier = 1.0
        if project.get("license_spdx"):
            quality_multiplier *= 1.10
        if _number(project.get("releases_30d")) > 0:
            quality_multiplier *= 1.15
        if project.get("contributors") is not None and _number(project.get("contributors")) <= 1:
            quality_multiplier *= 0.90
        is_collection = bool(project.get("is_collection"))
        if is_collection:
            penalties.append("COLLECTION")
            quality_multiplier *= 0.75

        owner_age = _days_since(project.get("owner_created_at"), now)
        suspicious = (
            _number(project.get("star_delta_7d")) >= 2_000
            and _number(project.get("commits_30d")) == 0
            and _number(project.get("fork_delta_7d")) < 5
            and owner_age < 90
        )
        if suspicious:
            penalties.append("SUSPICIOUS_GROWTH")
            quality_multiplier *= 0.25

        base_score = (
            0.40 * momentum_scores[index]
            + 0.25 * activity_scores[index]
            + 0.20 * engagement_scores[index]
            + 0.15 * freshness_scores[index]
        )
        comprehensive = min(100.0, base_score * quality_multiplier)
        hot = hot_scores[index]
        if is_collection:
            hot *= 0.75
        if suspicious:
            hot *= 0.25
        if excluded:
            comprehensive = 0.0
            hot = 0.0

        scored.append(
            {
                "repo": project["repo"],
                "category": category,
                "comprehensive_score": round(comprehensive, 2),
                "hot_score": round(min(100.0, hot), 2),
                "momentum_score": round(momentum_scores[index], 2),
                "activity_score": round(activity_scores[index], 2),
                "engagement_score": round(engagement_scores[index], 2),
                "quality_score": round(_quality_score(project), 2),
                "freshness_score": round(freshness_scores[index], 2),
                "excluded": excluded,
                "penalties": penalties,
            }
        )

    return scored
