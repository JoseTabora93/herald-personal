"""Authentication remains on the shared API; observing never launches an agent."""

from datetime import date as Date
from typing import Any

from fastapi import FastAPI

from .planning import GeneratePlan, Observation, PlanClaim, PlanError, Planning, PlanRecommendations


def attach_planning_routes(app: FastAPI, planning: Planning) -> None:
    @app.get("/v1/agent-observations")
    def observations() -> dict[str, list[dict[str, Any]]]:
        return {"items": planning.observations()}

    @app.put("/v1/agent-observations/{observer_id}")
    def observe(observer_id: str, payload: Observation) -> Observation:
        return planning.observe(observer_id, payload)

    @app.get("/v1/daily-plans")
    def plans(date: Date | None = None) -> dict[str, list[dict[str, Any]]]:
        return {"items": planning.plans(date.isoformat() if date else None)}

    @app.post("/v1/daily-plans/generate")
    def generate(payload: GeneratePlan) -> dict[str, Any]:
        return planning.generate(payload.date)

    @app.put("/v1/daily-plans/{selected}/recommendations")
    def recommendations(selected: Date, payload: PlanRecommendations) -> dict[str, Any]:
        return planning.recommend(selected.isoformat(), payload)

    @app.post("/v1/daily-plans/{selected}/open-claim")
    def open_claim(selected: Date, payload: PlanClaim) -> dict[str, bool]:
        return {"claimed": planning.claim(selected.isoformat(), "open", payload)}

    @app.post("/v1/daily-plans/{selected}/model-claim")
    def model_claim(selected: Date, payload: PlanClaim) -> dict[str, bool]:
        return {"claimed": planning.claim(selected.isoformat(), "model", payload)}

    @app.post("/v1/daily-plans/{selected}/model-error")
    def model_error(selected: Date, payload: PlanError) -> dict[str, Any]:
        return planning.model_error(selected.isoformat(), payload.error)
