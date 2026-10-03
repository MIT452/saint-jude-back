from fastapi import FastAPI
from pydantic import BaseModel
import numpy as np
import xgboost as xgb

app = FastAPI(
    title="Saint-Jude ML Service",
    version="1.0.0"
)


# =========================
# MODÈLE
# =========================

model = xgb.XGBRegressor(
    n_estimators=100,
    max_depth=4,
    learning_rate=0.1,
    objective="reg:squarederror"
)


# Petit dataset de démonstration
# À remplacer par les vraies données Saint-Jude
X_train = np.array([
    [50, 100, 20],
    [80, 150, 30],
    [100, 200, 40],
    [120, 250, 50],
    [150, 300, 60],
], dtype=float)

y_train = np.array([
    20,
    30,
    40,
    50,
    60
], dtype=float)

model.fit(X_train, y_train)


# =========================
# DONNÉES D'ENTRÉE
# =========================

class PredictionInput(BaseModel):
    distance_km: float
    passengers: int
    cargo_kg: float


# =========================
# ROUTES
# =========================

@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "saint-jude-ml"
    }


@app.post("/predict")
def predict(data: PredictionInput):

    X = np.array([[
        data.distance_km,
        data.passengers,
        data.cargo_kg
    ]], dtype=float)

    prediction = model.predict(X)[0]

    return {
        "prediction": float(prediction)
    }