# main.py
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from typing import List, Optional
import numpy as np
import pandas as pd
from datetime import datetime, timedelta
import xgboost as xgb
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error

app = FastAPI(
    title="Saint-Jude ML Service",
    version="1.1.0",
    description="Prévisions de demande et de chiffre d'affaires pour SAINT-JUDE"
)

# =========================================================
# MODÈLES XGBoost (un pour la demande, un pour le CA)
# =========================================================

model_demand = xgb.XGBRegressor(
    n_estimators=150,
    max_depth=5,
    learning_rate=0.08,
    objective="reg:squarederror",
    subsample=0.9,
    colsample_bytree=0.9,
    random_state=42
)

model_revenue = xgb.XGBRegressor(
    n_estimators=150,
    max_depth=5,
    learning_rate=0.08,
    objective="reg:squarederror",
    subsample=0.9,
    colsample_bytree=0.9,
    random_state=42
)

# Flag pour savoir si les modèles ont été entraînés
is_trained = {"demand": False, "revenue": False}


# =========================================================
# SCHÉMAS D'ENTRÉE / SORTIE
# =========================================================

class DailyPoint(BaseModel):
    date: str = Field(..., example="2026-10-15")          # YYYY-MM-DD
    value: float = Field(..., example=12)                 # nb réservations ou CA


class TrainRequest(BaseModel):
    data: List[DailyPoint]
    target: str = Field(..., pattern="^(demand|revenue)$")  # "demand" ou "revenue"


class ForecastRequest(BaseModel):
    history: List[DailyPoint]                             # historique récent
    periods: int = Field(30, ge=1, le=90)                 # jours à prédire
    target: str = Field("demand", pattern="^(demand|revenue)$")


class ForecastPoint(BaseModel):
    date: str
    prevision: float
    basse: Optional[float] = None
    haute: Optional[float] = None


# =========================================================
# UTILS – FEATURE ENGINEERING
# =========================================================

def create_features(df: pd.DataFrame) -> pd.DataFrame:
    """Crée les features temporelles + lags pour XGBoost"""
    df = df.copy()
    df["ds"] = pd.to_datetime(df["date"])
    df = df.sort_values("ds").reset_index(drop=True)

    df["dayofweek"] = df["ds"].dt.dayofweek          # 0=lundi
    df["month"] = df["ds"].dt.month
    df["day"] = df["ds"].dt.day
    df["weekofyear"] = df["ds"].dt.isocalendar().week.astype(int)
    df["is_weekend"] = (df["dayofweek"] >= 5).astype(int)

    # Lags (valeurs passées)
    for lag in [1, 2, 3, 7, 14]:
        df[f"lag_{lag}"] = df["y"].shift(lag)

    # Moyennes mobiles
    df["rolling_mean_7"] = df["y"].rolling(7, min_periods=1).mean()
    df["rolling_mean_14"] = df["y"].rolling(14, min_periods=1).mean()

    # Tendance simple
    df["trend"] = np.arange(len(df))

    return df


FEATURE_COLS = [
    "dayofweek", "month", "day", "weekofyear", "is_weekend",
    "lag_1", "lag_2", "lag_3", "lag_7", "lag_14",
    "rolling_mean_7", "rolling_mean_14", "trend"
]


# =========================================================
# ROUTES
# =========================================================

@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "saint-jude-ml",
        "models_trained": is_trained
    }


@app.post("/train")
def train_model(req: TrainRequest):
    """
    Entraîne le modèle (demand ou revenue) avec l'historique fourni.
    À appeler une fois avec vos vraies données, ou périodiquement.
    """
    if len(req.data) < 21:
        raise HTTPException(
            status_code=400,
            detail="Minimum 21 jours d'historique recommandés pour un entraînement fiable"
        )

    df = pd.DataFrame([{"date": p.date, "y": p.value} for p in req.data])
    df = create_features(df)
    df = df.dropna()          # on enlève les premières lignes sans lags

    if len(df) < 14:
        raise HTTPException(status_code=400, detail="Pas assez de données après feature engineering")

    X = df[FEATURE_COLS]
    y = df["y"]

    X_train, X_val, y_train, y_val = train_test_split(X, y, test_size=0.2, shuffle=False)

    model = model_demand if req.target == "demand" else model_revenue
    model.fit(
        X_train, y_train,
        eval_set=[(X_val, y_val)],
        verbose=False
    )

    # Évaluation rapide
    preds = model.predict(X_val)
    mae = float(mean_absolute_error(y_val, preds))

    is_trained[req.target] = True

    return {
        "status": "trained",
        "target": req.target,
        "samples": len(df),
        "mae_validation": round(mae, 2),
        "message": f"Modèle {req.target} entraîné avec succès"
    }


@app.post("/forecast", response_model=List[ForecastPoint])
def forecast(req: ForecastRequest):
    """
    Prévision sur les N prochains jours.
    On utilise l'historique fourni + le modèle déjà entraîné.
    """
    if not is_trained[req.target]:
        # Si le modèle n'a jamais été entraîné, on fait un entraînement rapide
        # avec l'historique fourni (pratique pour le démarrage)
        train_model(TrainRequest(data=req.history, target=req.target))

    if len(req.history) < 14:
        raise HTTPException(status_code=400, detail="Minimum 14 jours d'historique pour prédire")

    df = pd.DataFrame([{"date": p.date, "y": p.value} for p in req.history])
    df = create_features(df)

    model = model_demand if req.target == "demand" else model_revenue
    last_date = pd.to_datetime(df["date"]).max()

    results = []
    current_df = df.copy()

    for i in range(1, req.periods + 1):
        next_date = last_date + timedelta(days=i)

        # On crée une ligne pour le jour à prédire
        new_row = {
            "date": next_date.strftime("%Y-%m-%d"),
            "y": np.nan,          # sera prédit
            "ds": next_date,
            "dayofweek": next_date.dayofweek,
            "month": next_date.month,
            "day": next_date.day,
            "weekofyear": next_date.isocalendar()[1],
            "is_weekend": int(next_date.dayofweek >= 5),
            "trend": len(current_df) + i - 1
        }

        # Lags à partir de l'historique
        for lag in [1, 2, 3, 7, 14]:
            if len(current_df) >= lag:
                new_row[f"lag_{lag}"] = current_df["y"].iloc[-lag]
            else:
                new_row[f"lag_{lag}"] = current_df["y"].mean()

        new_row["rolling_mean_7"] = current_df["y"].tail(7).mean()
        new_row["rolling_mean_14"] = current_df["y"].tail(14).mean()

        X_pred = pd.DataFrame([new_row])[FEATURE_COLS]
        pred = float(model.predict(X_pred)[0])
        pred = max(0, pred)          # on ne prédit jamais de négatif

        # Intervalle de confiance approximatif (±15 %)
        results.append({
            "date": new_row["date"],
            "prevision": round(pred, 1),
            "basse": round(pred * 0.85, 1),
            "haute": round(pred * 1.15, 1)
        })

        # On ajoute la prédiction à l'historique pour les lags suivants
        current_df = pd.concat([
            current_df,
            pd.DataFrame([{"date": new_row["date"], "y": pred}])
        ], ignore_index=True)

    return results


@app.post("/predict")          # compatibilité avec votre ancien endpoint
def predict_legacy(data: dict):
    """Ancien endpoint conservé pour compatibilité"""
    return {"message": "Utilisez /forecast pour les prévisions SAINT-JUDE"}