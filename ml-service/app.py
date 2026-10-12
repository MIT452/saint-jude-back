import os
import pandas as pd
from dotenv import load_dotenv
from fastapi import FastAPI
from sqlalchemy import create_engine  # pip install sqlalchemy

load_dotenv()
engine = create_engine(os.environ["DATABASE_URL"])
app = FastAPI()

@app.get("/health")
def health():
    return {"ok": True}

@app.get("/stats/fill-rate")
def fill_rate():
    df = pd.read_sql("SELECT * FROM v_trip_stats", engine)
    df["fill_rate"] = (df["kg_booked"] / df["capacity"]).clip(0, 1)
    return df.fillna(0).to_dict(orient="records")

@app.get("/forecast/demand")
def forecast_demand(weeks: int = 4):
    df = pd.read_sql("SELECT day, kg_booked FROM v_trip_stats", engine)
    if df.empty:
        return {"forecast": [], "method": "no-data"}
    weekly = df.set_index(pd.to_datetime(df["day"])).resample("W")["kg_booked"].sum()
    # Base de référence : moyenne des 4 dernières semaines
    base = float(weekly.tail(4).mean())
    return {"method": "moving-average-4w", "forecast": [round(base, 1)] * weeks}